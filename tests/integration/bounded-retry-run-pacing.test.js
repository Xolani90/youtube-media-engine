import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { SqliteStorageDriver } from '../../src/storage/SqliteStorageDriver.js';
import { runAutonomousOperation } from '../../src/autonomous/runner.js';
import { runProduction } from '../../src/production/pipeline.js';
import { passGate2 } from '../helpers/gate2.js';
import { runPublication } from '../../src/publication/pipeline.js';
import { PublicationProvider } from '../../src/publication/PublicationProvider.js';
import { PUBLICATION_RESULT_STATUS, publicationActionId } from '../../src/publication/constants.js';
import { isQuarantined } from '../../src/state/StageRetryPolicy.js';
import { config } from '../../src/config/index.js';

// ADR-0023: one automatic retry attempt per stage per item per
// runAutonomousOperation() invocation. These tests use the REAL runner,
// selectors, runProduction/runPublication and durable retry policy. Only
// unrelated stages are stubbed (via the runner's test-only stageFns hook) to
// create background work whose eligibility changes every sweep -- the exact
// condition under which the un-paced runner used to re-attempt the item.

const nowISO = () => new Date().toISOString();

async function openStorage() {
  const dbPath = path.join(os.tmpdir(), `run-pacing-${Date.now()}-${Math.random()}.db`);
  const storage = new SqliteStorageDriver({ dbPath });
  await storage.migrate();
  return { storage, dbPath };
}
function cleanup(storage, dbPath, ...paths) {
  storage.close();
  for (const p of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`, ...paths]) fs.rmSync(p, { recursive: true, force: true });
}

function seed(storage, { state, mediaFilePath = null }) {
  const opportunityId = crypto.randomUUID();
  storage.run(`INSERT INTO opportunities (id, title, source, discovered_at, status) VALUES (?, 'T', 'rss', ?, 'DISCOVERED')`, [opportunityId, nowISO()]);
  const contentBriefId = crypto.randomUUID();
  storage.run(
    `INSERT INTO content_briefs
      (id, opportunity_id, working_title, core_question, target_audience, viewer_promise,
       hook, angle, narrative_structure, key_claims, counterpoints, original_insights, visual_ideas,
       monetization_opportunities, risk_assessment, created_at)
     VALUES (?, ?, 'T', 'Q', 'A', 'P', 'H', 'Angle', 'Structure', '[]', 'C', 'I', 'V', 'M', 'R', ?)`,
    [contentBriefId, opportunityId, nowISO()]
  );
  const scriptId = crypto.randomUUID();
  storage.run(`INSERT INTO scripts (id, content_brief_id, version, body, claim_links, created_at) VALUES (?, ?, 1, 'Body text.', '[]', ?)`, [scriptId, contentBriefId, nowISO()]);
  const contentVersionId = crypto.randomUUID();
  storage.run(`INSERT INTO content_versions (id, content_brief_id, script_id, state, created_at) VALUES (?, ?, ?, ?, ?)`, [contentVersionId, contentBriefId, scriptId, state, nowISO()]);
  if (mediaFilePath) {
    const productionId = crypto.randomUUID();
    storage.run(
      `INSERT INTO productions (id, content_version_id, script_id, artifact_type, artifact_path, artifact_checksum, manifest_json, created_at)
       VALUES (?, ?, ?, 'production_manifest_v1', '/tmp/x', 'deadbeef', '{}', ?)`,
      [productionId, contentVersionId, scriptId, nowISO()]
    );
    storage.run(
      `INSERT INTO media_artifacts
        (id, production_id, content_version_id, render_spec_json, render_spec_checksum,
         narration_path, narration_duration_seconds, artifact_path, artifact_checksum,
         duration_seconds, width, height, video_codec, audio_codec, created_at)
       VALUES (?, ?, ?, '{}', 'chk', '/tmp/n.wav', 5.0, ?, 'chk2', 5.0, 1280, 720, 'h264', 'aac', ?)`,
      [crypto.randomUUID(), productionId, contentVersionId, mediaFilePath, nowISO()]
    );
    // ADR-0032: a rendered PRODUCED item only becomes publishable by passing
    // Gate 2 (real final-compliance stage: PRODUCED -> FINAL_COMPLIANCE).
    if (state === 'PRODUCED' && fs.existsSync(mediaFilePath)) passGate2(storage, contentVersionId);
  }
  return { contentBriefId, contentVersionId };
}

/**
 * Background work whose eligible set changes EVERY sweep: `count` fillers sit
 * at PRODUCED; filler #j leaves (-> PUBLISHED) on its (j+1)th asset-provisioning
 * call, i.e. exactly one filler leaves per sweep. `exclude` protects the item
 * under test from the stub. Rights-verification/media-production are no-ops.
 */
function backgroundWork(storage, count, exclude = []) {
  const fillers = Array.from({ length: count }, () => seed(storage, { state: 'PRODUCED' }));
  const index = new Map(fillers.map((f, i) => [f.contentBriefId, i]));
  const calls = new Map();
  const counter = { assetCalls: 0 };
  const stageFns = {
    'asset-provisioning': (a) => {
      if (exclude.includes(a.contentBriefId)) return {};
      counter.assetCalls += 1;
      const n = (calls.get(a.contentBriefId) ?? 0) + 1;
      calls.set(a.contentBriefId, n);
      if (n >= index.get(a.contentBriefId) + 1) {
        storage.run(`UPDATE content_versions SET state = 'PUBLISHED' WHERE content_brief_id = ?`, [a.contentBriefId]);
      }
      return {};
    },
    'rights-verification': () => ({}),
    'media-production': () => ({})
  };
  const allPublished = () => fillers.every((f) => storage.get('SELECT state FROM content_versions WHERE id = ?', [f.contentVersionId]).state === 'PUBLISHED');
  return { fillers, stageFns, counter, allPublished };
}

const retryRow = (storage, cv, stage) => storage.get('SELECT * FROM stage_retry_state WHERE subject_id = ? AND stage = ?', [cv, stage]);

// ---------------------------------------------------------------- Production

function brokenDir() {
  const p = path.join(os.tmpdir(), `broken-artifacts-${Math.random()}`);
  fs.writeFileSync(p, 'a file, not a directory');
  return p;
}

function productionRun(storage, dir, bg, calls, extraFns = {}) {
  return runAutonomousOperation({
    storage, mode: 'SIMULATION', production: { artifactsDir: dir },
    stageFns: {
      ...bg.stageFns,
      production: (a) => { calls.push(a.contentBriefId); return runProduction(a); },
      ...extraFns
    }
  });
}

test('Production: one attempt per invocation despite many sweeps; attempts 2 and 3 on later invocations; quarantine; no 4th', async () => {
  const { storage, dbPath } = await openStorage();
  const bad = brokenDir();
  const x = seed(storage, { state: 'PRODUCTION_READY' });

  // Run N
  let calls = [];
  let bg = backgroundWork(storage, 5);
  const r1 = await productionRun(storage, bad, bg, calls);
  assert.equal(calls.length, 1, 'exactly one Production attempt for the item in the whole invocation');
  assert.ok(r1.sweeps >= 6, `background work must have forced several sweeps (got ${r1.sweeps})`);
  assert.equal(retryRow(storage, x.contentVersionId, 'PRODUCTION').attempt_count, 1);
  assert.equal(r1.stopReason, 'no_progress', 'stop semantics unchanged (item stays in the unfiltered signature)');
  assert.ok(bg.allPublished(), 'unrelated work continued to completion');
  assert.equal(bg.counter.assetCalls, 15, 'unrelated stage ran on every sweep as before');

  // Run N+1
  calls = []; bg = backgroundWork(storage, 5);
  await productionRun(storage, bad, bg, calls);
  assert.equal(calls.length, 1);
  assert.equal(retryRow(storage, x.contentVersionId, 'PRODUCTION').attempt_count, 2);
  assert.equal(isQuarantined(storage, x.contentVersionId, 'PRODUCTION'), false);

  // Run N+2: third failure quarantines
  calls = []; bg = backgroundWork(storage, 5);
  await productionRun(storage, bad, bg, calls);
  assert.equal(calls.length, 1);
  assert.equal(retryRow(storage, x.contentVersionId, 'PRODUCTION').attempt_count, 3);
  assert.ok(isQuarantined(storage, x.contentVersionId, 'PRODUCTION'));

  // Run N+3: not selected, no 4th attempt
  calls = []; bg = backgroundWork(storage, 5);
  await productionRun(storage, bad, bg, calls);
  assert.equal(calls.length, 0);
  assert.equal(retryRow(storage, x.contentVersionId, 'PRODUCTION').attempt_count, 3);
  assert.equal(storage.get('SELECT state FROM content_versions WHERE id = ?', [x.contentVersionId]).state, 'PRODUCTION_READY');
  cleanup(storage, dbPath, bad);
});

test('Production: an isolated failing item behaves exactly as before (2 sweeps, no_progress, 1 attempt)', async () => {
  const { storage, dbPath } = await openStorage();
  const bad = brokenDir();
  const x = seed(storage, { state: 'PRODUCTION_READY' });
  const calls = [];
  const r = await runAutonomousOperation({ storage, mode: 'SIMULATION', production: { artifactsDir: bad },
    stageFns: { production: (a) => { calls.push(a.contentBriefId); return runProduction(a); } } });
  assert.equal(r.sweeps, 2);
  assert.equal(r.stopReason, 'no_progress');
  assert.equal(calls.length, 1);
  assert.equal(retryRow(storage, x.contentVersionId, 'PRODUCTION').attempt_count, 1);
  cleanup(storage, dbPath, bad);
});

test('Production: an independent failing item still receives its own first attempt; a succeeding item is unaffected', async () => {
  const { storage, dbPath } = await openStorage();
  const bad = brokenDir();
  const good = fs.mkdtempSync(path.join(os.tmpdir(), 'good-artifacts-'));
  const x = seed(storage, { state: 'PRODUCTION_READY' });
  const z = seed(storage, { state: 'PRODUCTION_READY' });
  const ok = seed(storage, { state: 'PRODUCTION_READY' });
  const bg = backgroundWork(storage, 5);
  const calls = [];
  await runAutonomousOperation({
    storage, mode: 'SIMULATION',
    stageFns: {
      ...bg.stageFns,
      production: (a) => {
        calls.push(a.contentBriefId);
        return runProduction({ ...a, artifactsDir: a.contentBriefId === ok.contentBriefId ? good : bad });
      }
    }
  });
  const count = (b) => calls.filter((c) => c === b).length;
  assert.equal(count(x.contentBriefId), 1);
  assert.equal(count(z.contentBriefId), 1);
  assert.equal(count(ok.contentBriefId), 1, 'succeeded once and left eligibility');
  assert.equal(retryRow(storage, x.contentVersionId, 'PRODUCTION').attempt_count, 1);
  assert.equal(retryRow(storage, z.contentVersionId, 'PRODUCTION').attempt_count, 1);
  assert.equal(retryRow(storage, ok.contentVersionId, 'PRODUCTION'), undefined);
  assert.equal(storage.get('SELECT state FROM content_versions WHERE id = ?', [ok.contentVersionId]).state, 'PRODUCED');
  cleanup(storage, dbPath, bad, good);
});

// --------------------------------------------------------------- Publication

class MockAdapter extends PublicationProvider {
  constructor(result) { super(); this.result = result; this.calls = 0; }
  get id() { return 'mock'; }
  async publish() { this.calls += 1; return this.result; }
}
const FAIL = { status: PUBLICATION_RESULT_STATUS.EXPLICIT_FAILURE, provider: 'mock', errorClass: 'REJECTED_UPLOAD' };
const AMBIG = { status: PUBLICATION_RESULT_STATUS.AMBIGUOUS, provider: 'mock', reconciliationInfo: {} };

async function withConfig({ live, authorize }, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pace-auth-'));
  const file = path.join(dir, 'authorized.json');
  fs.writeFileSync(file, JSON.stringify(authorize));
  const saved = [config.authorizedExternalActionsPath, config.runMode, config.autonomousEnabled];
  config.authorizedExternalActionsPath = file;
  config.runMode = live ? 'LIVE' : 'SIMULATION';
  config.autonomousEnabled = live;
  try { return await fn(); } finally {
    [config.authorizedExternalActionsPath, config.runMode, config.autonomousEnabled] = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function publicationRun(storage, mode, adapter, bg, calls) {
  return runAutonomousOperation({
    storage, mode, publication: { provider: 'mock', adapter },
    stageFns: {
      ...bg.stageFns,
      publication: (a) => { calls.push(a.contentBriefId); return runPublication(a); }
    }
  });
}

function seedPublishable(storage) {
  const media = path.join(os.tmpdir(), `media-${Math.random()}.mp4`);
  fs.writeFileSync(media, 'x');
  return { ...seed(storage, { state: 'PRODUCED', mediaFilePath: media }), media };
}

test('Publication: one provider failure per invocation despite many sweeps; attempts 2 and 3 on later invocations; quarantine; no 4th', async () => {
  const { storage, dbPath } = await openStorage();
  const x = seedPublishable(storage);
  const adapter = new MockAdapter(FAIL);
  await withConfig({ live: true, authorize: [publicationActionId('mock', x.contentVersionId)] }, async () => {
    let calls = []; let bg = backgroundWork(storage, 5, [x.contentBriefId]);
    const r1 = await publicationRun(storage, 'LIVE', adapter, bg, calls);
    assert.equal(calls.length, 1, 'one Publication attempt in the whole invocation');
    assert.equal(adapter.calls, 1);
    assert.ok(r1.sweeps >= 6);
    assert.equal(storage.get('SELECT attempt_count, status FROM publications WHERE content_version_id = ?', [x.contentVersionId]).attempt_count, 1);
    assert.equal(retryRow(storage, x.contentVersionId, 'PUBLICATION').attempt_count, 1);
    assert.ok(bg.allPublished());

    calls = []; bg = backgroundWork(storage, 5, [x.contentBriefId]);
    await publicationRun(storage, 'LIVE', adapter, bg, calls);
    assert.equal(adapter.calls, 2);
    assert.equal(retryRow(storage, x.contentVersionId, 'PUBLICATION').attempt_count, 2);
    assert.equal(isQuarantined(storage, x.contentVersionId, 'PUBLICATION'), false);

    calls = []; bg = backgroundWork(storage, 5, [x.contentBriefId]);
    await publicationRun(storage, 'LIVE', adapter, bg, calls);
    assert.equal(adapter.calls, 3);
    assert.equal(retryRow(storage, x.contentVersionId, 'PUBLICATION').attempt_count, 3);
    assert.ok(isQuarantined(storage, x.contentVersionId, 'PUBLICATION'));
    assert.equal(storage.get('SELECT status FROM publications WHERE content_version_id = ?', [x.contentVersionId]).status, 'FAILED');

    calls = []; bg = backgroundWork(storage, 5, [x.contentBriefId]);
    await publicationRun(storage, 'LIVE', adapter, bg, calls);
    assert.equal(calls.length, 0, 'quarantined item is not selected');
    assert.equal(adapter.calls, 3, 'no fourth attempt');
  });
  cleanup(storage, dbPath, x.media);
});

test('Publication: AMBIGUOUS is outside retry pacing and the counter (still evaluated each sweep, provider called once)', async () => {
  const { storage, dbPath } = await openStorage();
  const x = seedPublishable(storage);
  const adapter = new MockAdapter(AMBIG);
  await withConfig({ live: true, authorize: [publicationActionId('mock', x.contentVersionId)] }, async () => {
    const calls = []; const bg = backgroundWork(storage, 5, [x.contentBriefId]);
    await publicationRun(storage, 'LIVE', adapter, bg, calls);
    assert.equal(adapter.calls, 1, 'AMBIGUOUS never auto-retried');
    assert.ok(calls.length > 1, 'AMBIGUOUS did not consume the run-local slot (behavior unchanged)');
    assert.equal(retryRow(storage, x.contentVersionId, 'PUBLICATION'), undefined);
  });
  cleanup(storage, dbPath, x.media);
});

test('Publication: D-C2 denial (LIVE, unauthorized) is outside retry pacing and the counter', async () => {
  const { storage, dbPath } = await openStorage();
  const x = seedPublishable(storage);
  const adapter = new MockAdapter(FAIL);
  await withConfig({ live: true, authorize: [] }, async () => {
    const calls = []; const bg = backgroundWork(storage, 5, [x.contentBriefId]);
    await publicationRun(storage, 'LIVE', adapter, bg, calls);
    assert.equal(adapter.calls, 0);
    assert.ok(calls.length > 1, 'denial re-evaluated every sweep, as before');
    assert.equal(retryRow(storage, x.contentVersionId, 'PUBLICATION'), undefined);
    assert.ok(storage.get(`SELECT id FROM decision_log WHERE decision = 'AUTHORIZATION_DENIED' AND subject_id = ?`, [x.contentVersionId]));
  });
  cleanup(storage, dbPath, x.media);
});

test('Publication: SIMULATION veto is outside retry pacing and the counter (even if process config is LIVE and authorized)', async () => {
  const { storage, dbPath } = await openStorage();
  const x = seedPublishable(storage);
  const adapter = new MockAdapter(FAIL);
  await withConfig({ live: true, authorize: [publicationActionId('mock', x.contentVersionId)] }, async () => {
    const calls = []; const bg = backgroundWork(storage, 5, [x.contentBriefId]);
    await publicationRun(storage, 'SIMULATION', adapter, bg, calls);
    assert.equal(adapter.calls, 0);
    assert.ok(calls.length > 1);
    assert.equal(retryRow(storage, x.contentVersionId, 'PUBLICATION'), undefined);
  });
  cleanup(storage, dbPath, x.media);
});

test('run-local pacing set is invocation-scoped: not exported, not persisted, no new tables', () => {
  const src = fs.readFileSync('src/autonomous/runner.js', 'utf8');
  assert.match(src, /const retryConsumed = new Set\(\);/);
  assert.equal(/export .*retryConsumed/.test(src), false);
  const migrations = fs.readdirSync('src/db/migrations').filter((f) => f.endsWith('.sql')).sort();
  // The point of this assertion is that run-local pacing added NO migration of
  // its own -- the newest stage-retry migration is still the A4 Slice 1
  // generalization (0017). It is asserted that way now, rather than as "whatever
  // sorts last", which broke silently when ADR-0032 added 0018/0019.
  const retryMigrations = migrations.filter((f) => /stage_retry|retry_quarantine/.test(f));
  assert.equal(retryMigrations.at(-1), '0017_generalize_stage_retry_identity.sql', 'no stage-retry/pacing migration beyond 0017 was added');
  // The current latest migration overall is pinned by name and deliberately
  // acknowledged (ADR-0032 Gate 2 added 0018 and 0019).
  assert.equal(migrations.at(-1), '0020_discovery_evaluations.sql', 'current latest migration (update this deliberately when one is added)');
});
