import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { SqliteStorageDriver } from '../../src/storage/SqliteStorageDriver.js';
import { passGate2 } from '../helpers/gate2.js';
import { runPublication } from '../../src/publication/pipeline.js';
import { PublicationProvider } from '../../src/publication/PublicationProvider.js';
import { PUBLICATION_RESULT_STATUS, publicationActionId } from '../../src/publication/constants.js';
import { selectEligiblePublications } from '../../src/autonomous/workSelection.js';
import {
  STAGE_RETRY_CAP, RETRY_STAGE, isQuarantined, recordFailedAttempt, reactivateQuarantined, QuarantineReactivationError
} from '../../src/state/StageRetryPolicy.js';
import { config } from '../../src/config/index.js';

// Regression coverage for the provider-scoped PUBLICATION retry/quarantine
// fix (0026_provider_scoped_publication_retry.sql): identity is now
// (stage, subject_id, provider), never (stage, subject_id) alone, so one
// provider's failures/quarantine can never affect another provider's.

const nowISO = () => new Date().toISOString();

function freshDbPath() {
  return path.join(os.tmpdir(), `pub-provider-retry-${Date.now()}-${Math.random()}.db`);
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

function seedPublishable(storage) {
  const media = path.join(os.tmpdir(), `media-${Math.random()}.mp4`);
  fs.writeFileSync(media, 'x');
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
  storage.run(`INSERT INTO content_versions (id, content_brief_id, script_id, state, created_at) VALUES (?, ?, ?, 'PRODUCED', ?)`, [contentVersionId, contentBriefId, scriptId, nowISO()]);
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
    [crypto.randomUUID(), productionId, contentVersionId, media, nowISO()]
  );
  passGate2(storage, contentVersionId);
  return { contentBriefId, contentVersionId, media };
}

class MockAdapter extends PublicationProvider {
  constructor(providerId, result) { super(); this.providerId = providerId; this.result = result; this.calls = 0; }
  get id() { return this.providerId; }
  async publish() { this.calls += 1; return this.result; }
}
const failFor = (providerId) => ({ status: PUBLICATION_RESULT_STATUS.EXPLICIT_FAILURE, provider: providerId, errorClass: 'REJECTED_UPLOAD' });
const successFor = (providerId, itemId) => ({ status: PUBLICATION_RESULT_STATUS.SUCCESS, provider: providerId, providerItemId: itemId, providerUrl: `https://example.test/${itemId}` });

