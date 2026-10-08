import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { SqliteStorageDriver } from '../../src/storage/SqliteStorageDriver.js';
import { runProduction } from '../../src/production/pipeline.js';
import { runMediaProduction, runShortFormProduction } from '../../src/media/pipeline.js';
import { verifyShortFormBinding, verifyGate2Pass } from '../../src/compliance/verify.js';
import { runPublication } from '../../src/publication/pipeline.js';
import { PublicationProvider } from '../../src/publication/PublicationProvider.js';
import { PUBLICATION_RESULT_STATUS } from '../../src/publication/constants.js';
import { AssetProvenanceRepository } from '../../src/state/AssetProvenance.js';
import { config } from '../../src/config/index.js';
import { passGate2, recordVerification, runGate2 } from '../helpers/gate2.js';

function freshStorage() {
  const dbPath = path.join(os.tmpdir(), `sfbind-${Date.now()}-${Math.random()}.db`);
  return { storage: new SqliteStorageDriver({ dbPath }), dbPath };
}

function freshDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
}

function cleanup(storage, dbPath, ...dirs) {
  storage.close();
  fs.rmSync(dbPath, { force: true });
  fs.rmSync(`${dbPath}-wal`, { force: true });
  fs.rmSync(`${dbPath}-shm`, { force: true });
  for (const d of dirs) {
    if (d) fs.rmSync(d, { recursive: true, force: true });
  }
}

function nowISO() {
  return new Date().toISOString();
}

function seedResearchProject(storage) {
  const opportunityId = crypto.randomUUID();
  storage.run(
    `INSERT INTO opportunities (id, title, source, discovered_at, status) VALUES (?, 'Test opportunity', 'rss', ?, 'DISCOVERED')`,
    [opportunityId, nowISO()]
  );
  return { opportunityId };
}

function seedBrief(storage, opportunityId) {
  const id = crypto.randomUUID();
  storage.run(
    `INSERT INTO content_briefs
      (id, opportunity_id, working_title, core_question, target_audience, viewer_promise,
       hook, angle, narrative_structure, key_claims, counterpoints, original_insights, visual_ideas,
       monetization_opportunities, risk_assessment, created_at)
     VALUES (?, ?, 'Short Form E2E Title', 'Q', 'A', 'A concise promise', 'H', 'Angle', 'Structure', '[]', 'C', 'I', 'V', 'M', 'R', ?)`,
    [id, opportunityId, nowISO()]
  );
  return id;
}

function seedContentVersion(storage, { body = 'This is a short narration script for the short form end to end test.' } = {}) {
  const { opportunityId } = seedResearchProject(storage);
  const contentBriefId = seedBrief(storage, opportunityId);
  const scriptId = crypto.randomUUID();
  storage.run(
    `INSERT INTO scripts (id, content_brief_id, version, body, claim_links, created_at)
     VALUES (?, ?, 1, ?, '[]', ?)`,
    [scriptId, contentBriefId, body, nowISO()]
  );
  const contentVersionId = crypto.randomUUID();
  storage.run(
    `INSERT INTO content_versions (id, content_brief_id, script_id, state, created_at) VALUES (?, ?, ?, 'PRODUCTION_READY', ?)`,
    [contentVersionId, contentBriefId, scriptId, nowISO()]
  );
  return { contentBriefId, scriptId, contentVersionId };
}

function seedVisualAsset(storage, contentVersionId, location, verificationStatus = 'VERIFIED') {
  const repo = new AssetProvenanceRepository(storage);
  const assetId = repo.recordAsset({ assetType: 'image', location, verificationStatus });
  repo.recordUsage({ assetId, contentVersionId, usageContext: 'b-roll' });
  return assetId;
}

function makeFixtureImage(dir, name, color) {
  const location = path.join(dir, name);
  execFileSync('ffmpeg', ['-f', 'lavfi', '-i', `color=c=${color}:s=64x64:d=1`, '-frames:v', '1', '-y', location], {
    stdio: ['ignore', 'pipe', 'pipe']
  });
  return location;
}

class MockYouTube extends PublicationProvider {
  constructor(result) {
    super();
    this.result = result;
    this.calls = [];
  }
  get id() {
    return 'youtube';
  }
  async publish(request) {
    this.calls.push(request);
    return this.result;
  }
}

