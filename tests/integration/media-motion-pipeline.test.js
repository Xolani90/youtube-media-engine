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
import { sha256File } from '../../src/media/artifactStore.js';
import { runPublication } from '../../src/publication/pipeline.js';
import { PublicationProvider } from '../../src/publication/PublicationProvider.js';
import { PUBLICATION_RESULT_STATUS } from '../../src/publication/constants.js';
import { AssetProvenanceRepository } from '../../src/state/AssetProvenance.js';
import { config } from '../../src/config/index.js';
import { passGate2, recordVerification } from '../helpers/gate2.js';

// Ken Burns motion through the REAL pipeline: Production MVP -> runMediaProduction
// (actual narration + FFmpeg + FFprobe) -> persisted media_artifacts row -> Gate 2 -> publication.

function freshDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
}
const nowISO = () => new Date().toISOString();

async function setup({ images = 2, body = 'This is a short narration script for the motion test video. It has a second sentence too.' } = {}) {
  const dbPath = path.join(os.tmpdir(), `motion-int-${Date.now()}-${Math.random()}.db`);
  const storage = new SqliteStorageDriver({ dbPath });
  await storage.migrate();
  const dirs = { production: freshDir('motion-prod'), media: freshDir('motion-media'), assets: freshDir('motion-assets') };

  const opportunityId = crypto.randomUUID();
  storage.run(`INSERT INTO opportunities (id, title, source, discovered_at, status) VALUES (?, 'Test opportunity', 'rss', ?, 'DISCOVERED')`, [opportunityId, nowISO()]);
  const contentBriefId = crypto.randomUUID();
  storage.run(
    `INSERT INTO content_briefs
      (id, opportunity_id, working_title, core_question, target_audience, viewer_promise,
       hook, angle, narrative_structure, key_claims, counterpoints, original_insights, visual_ideas,
       monetization_opportunities, risk_assessment, created_at)
     VALUES (?, ?, 'Motion E2E Title', 'Q', 'A', 'A concise promise', 'H', 'Angle', 'Structure', '[]', 'C', 'I', 'V', 'M', 'R', ?)`,
    [contentBriefId, opportunityId, nowISO()]
  );
  const scriptId = crypto.randomUUID();
  storage.run(`INSERT INTO scripts (id, content_brief_id, version, body, claim_links, created_at) VALUES (?, ?, 1, ?, '[]', ?)`, [scriptId, contentBriefId, body, nowISO()]);
  const contentVersionId = crypto.randomUUID();
  storage.run(`INSERT INTO content_versions (id, content_brief_id, script_id, state, created_at) VALUES (?, ?, ?, 'PRODUCTION_READY', ?)`, [contentVersionId, contentBriefId, scriptId, nowISO()]);

  const repo = new AssetProvenanceRepository(storage);
  const assetIds = [];
  for (let i = 0; i < images; i++) {
    // 16:9 testsrc stills (not flat colours) so motion changes real pixels.
    const location = path.join(dirs.assets, `img${i}.png`);
    execFileSync('ffmpeg', ['-f', 'lavfi', '-i', `testsrc2=s=640x360:r=1:d=1`, '-vf', `hue=h=${i * 90}`, '-frames:v', '1', '-y', location], { stdio: 'ignore' });
    const assetId = repo.recordAsset({ assetType: 'image', location, verificationStatus: 'VERIFIED' });
    repo.recordUsage({ assetId, contentVersionId, usageContext: 'b-roll' });
    assetIds.push(assetId);
  }
  runProduction({ storage, contentBriefId, artifactsDir: dirs.production });
  return {
    storage, contentBriefId, contentVersionId, assetIds, dirs,
    cleanup: () => {
      storage.close();
      for (const f of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) fs.rmSync(f, { force: true });
      for (const d of Object.values(dirs)) fs.rmSync(d, { recursive: true, force: true });
    }
  };
}

const probe = (file) => JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file]).toString());
const withEnv = (key, value, fn) => {
  const prev = process.env[key];
  if (value === undefined) delete process.env[key]; else process.env[key] = value;
  try { return fn(); } finally { if (prev === undefined) delete process.env[key]; else process.env[key] = prev; }
};

