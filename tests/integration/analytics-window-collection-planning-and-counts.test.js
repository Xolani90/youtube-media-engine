import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runWindowCollection } from '../../src/analytics/windowCollection.js';

// Regression tests for two corrections in runWindowCollection:
//  1. one planning instant per invocation, shared by the scalar and audience planners;
//  2. unsupported-adapter counts are individual reports (sum of target.kinds.length), not targets.

const PUBLISHED_AT = '2026-09-01T10:00:00.000Z';
const NOW_BOTH_WINDOWS = '2026-10-01T00:00:00.000Z'; // 24H and 7D usable
const NOW_24H_ONLY = '2026-09-06T00:00:00.000Z';      // only 24H usable

async function openStorage() {
  const dbPath = path.join(os.tmpdir(), `win-corr-${process.pid}-${Date.now()}-${Math.random()}.db`);
  try {
    const { SqliteStorageDriver } = await import('../../src/storage/SqliteStorageDriver.js');
    const storage = new SqliteStorageDriver({ dbPath });
    await storage.migrate();
    return { storage, cleanup: () => { storage.close(); for (const s of ['', '-wal', '-shm']) fs.rmSync(dbPath + s, { force: true }); } };
  } catch (err) {
    if (!/better-sqlite3|dlopen|bindings|Cannot find/i.test(String(err?.message ?? err))) throw err;
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(':memory:');
    const dir = fileURLToPath(new URL('../../src/db/migrations/', import.meta.url));
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) db.exec(fs.readFileSync(path.join(dir, f), 'utf8'));
    return {
      storage: {
        run: (sql, p = []) => { const r = db.prepare(sql).run(...p); return { changes: Number(r.changes) }; },
        all: (sql, p = []) => db.prepare(sql).all(...p),
        get: (sql, p = []) => db.prepare(sql).get(...p)
      },
      cleanup: () => db.close()
    };
  }
}
function seed(storage, n) {
  storage.run(`INSERT INTO system_runs (id, mode, autonomous_enabled, started_at, config_snapshot) VALUES (?, 'LIVE', 1, ?, '{}')`, [`run${n}`, PUBLISHED_AT]);
  storage.run(
    `INSERT INTO publications (id, content_version_id, media_artifact_id, provider, status, request_json, provider_item_id, result_json, created_at, updated_at)
     VALUES (?, ?, ?, 'youtube', 'PUBLISHED', ?, ?, ?, ?, ?)`,
    [`pub${n}`, `cv${n}`, `ma${n}`, JSON.stringify({ requestedPublishAt: null }), `vidAAAAAA${n}`, JSON.stringify({ confirmedVisibility: 'public' }), PUBLISHED_AT, PUBLISHED_AT]
  );
  storage.run(`INSERT INTO decision_log (id, run_id, subject_type, subject_id, decision, reason, created_at) VALUES (?, ?, 'content_version', ?, 'PUBLISHED', ?, ?)`,
    [`dl${n}`, `run${n}`, `cv${n}`, `publication_pub${n}_persisted`, PUBLISHED_AT]);
}
function seedSuccessAudience(storage, n, kind, start, end) {
  storage.run(
    `INSERT INTO analytics_audience_snapshots (id, publication_id, provider, provider_item_id, kind, period_start, period_end, collected_at, status, summary_json, result_json, created_at)
     VALUES (?, ?, 'youtube', ?, ?, ?, ?, ?, 'SUCCESS', '{}', '{}', ?)`,
    [`aud-${n}-${kind}-${end}`, `pub${n}`, `vidAAAAAA${n}`, kind, start, end, NOW_BOTH_WINDOWS, NOW_BOTH_WINDOWS]
  );
}
async function setup(pubs) {
  const { storage, cleanup } = await openStorage();
  storage.run('PRAGMA foreign_keys = OFF');
  for (const n of pubs) seed(storage, n);
  return { storage, cleanup, lp: path.join(os.tmpdir(), `win-corr-lock-${process.pid}-${Math.random()}.lock`) };
}
// Adapter that supports scalar collection only (lacks both audience methods).
const legacyAdapter = () => ({ collect: async (a) => ({ status: 'SUCCESS', byVideoId: Object.fromEntries(a.videoIds.map((v) => [v, { views: 1 }])) }) });
const sumKinds = (targets) => targets.reduce((n, t) => n + t.kinds.length, 0);

// ---------------- Correction 1: single planning timestamp ----------------

test('both planners receive the same planning instant even when the clock differs on every call', async () => {
  const { storage, cleanup, lp } = await setup([1]);
  try {
    let calls = 0;
    const clock = () => new Date(Date.parse(NOW_BOTH_WINDOWS) + (calls++) * 86400000).toISOString();
    const r = await runWindowCollection({ storage, adapter: null, execute: false, now: clock, lockPath: lp });
    const first = new Date(Date.parse(NOW_BOTH_WINDOWS)).toISOString();
    assert.equal(r.plan.now, first, 'scalar planner got the first clock reading');
    assert.equal(r.audience.plan.now, first, 'audience planner got the very same instant');
    assert.equal(r.plan.now, r.audience.plan.now);
    assert.equal(calls, 1, 'the clock is read exactly once for planning');
  } finally { cleanup(); fs.rmSync(lp, { force: true }); }
});