function withLiveAuthorized(actions, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sfbind-auth-'));
  const filePath = path.join(dir, 'authorized.json');
  fs.writeFileSync(filePath, JSON.stringify(actions));
  const originalPath = config.authorizedExternalActionsPath;
  const originalMode = config.runMode;
  const originalAutonomous = config.autonomousEnabled;
  config.authorizedExternalActionsPath = filePath;
  config.runMode = 'LIVE';
  config.autonomousEnabled = true;
  return Promise.resolve(fn(filePath)).finally(() => {
    config.authorizedExternalActionsPath = originalPath;
    config.runMode = originalMode;
    config.autonomousEnabled = originalAutonomous;
    fs.rmSync(dir, { recursive: true, force: true });
  });
}

// ---------------------------------------------------------------------------
// Gate 2 short-form artifact binding: a SHORT_FORM publication may upload only
// the exact short-form artifact bound into its Gate 2 PASS, re-hashed at the
// publication boundary. Every blocking test authorizes D-C2 (LIVE grant) and
// asserts the adapter was never called, so the block is proven to come from
// the binding and not from a missing authorization.
// ---------------------------------------------------------------------------

async function build({ renderShortFirst = true, passGate = true } = {}) {
  const { storage, dbPath } = freshStorage();
  const dirs = [freshDir('sfbind-production'), freshDir('sfbind-media'), freshDir('sfbind-assets')];
  const [productionDir, mediaDir, assetsDir] = dirs;
  await storage.migrate();
  const { contentBriefId, contentVersionId } = seedContentVersion(storage);
  const assetA = seedVisualAsset(storage, contentVersionId, makeFixtureImage(assetsDir, 'a.png', 'blue'));
  const assetB = seedVisualAsset(storage, contentVersionId, makeFixtureImage(assetsDir, 'b.png', 'red'));
  runProduction({ storage, contentBriefId, artifactsDir: productionDir });
  const longForm = runMediaProduction({ storage, contentBriefId, artifactsDir: mediaDir });
  assert.equal(longForm.outcome, 'RENDERED');
  let shortForm = null;
  if (renderShortFirst) {
    shortForm = runShortFormProduction({ storage, contentBriefId, artifactsDir: mediaDir });
    assert.equal(shortForm.outcome, 'RENDERED');
  }
  recordVerification(storage, assetA, 'VERIFIED');
  recordVerification(storage, assetB, 'VERIFIED');
  if (passGate) passGate2(storage, contentVersionId);
  const renderShort = () => {
    shortForm = runShortFormProduction({ storage, contentBriefId, artifactsDir: mediaDir });
    assert.equal(shortForm.outcome, 'RENDERED');
    return shortForm;
  };
  return {
    storage, dbPath, dirs, contentBriefId, contentVersionId, longForm, assetsDir, mediaDir, renderShort,
    get shortForm() { return shortForm; },
    cleanup: () => cleanup(storage, dbPath, ...dirs)
  };
}

const mock = (provider = 'youtube_shorts') => {
  const m = new MockYouTube({ status: PUBLICATION_RESULT_STATUS.SUCCESS, provider, providerItemId: 'VID', providerUrl: 'https://youtu.be/VID' });
  m.providerId = provider;
  return m;
};

async function publishShorts(ctx, adapter = mock()) {
  return withLiveAuthorized([`publish:youtube_shorts:${ctx.contentVersionId}`], () =>
    runPublication({ storage: ctx.storage, contentBriefId: ctx.contentBriefId, provider: 'youtube_shorts', adapter })
  ).then((result) => ({ result, adapter }));
}

function assertBlocked({ result, adapter }, reason, storage, contentVersionId) {
  assert.equal(result.outcome, 'GATE2_NOT_AUTHORIZING');
  assert.equal(result.reason, reason);
  assert.equal(adapter.calls.length, 0, 'adapter must NOT be called');
  assert.equal(storage.get('SELECT COUNT(*) AS n FROM publications WHERE content_version_id = ?', [contentVersionId]).n, 0, 'nothing claimed');
}

test('A. valid short-form authorization: PASS binds the short-form id + checksum and the adapter receives exactly that file', async () => {
  const ctx = await build();
  const record = storage_newest(ctx);
  const evidence = JSON.parse(record.evidence_json);
  assert.deepEqual(evidence.short_form, {
    short_form_media_artifact_id: ctx.shortForm.mediaArtifact.id,
    artifact_checksum: ctx.shortForm.mediaArtifact.artifact_checksum
  });
  // Long-form binding is unchanged.
  assert.equal(record.bound_media_artifact_id, ctx.longForm.mediaArtifact.id);
  assert.deepEqual(evidence.media, { media_artifact_id: ctx.longForm.mediaArtifact.id, artifact_checksum: ctx.longForm.mediaArtifact.artifact_checksum });

  const { result, adapter } = await publishShorts(ctx);
  assert.equal(result.outcome, 'PUBLISHED');
  assert.equal(adapter.calls.length, 1);
  assert.equal(adapter.calls[0].mediaFilePath, ctx.shortForm.mediaArtifact.artifact_path);
  assert.equal(adapter.calls[0].mediaChecksum, ctx.shortForm.mediaArtifact.artifact_checksum);
  ctx.cleanup();
});