test('H/artifact integrity: still images get motion by default; descriptors are in render_spec (covered by its checksum); artifact flows through the existing row, checksum and validation', async () => {
  const ctx = await setup();
  const res = withEnv('KEN_BURNS_MOTION', undefined, () => runMediaProduction({ storage: ctx.storage, contentBriefId: ctx.contentBriefId, artifactsDir: ctx.dirs.media }));
  assert.equal(res.outcome, 'RENDERED');
  const art = res.mediaArtifact;

  // Same artifact model: one media_artifacts row, bytes match the recorded checksum.
  const row = ctx.storage.get('SELECT * FROM media_artifacts WHERE content_version_id = ?', [ctx.contentVersionId]);
  assert.equal(row.id, art.id);
  assert.equal(sha256File(row.artifact_path), row.artifact_checksum);
  assert.equal(path.basename(row.artifact_path), 'video.mp4');

  // Existing validation contract still holds.
  const p = probe(row.artifact_path);
  const v = p.streams.find((s) => s.codec_type === 'video');
  assert.equal(v.codec_name, 'h264');
  assert.equal(v.width, 1280);
  assert.equal(v.height, 720);
  assert.equal(p.streams.find((s) => s.codec_type === 'audio').codec_name, 'aac');
  assert.equal(row.video_codec, 'h264');
  assert.ok(Math.abs(parseFloat(p.format.duration) - row.narration_duration_seconds) < 0.25, 'video length follows the narration (existing timing contract)');

  // Motion is recorded, deterministic, and part of the checksummed render spec.
  const spec = JSON.parse(row.render_spec_json);
  assert.equal(spec.render_spec_type, 'media_render_spec_v1');
  for (const seg of spec.visual_timing) {
    assert.ok(seg.motion, 'every still-image segment carries a motion descriptor');
    assert.ok(seg.location.endsWith('.png'), 'render_spec still references the SOURCE asset, never the temp clip');
    assert.equal(seg.pre_rendered, undefined, 'temp-render marker never leaks into the persisted spec');
  }
  assert.equal(row.render_spec_checksum, crypto.createHash('sha256').update(row.render_spec_json).digest('hex'));

  // No temp clips left behind.
  assert.deepEqual(fs.readdirSync(path.dirname(row.artifact_path)).filter((f) => f.startsWith('.motion-')), []);

  // The video is genuinely not static: first and last frame of the first segment differ.
  const f0 = path.join(ctx.dirs.media, 'f0.png');
  const f1 = path.join(ctx.dirs.media, 'f1.png');
  const t1 = (spec.visual_timing[0].duration_seconds - 0.2).toFixed(2);
  execFileSync('ffmpeg', ['-y', '-ss', '0', '-i', row.artifact_path, '-frames:v', '1', f0], { stdio: 'ignore' });
  execFileSync('ffmpeg', ['-y', '-ss', t1, '-i', row.artifact_path, '-frames:v', '1', f1], { stdio: 'ignore' });
  assert.notEqual(sha256File(f0), sha256File(f1));
  ctx.cleanup();
});

test('A/H. determinism across independent runs: same assets + same script -> same motion descriptors in the persisted render spec', async () => {
  const a = await setup();
  const b = await setup();
  // Asset ids are random per setup, so compare the rule, not the ids: re-derive from each run's own ids.
  const ra = runMediaProduction({ storage: a.storage, contentBriefId: a.contentBriefId, artifactsDir: a.dirs.media });
  const specA = JSON.parse(ra.mediaArtifact.render_spec_json);
  const { planMotion } = await import('../../src/media/motion.js');
  specA.visual_timing.forEach((seg, i) => assert.deepEqual(seg.motion, planMotion({ assetId: seg.asset_id, segmentIndex: i })));
  // A second render of the SAME content_version is idempotent (existing semantics), not re-motioned.
  const again = runMediaProduction({ storage: a.storage, contentBriefId: a.contentBriefId, artifactsDir: a.dirs.media });
  assert.equal(again.outcome, 'ALREADY_RENDERED');
  assert.equal(again.mediaArtifact.artifact_checksum, ra.mediaArtifact.artifact_checksum);
  a.cleanup(); b.cleanup();
});

test('G. existing renderer regression: KEN_BURNS_MOTION=off renders plain stills exactly as before (no motion in spec, valid artifact)', async () => {
  const ctx = await setup();
  const res = withEnv('KEN_BURNS_MOTION', 'off', () => runMediaProduction({ storage: ctx.storage, contentBriefId: ctx.contentBriefId, artifactsDir: ctx.dirs.media }));
  assert.equal(res.outcome, 'RENDERED');
  const spec = JSON.parse(res.mediaArtifact.render_spec_json);
  for (const seg of spec.visual_timing) assert.equal('motion' in seg, false);
  const v = probe(res.mediaArtifact.artifact_path).streams.find((s) => s.codec_type === 'video');
  assert.equal(v.width, 1280);
  assert.equal(v.height, 720);
  assert.equal(sha256File(res.mediaArtifact.artifact_path), res.mediaArtifact.artifact_checksum);
  ctx.cleanup();
});

