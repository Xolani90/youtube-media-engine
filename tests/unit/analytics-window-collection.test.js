import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { planWindowCollection, runWindowCollection, acquireLock } from '../../src/analytics/windowCollection.js';
import { collectAnalytics } from '../../src/analytics/collector.js';

// Published 2026-09-01T10:00Z => 24H = 2026-09-02; 7D = 2026-09-02..2026-09-08.
// 24H usable from 2026-09-02 end +1 day + 2 days = 2026-09-05T00:00Z; 7D from 2026-09-11T00:00Z.
const PUBLISHED_AT = '2026-09-01T10:00:00.000Z';
const W24 = { start: '2026-09-02', end: '2026-09-02' };
const W7 = { start: '2026-09-02', end: '2026-09-08' };

function pub(n, over = {}) {
  return {
    id: `pub${n}`, provider: 'youtube', provider_item_id: `vid${n}`, status: 'PUBLISHED', content_version_id: `cv${n}`,
    request_json: JSON.stringify({ requestedPublishAt: null }), result_json: JSON.stringify({ confirmedVisibility: 'public' }),
    published_at: PUBLISHED_AT, run_mode: 'LIVE', ...over
  };
}
function snap(n, w, over = {}) {
  return {
    id: `s${n}${w.end}`, publication_id: `pub${n}`, provider: 'youtube', provider_item_id: `vid${n}`, period_start: w.start, period_end: w.end,
    collected_at: '2026-09-20T00:00:00.000Z', status: 'SUCCESS', views: 1, impressions: 5000, impressions_ctr: 4, average_view_percentage: 40, ...over
  };
}
const ev = (publications, snapshots = []) => ({ provider: 'youtube', publications, snapshots });
const plan = (e, now) => planWindowCollection(e, { now });

test('window boundaries: 24H due at D0+4 00:00Z, 7D at D0+10 00:00Z; nothing earlier', () => {
  const e = ev([pub(1)]);
  let p = plan(e, '2026-09-04T23:59:59.999Z');
  assert.equal(p.due.length, 0);
  assert.equal(p.notDue.length, 2);
  p = plan(e, '2026-09-05T00:00:00.000Z');
  assert.deepEqual(p.due.map((g) => [g.periodStart, g.periodEnd, g.windows]), [['2026-09-02', '2026-09-02', ['24H']]]);
  p = plan(e, '2026-09-10T23:59:59.999Z');
  assert.deepEqual(p.due.map((g) => g.windows), [['24H']]);
  p = plan(e, '2026-09-11T00:00:00.000Z');
  assert.deepEqual(p.due.map((g) => `${g.periodStart}..${g.periodEnd}`).sort(), ['2026-09-02..2026-09-02', '2026-09-02..2026-09-08']);
});

test('publications sharing a publish day share one collector period; different days do not', () => {
  const e = ev([pub(1), pub(2), pub(3, { published_at: '2026-09-02T01:00:00.000Z' })]);
  const p = plan(e, '2026-09-05T00:00:00.000Z');
  const g = p.due.find((x) => x.periodStart === '2026-09-02');
  assert.deepEqual(g.publicationIds, ['pub1', 'pub2']);
  assert.equal(p.due.length, 1); // pub3's 24H (2026-09-03) is not usable until 2026-09-06
  assert.equal(plan(e, '2026-09-06T00:00:00.000Z').due.length, 2);
});

test('already-collected SUCCESS windows are not due, so never re-collected', () => {
  const e = ev([pub(1)], [snap(1, W24), snap(1, W7)]);
  assert.equal(plan(e, '2026-10-01T00:00:00.000Z').due.length, 0);
});

test('non-SUCCESS snapshots are retried only after the cooldown', () => {
  const e = ev([pub(1)], [snap(1, W24, { status: 'TRANSIENT_FAILURE', collected_at: '2026-09-05T00:00:00.000Z' })]);
  const early = planWindowCollection(e, { now: '2026-09-05T05:59:00.000Z', retryAfterHours: 6 });
  assert.equal(early.due.length, 0);
  assert.equal(early.deferred.length, 1);
  assert.equal(early.deferred[0].retryAt, '2026-09-05T06:00:00.000Z');
  const later = planWindowCollection(e, { now: '2026-09-05T06:00:00.000Z', retryAfterHours: 6 });
  assert.equal(later.due.length, 1);
});

test('missing or unusable publication timestamps are skipped and reported, never guessed', () => {
  const e = ev([pub(1, { published_at: null }), pub(2, { published_at: 'garbage' }), pub(3, { run_mode: 'SIMULATION' }), pub(4, { request_json: JSON.stringify({ requestedPublishAt: '2026-09-09T00:00:00Z' }) })]);
  const p = plan(e, '2026-10-01T00:00:00.000Z');
  assert.equal(p.due.length, 0);
  assert.deepEqual(p.skipped.map((s) => s.reason).sort(), ['no_persisted_published_decision', 'run_mode_not_live', 'scheduled_publication', 'unparseable_published_at']);
});

