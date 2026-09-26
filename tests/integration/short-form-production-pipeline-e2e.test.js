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
import { runPublication } from '../../src/publication/pipeline.js';
import { PublicationProvider } from '../../src/publication/PublicationProvider.js';
import { PUBLICATION_RESULT_STATUS } from '../../src/publication/constants.js';
import { AssetProvenanceRepository } from '../../src/state/AssetProvenance.js';
import { config } from '../../src/config/index.js';
import { passGate2, recordVerification } from '../helpers/gate2.js';

function freshStorage() {
  const dbPath = path.join(os.tmpdir(), `shortform-e2e-${Date.now()}-${Math.random()}.db`);
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shortform-e2e-auth-'));
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

// --- Short-form rendering ---

test('short-form production: 1080x1920 vertical artifact created, duration within the configured cap, long-form artifact unaffected', async () => {
  const { storage, dbPath } = freshStorage();
  const productionArtifactsDir = freshDir('shortform-e2e-production');
  const mediaArtifactsDir = freshDir('shortform-e2e-media');
  const assetsDir = freshDir('shortform-e2e-assets');
  await storage.migrate();

  const { contentBriefId, contentVersionId } = seedContentVersion(storage);
  const imgA = makeFixtureImage(assetsDir, 'a.png', 'blue');
  const imgB = makeFixtureImage(assetsDir, 'b.png', 'red');
  seedVisualAsset(storage, contentVersionId, imgA);
  seedVisualAsset(storage, contentVersionId, imgB);

  runProduction({ storage, contentBriefId, artifactsDir: productionArtifactsDir });
  const longFormResult = runMediaProduction({ storage, contentBriefId, artifactsDir: mediaArtifactsDir });
  assert.equal(longFormResult.outcome, 'RENDERED');

  const shortResult = runShortFormProduction({ storage, contentBriefId, artifactsDir: mediaArtifactsDir });
  assert.equal(shortResult.outcome, 'RENDERED');
  const shortArtifact = shortResult.mediaArtifact;
  assert.ok(shortArtifact);
  assert.equal(shortArtifact.content_version_id, contentVersionId);
  assert.equal(shortArtifact.media_artifact_id, longFormResult.mediaArtifact.id);

  // Real, playable, correctly-shaped vertical video on disk.
  assert.ok(fs.existsSync(shortArtifact.artifact_path));
  const probeOut = execFileSync(
    'ffprobe',
    ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', shortArtifact.artifact_path],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  ).toString();
  const probe = JSON.parse(probeOut);
  const videoStream = probe.streams.find((s) => s.codec_type === 'video');
  const audioStream = probe.streams.find((s) => s.codec_type === 'audio');
  assert.ok(videoStream);
  assert.ok(audioStream);
  assert.equal(videoStream.width, 1080);
  assert.equal(videoStream.height, 1920);
  assert.equal(shortArtifact.width, 1080);
  assert.equal(shortArtifact.height, 1920);

  // Duration within the configured short-form cap (60s).
  assert.ok(shortArtifact.duration_seconds > 0);
  assert.ok(shortArtifact.duration_seconds <= 60);

  const actualChecksum = crypto.createHash('sha256').update(fs.readFileSync(shortArtifact.artifact_path)).digest('hex');
  assert.equal(shortArtifact.artifact_checksum, actualChecksum);

  // Existing long-form artifact/file is completely untouched.
  const longFormAfter = storage.get('SELECT * FROM media_artifacts WHERE content_version_id = ?', [contentVersionId]);
  assert.equal(longFormAfter.id, longFormResult.mediaArtifact.id);
  assert.equal(longFormAfter.artifact_path, longFormResult.mediaArtifact.artifact_path);
  assert.equal(longFormAfter.width, 1280);
  assert.equal(longFormAfter.height, 720);
  assert.ok(fs.existsSync(longFormAfter.artifact_path));
  const longFormProbeOut = execFileSync(
    'ffprobe',
    ['-v', 'error', '-print_format', 'json', '-show_streams', longFormAfter.artifact_path],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  ).toString();
  const longFormVideoStream = JSON.parse(longFormProbeOut).streams.find((s) => s.codec_type === 'video');
  assert.equal(longFormVideoStream.width, 1280);
  assert.equal(longFormVideoStream.height, 720);

  cleanup(storage, dbPath, productionArtifactsDir, mediaArtifactsDir, assetsDir);
});

test('short-form production is idempotent: repeated invocation returns the existing record, no duplicate row', async () => {
  const { storage, dbPath } = freshStorage();
  const productionArtifactsDir = freshDir('shortform-e2e-production');
  const mediaArtifactsDir = freshDir('shortform-e2e-media');
  const assetsDir = freshDir('shortform-e2e-assets');
  await storage.migrate();

  const { contentBriefId, contentVersionId } = seedContentVersion(storage);
  seedVisualAsset(storage, contentVersionId, makeFixtureImage(assetsDir, 'a.png', 'green'));
  runProduction({ storage, contentBriefId, artifactsDir: productionArtifactsDir });
  runMediaProduction({ storage, contentBriefId, artifactsDir: mediaArtifactsDir });

  const first = runShortFormProduction({ storage, contentBriefId, artifactsDir: mediaArtifactsDir });
  const second = runShortFormProduction({ storage, contentBriefId, artifactsDir: mediaArtifactsDir });

  assert.equal(first.outcome, 'RENDERED');
  assert.equal(second.outcome, 'ALREADY_RENDERED');
  assert.equal(second.mediaArtifact.id, first.mediaArtifact.id);
  const count = storage.get('SELECT COUNT(*) AS n FROM short_form_media_artifacts WHERE content_version_id = ?', [contentVersionId]).n;
  assert.equal(count, 1);

  cleanup(storage, dbPath, productionArtifactsDir, mediaArtifactsDir, assetsDir);
});

test('short-form production before the long-form artifact exists -> NOT_YET_PRODUCED, no artifact', async () => {
  const { storage, dbPath } = freshStorage();
  const productionArtifactsDir = freshDir('shortform-e2e-production');
  const mediaArtifactsDir = freshDir('shortform-e2e-media');
  const assetsDir = freshDir('shortform-e2e-assets');
  await storage.migrate();

  const { contentBriefId, contentVersionId } = seedContentVersion(storage);
  seedVisualAsset(storage, contentVersionId, makeFixtureImage(assetsDir, 'a.png', 'blue'));
  runProduction({ storage, contentBriefId, artifactsDir: productionArtifactsDir });
  // Deliberately no runMediaProduction() call -- no long-form artifact yet.

  const result = runShortFormProduction({ storage, contentBriefId, artifactsDir: mediaArtifactsDir });
  assert.equal(result.outcome, 'NOT_YET_PRODUCED');
  assert.equal(result.reason, 'LONG_FORM_NOT_YET_RENDERED');
  assert.equal(result.mediaArtifact, null);
  assert.equal(storage.get('SELECT COUNT(*) AS n FROM short_form_media_artifacts WHERE content_version_id = ?', [contentVersionId]).n, 0);

  cleanup(storage, dbPath, productionArtifactsDir, mediaArtifactsDir, assetsDir);
});

// --- YouTube Shorts publication ---
//
// NOTE ON TEST SHAPE: the two publish scenarios below deliberately use
// SEPARATE content_versions rather than publishing 'youtube_shorts' then
// 'youtube' back-to-back on the same one. That sequential shape was
// tried first and surfaced a genuine, pre-existing cross-provider
// interaction in ADR-0032's Gate 2 boundary (src/compliance/verify.js):
// Gate 2 requires content_version.state === 'FINAL_COMPLIANCE' and is
// checked BEFORE D-C2 authorization (publication/pipeline.js step 4.7
// vs step 5); the FIRST successful publish (any provider) transitions
// FINAL_COMPLIANCE -> PUBLISHED unconditionally (step 8, no
// provider-scoping), so a SECOND provider attempted afterwards on that
// same content_version fails at Gate 2 (GATE2_NOT_AUTHORIZING) rather
// than reaching D-C2 authorization at all. This is a latent one-shot
// assumption in the existing state machine that predates this task
// (only one provider, 'youtube', ever existed before youtube_shorts),
// not something introduced here, and it will identically affect TikTok
// and Facebook Reels later. Per this task's explicit instruction to
// report rather than invent an architectural fix, it is NOT patched
// here -- these tests instead prove each provider's short-form-vs-long-
// form artifact selection and independent D-C2 authorization correctly,
// each on its own content_version, and the finding is carried into the
// final report as a known cross-provider limitation.

test('YouTube Shorts publication: publishes the short-form artifact via the unmodified YouTubeAdapter shape', async () => {
  const { storage, dbPath } = freshStorage();
  const productionArtifactsDir = freshDir('shortform-e2e-production');
  const mediaArtifactsDir = freshDir('shortform-e2e-media');
  const assetsDir = freshDir('shortform-e2e-assets');
  await storage.migrate();

  const { contentBriefId, contentVersionId } = seedContentVersion(storage);
  const assetA = seedVisualAsset(storage, contentVersionId, makeFixtureImage(assetsDir, 'a.png', 'blue'));
  const assetB = seedVisualAsset(storage, contentVersionId, makeFixtureImage(assetsDir, 'b.png', 'red'));

  runProduction({ storage, contentBriefId, artifactsDir: productionArtifactsDir });
  const longFormResult = runMediaProduction({ storage, contentBriefId, artifactsDir: mediaArtifactsDir });
  const shortResult = runShortFormProduction({ storage, contentBriefId, artifactsDir: mediaArtifactsDir });
  assert.equal(shortResult.outcome, 'RENDERED');

  recordVerification(storage, assetA, 'VERIFIED');
  recordVerification(storage, assetB, 'VERIFIED');
  passGate2(storage, contentVersionId);

  // YouTube Shorts publication needs its OWN D-C2 authorization entry --
  // distinct action id, distinct from the long-form 'youtube' action.
  const shortsDenied = await runPublication({
    storage, contentBriefId, provider: 'youtube_shorts',
    adapter: new MockYouTube({ status: PUBLICATION_RESULT_STATUS.SUCCESS, provider: 'youtube_shorts', providerItemId: 'SHOULD_NOT_BE_USED', providerUrl: 'x' })
  });
  assert.equal(shortsDenied.outcome, 'AUTHORIZATION_DENIED');

  const shortsPublished = await withLiveAuthorized([`publish:youtube_shorts:${contentVersionId}`], async () => {
    const adapter = new MockYouTube({ status: PUBLICATION_RESULT_STATUS.SUCCESS, provider: 'youtube_shorts', providerItemId: 'SHORT_VIDEO_ID', providerUrl: 'https://youtu.be/SHORT_VIDEO_ID' });
    const result = await runPublication({ storage, contentBriefId, provider: 'youtube_shorts', adapter });
    assert.equal(adapter.calls.length, 1);
    // The vertical short-form file was uploaded, NOT the long-form one.
    assert.equal(adapter.calls[0].mediaFilePath, shortResult.mediaArtifact.artifact_path);
    assert.notEqual(adapter.calls[0].mediaFilePath, longFormResult.mediaArtifact.artifact_path);
    return result;
  });
  assert.equal(shortsPublished.outcome, 'PUBLISHED');
  assert.equal(shortsPublished.publication.provider, 'youtube_shorts');
  assert.equal(shortsPublished.publication.provider_item_id, 'SHORT_VIDEO_ID');

  const rows = storage.all('SELECT provider, status, provider_item_id FROM publications WHERE content_version_id = ?', [contentVersionId]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].provider, 'youtube_shorts');
  assert.equal(rows[0].status, 'PUBLISHED');

  cleanup(storage, dbPath, productionArtifactsDir, mediaArtifactsDir, assetsDir);
});

test('existing long-form YouTube publication is unaffected: unchanged authorization + provider behavior on its own content_version', async () => {
  const { storage, dbPath } = freshStorage();
  const productionArtifactsDir = freshDir('shortform-e2e-production');
  const mediaArtifactsDir = freshDir('shortform-e2e-media');
  const assetsDir = freshDir('shortform-e2e-assets');
  await storage.migrate();

  const { contentBriefId, contentVersionId } = seedContentVersion(storage);
  const assetA = seedVisualAsset(storage, contentVersionId, makeFixtureImage(assetsDir, 'a.png', 'blue'));

  runProduction({ storage, contentBriefId, artifactsDir: productionArtifactsDir });
  const longFormResult = runMediaProduction({ storage, contentBriefId, artifactsDir: mediaArtifactsDir });
  // Deliberately no runShortFormProduction() call -- long-form publication
  // must not require a short-form derivative to exist.

  recordVerification(storage, assetA, 'VERIFIED');
  passGate2(storage, contentVersionId);

  const longFormDenied = await runPublication({
    storage, contentBriefId, provider: 'youtube',
    adapter: new MockYouTube({ status: PUBLICATION_RESULT_STATUS.SUCCESS, provider: 'youtube', providerItemId: 'SHOULD_NOT_BE_USED', providerUrl: 'x' })
  });
  assert.equal(longFormDenied.outcome, 'AUTHORIZATION_DENIED');

  const longFormPublished = await withLiveAuthorized([`publish:youtube:${contentVersionId}`], async () => {
    const adapter = new MockYouTube({ status: PUBLICATION_RESULT_STATUS.SUCCESS, provider: 'youtube', providerItemId: 'LONG_VIDEO_ID', providerUrl: 'https://youtu.be/LONG_VIDEO_ID' });
    const result = await runPublication({ storage, contentBriefId, provider: 'youtube', adapter });
    assert.equal(adapter.calls.length, 1);
    assert.equal(adapter.calls[0].mediaFilePath, longFormResult.mediaArtifact.artifact_path);
    return result;
  });
  assert.equal(longFormPublished.outcome, 'PUBLISHED');
  assert.equal(longFormPublished.publication.provider, 'youtube');
  assert.equal(longFormPublished.publication.provider_item_id, 'LONG_VIDEO_ID');

  cleanup(storage, dbPath, productionArtifactsDir, mediaArtifactsDir, assetsDir);
});

test('YouTube Shorts publication before short-form has rendered -> NOT_YET_RENDERED, adapter never called', async () => {
  const { storage, dbPath } = freshStorage();
  const productionArtifactsDir = freshDir('shortform-e2e-production');
  const mediaArtifactsDir = freshDir('shortform-e2e-media');
  const assetsDir = freshDir('shortform-e2e-assets');
  await storage.migrate();

  const { contentBriefId, contentVersionId } = seedContentVersion(storage);
  const assetA = seedVisualAsset(storage, contentVersionId, makeFixtureImage(assetsDir, 'a.png', 'blue'));
  runProduction({ storage, contentBriefId, artifactsDir: productionArtifactsDir });
  runMediaProduction({ storage, contentBriefId, artifactsDir: mediaArtifactsDir });
  // Deliberately no runShortFormProduction() call.

  recordVerification(storage, assetA, 'VERIFIED');
  passGate2(storage, contentVersionId);

  const result = await withLiveAuthorized([`publish:youtube_shorts:${contentVersionId}`], async () => {
    const adapter = new MockYouTube({ status: PUBLICATION_RESULT_STATUS.SUCCESS, provider: 'youtube_shorts', providerItemId: 'SHOULD_NOT_BE_USED', providerUrl: 'x' });
    const r = await runPublication({ storage, contentBriefId, provider: 'youtube_shorts', adapter });
    assert.equal(adapter.calls.length, 0);
    return r;
  });
  assert.equal(result.outcome, 'NOT_YET_RENDERED');
  assert.equal(storage.get('SELECT COUNT(*) AS n FROM publications WHERE content_version_id = ?', [contentVersionId]).n, 0);

  cleanup(storage, dbPath, productionArtifactsDir, mediaArtifactsDir, assetsDir);
});