test('F/G. invalid motion config and a corrupt image fail with the EXISTING RENDER_FAILED semantics; no artifact row, no leftovers', async () => {
  // Invalid KEN_BURNS_MOTION value.
  const ctx = await setup();
  const bad = withEnv('KEN_BURNS_MOTION', 'sideways', () => runMediaProduction({ storage: ctx.storage, contentBriefId: ctx.contentBriefId, artifactsDir: ctx.dirs.media }));
  assert.equal(bad.outcome, 'RENDER_FAILED');
  assert.match(bad.reason, /motion_CONFIG_INVALID/);
  assert.equal(bad.mediaArtifact, null);
  assert.equal(ctx.storage.get('SELECT COUNT(*) AS n FROM media_artifacts').n, 0);
  ctx.cleanup();

  // An undecodable image (checksum not declared, so the rights/checksum gates pass; motion refuses it).
  const ctx2 = await setup({ images: 1 });
  const asset = ctx2.storage.get('SELECT * FROM assets WHERE id = ?', [ctx2.assetIds[0]]);
  fs.writeFileSync(asset.location, 'not an image');
  const res = runMediaProduction({ storage: ctx2.storage, contentBriefId: ctx2.contentBriefId, artifactsDir: ctx2.dirs.media });
  assert.equal(res.outcome, 'RENDER_FAILED');
  assert.match(res.reason, /motion_INVALID_IMAGE/);
  assert.equal(res.mediaArtifact, null);
  assert.equal(ctx2.storage.get('SELECT COUNT(*) AS n FROM media_artifacts').n, 0);
  const mediaSub = fs.readdirSync(ctx2.dirs.media, { recursive: true }).map(String);
  assert.deepEqual(mediaSub.filter((f) => /\.motion-|\.silent|\.video\.tmp/.test(f)), []);
  ctx2.cleanup();
});

test('I. rights regression: motion cannot bypass the existing rights gate (DISPUTED/UNVERIFIED -> ASSET_RIGHTS_BLOCKED before any motion work)', async () => {
  for (const status of ['DISPUTED', 'UNVERIFIED']) {
    const ctx = await setup({ images: 1 });
    ctx.storage.run('UPDATE assets SET verification_status = ? WHERE id = ?', [status, ctx.assetIds[0]]);
    const res = withEnv('KEN_BURNS_MOTION', 'on', () => runMediaProduction({ storage: ctx.storage, contentBriefId: ctx.contentBriefId, artifactsDir: ctx.dirs.media }));
    assert.equal(res.outcome, 'ASSET_RIGHTS_BLOCKED');
    assert.equal(res.mediaArtifact, null);
    assert.equal(ctx.storage.get('SELECT COUNT(*) AS n FROM media_artifacts').n, 0);
    const leftovers = fs.existsSync(ctx.dirs.media) ? fs.readdirSync(ctx.dirs.media, { recursive: true }).map(String).filter((f) => /\.mp4$/.test(f)) : [];
    assert.deepEqual(leftovers, [], 'no motion clip was rendered for a rights-blocked asset');
    ctx.cleanup();
  }
});

class MockYouTube extends PublicationProvider {
  constructor(provider) { super(); this.providerId = provider; this.calls = []; }
  get id() { return 'youtube'; }
  async publish(request) {
    this.calls.push(request);
    return { status: PUBLICATION_RESULT_STATUS.SUCCESS, provider: this.providerId, providerItemId: 'VID', providerUrl: 'https://youtu.be/VID' };
  }
}

function withLiveAuthorized(actions, fn) {
  const dir = freshDir('motion-auth');
  const filePath = path.join(dir, 'authorized.json');
  fs.writeFileSync(filePath, JSON.stringify(actions));
  const saved = { p: config.authorizedExternalActionsPath, m: config.runMode, a: config.autonomousEnabled };
  config.authorizedExternalActionsPath = filePath;
  config.runMode = 'LIVE';
  config.autonomousEnabled = true;
  return Promise.resolve(fn()).finally(() => {
    config.authorizedExternalActionsPath = saved.p;
    config.runMode = saved.m;
    config.autonomousEnabled = saved.a;
    fs.rmSync(dir, { recursive: true, force: true });
  });
}