function storage_newest(ctx) {
  return ctx.storage.get('SELECT * FROM gate2_compliance_records WHERE content_version_id = ? ORDER BY seq DESC LIMIT 1', [ctx.contentVersionId]);
}

test('B. short-form file substituted after Gate 2 PASS -> BLOCK, adapter not called', async () => {
  const ctx = await build();
  fs.appendFileSync(ctx.shortForm.mediaArtifact.artifact_path, Buffer.from('tampered'));
  assertBlocked(await publishShorts(ctx), 'SHORT_FORM_FILE_CHECKSUM_MISMATCH', ctx.storage, ctx.contentVersionId);
  ctx.cleanup();
});

test('B2. short-form file deleted after Gate 2 PASS -> not authorized, adapter not called', async () => {
  const ctx = await build();
  fs.rmSync(ctx.shortForm.mediaArtifact.artifact_path);
  const out = await publishShorts(ctx);
  assert.equal(out.adapter.calls.length, 0);
  assert.notEqual(out.result.outcome, 'PUBLISHED');
  ctx.cleanup();
});

test('C. short-form row checksum or identity changed after PASS -> BLOCK, adapter not called', async () => {
  const ctx = await build();
  const sfId = ctx.shortForm.mediaArtifact.id;
  const originalChecksum = ctx.shortForm.mediaArtifact.artifact_checksum;

  ctx.storage.run('UPDATE short_form_media_artifacts SET artifact_checksum = ? WHERE id = ?', ['0'.repeat(64), sfId]);
  assertBlocked(await publishShorts(ctx), 'SHORT_FORM_CHECKSUM_MISMATCH', ctx.storage, ctx.contentVersionId);

  ctx.storage.run('UPDATE short_form_media_artifacts SET artifact_checksum = ? WHERE id = ?', [originalChecksum, sfId]);
  const newId = crypto.randomUUID();
  ctx.storage.run('UPDATE short_form_media_artifacts SET id = ? WHERE id = ?', [newId, sfId]);
  assertBlocked(await publishShorts(ctx), 'SHORT_FORM_IDENTITY_MISMATCH', ctx.storage, ctx.contentVersionId);
  ctx.cleanup();
});

test('D. a DIFFERENT but internally valid short-form artifact is refused (critical regression)', async () => {
  const ctx = await build();
  const row = ctx.shortForm.mediaArtifact;
  // A second, fully valid vertical mp4 with its own correct checksum.
  const other = path.join(ctx.mediaDir, 'other-valid-short.mp4');
  execFileSync('ffmpeg', ['-f', 'lavfi', '-i', 'color=c=green:s=1080x1920:d=1', '-pix_fmt', 'yuv420p', '-y', other], { stdio: ['ignore', 'pipe', 'pipe'] });
  const otherChecksum = crypto.createHash('sha256').update(fs.readFileSync(other)).digest('hex');
  assert.notEqual(otherChecksum, row.artifact_checksum);

  // D1: row repointed to the other file with a consistent (valid) checksum, same id.
  ctx.storage.run('UPDATE short_form_media_artifacts SET artifact_path = ?, artifact_checksum = ? WHERE id = ?', [other, otherChecksum, row.id]);
  assertBlocked(await publishShorts(ctx), 'SHORT_FORM_CHECKSUM_MISMATCH', ctx.storage, ctx.contentVersionId);

  // D2: a wholly new valid row (new id) replaces the bound one.
  ctx.storage.run('DELETE FROM short_form_media_artifacts WHERE id = ?', [row.id]);
  ctx.storage.run(
    `INSERT INTO short_form_media_artifacts
      (id, media_artifact_id, content_version_id, segment_start_seconds, segment_end_seconds, render_spec_json, render_spec_checksum,
       artifact_path, artifact_checksum, duration_seconds, width, height, video_codec, audio_codec, created_at)
     VALUES (?, ?, ?, 0, 1, ?, ?, ?, ?, 1, 1080, 1920, 'h264', 'aac', ?)`,
    [crypto.randomUUID(), row.media_artifact_id, ctx.contentVersionId, row.render_spec_json, row.render_spec_checksum, other, otherChecksum, nowISO()]
  );
  assertBlocked(await publishShorts(ctx), 'SHORT_FORM_IDENTITY_MISMATCH', ctx.storage, ctx.contentVersionId);
  ctx.cleanup();
});

