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
import { writeMusicWav, decodeMono, toneLevelDb, MUSIC_HZ } from '../helpers/audioSignals.js';

// Ken Burns motion through the REAL pipeline: Production MVP -> runMediaProduction
// (actual narration + FFmpeg + FFprobe) -> persisted media_artifacts row -> Gate 2 -> publication.

function freshDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
}
const nowISO = () => new Date().toISOString();

async function setup({ images = 2, music = null, body = 'This is a short narration script for the motion test video. It has a second sentence too.' } = {}) {
  const dbPath = path.join(os.tmpdir(), `audiomix-int-${Date.now()}-${Math.random()}.db`);
  const storage = new SqliteStorageDriver({ dbPath });
  await storage.migrate();
  const dirs = { production: freshDir('am-prod'), media: freshDir('am-media'), assets: freshDir('am-assets') };

  const opportunityId = crypto.randomUUID();
  storage.run(`INSERT INTO opportunities (id, title, source, discovered_at, status) VALUES (?, 'Test opportunity', 'rss', ?, 'DISCOVERED')`, [opportunityId, nowISO()]);
  const contentBriefId = crypto.randomUUID();
  storage.run(
    `INSERT INTO content_briefs
      (id, opportunity_id, working_title, core_question, target_audience, viewer_promise,
       hook, angle, narrative_structure, key_claims, counterpoints, original_insights, visual_ideas,
       monetization_opportunities, risk_assessment, created_at)
     VALUES (?, ?, 'Audio Mix E2E Title', 'Q', 'A', 'A concise promise', 'H', 'Angle', 'Structure', '[]', 'C', 'I', 'V', 'M', 'R', ?)`,
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
  let musicAssetId = null;
  if (music) {
    const location = path.join(dirs.assets, 'bed.wav');
    if (music.corrupt) fs.writeFileSync(location, 'not audio at all');
    else if (!music.missing) writeMusicWav(location, { duration: 2 });
    musicAssetId = repo.recordAsset({ assetType: 'music', location, checksum: fs.existsSync(location) ? sha256File(location) : null, verificationStatus: music.status ?? 'VERIFIED' });
    repo.recordUsage({ assetId: musicAssetId, contentVersionId, usageContext: 'background-music' });
    assetIds.push(musicAssetId);
  }
  runProduction({ storage, contentBriefId, artifactsDir: dirs.production });
  return {
    storage, contentBriefId, contentVersionId, assetIds, musicAssetId, dirs,
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

const run = (ctx) => runMediaProduction({ storage: ctx.storage, contentBriefId: ctx.contentBriefId, artifactsDir: ctx.dirs.media });
const decisions = (ctx, decision) => ctx.storage.all(`SELECT reason FROM decision_log WHERE decision = ? AND stage = 'MEDIA_PRODUCTION'`, [decision]);
const audioOf = (file) => probe(file).streams.find((s) => s.codec_type === 'audio');

class MockYouTube extends PublicationProvider {
  constructor(provider) { super(); this.providerId = provider; this.calls = []; }
  get id() { return 'youtube'; }
  async publish(request) {
    this.calls.push(request);
    return { status: PUBLICATION_RESULT_STATUS.SUCCESS, provider: this.providerId, providerItemId: 'VID', providerUrl: 'https://youtu.be/VID' };
  }
}

function withLiveAuthorized(actions, fn) {
  const dir = freshDir('audiomix-auth');
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

test('A/H. narration-only regression through the real pipeline: no music asset -> RENDERED, no music in render_spec, mono narration track as before', async () => {
  const ctx = await setup();
  const res = run(ctx);
  assert.equal(res.outcome, 'RENDERED');
  assert.ok(!('music' in JSON.parse(res.mediaArtifact.render_spec_json)));
  assert.equal(audioOf(res.mediaArtifact.artifact_path).channels, 1);
  assert.equal(decisions(ctx, 'MUSIC_UNAVAILABLE').length, 0);
  ctx.cleanup();
});

test('B/J. music asset + narration through the real pipeline: mixed stereo artifact, music recorded in render_spec (covered by its checksum), existing row/checksum/validation path', async () => {
  const ctx = await setup({ music: {} });
  const res = withEnv('MUSIC_DUCKING', undefined, () => run(ctx));
  assert.equal(res.outcome, 'RENDERED');
  const a = res.mediaArtifact;
  const spec = JSON.parse(a.render_spec_json);
  assert.equal(spec.music.asset_id, ctx.musicAssetId);
  assert.equal(spec.music.sha256, sha256File(path.join(ctx.dirs.assets, 'bed.wav')));
  assert.equal(spec.music.params.ratio, 12);
  assert.equal(audioOf(a.artifact_path).channels, 2, 'the mix is stereo (music bed present)');
  assert.equal(audioOf(a.artifact_path).codec_name, 'aac');
  // the music really is in the file: the 220 Hz bed is audible in the decoded artifact
  const dec = decodeMono(a.artifact_path);
  assert.ok(toneLevelDb(dec, MUSIC_HZ, 0.2, 1.5) > -80);
  assert.equal(sha256File(a.artifact_path), a.artifact_checksum);
  const row = ctx.storage.get('SELECT * FROM media_artifacts WHERE content_version_id = ?', [ctx.contentVersionId]);
  assert.equal(row.id, a.id);
  assert.equal(ctx.storage.get('SELECT COUNT(*) AS n FROM media_artifacts').n, 1);
  assert.equal(ctx.storage.get('SELECT COUNT(*) AS n FROM publications').n, 0);
  // render_spec checksum is over the stored JSON including the music record
  assert.equal(a.render_spec_checksum, crypto.createHash('sha256').update(a.render_spec_json).digest('hex'));
  // idempotent: a second run returns the same artifact and does not re-render
  const again = run(ctx);
  assert.equal(again.outcome, 'ALREADY_RENDERED');
  assert.equal(again.mediaArtifact.id, a.id);
  ctx.cleanup();
});

test('D. determinism through the pipeline: two independent runs record identical music/ducking configuration', async () => {
  const one = await setup({ music: {} });
  const two = await setup({ music: {} });
  const s1 = JSON.parse(run(one).mediaArtifact.render_spec_json).music;
  const s2 = JSON.parse(run(two).mediaArtifact.render_spec_json).music;
  assert.deepEqual({ ...s1, asset_id: null }, { ...s2, asset_id: null });
  one.cleanup(); two.cleanup();
});

test('H. missing music file or MUSIC_DUCKING=off -> unchanged narration-only render, the reason is recorded (never silent)', async () => {
  const missing = await setup({ music: { missing: true } });
  const r1 = run(missing);
  assert.equal(r1.outcome, 'RENDERED');
  assert.ok(!('music' in JSON.parse(r1.mediaArtifact.render_spec_json)));
  assert.equal(audioOf(r1.mediaArtifact.artifact_path).channels, 1);
  assert.match(decisions(missing, 'MUSIC_UNAVAILABLE')[0].reason, /file_missing/);
  missing.cleanup();

  const off = await setup({ music: {} });
  const r2 = withEnv('MUSIC_DUCKING', 'off', () => run(off));
  assert.equal(r2.outcome, 'RENDERED');
  assert.ok(!('music' in JSON.parse(r2.mediaArtifact.render_spec_json)));
  assert.match(decisions(off, 'MUSIC_UNAVAILABLE')[0].reason, /mixing_disabled/);
  off.cleanup();
});

test('G. invalid music (undecodable file) and invalid MUSIC_DUCKING fail with the EXISTING RENDER_FAILED semantics: no artifact row, no leftovers', async () => {
  const ctx = await setup({ music: { corrupt: true } });
  const res = run(ctx);
  assert.equal(res.outcome, 'RENDER_FAILED');
  assert.match(res.reason, /MUSIC_INVALID/);
  assert.equal(res.mediaArtifact, null);
  assert.equal(ctx.storage.get('SELECT COUNT(*) AS n FROM media_artifacts').n, 0);
  const leftovers = fs.existsSync(ctx.dirs.media) ? fs.readdirSync(ctx.dirs.media, { recursive: true }).map(String).filter((f) => /\.(mp4|tmp)/.test(f)) : [];
  assert.deepEqual(leftovers, []);
  ctx.cleanup();

  const bad = await setup({ music: {} });
  const res2 = withEnv('MUSIC_DUCKING', 'sometimes', () => run(bad));
  assert.equal(res2.outcome, 'RENDER_FAILED');
  assert.match(res2.reason, /MUSIC_DUCKING/);
  assert.equal(bad.storage.get('SELECT COUNT(*) AS n FROM media_artifacts').n, 0);
  bad.cleanup();
});

test('K. rights regression: audio mixing cannot bypass the rights gate -- UNVERIFIED/DISPUTED music -> ASSET_RIGHTS_BLOCKED before any audio work; checksum drift -> ASSET_CHECKSUM_MISMATCH', async () => {
  for (const status of ['UNVERIFIED', 'DISPUTED']) {
    const ctx = await setup({ music: {} });
    // Production MVP already refuses unverified assets, so flip the status AFTER production (rights can change before render).
    ctx.storage.run('UPDATE assets SET verification_status = ? WHERE id = ?', [status, ctx.musicAssetId]);
    const res = run(ctx);
    assert.equal(res.outcome, 'ASSET_RIGHTS_BLOCKED', status);
    assert.equal(res.mediaArtifact, null);
    assert.equal(ctx.storage.get('SELECT COUNT(*) AS n FROM media_artifacts').n, 0);
    const leftovers = fs.existsSync(ctx.dirs.media) ? fs.readdirSync(ctx.dirs.media, { recursive: true }).map(String).filter((f) => /\.(mp4|wav)$/.test(f)) : [];
    assert.deepEqual(leftovers, [], 'nothing was narrated, rendered or mixed');
    ctx.cleanup();
  }
  const drift = await setup({ music: {} });
  fs.appendFileSync(path.join(drift.dirs.assets, 'bed.wav'), Buffer.from('tamper'));
  const res = run(drift);
  assert.equal(res.outcome, 'ASSET_CHECKSUM_MISMATCH');
  assert.equal(res.mediaArtifact, null);
  drift.cleanup();
  // a music asset that is merely NOT verified is not usable even when images are fine
  const mixed = await setup({ music: {} });
  mixed.storage.run('UPDATE assets SET verification_status = ? WHERE id = ?', ['UNVERIFIED', mixed.musicAssetId]);
  assert.equal(run(mixed).outcome, 'ASSET_RIGHTS_BLOCKED');
  mixed.cleanup();
});

test('L. Gate 2 regression: a music-mixed artifact is bound by id + checksum, publishes exactly that file, and tampering after PASS blocks', async () => {
  const ctx = await setup({ music: {} });
  const long = run(ctx);
  assert.equal(long.outcome, 'RENDERED');
  assert.ok(JSON.parse(long.mediaArtifact.render_spec_json).music);
  const short = runShortFormProduction({ storage: ctx.storage, contentBriefId: ctx.contentBriefId, artifactsDir: ctx.dirs.media });
  assert.equal(short.outcome, 'RENDERED', 'short-form derivative still renders from a music-mixed source');
  for (const id of ctx.assetIds) recordVerification(ctx.storage, id, 'VERIFIED');
  passGate2(ctx.storage, ctx.contentVersionId);
  const record = ctx.storage.get('SELECT * FROM gate2_compliance_records WHERE content_version_id = ? ORDER BY seq DESC LIMIT 1', [ctx.contentVersionId]);
  assert.equal(record.bound_media_artifact_id, long.mediaArtifact.id);
  assert.deepEqual(JSON.parse(record.evidence_json).media, { media_artifact_id: long.mediaArtifact.id, artifact_checksum: long.mediaArtifact.artifact_checksum });
  const adapter = new MockYouTube('youtube');
  const out = await withLiveAuthorized([`publish:youtube:${ctx.contentVersionId}`], () =>
    runPublication({ storage: ctx.storage, contentBriefId: ctx.contentBriefId, provider: 'youtube', adapter }));
  assert.equal(out.outcome, 'PUBLISHED');
  assert.equal(adapter.calls[0].mediaFilePath, long.mediaArtifact.artifact_path);
  assert.equal(adapter.calls[0].mediaChecksum, long.mediaArtifact.artifact_checksum);
  ctx.cleanup();

  const ctx2 = await setup({ music: {} });
  const long2 = run(ctx2);
  for (const id of ctx2.assetIds) recordVerification(ctx2.storage, id, 'VERIFIED');
  passGate2(ctx2.storage, ctx2.contentVersionId);
  fs.appendFileSync(long2.mediaArtifact.artifact_path, Buffer.from('tampered'));
  const adapter2 = new MockYouTube('youtube');
  const out2 = await withLiveAuthorized([`publish:youtube:${ctx2.contentVersionId}`], () =>
    runPublication({ storage: ctx2.storage, contentBriefId: ctx2.contentBriefId, provider: 'youtube', adapter: adapter2 }));
  assert.notEqual(out2.outcome, 'PUBLISHED');
  assert.equal(adapter2.calls.length, 0);
  ctx2.cleanup();
});