// ---- database-backed: repeat execution, collector failures, isolation ----
async function openStorage() {
  const dbPath = path.join(os.tmpdir(), `analytics-win-${process.pid}-${Date.now()}-${Math.random()}.db`);
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
function seed(storage, n, { publishedAt = PUBLISHED_AT, mode = 'LIVE' } = {}) {
  storage.run(`INSERT INTO system_runs (id, mode, autonomous_enabled, started_at, config_snapshot) VALUES (?, ?, 1, ?, '{}')`, [`run${n}`, mode, publishedAt]);
  storage.run(
    `INSERT INTO publications (id, content_version_id, media_artifact_id, provider, status, request_json, provider_item_id, result_json, created_at, updated_at)
     VALUES (?, ?, ?, 'youtube', 'PUBLISHED', ?, ?, ?, ?, ?)`,
    [`pub${n}`, `cv${n}`, `ma${n}`, JSON.stringify({ requestedPublishAt: null }), `vid${n}`, JSON.stringify({ confirmedVisibility: 'public' }), publishedAt, publishedAt]
  );
  storage.run(
    `INSERT INTO decision_log (id, run_id, subject_type, subject_id, decision, reason, created_at) VALUES (?, ?, 'content_version', ?, 'PUBLISHED', ?, ?)`,
    [`dl${n}`, `run${n}`, `cv${n}`, `publication_pub${n}_persisted`, publishedAt]
  );
}
function fakeAdapter(handler) {
  const calls = [];
  return { calls, collect: async (args) => { calls.push(args); return handler(args, calls.length); } };
}
const okReport = (args) => ({ status: 'SUCCESS', byVideoId: Object.fromEntries(args.videoIds.map((v) => [v, { views: 10, impressions: 2000, impressionsCtr: 5, averageViewPercentage: 50 }])) });
const lockFile = () => path.join(os.tmpdir(), `awc-lock-${process.pid}-${Math.random()}.lock`);
const NOW = '2026-10-01T00:00:00.000Z';

test('repeat execution: second run collects nothing; only exact fixed windows are called', async () => {
  const { storage, cleanup } = await openStorage();
  const lp = lockFile();
  try {
    storage.run('PRAGMA foreign_keys = OFF');
    seed(storage, 1); seed(storage, 2);
    const adapter = fakeAdapter(okReport);
    const first = await runWindowCollection({ storage, adapter, now: () => NOW, lockPath: lp });
    assert.equal(first.status, 'OK');
    assert.deepEqual(adapter.calls.map((c) => `${c.periodStart}..${c.periodEnd}`).sort(), ['2026-09-02..2026-09-02', '2026-09-02..2026-09-08']);
    assert.ok(adapter.calls.every((c) => c.videoIds.length === 2));
    assert.equal(storage.all('SELECT * FROM analytics_snapshots').length, 4);
    const snapsAfter = JSON.stringify(storage.all('SELECT * FROM analytics_snapshots ORDER BY id'));
    const second = await runWindowCollection({ storage, adapter, now: () => NOW, lockPath: lp });
    assert.equal(second.status, 'OK');
    assert.equal(second.groups.length, 0);
    assert.equal(adapter.calls.length, 2);
    assert.equal(JSON.stringify(storage.all('SELECT * FROM analytics_snapshots ORDER BY id')), snapsAfter);
    assert.equal(fs.existsSync(lp), false); // lock released
  } finally { cleanup(); fs.rmSync(lp, { force: true }); }
});

test('plan-only (execute:false) calls no adapter and writes nothing', async () => {
  const { storage, cleanup } = await openStorage();
  const lp = lockFile();
  try {
    storage.run('PRAGMA foreign_keys = OFF');
    seed(storage, 1);
    const r = await runWindowCollection({ storage, adapter: null, execute: false, now: () => NOW, lockPath: lp });
    assert.equal(r.status, 'PLANNED');
    assert.equal(r.plan.due.length, 2);
    assert.equal(storage.all('SELECT * FROM analytics_snapshots').length, 0);
  } finally { cleanup(); fs.rmSync(lp, { force: true }); }
});

test('collector failures: failed rows are recorded, never zeros, and retried only after cooldown; SUCCESS never overwritten', async () => {
  const { storage, cleanup } = await openStorage();
  const lp = lockFile();
  try {
    storage.run('PRAGMA foreign_keys = OFF');
    seed(storage, 1);
    const failing = fakeAdapter(() => ({ status: 'TRANSIENT_FAILURE', errorClass: 'http_503' }));
    const r1 = await runWindowCollection({ storage, adapter: failing, now: () => NOW, lockPath: lp });
    assert.equal(r1.status, 'FAILED');
    const rows = storage.all('SELECT * FROM analytics_snapshots');
    assert.equal(rows.length, 2);
    assert.ok(rows.every((x) => x.status === 'TRANSIENT_FAILURE' && x.views === null && x.impressions_ctr === null));

    const within = await runWindowCollection({ storage, adapter: failing, now: () => '2026-10-01T05:00:00.000Z', lockPath: lp });
    assert.equal(within.groups.length, 0);
    assert.equal(failing.calls.length, 2);

    const healthy = fakeAdapter(okReport);
    const r2 = await runWindowCollection({ storage, adapter: healthy, now: () => '2026-10-01T06:00:00.000Z', lockPath: lp });
    assert.equal(r2.status, 'OK');
    assert.ok(storage.all('SELECT * FROM analytics_snapshots').every((x) => x.status === 'SUCCESS'));
    const done = JSON.stringify(storage.all('SELECT * FROM analytics_snapshots ORDER BY id'));
    await runWindowCollection({ storage, adapter: failing, now: () => '2026-10-02T00:00:00.000Z', lockPath: lp });
    assert.equal(JSON.stringify(storage.all('SELECT * FROM analytics_snapshots ORDER BY id')), done);
  } finally { cleanup(); fs.rmSync(lp, { force: true }); }
});

test('auth failure aborts remaining groups; adapter/collector throw is reported and releases the lock', async () => {
  const { storage, cleanup } = await openStorage();
  const lp = lockFile();
  try {
    storage.run('PRAGMA foreign_keys = OFF');
    seed(storage, 1);
    const auth = fakeAdapter(() => ({ status: 'AUTH_FAILURE', errorClass: 'invalid_grant' }));
    const r = await runWindowCollection({ storage, adapter: auth, now: () => NOW, lockPath: lp });
    assert.equal(r.status, 'FAILED');
    assert.equal(auth.calls.length, 1); // second period never attempted
    const boom = await runWindowCollection({ storage, adapter: fakeAdapter(okReport), now: () => '2026-11-01T00:00:00.000Z', lockPath: lp, collect: async () => { throw new Error('db exploded'); } });
    assert.equal(boom.status, 'FAILED');
    assert.match(boom.groups[0].error, /db exploded/);
    assert.equal(fs.existsSync(lp), false);
  } finally { cleanup(); fs.rmSync(lp, { force: true }); }
});

test('overlap: a held lock stops the run; a stale lock is taken over', async () => {
  const { storage, cleanup } = await openStorage();
  const lp = lockFile();
  try {
    storage.run('PRAGMA foreign_keys = OFF');
    seed(storage, 1);
    const release = acquireLock(lp);
    const adapter = fakeAdapter(okReport);
    const blocked = await runWindowCollection({ storage, adapter, now: () => NOW, lockPath: lp });
    assert.equal(blocked.status, 'LOCKED');
    assert.equal(adapter.calls.length, 0);
    release();
    fs.writeFileSync(lp, '{}');
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    fs.utimesSync(lp, old, old);
    assert.equal((await runWindowCollection({ storage, adapter, now: () => NOW, lockPath: lp })).status, 'OK');
  } finally { cleanup(); fs.rmSync(lp, { force: true }); }
});

test('isolation: only targeted publications are collected; publications and unrelated snapshots untouched; simulated runs never called', async () => {
  const { storage, cleanup } = await openStorage();
  try {
    storage.run('PRAGMA foreign_keys = OFF');
    seed(storage, 1); seed(storage, 2, { mode: 'SIMULATION' });
    const pubsBefore = JSON.stringify(storage.all('SELECT * FROM publications ORDER BY id'));
    const adapter = fakeAdapter(okReport);
    const s = await collectAnalytics({ storage, adapter, periodStart: W24.start, periodEnd: W24.end, publicationIds: ['pub1'] });
    assert.deepEqual(adapter.calls[0].videoIds, ['vid1']);
    assert.equal(s.eligible, 1);
    assert.equal((await collectAnalytics({ storage, adapter, periodStart: W24.start, periodEnd: W24.end, publicationIds: [] })).eligible, 0);
    const lp = lockFile();
    const a2 = fakeAdapter(okReport);
    await runWindowCollection({ storage, adapter: a2, now: () => NOW, lockPath: lp });
    assert.ok(a2.calls.every((c) => !c.videoIds.includes('vid2')));
    assert.equal(JSON.stringify(storage.all('SELECT * FROM publications ORDER BY id')), pubsBefore);
    assert.equal(storage.all(`SELECT * FROM analytics_snapshots WHERE publication_id = 'pub2'`).length, 0);
    fs.rmSync(lp, { force: true });
  } finally { cleanup(); }
});