test('D3. verifyShortFormBinding refuses an upload path that is not the bound row path, even if that file is valid', async () => {
  const ctx = await build();
  const gate2 = verifyGate2Pass(ctx.storage, ctx.contentVersionId);
  assert.equal(gate2.authorizing, true);
  const row = ctx.shortForm.mediaArtifact;
  const args = { contentVersionId: ctx.contentVersionId, record: gate2.record, resolvedShortFormId: row.id };
  assert.equal(verifyShortFormBinding(ctx.storage, { ...args, mediaFilePath: row.artifact_path }).authorizing, true);
  const longPath = ctx.longForm.mediaArtifact.artifact_path; // valid file, wrong artifact
  const wrong = verifyShortFormBinding(ctx.storage, { ...args, mediaFilePath: longPath });
  assert.equal(wrong.authorizing, false);
  assert.equal(wrong.reason, 'SHORT_FORM_PATH_MISMATCH');
  ctx.cleanup();
});

test('E. long-form regression: long-form publication is unaffected by (and independent of) the short-form artifact', async () => {
  // E1: tampered short-form file does not affect long-form publication.
  const ctx = await build();
  fs.appendFileSync(ctx.shortForm.mediaArtifact.artifact_path, Buffer.from('tampered'));
  const adapter = mock('youtube');
  const out = await withLiveAuthorized([`publish:youtube:${ctx.contentVersionId}`], () =>
    runPublication({ storage: ctx.storage, contentBriefId: ctx.contentBriefId, provider: 'youtube', adapter })
  );
  assert.equal(out.outcome, 'PUBLISHED');
  assert.equal(adapter.calls[0].mediaFilePath, ctx.longForm.mediaArtifact.artifact_path);
  ctx.cleanup();

  // E2: no short-form row at all: PASS carries no short_form key; long-form publishes.
  const ctx2 = await build({ renderShortFirst: false });
  assert.equal('short_form' in JSON.parse(storage_newest(ctx2).evidence_json), false);
  const adapter2 = mock('youtube');
  const out2 = await withLiveAuthorized([`publish:youtube:${ctx2.contentVersionId}`], () =>
    runPublication({ storage: ctx2.storage, contentBriefId: ctx2.contentBriefId, provider: 'youtube', adapter: adapter2 })
  );
  assert.equal(out2.outcome, 'PUBLISHED');
  ctx2.cleanup();
});

test('F. missing short-form artifact -> NOT_YET_RENDERED, no authorization manufactured, adapter not called', async () => {
  const ctx = await build({ renderShortFirst: false });
  const { result, adapter } = await publishShorts(ctx);
  assert.equal(result.outcome, 'NOT_YET_RENDERED');
  assert.equal(adapter.calls.length, 0);
  ctx.cleanup();
});

test('G. PASS issued BEFORE the short-form existed does not authorize shorts; re-running Gate 2 binds it', async () => {
  const ctx = await build({ renderShortFirst: false });
  const sf = ctx.renderShort();
  const blocked = await publishShorts(ctx);
  assertBlocked(blocked, 'SHORT_FORM_BINDING_ABSENT', ctx.storage, ctx.contentVersionId);

  // The final-compliance stage must not call the stale PASS ALREADY_VALID.
  const rerun = runGate2(ctx.storage, ctx.contentVersionId);
  assert.equal(rerun.outcome, 'PASS');
  assert.deepEqual(JSON.parse(storage_newest(ctx).evidence_json).short_form, {
    short_form_media_artifact_id: sf.mediaArtifact.id, artifact_checksum: sf.mediaArtifact.artifact_checksum
  });
  assert.equal(runGate2(ctx.storage, ctx.contentVersionId).outcome, 'ALREADY_VALID');

  const { result, adapter } = await publishShorts(ctx);
  assert.equal(result.outcome, 'PUBLISHED');
  assert.equal(adapter.calls[0].mediaFilePath, sf.mediaArtifact.artifact_path);
  ctx.cleanup();
});

test('H. short-form file tampered BEFORE Gate 2 evaluation: nothing is bound, shorts blocked, long-form PASS still valid', async () => {
  const ctx = await build({ passGate: false });
  fs.appendFileSync(ctx.shortForm.mediaArtifact.artifact_path, Buffer.from('tampered'));
  passGate2(ctx.storage, ctx.contentVersionId);
  assert.equal('short_form' in JSON.parse(storage_newest(ctx).evidence_json), false);
  assertBlocked(await publishShorts(ctx), 'SHORT_FORM_BINDING_ABSENT', ctx.storage, ctx.contentVersionId);
  assert.equal(verifyGate2Pass(ctx.storage, ctx.contentVersionId).authorizing, true);
  ctx.cleanup();
});