test('J. Gate 2 regression: a motion artifact is bound by id + checksum and authorizes only itself; tampering after PASS blocks', async () => {
  const ctx = await setup();
  const long = runMediaProduction({ storage: ctx.storage, contentBriefId: ctx.contentBriefId, artifactsDir: ctx.dirs.media });
  assert.equal(long.outcome, 'RENDERED');
  assert.ok(JSON.parse(long.mediaArtifact.render_spec_json).visual_timing.every((s) => s.motion));
  const short = runShortFormProduction({ storage: ctx.storage, contentBriefId: ctx.contentBriefId, artifactsDir: ctx.dirs.media });
  assert.equal(short.outcome, 'RENDERED');
  for (const id of ctx.assetIds) recordVerification(ctx.storage, id, 'VERIFIED');
  passGate2(ctx.storage, ctx.contentVersionId);

  const record = ctx.storage.get('SELECT * FROM gate2_compliance_records WHERE content_version_id = ? ORDER BY seq DESC LIMIT 1', [ctx.contentVersionId]);
  const evidence = JSON.parse(record.evidence_json);
  assert.equal(record.bound_media_artifact_id, long.mediaArtifact.id);
  assert.deepEqual(evidence.media, { media_artifact_id: long.mediaArtifact.id, artifact_checksum: long.mediaArtifact.artifact_checksum });
  assert.deepEqual(evidence.short_form, { short_form_media_artifact_id: short.mediaArtifact.id, artifact_checksum: short.mediaArtifact.artifact_checksum });

  // Authorized long-form publication uploads exactly the bound file.
  const adapter = new MockYouTube('youtube');
  const out = await withLiveAuthorized([`publish:youtube:${ctx.contentVersionId}`], () =>
    runPublication({ storage: ctx.storage, contentBriefId: ctx.contentBriefId, provider: 'youtube', adapter }));
  assert.equal(out.outcome, 'PUBLISHED');
  assert.equal(adapter.calls[0].mediaFilePath, long.mediaArtifact.artifact_path);
  assert.equal(adapter.calls[0].mediaChecksum, long.mediaArtifact.artifact_checksum);
  ctx.cleanup();

  // Substituting the motion video after PASS is still blocked (identity/checksum binding intact).
  const ctx2 = await setup();
  const long2 = runMediaProduction({ storage: ctx2.storage, contentBriefId: ctx2.contentBriefId, artifactsDir: ctx2.dirs.media });
  for (const id of ctx2.assetIds) recordVerification(ctx2.storage, id, 'VERIFIED');
  passGate2(ctx2.storage, ctx2.contentVersionId);
  fs.appendFileSync(long2.mediaArtifact.artifact_path, Buffer.from('tampered'));
  const adapter2 = new MockYouTube('youtube');
  const out2 = await withLiveAuthorized([`publish:youtube:${ctx2.contentVersionId}`], () =>
    runPublication({ storage: ctx2.storage, contentBriefId: ctx2.contentBriefId, provider: 'youtube', adapter: adapter2 }));
  assert.notEqual(out2.outcome, 'PUBLISHED');
  assert.equal(adapter2.calls.length, 0, 'adapter must NOT be called for a substituted artifact');
  ctx2.cleanup();
});

test('short-form derivative consumes the RECORDED motion descriptors (no re-derive) at 1080x1920; a motionless source stays plain stills', async () => {
  const ctx = await setup();
  const long = runMediaProduction({ storage: ctx.storage, contentBriefId: ctx.contentBriefId, artifactsDir: ctx.dirs.media });
  const short = runShortFormProduction({ storage: ctx.storage, contentBriefId: ctx.contentBriefId, artifactsDir: ctx.dirs.media });
  assert.equal(short.outcome, 'RENDERED');
  const longSpec = JSON.parse(long.mediaArtifact.render_spec_json);
  const shortSpec = JSON.parse(short.mediaArtifact.render_spec_json);
  shortSpec.visual_timing.forEach((seg, i) => assert.deepEqual(seg.motion, longSpec.visual_timing[i].motion));
  const v = probe(short.mediaArtifact.artifact_path).streams.find((s) => s.codec_type === 'video');
  assert.equal(v.width, 1080);
  assert.equal(v.height, 1920);
  assert.equal(sha256File(short.mediaArtifact.artifact_path), short.mediaArtifact.artifact_checksum);
  ctx.cleanup();

  const plain = await setup();
  const l2 = withEnv('KEN_BURNS_MOTION', 'off', () => runMediaProduction({ storage: plain.storage, contentBriefId: plain.contentBriefId, artifactsDir: plain.dirs.media }));
  assert.equal(l2.outcome, 'RENDERED');
  // Even with the toggle back ON, the short-form of a motionless source re-derives nothing.
  const s2 = withEnv('KEN_BURNS_MOTION', 'on', () => runShortFormProduction({ storage: plain.storage, contentBriefId: plain.contentBriefId, artifactsDir: plain.dirs.media }));
  assert.equal(s2.outcome, 'RENDERED');
  assert.ok(JSON.parse(s2.mediaArtifact.render_spec_json).visual_timing.every((s) => !('motion' in s)));
  plain.cleanup();
});
