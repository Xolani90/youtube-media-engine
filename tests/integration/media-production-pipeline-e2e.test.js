import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { SqliteStorageDriver } from '../../src/storage/SqliteStorageDriver.js';
import { runProduction } from '../../src/production/pipeline.js';
import { runMediaProduction } from '../../src/media/pipeline.js';
import { AssetProvenanceRepository } from '../../src/state/AssetProvenance.js';

function freshStorage() {
  const dbPath = path.join(os.tmpdir(), `media-e2e-${Date.now()}-${Math.random()}.db`);
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
     VALUES (?, ?, 'T', 'Q', 'A', 'P', 'H', 'Angle', 'Structure', '[]', 'C', 'I', 'V', 'M', 'R', ?)`,
    [id, opportunityId, nowISO()]
  );
  return id;
}

function seedContentVersion(storage, { state = 'PRODUCTION_READY', body = 'This is a short narration script for the test video.' } = {}) {
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
    `INSERT INTO content_versions (id, content_brief_id, script_id, state, created_at) VALUES (?, ?, ?, ?, ?)`,
    [contentVersionId, contentBriefId, scriptId, state, nowISO()]
  );
  return { contentBriefId, scriptId, contentVersionId };
}

/** Creates a real on-disk PNG fixture (via FFmpeg) so the renderer has actual visual asset files to consume, not just DB rows. */
function makeFixtureImage(dir, name, color) {
  const location = path.join(dir, name);
  execFileSync('ffmpeg', ['-f', 'lavfi', '-i', `color=c=${color}:s=64x64:d=1`, '-frames:v', '1', '-y', location], {
    stdio: ['ignore', 'pipe', 'pipe']
  });
  return location;
}

function seedVisualAsset(storage, contentVersionId, location, verificationStatus = 'VERIFIED') {
  const repo = new AssetProvenanceRepository(storage);
  const assetId = repo.recordAsset({ assetType: 'image', location, verificationStatus });
  repo.recordUsage({ assetId, contentVersionId, usageContext: 'b-roll' });
  return assetId;
}

// --- Full end-to-end: PRODUCED content -> real, validated MP4 -----

test('end-to-end: production manifest -> narration -> render spec -> FFmpeg -> FFprobe -> persisted media artifact', async () => {
  const { storage, dbPath } = freshStorage();
  const productionArtifactsDir = freshDir('media-e2e-production');
  const mediaArtifactsDir = freshDir('media-e2e-media');
  const assetsDir = freshDir('media-e2e-assets');
  await storage.migrate();

  const { contentBriefId, contentVersionId } = seedContentVersion(storage);
  const imgA = makeFixtureImage(assetsDir, 'a.png', 'blue');
  const imgB = makeFixtureImage(assetsDir, 'b.png', 'red');
  seedVisualAsset(storage, contentVersionId, imgA);
  seedVisualAsset(storage, contentVersionId, imgB);

  // Drive through Production MVP first (Media Production's stated precondition).
  const productionResult = runProduction({ storage, contentBriefId, artifactsDir: productionArtifactsDir });
  assert.equal(productionResult.outcome, 'PRODUCED');

  const mediaResult = runMediaProduction({ storage, contentBriefId, artifactsDir: mediaArtifactsDir });

  assert.equal(mediaResult.outcome, 'RENDERED');
  const artifact = mediaResult.mediaArtifact;
  assert.ok(artifact);
  assert.equal(artifact.content_version_id, contentVersionId);

  // Prove it's a real, playable video: inspect the actual file via FFprobe.
  assert.ok(fs.existsSync(artifact.artifact_path));
  assert.ok(fs.statSync(artifact.artifact_path).size > 0);
  const probeOut = execFileSync(
    'ffprobe',
    ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', artifact.artifact_path],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  ).toString();
  const probe = JSON.parse(probeOut);
  const videoStream = probe.streams.find((s) => s.codec_type === 'video');
  const audioStream = probe.streams.find((s) => s.codec_type === 'audio');
  assert.ok(videoStream);
  assert.ok(audioStream);
  assert.equal(videoStream.codec_name, 'h264');
  assert.equal(audioStream.codec_name, 'aac');
  assert.equal(videoStream.width, 1280);
  assert.equal(videoStream.height, 720);
  assert.ok(parseFloat(probe.format.duration) > 0);

  // DB record matches the on-disk artifact.
  assert.equal(artifact.width, 1280);
  assert.equal(artifact.height, 720);
  assert.equal(artifact.video_codec, 'h264');
  assert.equal(artifact.audio_codec, 'aac');
  assert.ok(artifact.duration_seconds > 0);
  const actualChecksum = crypto.createHash('sha256').update(fs.readFileSync(artifact.artifact_path)).digest('hex');
  assert.equal(artifact.artifact_checksum, actualChecksum);

  // content_versions.state is untouched by Media Production (still PRODUCED, set by Production MVP).
  const cv = storage.get('SELECT * FROM content_versions WHERE id = ?', [contentVersionId]);
  assert.equal(cv.state, 'PRODUCED');

  cleanup(storage, dbPath, productionArtifactsDir, mediaArtifactsDir, assetsDir);
});

// --- Idempotency: repeated run does not duplicate ------

test('repeated media production for the same content_version returns the existing record, no duplicate row', async () => {
  const { storage, dbPath } = freshStorage();
  const productionArtifactsDir = freshDir('media-e2e-production');
  const mediaArtifactsDir = freshDir('media-e2e-media');
  const assetsDir = freshDir('media-e2e-assets');
  await storage.migrate();

  const { contentBriefId, contentVersionId } = seedContentVersion(storage);
  const img = makeFixtureImage(assetsDir, 'a.png', 'green');
  seedVisualAsset(storage, contentVersionId, img);
  runProduction({ storage, contentBriefId, artifactsDir: productionArtifactsDir });

  const first = runMediaProduction({ storage, contentBriefId, artifactsDir: mediaArtifactsDir });
  const second = runMediaProduction({ storage, contentBriefId, artifactsDir: mediaArtifactsDir });

  assert.equal(first.outcome, 'RENDERED');
  assert.equal(second.outcome, 'ALREADY_RENDERED');
  assert.equal(second.mediaArtifact.id, first.mediaArtifact.id);
  const rows = storage.all('SELECT * FROM media_artifacts WHERE content_version_id = ?', [contentVersionId]);
  assert.equal(rows.length, 1);

  cleanup(storage, dbPath, productionArtifactsDir, mediaArtifactsDir, assetsDir);
});

// --- Not yet produced ------

test('content still at PRODUCTION_READY (Production MVP not yet run) -> NOT_YET_PRODUCED, no artifact', async () => {
  const { storage, dbPath } = freshStorage();
  const mediaArtifactsDir = freshDir('media-e2e-media');
  const assetsDir = freshDir('media-e2e-assets');
  await storage.migrate();

  const { contentBriefId, contentVersionId } = seedContentVersion(storage);
  const img = makeFixtureImage(assetsDir, 'a.png', 'yellow');
  seedVisualAsset(storage, contentVersionId, img);
  // Deliberately skip runProduction: no `productions` row exists yet.

  const result = runMediaProduction({ storage, contentBriefId, artifactsDir: mediaArtifactsDir });

  assert.equal(result.outcome, 'NOT_YET_PRODUCED');
  assert.equal(result.mediaArtifact, null);
  assert.equal(storage.get('SELECT * FROM media_artifacts WHERE content_version_id = ?', [contentVersionId]), undefined);

  cleanup(storage, dbPath, mediaArtifactsDir, assetsDir);
});

// --- No visual assets ------

test('PRODUCED content with no usable visual assets -> NO_VISUAL_ASSETS, no artifact', async () => {
  const { storage, dbPath } = freshStorage();
  const productionArtifactsDir = freshDir('media-e2e-production');
  const mediaArtifactsDir = freshDir('media-e2e-media');
  await storage.migrate();

  const { contentBriefId, contentVersionId } = seedContentVersion(storage);
  // No assets attached at all.
  runProduction({ storage, contentBriefId, artifactsDir: productionArtifactsDir });

  const result = runMediaProduction({ storage, contentBriefId, artifactsDir: mediaArtifactsDir });

  assert.equal(result.outcome, 'NO_VISUAL_ASSETS');
  assert.equal(result.mediaArtifact, null);
  assert.equal(storage.get('SELECT * FROM media_artifacts WHERE content_version_id = ?', [contentVersionId]), undefined);

  cleanup(storage, dbPath, productionArtifactsDir, mediaArtifactsDir);
});

// --- DISPUTED asset blocked at render time ------

test('DISPUTED asset at render time -> ASSET_RIGHTS_BLOCKED, no artifact persisted', async () => {
  const { storage, dbPath } = freshStorage();
  const productionArtifactsDir = freshDir('media-e2e-production');
  const mediaArtifactsDir = freshDir('media-e2e-media');
  const assetsDir = freshDir('media-e2e-assets');
  await storage.migrate();

  const { contentBriefId, contentVersionId } = seedContentVersion(storage);
  const img = makeFixtureImage(assetsDir, 'a.png', 'purple');
  // VERIFIED at Production MVP time so it can pass through...
  seedVisualAsset(storage, contentVersionId, img, 'VERIFIED');
  runProduction({ storage, contentBriefId, artifactsDir: productionArtifactsDir });

  // ...but disputed by the time Media Production re-checks D-G2.
  const asset = storage.get('SELECT * FROM assets WHERE location = ?', [img]);
  storage.run('UPDATE assets SET verification_status = ? WHERE id = ?', ['DISPUTED', asset.id]);

  const result = runMediaProduction({ storage, contentBriefId, artifactsDir: mediaArtifactsDir });

  assert.equal(result.outcome, 'ASSET_RIGHTS_BLOCKED');
  assert.equal(result.mediaArtifact, null);
  assert.equal(storage.get('SELECT * FROM media_artifacts WHERE content_version_id = ?', [contentVersionId]), undefined);

  cleanup(storage, dbPath, productionArtifactsDir, mediaArtifactsDir, assetsDir);
});

// --- Missing asset file on disk ------

test('visual asset file missing from disk at render time -> RENDER_FAILED, no artifact persisted', async () => {
  const { storage, dbPath } = freshStorage();
  const productionArtifactsDir = freshDir('media-e2e-production');
  const mediaArtifactsDir = freshDir('media-e2e-media');
  const assetsDir = freshDir('media-e2e-assets');
  await storage.migrate();

  const { contentBriefId, contentVersionId } = seedContentVersion(storage);
  const img = makeFixtureImage(assetsDir, 'a.png', 'orange');
  seedVisualAsset(storage, contentVersionId, img);
  runProduction({ storage, contentBriefId, artifactsDir: productionArtifactsDir });

  fs.rmSync(img, { force: true });

  const result = runMediaProduction({ storage, contentBriefId, artifactsDir: mediaArtifactsDir });

  assert.equal(result.outcome, 'RENDER_FAILED');
  assert.equal(result.mediaArtifact, null);
  assert.equal(storage.get('SELECT * FROM media_artifacts WHERE content_version_id = ?', [contentVersionId]), undefined);

  cleanup(storage, dbPath, productionArtifactsDir, mediaArtifactsDir, assetsDir);
});
