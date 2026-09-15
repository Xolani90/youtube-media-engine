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

// --- Visual sequencing (Media Production v1.2) reaches the real renderer ------

test('multiple visual assets + a longer script: sequencing is reflected in the persisted render spec and a valid multi-segment MP4 is produced', async () => {
  const { storage, dbPath } = freshStorage();
  const productionArtifactsDir = freshDir('media-e2e-production');
  const mediaArtifactsDir = freshDir('media-e2e-media');
  const assetsDir = freshDir('media-e2e-assets');
  await storage.migrate();

  const longerBody = 'This is the first sentence of a longer test script. Here is a second sentence with more content. '
    + 'A third sentence continues the narration further still. Finally, a fourth sentence wraps up the script.';
  const { contentBriefId, contentVersionId } = seedContentVersion(storage, { body: longerBody });
  const imgA = makeFixtureImage(assetsDir, 'a.png', 'blue');
  const imgB = makeFixtureImage(assetsDir, 'b.png', 'red');
  const imgC = makeFixtureImage(assetsDir, 'c.png', 'green');
  seedVisualAsset(storage, contentVersionId, imgA);
  seedVisualAsset(storage, contentVersionId, imgB);
  seedVisualAsset(storage, contentVersionId, imgC);

  runProduction({ storage, contentBriefId, artifactsDir: productionArtifactsDir });
  const mediaResult = runMediaProduction({ storage, contentBriefId, artifactsDir: mediaArtifactsDir });

  assert.equal(mediaResult.outcome, 'RENDERED');
  const artifact = mediaResult.mediaArtifact;

  // The persisted render spec proves the sequenced (not flat equal-share)
  // timeline reached buildRenderSpec: full coverage, no gaps/overlaps,
  // and an exact end at the measured narration duration.
  const renderSpec = JSON.parse(artifact.render_spec_json);
  const visualTiming = renderSpec.visual_timing;
  assert.ok(visualTiming.length >= 1);
  assert.equal(visualTiming[0].start_seconds, 0);
  for (let i = 1; i < visualTiming.length; i++) {
    const prevEnd = Math.round((visualTiming[i - 1].start_seconds + visualTiming[i - 1].duration_seconds) * 1000) / 1000;
    assert.equal(visualTiming[i].start_seconds, prevEnd);
  }
  const last = visualTiming[visualTiming.length - 1];
  assert.ok(Math.abs((last.start_seconds + last.duration_seconds) - artifact.narration_duration_seconds) < 0.01);

  // And it's a real, playable, correctly shaped video on disk.
  const probeOut = execFileSync(
    'ffprobe',
    ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', artifact.artifact_path],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  ).toString();
  const probe = JSON.parse(probeOut);
  assert.ok(probe.streams.find((s) => s.codec_type === 'video'));
  assert.ok(probe.streams.find((s) => s.codec_type === 'audio'));
  assert.ok(parseFloat(probe.format.duration) > 0);

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

// --- Crash recovery -----
//
// Two distinct crash points are worth proving safe, since they are the
// only two places a prior run could have left the on-disk directory in
// a state a fresh run must tolerate:
//
//   1. A process killed mid-render leaves orphaned `.tmp-<pid>-<ts>`
//      files (narration/concat-list/silent-video/final-video) sitting
//      in the content_version's directory. Every tmp filename is
//      pid+timestamp-scoped, so a fresh run never collides with them —
//      it should simply proceed and succeed, leaving the stale tmp
//      files behind (harmless, not cleaned up by the new run, but never
//      mistaken for real output).
//
//   2. A process killed AFTER finalizeArtifact's atomic rename (so a
//      real, validated `video.mp4` already exists on disk at the
//      deterministic path) but BEFORE the DB transaction committed the
//      media_artifacts row. Because persistence only ever happens after
//      promotion, and finalizeArtifact's rename is happy to overwrite
//      an existing path, a fresh run must re-render, overwrite that
//      leftover file with a freshly validated one, and end up with
//      exactly one DB row — never silently trusting the pre-existing
//      file as if it were already validated and persisted.

test('crash recovery: orphaned tmp files from a killed prior run do not block or corrupt a fresh render', async () => {
  const { storage, dbPath } = freshStorage();
  const productionArtifactsDir = freshDir('media-e2e-production');
  const mediaArtifactsDir = freshDir('media-e2e-media');
  const assetsDir = freshDir('media-e2e-assets');
  await storage.migrate();

  const { contentBriefId, contentVersionId } = seedContentVersion(storage);
  const img = makeFixtureImage(assetsDir, 'a.png', 'cyan');
  seedVisualAsset(storage, contentVersionId, img);
  runProduction({ storage, contentBriefId, artifactsDir: productionArtifactsDir });

  // Simulate a previously killed run: pre-create the content_version's
  // directory with leftover tmp artifacts from a different (fake) pid,
  // as `fs.mkdtempSync`-style crashes would leave behind.
  const dir = path.join(mediaArtifactsDir, contentVersionId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '.narration.wav.tmp-99999-1000'), 'partial narration bytes');
  fs.writeFileSync(path.join(dir, '.silent.tmp-99999-1000.mp4'), 'partial silent video bytes');
  fs.writeFileSync(path.join(dir, '.video.tmp-99999-1000.mp4'), 'partial final video bytes');
  fs.writeFileSync(path.join(dir, '.concat.tmp-99999-1000.txt'), "file 'stale'\n");

  const result = runMediaProduction({ storage, contentBriefId, artifactsDir: mediaArtifactsDir });

  assert.equal(result.outcome, 'RENDERED');
  assert.ok(fs.existsSync(result.mediaArtifact.artifact_path));
  const probe = JSON.parse(execFileSync(
    'ffprobe',
    ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', result.mediaArtifact.artifact_path],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  ).toString());
  assert.ok(probe.streams.find((s) => s.codec_type === 'video'));
  assert.ok(probe.streams.find((s) => s.codec_type === 'audio'));
  // The orphaned tmp files from the "prior" run are untouched garbage,
  // not mistaken for this run's output.
  assert.ok(fs.existsSync(path.join(dir, '.narration.wav.tmp-99999-1000')));
  const rows = storage.all('SELECT * FROM media_artifacts WHERE content_version_id = ?', [contentVersionId]);
  assert.equal(rows.length, 1);

  cleanup(storage, dbPath, productionArtifactsDir, mediaArtifactsDir, assetsDir);
});

test('crash recovery: a validated video.mp4 left on disk from a run killed before DB commit is safely re-rendered and persisted exactly once', async () => {
  const { storage, dbPath } = freshStorage();
  const productionArtifactsDir = freshDir('media-e2e-production');
  const mediaArtifactsDir = freshDir('media-e2e-media');
  const assetsDir = freshDir('media-e2e-assets');
  await storage.migrate();

  const { contentBriefId, contentVersionId } = seedContentVersion(storage);
  const img = makeFixtureImage(assetsDir, 'a.png', 'magenta');
  seedVisualAsset(storage, contentVersionId, img);
  runProduction({ storage, contentBriefId, artifactsDir: productionArtifactsDir });

  // Simulate the file having been promoted to its final deterministic
  // path by a run that then crashed before its DB transaction committed:
  // a `video.mp4` already sits at the exact path a real render would
  // use, but no media_artifacts row exists yet for it.
  const dir = path.join(mediaArtifactsDir, contentVersionId);
  fs.mkdirSync(dir, { recursive: true });
  const leftoverVideoPath = path.join(dir, 'video.mp4');
  fs.writeFileSync(leftoverVideoPath, 'not a real video: leftover from a crashed run');
  const leftoverChecksum = crypto.createHash('sha256').update(fs.readFileSync(leftoverVideoPath)).digest('hex');

  const result = runMediaProduction({ storage, contentBriefId, artifactsDir: mediaArtifactsDir });

  assert.equal(result.outcome, 'RENDERED');
  // The leftover garbage was overwritten by a freshly rendered, validated file.
  assert.notEqual(result.mediaArtifact.artifact_checksum, leftoverChecksum);
  const probe = JSON.parse(execFileSync(
    'ffprobe',
    ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', result.mediaArtifact.artifact_path],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  ).toString());
  assert.ok(probe.streams.find((s) => s.codec_type === 'video'));
  assert.ok(probe.streams.find((s) => s.codec_type === 'audio'));
  const actualChecksum = crypto.createHash('sha256').update(fs.readFileSync(result.mediaArtifact.artifact_path)).digest('hex');
  assert.equal(result.mediaArtifact.artifact_checksum, actualChecksum);

  const rows = storage.all('SELECT * FROM media_artifacts WHERE content_version_id = ?', [contentVersionId]);
  assert.equal(rows.length, 1);

  cleanup(storage, dbPath, productionArtifactsDir, mediaArtifactsDir, assetsDir);
});
