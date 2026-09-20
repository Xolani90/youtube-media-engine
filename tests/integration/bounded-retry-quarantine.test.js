import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { SqliteStorageDriver } from '../../src/storage/SqliteStorageDriver.js';
import { runProduction } from '../../src/production/pipeline.js';
import { runPublication } from '../../src/publication/pipeline.js';
import { PublicationProvider } from '../../src/publication/PublicationProvider.js';
import { PUBLICATION_RESULT_STATUS, publicationActionId } from '../../src/publication/constants.js';
import { selectEligibleProductions, selectEligiblePublications } from '../../src/autonomous/workSelection.js';
import {
  STAGE_RETRY_CAP, RETRY_STAGE, isQuarantined, reactivateQuarantined, QuarantineReactivationError
} from '../../src/state/StageRetryPolicy.js';
import { config } from '../../src/config/index.js';

const nowISO = () => new Date().toISOString();

function freshDbPath() {
  return path.join(os.tmpdir(), `bounded-retry-${Date.now()}-${Math.random()}.db`);
}
async function openStorage(dbPath) {
  const storage = new SqliteStorageDriver({ dbPath });
  await storage.migrate();
  return storage;
}
function cleanup(storage, dbPath, ...paths) {
  storage.close();
  for (const p of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`, ...paths]) fs.rmSync(p, { recursive: true, force: true });
}

function seedContent(storage, { state, mediaFilePath = null } = {}) {
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
  }
  return { contentBriefId, contentVersionId };
}

const OWNER = { actor: 'OWNER', reason: 'root cause fixed: disk permissions repaired' };
const retryRow = (storage, cv, stage) => storage.get('SELECT * FROM stage_retry_state WHERE content_version_id = ? AND stage = ?', [cv, stage]);
const decisions = (storage, cv, decision) => storage.all('SELECT * FROM decision_log WHERE subject_id = ? AND decision = ?', [cv, decision]);

// ---------------------------------------------------------------- Production

function brokenArtifactsDir() {
  // A regular FILE used as the artifacts directory -> the write always fails.
  const p = path.join(os.tmpdir(), `broken-artifacts-${Math.random()}`);
  fs.writeFileSync(p, 'not a directory');
  return p;
}

test('Production: attempts 1-3 recorded, 3rd quarantines, 4th selection/invocation refused, count survives new process', async () => {
  const dbPath = freshDbPath();
  let storage = await openStorage(dbPath);
  const bad = brokenArtifactsDir();
  const { contentBriefId, contentVersionId } = seedContent(storage, { state: 'PRODUCTION_READY' });

  const r1 = runProduction({ storage, contentBriefId, artifactsDir: bad });
  assert.equal(r1.outcome, 'ARTIFACT_WRITE_FAILED');
  assert.equal(r1.attempt, 1);
  assert.equal(retryRow(storage, contentVersionId, 'PRODUCTION').attempt_count, 1);
  assert.equal(selectEligibleProductions(storage).length, 1);

  // Simulate a new process: reopen the same DB file.
  storage.close();
  storage = await openStorage(dbPath);
  assert.equal(retryRow(storage, contentVersionId, 'PRODUCTION').attempt_count, 1, 'count survives new process');

  const r2 = runProduction({ storage, contentBriefId, artifactsDir: bad });
  assert.equal(r2.attempt, 2);
  assert.equal(r2.quarantined, false);
  assert.equal(isQuarantined(storage, contentVersionId, 'PRODUCTION'), false);

  const r3 = runProduction({ storage, contentBriefId, artifactsDir: bad });
  assert.equal(r3.outcome, 'ARTIFACT_WRITE_FAILED');
  assert.equal(r3.attempt, STAGE_RETRY_CAP);
  assert.equal(r3.quarantined, true);
  assert.ok(isQuarantined(storage, contentVersionId, 'PRODUCTION'));
  assert.equal(decisions(storage, contentVersionId, 'QUARANTINED').length, 1);

  // Frozen content-version state untouched; distinct from BLOCKED/REJECTED/NEEDS_REVIEW.
  assert.equal(storage.get('SELECT state FROM content_versions WHERE id = ?', [contentVersionId]).state, 'PRODUCTION_READY');

  // Not selected; direct invocation independently refused; counter does not grow.
  assert.equal(selectEligibleProductions(storage).length, 0);
  const r4 = runProduction({ storage, contentBriefId, artifactsDir: bad });
  assert.equal(r4.outcome, 'QUARANTINED');
  assert.equal(retryRow(storage, contentVersionId, 'PRODUCTION').attempt_count, 3);

  cleanup(storage, dbPath, bad);
});

test('Production: success before exhaustion does not quarantine', async () => {
  const dbPath = freshDbPath();
  const storage = await openStorage(dbPath);
  const bad = brokenArtifactsDir();
  const good = fs.mkdtempSync(path.join(os.tmpdir(), 'good-artifacts-'));
  const { contentBriefId, contentVersionId } = seedContent(storage, { state: 'PRODUCTION_READY' });
  runProduction({ storage, contentBriefId, artifactsDir: bad });
  runProduction({ storage, contentBriefId, artifactsDir: bad });
  const ok = runProduction({ storage, contentBriefId, artifactsDir: good });
  assert.equal(ok.outcome, 'PRODUCED');
  assert.equal(isQuarantined(storage, contentVersionId, 'PRODUCTION'), false);
  cleanup(storage, dbPath, bad, good);
});

test('Production: Owner reactivation preserves history, starts cycle 2, item eligible again via normal gates', async () => {
  const dbPath = freshDbPath();
  const storage = await openStorage(dbPath);
  const bad = brokenArtifactsDir();
  const good = fs.mkdtempSync(path.join(os.tmpdir(), 'good-artifacts-'));
  const { contentBriefId, contentVersionId } = seedContent(storage, { state: 'PRODUCTION_READY' });
  for (let i = 0; i < 3; i++) runProduction({ storage, contentBriefId, artifactsDir: bad });
  const quarantinedAt = retryRow(storage, contentVersionId, 'PRODUCTION').quarantined_at;

  // Explicit Owner context is mandatory.
  assert.throws(() => reactivateQuarantined(storage, { contentVersionId, stage: RETRY_STAGE.PRODUCTION }), QuarantineReactivationError);
  assert.throws(() => reactivateQuarantined(storage, { contentVersionId, stage: RETRY_STAGE.PRODUCTION, ownerAction: { actor: 'SYSTEM', reason: 'x' } }), QuarantineReactivationError);
  assert.throws(() => reactivateQuarantined(storage, { contentVersionId, stage: RETRY_STAGE.PRODUCTION, ownerAction: { actor: 'OWNER', reason: '  ' } }), QuarantineReactivationError);
  assert.ok(isQuarantined(storage, contentVersionId, 'PRODUCTION'));

  const res = reactivateQuarantined(storage, { contentVersionId, stage: RETRY_STAGE.PRODUCTION, ownerAction: OWNER });
  assert.equal(res.cycle, 2);
  assert.equal(res.previousAttempts, 3);

  // Auditable: decision_log + preserved history.
  const log = decisions(storage, contentVersionId, 'QUARANTINE_REACTIVATED');
  assert.equal(log.length, 1);
  assert.match(log[0].reason, /disk permissions repaired/);
  const hist = storage.all('SELECT * FROM stage_retry_cycle_history WHERE content_version_id = ?', [contentVersionId]);
  assert.equal(hist.length, 1);
  assert.equal(hist[0].attempts_in_cycle, 3);
  assert.equal(hist[0].quarantined_at, quarantinedAt);
  assert.equal(hist[0].owner_reason, OWNER.reason);
  assert.ok(hist[0].reactivated_at);

  // No state change; nothing produced automatically; eligible again.
  assert.equal(storage.get('SELECT state FROM content_versions WHERE id = ?', [contentVersionId]).state, 'PRODUCTION_READY');
  assert.equal(storage.get('SELECT COUNT(*) AS n FROM productions').n, 0);
  assert.equal(selectEligibleProductions(storage).length, 1);

  // New cycle: fresh 3-attempt allowance, and it can quarantine again.
  assert.equal(runProduction({ storage, contentBriefId, artifactsDir: bad }).attempt, 1);
  assert.equal(retryRow(storage, contentVersionId, 'PRODUCTION').cycle_number, 2);

  // Reactivating a non-quarantined item is refused.
  assert.throws(() => reactivateQuarantined(storage, { contentVersionId, stage: RETRY_STAGE.PRODUCTION, ownerAction: OWNER }), QuarantineReactivationError);

  // Production re-runs through its normal gates after reactivation.
  const ok = runProduction({ storage, contentBriefId, artifactsDir: good });
  assert.equal(ok.outcome, 'PRODUCED');
  cleanup(storage, dbPath, bad, good);
});

test('Production: persistence failure propagates (never silently unbounded)', async () => {
  const dbPath = freshDbPath();
  const storage = await openStorage(dbPath);
  const bad = brokenArtifactsDir();
  const { contentBriefId, contentVersionId } = seedContent(storage, { state: 'PRODUCTION_READY' });
  storage.run('DROP TABLE stage_retry_state');
  assert.throws(() => runProduction({ storage, contentBriefId, artifactsDir: bad }));
  // The decision_log row rolled back with the failed transaction: nothing claimed as recorded.
  assert.equal(decisions(storage, contentVersionId, 'ARTIFACT_WRITE_FAILED').length, 0);
  cleanup(storage, dbPath, bad);
});

// --------------------------------------------------------------- Publication

class MockAdapter extends PublicationProvider {
  constructor(result) { super(); this.result = result; this.calls = 0; }
  get id() { return 'mock'; }
  async publish() { this.calls += 1; return this.result; }
}
const FAIL = { status: PUBLICATION_RESULT_STATUS.EXPLICIT_FAILURE, provider: 'mock', errorClass: 'REJECTED_UPLOAD' };

async function withLive(cvId, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'br-auth-'));
  const filePath = path.join(dir, 'authorized.json');
  fs.writeFileSync(filePath, JSON.stringify([publicationActionId('mock', cvId)]));
  const saved = [config.authorizedExternalActionsPath, config.runMode, config.autonomousEnabled];
  config.authorizedExternalActionsPath = filePath; config.runMode = 'LIVE'; config.autonomousEnabled = true;
  try { return await fn(); } finally {
    [config.authorizedExternalActionsPath, config.runMode, config.autonomousEnabled] = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('Publication: FAILED attempts 1-3 recorded, 3rd quarantines (status stays FAILED), 4th refused, AMBIGUOUS not counted', async () => {
  const dbPath = freshDbPath();
  let storage = await openStorage(dbPath);
  const media = path.join(os.tmpdir(), `media-${Math.random()}.mp4`);
  fs.writeFileSync(media, 'x');
  const { contentBriefId, contentVersionId } = seedContent(storage, { state: 'PRODUCED', mediaFilePath: media });
  const adapter = new MockAdapter(FAIL);
  const run = () => runPublication({ storage, contentBriefId, provider: 'mock', adapter });

  await withLive(contentVersionId, async () => {
    const r1 = await run();
    assert.equal(r1.outcome, 'PROVIDER_FAILURE');
    assert.equal(r1.attempt, 1);
    assert.equal(r1.publication.status, 'FAILED');
    assert.equal(selectEligiblePublications(storage).length, 1);

    storage.close();
    storage = await openStorage(dbPath); // new process
    assert.equal(retryRow(storage, contentVersionId, 'PUBLICATION').attempt_count, 1);

    const r2 = await run();
    assert.equal(r2.attempt, 2);
    assert.equal(r2.quarantined, false);
    const r3 = await run();
    assert.equal(r3.attempt, 3);
    assert.equal(r3.quarantined, true);
    // FAILED itself is not reinterpreted; quarantine is the separate record.
    assert.equal(storage.get('SELECT status FROM publications WHERE content_version_id = ?', [contentVersionId]).status, 'FAILED');
    assert.ok(isQuarantined(storage, contentVersionId, 'PUBLICATION'));
    assert.equal(storage.get('SELECT state FROM content_versions WHERE id = ?', [contentVersionId]).state, 'PRODUCED');

    const callsBefore = adapter.calls;
    assert.equal(selectEligiblePublications(storage).length, 0);
    const r4 = await run();
    assert.equal(r4.outcome, 'QUARANTINED');
    assert.equal(adapter.calls, callsBefore, 'provider never called after quarantine');
    assert.equal(retryRow(storage, contentVersionId, 'PUBLICATION').attempt_count, 3);
  });
  cleanup(storage, dbPath, media);
});

test('Publication: AMBIGUOUS stays non-retryable and does not increment the governance counter', async () => {
  const dbPath = freshDbPath();
  const storage = await openStorage(dbPath);
  const media = path.join(os.tmpdir(), `media-${Math.random()}.mp4`);
  fs.writeFileSync(media, 'x');
  const { contentBriefId, contentVersionId } = seedContent(storage, { state: 'PRODUCED', mediaFilePath: media });
  const amb = new MockAdapter({ status: PUBLICATION_RESULT_STATUS.AMBIGUOUS, provider: 'mock', reconciliationInfo: {} });
  await withLive(contentVersionId, async () => {
    const r1 = await runPublication({ storage, contentBriefId, provider: 'mock', adapter: amb });
    assert.equal(r1.outcome, 'AMBIGUOUS');
    const r2 = await runPublication({ storage, contentBriefId, provider: 'mock', adapter: amb });
    assert.equal(r2.outcome, 'AMBIGUOUS');
    assert.equal(amb.calls, 1, 'AMBIGUOUS never auto-retried');
    assert.equal(retryRow(storage, contentVersionId, 'PUBLICATION'), undefined, 'no governance counter row created');
  });
  cleanup(storage, dbPath, media);
});

test('Publication: success before exhaustion does not quarantine; idempotency intact', async () => {
  const dbPath = freshDbPath();
  const storage = await openStorage(dbPath);
  const media = path.join(os.tmpdir(), `media-${Math.random()}.mp4`);
  fs.writeFileSync(media, 'x');
  const { contentBriefId, contentVersionId } = seedContent(storage, { state: 'PRODUCED', mediaFilePath: media });
  await withLive(contentVersionId, async () => {
    await runPublication({ storage, contentBriefId, provider: 'mock', adapter: new MockAdapter(FAIL) });
    await runPublication({ storage, contentBriefId, provider: 'mock', adapter: new MockAdapter(FAIL) });
    const okAdapter = new MockAdapter({ status: PUBLICATION_RESULT_STATUS.SUCCESS, provider: 'mock', providerItemId: 'V1', providerUrl: 'u' });
    const ok = await runPublication({ storage, contentBriefId, provider: 'mock', adapter: okAdapter });
    assert.equal(ok.outcome, 'PUBLISHED');
    assert.equal(isQuarantined(storage, contentVersionId, 'PUBLICATION'), false);
    const again = await runPublication({ storage, contentBriefId, provider: 'mock', adapter: okAdapter });
    assert.equal(again.outcome, 'ALREADY_PUBLISHED');
    assert.equal(okAdapter.calls, 1);
  });
  cleanup(storage, dbPath, media);
});

test('Publication: reactivation is audited, does not publish or bypass D-C2, begins a new cycle', async () => {
  const dbPath = freshDbPath();
  const storage = await openStorage(dbPath);
  const media = path.join(os.tmpdir(), `media-${Math.random()}.mp4`);
  fs.writeFileSync(media, 'x');
  const { contentBriefId, contentVersionId } = seedContent(storage, { state: 'PRODUCED', mediaFilePath: media });
  const adapter = new MockAdapter(FAIL);
  await withLive(contentVersionId, async () => {
    for (let i = 0; i < 3; i++) await runPublication({ storage, contentBriefId, provider: 'mock', adapter });
    assert.ok(isQuarantined(storage, contentVersionId, 'PUBLICATION'));
    const callsBefore = adapter.calls;

    reactivateQuarantined(storage, { contentVersionId, stage: RETRY_STAGE.PUBLICATION, ownerAction: OWNER });
    assert.equal(adapter.calls, callsBefore, 'reactivation itself publishes nothing');
    assert.equal(decisions(storage, contentVersionId, 'QUARANTINE_REACTIVATED').length, 1);
    assert.equal(storage.all('SELECT * FROM stage_retry_cycle_history').length, 1);
    assert.equal(selectEligiblePublications(storage).length, 1);
  });

  // Outside LIVE/authorized (SIMULATION default, empty auth): D-C2 still denies.
  const denied = await runPublication({ storage, contentBriefId, provider: 'mock', adapter });
  assert.equal(denied.outcome, 'AUTHORIZATION_DENIED');
  assert.equal(adapter.calls, 3);
  cleanup(storage, dbPath, media);
});

test('Reactivation function is not reachable from the runner, pipelines or selectors', () => {
  for (const f of ['src/autonomous/runner.js', 'src/autonomous/workSelection.js', 'src/production/pipeline.js', 'src/publication/pipeline.js']) {
    const src = fs.readFileSync(f, 'utf8');
    assert.equal(src.includes('reactivateQuarantined'), false, `${f} must not reference reactivateQuarantined`);
  }
});