async function withLive(cvId, providers, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pub-provider-auth-'));
  const filePath = path.join(dir, 'authorized.json');
  fs.writeFileSync(filePath, JSON.stringify(providers.map((p) => publicationActionId(p, cvId))));
  const saved = [config.authorizedExternalActionsPath, config.runMode, config.autonomousEnabled];
  config.authorizedExternalActionsPath = filePath; config.runMode = 'LIVE'; config.autonomousEnabled = true;
  try { return await fn(); } finally {
    [config.authorizedExternalActionsPath, config.runMode, config.autonomousEnabled] = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const retryRow = (storage, cv, stage, provider) =>
  storage.get('SELECT * FROM stage_retry_state WHERE subject_id = ? AND stage = ? AND provider = ?', [cv, stage, provider]);

// 1 & 3: YouTube quarantine does NOT quarantine Facebook; YouTube retries independently.
test('YouTube quarantine does not quarantine Facebook; each retries independently', async () => {
  const dbPath = freshDbPath();
  const storage = await openStorage(dbPath);
  const { contentBriefId, contentVersionId, media } = seedPublishable(storage);
  const yt = new MockAdapter('youtube', failFor('youtube'));
  const fb = new MockAdapter('facebook', failFor('facebook'));

  await withLive(contentVersionId, ['youtube', 'facebook'], async () => {
    for (let i = 1; i <= STAGE_RETRY_CAP; i++) {
      const r = await runPublication({ storage, contentBriefId, provider: 'youtube', adapter: yt });
      assert.equal(r.attempt, i);
    }
    assert.ok(isQuarantined(storage, contentVersionId, 'PUBLICATION', 'youtube'), 'youtube quarantined after 3 failures');
    assert.equal(isQuarantined(storage, contentVersionId, 'PUBLICATION', 'facebook'), false, 'facebook untouched by youtube quarantine');
    assert.equal(retryRow(storage, contentVersionId, 'PUBLICATION', 'facebook'), undefined, 'no facebook retry row exists yet');

    // Facebook can still make its own independent attempts.
    const fb1 = await runPublication({ storage, contentBriefId, provider: 'facebook', adapter: fb });
    assert.equal(fb1.outcome, 'PROVIDER_FAILURE');
    assert.equal(fb1.attempt, 1);
    assert.equal(fb.calls, 1);
  });
  cleanup(storage, dbPath, media);
});

// 2 & 4: Facebook quarantine does NOT quarantine YouTube; Facebook retries independently.
test('Facebook quarantine does not quarantine YouTube; each retries independently', async () => {
  const dbPath = freshDbPath();
  const storage = await openStorage(dbPath);
  const { contentBriefId, contentVersionId, media } = seedPublishable(storage);
  const yt = new MockAdapter('youtube', failFor('youtube'));
  const fb = new MockAdapter('facebook', failFor('facebook'));

  await withLive(contentVersionId, ['youtube', 'facebook'], async () => {
    for (let i = 1; i <= STAGE_RETRY_CAP; i++) {
      const r = await runPublication({ storage, contentBriefId, provider: 'facebook', adapter: fb });
      assert.equal(r.attempt, i);
    }
    assert.ok(isQuarantined(storage, contentVersionId, 'PUBLICATION', 'facebook'));
    assert.equal(isQuarantined(storage, contentVersionId, 'PUBLICATION', 'youtube'), false);

    const yt1 = await runPublication({ storage, contentBriefId, provider: 'youtube', adapter: yt });
    assert.equal(yt1.outcome, 'PROVIDER_FAILURE');
    assert.equal(yt1.attempt, 1);
    assert.equal(yt.calls, 1);
  });
  cleanup(storage, dbPath, media);
});

// 5: Same-provider three-strike/quarantine behavior remains unchanged.
test('Same-provider three-strike quarantine behavior is unchanged', async () => {
  const dbPath = freshDbPath();
  const storage = await openStorage(dbPath);
  const { contentBriefId, contentVersionId, media } = seedPublishable(storage);
  const yt = new MockAdapter('youtube', failFor('youtube'));

  await withLive(contentVersionId, ['youtube'], async () => {
    const r1 = await runPublication({ storage, contentBriefId, provider: 'youtube', adapter: yt });
    assert.equal(r1.attempt, 1);
    assert.equal(r1.quarantined, false);
    const r2 = await runPublication({ storage, contentBriefId, provider: 'youtube', adapter: yt });
    assert.equal(r2.attempt, 2);
    assert.equal(r2.quarantined, false);
    const r3 = await runPublication({ storage, contentBriefId, provider: 'youtube', adapter: yt });
    assert.equal(r3.attempt, 3);
    assert.equal(r3.quarantined, true);

    const callsBefore = yt.calls;
    const r4 = await runPublication({ storage, contentBriefId, provider: 'youtube', adapter: yt });
    assert.equal(r4.outcome, 'QUARANTINED');
    assert.equal(yt.calls, callsBefore, 'provider never called again after quarantine');
  });
  cleanup(storage, dbPath, media);
});

// 6 & 7: Reactivating one provider does not affect the other's retry state.
test('Reactivating YouTube does not affect Facebook retry state, and vice versa', async () => {
  const dbPath = freshDbPath();
  const storage = await openStorage(dbPath);
  const { contentBriefId, contentVersionId, media } = seedPublishable(storage);
  const yt = new MockAdapter('youtube', failFor('youtube'));
  const fb = new MockAdapter('facebook', failFor('facebook'));
  const OWNER = { actor: 'OWNER', reason: 'root cause fixed' };

  await withLive(contentVersionId, ['youtube', 'facebook'], async () => {
    for (let i = 0; i < STAGE_RETRY_CAP; i++) await runPublication({ storage, contentBriefId, provider: 'youtube', adapter: yt });
    for (let i = 0; i < STAGE_RETRY_CAP; i++) await runPublication({ storage, contentBriefId, provider: 'facebook', adapter: fb });
    assert.ok(isQuarantined(storage, contentVersionId, 'PUBLICATION', 'youtube'));
    assert.ok(isQuarantined(storage, contentVersionId, 'PUBLICATION', 'facebook'));

    // Reactivate only YouTube.
    reactivateQuarantined(storage, { contentVersionId, stage: RETRY_STAGE.PUBLICATION, provider: 'youtube', ownerAction: OWNER });
    assert.equal(isQuarantined(storage, contentVersionId, 'PUBLICATION', 'youtube'), false, 'youtube reactivated');
    assert.ok(isQuarantined(storage, contentVersionId, 'PUBLICATION', 'facebook'), 'facebook still quarantined, untouched by youtube reactivation');
    assert.equal(retryRow(storage, contentVersionId, 'PUBLICATION', 'facebook').attempt_count, 3, 'facebook counter unchanged');
    assert.equal(retryRow(storage, contentVersionId, 'PUBLICATION', 'youtube').attempt_count, 0, 'youtube counter reset for new cycle');

    // Reactivate Facebook too, then confirm YouTube's fresh cycle is unaffected by it.
    reactivateQuarantined(storage, { contentVersionId, stage: RETRY_STAGE.PUBLICATION, provider: 'facebook', ownerAction: OWNER });
    assert.equal(isQuarantined(storage, contentVersionId, 'PUBLICATION', 'facebook'), false);
    assert.equal(retryRow(storage, contentVersionId, 'PUBLICATION', 'youtube').attempt_count, 0, 'youtube unaffected by facebook reactivation');
    assert.equal(retryRow(storage, contentVersionId, 'PUBLICATION', 'youtube').cycle_number, 2);
    assert.equal(retryRow(storage, contentVersionId, 'PUBLICATION', 'facebook').cycle_number, 2);

    // Cycle history rows are provider-scoped too, not shared.
    const ytHist = storage.all('SELECT * FROM stage_retry_cycle_history WHERE subject_id = ? AND provider = ?', [contentVersionId, 'youtube']);
    const fbHist = storage.all('SELECT * FROM stage_retry_cycle_history WHERE subject_id = ? AND provider = ?', [contentVersionId, 'facebook']);
    assert.equal(ytHist.length, 1);
    assert.equal(fbHist.length, 1);
  });
  cleanup(storage, dbPath, media);
});

// 8 & 9: selectEligiblePublications for one provider still selects content quarantined only for the other.
test('selectEligiblePublications: a provider-specific quarantine never excludes the other provider', async () => {
  const dbPath = freshDbPath();
  const storage = await openStorage(dbPath);
  const { contentBriefId, contentVersionId, media } = seedPublishable(storage);
  const yt = new MockAdapter('youtube', failFor('youtube'));

  await withLive(contentVersionId, ['youtube'], async () => {
    for (let i = 0; i < STAGE_RETRY_CAP; i++) await runPublication({ storage, contentBriefId, provider: 'youtube', adapter: yt });
    assert.ok(isQuarantined(storage, contentVersionId, 'PUBLICATION', 'youtube'));

    // Quarantined-for-youtube item must not be selected for a youtube run...
    assert.deepEqual(selectEligiblePublications(storage, 'youtube'), []);
    // ...but IS still selected for a facebook run, and a youtube_shorts run.
    assert.equal(selectEligiblePublications(storage, 'facebook').length, 1);
    assert.equal(selectEligiblePublications(storage, 'youtube_shorts').length, 1);
  });
  cleanup(storage, dbPath, media);
});

// 10: One provider PUBLISHED while the other is QUARANTINED for the same content version.
test('One provider can be PUBLISHED while the other is QUARANTINED for the same content version', async () => {
  const dbPath = freshDbPath();
  const storage = await openStorage(dbPath);
  const { contentBriefId, contentVersionId, media } = seedPublishable(storage);
  const yt = new MockAdapter('youtube', failFor('youtube'));
  const fb = new MockAdapter('facebook', successFor('facebook', 'FB1'));

  await withLive(contentVersionId, ['youtube', 'facebook'], async () => {
    for (let i = 0; i < STAGE_RETRY_CAP; i++) await runPublication({ storage, contentBriefId, provider: 'youtube', adapter: yt });
    assert.ok(isQuarantined(storage, contentVersionId, 'PUBLICATION', 'youtube'));

    const fbResult = await runPublication({ storage, contentBriefId, provider: 'facebook', adapter: fb });
    assert.equal(fbResult.outcome, 'PUBLISHED');
    assert.equal(
      storage.get(`SELECT status FROM publications WHERE content_version_id = ? AND provider = 'youtube'`, [contentVersionId]).status,
      'FAILED'
    );
    assert.equal(
      storage.get(`SELECT status FROM publications WHERE content_version_id = ? AND provider = 'facebook'`, [contentVersionId]).status,
      'PUBLISHED'
    );
  });
  cleanup(storage, dbPath, media);
});

// 11: Existing non-PUBLICATION retry/quarantine tests continue to pass (see
// tests/integration/bounded-retry-quarantine.test.js and
// tests/integration/a4-stage-retry-quarantine.test.js, run unmodified except
// for the pre-existing PUBLICATION call sites updated to pass `provider`).
// This test additionally proves non-PUBLICATION stages are refused a
// provider argument (the identity boundary is enforced, not just unused).
test('Non-PUBLICATION stages refuse a provider argument; PUBLICATION requires one', () => {
  const subjectId = crypto.randomUUID();
  const dbPath = freshDbPath();
  return openStorage(dbPath).then((storage) => {
    assert.throws(() => isQuarantined(storage, subjectId, RETRY_STAGE.PRODUCTION, 'youtube'), /not provider-scoped/);
    assert.throws(() => isQuarantined(storage, subjectId, RETRY_STAGE.PUBLICATION), /provider-scoped/);
    assert.throws(
      () => recordFailedAttempt(storage, { subjectId, stage: RETRY_STAGE.PRODUCTION, provider: 'youtube', reason: 'x' }),
      /not provider-scoped/
    );
    assert.throws(
      () => recordFailedAttempt(storage, { subjectId, stage: RETRY_STAGE.PUBLICATION, reason: 'x' }),
      /provider-scoped/
    );
    // A valid non-provider PRODUCTION call still works exactly as before.
    assert.equal(isQuarantined(storage, subjectId, RETRY_STAGE.PRODUCTION), false);
    cleanup(storage, dbPath);
  });
});

// 12: Existing publication idempotency tests continue to pass (see
// tests/integration/bounded-retry-quarantine.test.js "success before
// exhaustion does not quarantine; idempotency intact", run unmodified other
// than passing `provider` to isQuarantined). This test additionally proves
// idempotency (ALREADY_PUBLISHED short-circuit, no duplicate adapter call)
// holds per-provider under the new scoping.
test('Idempotency is preserved per provider under provider-scoped retry', async () => {
  const dbPath = freshDbPath();
  const storage = await openStorage(dbPath);
  const { contentBriefId, contentVersionId, media } = seedPublishable(storage);
  const ytOk = new MockAdapter('youtube', successFor('youtube', 'YT1'));

  await withLive(contentVersionId, ['youtube'], async () => {
    const first = await runPublication({ storage, contentBriefId, provider: 'youtube', adapter: ytOk });
    assert.equal(first.outcome, 'PUBLISHED');
    const again = await runPublication({ storage, contentBriefId, provider: 'youtube', adapter: ytOk });
    assert.equal(again.outcome, 'ALREADY_PUBLISHED');
    assert.equal(ytOk.calls, 1);
    assert.equal(isQuarantined(storage, contentVersionId, 'PUBLICATION', 'youtube'), false);
  });
  cleanup(storage, dbPath, media);
});

// 13: Existing multi-provider publication tests continue to pass -- proven
// by exercising the pre-existing multi-provider selection/publish path
// (selectEligiblePublications' own provider-scoped PUBLISHED exclusion,
// unrelated to and unaffected by this fix) alongside the new provider-scoped
// quarantine columns.
test('Multi-provider fan-out selection is unaffected by provider-scoped retry columns', async () => {
  const dbPath = freshDbPath();
  const storage = await openStorage(dbPath);
  const { contentBriefId, contentVersionId, media } = seedPublishable(storage);
  const ytOk = new MockAdapter('youtube', successFor('youtube', 'YT1'));

  await withLive(contentVersionId, ['youtube', 'facebook'], async () => {
    assert.equal(selectEligiblePublications(storage, 'youtube').length, 1);
    assert.equal(selectEligiblePublications(storage, 'facebook').length, 1);
    const published = await runPublication({ storage, contentBriefId, provider: 'youtube', adapter: ytOk });
    assert.equal(published.outcome, 'PUBLISHED');
    // youtube run no longer sees this item (already PUBLISHED-by-it); facebook still does.
    assert.equal(selectEligiblePublications(storage, 'youtube').length, 0);
    assert.equal(selectEligiblePublications(storage, 'facebook').length, 1);
  });
  cleanup(storage, dbPath, media);
});