test('planning instant is fixed, but collectors still receive the live now callback', async () => {
  const { storage, cleanup, lp } = await setup([1]);
  try {
    let calls = 0;
    const clock = () => new Date(Date.parse(NOW_BOTH_WINDOWS) + (calls++) * 1000).toISOString();
    const seen = {};
    const adapter = { collect: async () => ({}), collectRetentionCurve: async () => ({}), collectTrafficSources: async () => ({}) };
    const r = await runWindowCollection({
      storage, adapter, now: clock, lockPath: lp,
      collect: async (a) => { seen.scalarNow = a.nowISO; seen.callsAtScalar = calls; return { eligible: 0, collected: 0, unavailable: 0, failed: 0, aborted: false }; },
      collectAudience: async (a) => { seen.audienceNow = a.nowISO; return { requested: 0, collected: 0, unavailable: 0, failed: 0, aborted: false }; }
    });
    assert.equal(r.plan.now, r.audience.plan.now);
    assert.equal(seen.callsAtScalar, 1, 'planning consumed exactly one clock reading before collection began');
    assert.equal(seen.scalarNow, clock, 'scalar collector receives the callback itself, not a fixed timestamp');
    assert.equal(seen.audienceNow, clock, 'audience collector receives the callback itself, not a fixed timestamp');
    assert.equal(typeof seen.scalarNow(), 'string');
  } finally { cleanup(); fs.rmSync(lp, { force: true }); }
});

// ---------------- Correction 2: unsupported-adapter report counts ----------------

test('one target holding both audience kinds: requested 2, failed 2', async () => {
  const { storage, cleanup, lp } = await setup([1]);
  try {
    const r = await runWindowCollection({ storage, adapter: legacyAdapter(), now: () => NOW_24H_ONLY, lockPath: lp });
    assert.equal(r.audience.plan.targets.length, 1);
    assert.deepEqual([...r.audience.plan.targets[0].kinds].sort(), ['RETENTION', 'TRAFFIC_SOURCES']);
    assert.equal(r.audience.result.requested, 2);
    assert.equal(r.audience.result.failed, 2);
    assert.equal(r.audience.result.collected, 0);
  } finally { cleanup(); fs.rmSync(lp, { force: true }); }
});

test('multiple targets with different kind counts: requested and failed are the kind sum', async () => {
  const { storage, cleanup, lp } = await setup([1, 2, 3]);
  try {
    // pub1 already has RETENTION for both windows => its two targets carry one kind (TRAFFIC_SOURCES) each.
    seedSuccessAudience(storage, 1, 'RETENTION', '2026-09-02', '2026-09-02');
    seedSuccessAudience(storage, 1, 'RETENTION', '2026-09-02', '2026-09-08');
    const r = await runWindowCollection({ storage, adapter: legacyAdapter(), now: () => NOW_BOTH_WINDOWS, lockPath: lp });
    const t = r.audience.plan.targets;
    assert.equal(t.length, 6, 'three publications x two windows');
    assert.deepEqual([...new Set(t.map((x) => x.kinds.length))].sort(), [1, 2], 'targets differ in kind count');
    assert.equal(sumKinds(t), 10);
    assert.equal(r.audience.result.requested, 10);
    assert.equal(r.audience.result.failed, 10);
    assert.notEqual(r.audience.result.requested, t.length, 'not the target count');
  } finally { cleanup(); fs.rmSync(lp, { force: true }); }
});

test('unsupported-adapter behaviour and error reporting are otherwise unchanged', async () => {
  const { storage, cleanup, lp } = await setup([1]);
  try {
    const r = await runWindowCollection({ storage, adapter: legacyAdapter(), now: () => NOW_24H_ONLY, lockPath: lp });
    const res = r.audience.result;
    assert.equal(r.status, 'OK', 'scalar outcome independent');
    assert.equal(r.audience.status, 'FAILED');
    assert.equal(r.overallStatus, 'PARTIAL');
    assert.equal(res.unsupported, true);
    assert.deepEqual(res.missingMethods, ['collectRetentionCurve', 'collectTrafficSources']);
    assert.equal(res.error, 'AUDIENCE_ADAPTER_UNSUPPORTED: adapter lacks collectRetentionCurve, collectTrafficSources');
    assert.equal(res.alreadyCollected, 0);
    assert.equal(res.collected, 0);
    assert.equal(res.unavailable, 0);
    assert.equal(res.aborted, false);
    assert.equal(storage.all('SELECT * FROM analytics_audience_snapshots').length, 0, 'nothing written for work never attempted');
  } finally { cleanup(); fs.rmSync(lp, { force: true }); }
});
