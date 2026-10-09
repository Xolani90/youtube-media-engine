import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { SqliteStorageDriver } from '../../src/storage/SqliteStorageDriver.js';
import { runPublication } from '../../src/publication/pipeline.js';
import { PublicationProvider } from '../../src/publication/PublicationProvider.js';
import { PUBLICATION_RESULT_STATUS } from '../../src/publication/constants.js';
import { config } from '../../src/config/index.js';
import { generateThumbnailDetailed, generateThumbnailFfmpeg, MAX_THUMBNAIL_BYTES } from '../../src/media/thumbnail.js';
import { passGate2 } from '../helpers/gate2.js';

/*
 * Stage A integration proof: the publication pipeline, driven by a MOCK adapter (no network,
 * no live upload), persists the canvas-rendered thumbnail path + checksum and hands exactly
 * that file to the adapter. Fixture style mirrors publication-pipeline-thumbnail.test.js
 * (re-implemented locally per this repository's per-test-file decoupling convention).
 */

const TITLE = 'Canvas Handoff: 3 Checks on 100% of Inputs';
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function nowISO() { return new Date().toISOString(); }

function freshStorage() {
  const dbPath = path.join(os.tmpdir(), `pub-pipeline-thumb-canvas-${Date.now()}-${Math.random()}.db`);
  return { storage: new SqliteStorageDriver({ dbPath }), dbPath };
}

function cleanup(storage, dbPath, ...files) {
  storage.close();
  for (const f of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`, ...files]) fs.rmSync(f, { force: true });
}

function seedFullyEligibleContent(storage, { mediaFilePath, workingTitle }) {
  const opportunityId = crypto.randomUUID();
  storage.run(`INSERT INTO opportunities (id, title, source, discovered_at, status) VALUES (?, 'T', 'rss', ?, 'DISCOVERED')`, [opportunityId, nowISO()]);
  const contentBriefId = crypto.randomUUID();
  storage.run(
    `INSERT INTO content_briefs
      (id, opportunity_id, working_title, core_question, target_audience, viewer_promise,
       hook, angle, narrative_structure, key_claims, counterpoints, original_insights, visual_ideas,
       monetization_opportunities, risk_assessment, created_at)
     VALUES (?, ?, ?, 'Q', 'A', 'Promise', 'H', 'Angle', 'Structure', '[]', 'C', 'I', 'V', 'M', 'R', ?)`,
    [contentBriefId, opportunityId, workingTitle, nowISO()]
  );
  const scriptId = crypto.randomUUID();
  storage.run(`INSERT INTO scripts (id, content_brief_id, version, body, claim_links, created_at) VALUES (?, ?, 1, 'Body.', '[]', ?)`, [scriptId, contentBriefId, nowISO()]);
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
    [crypto.randomUUID(), productionId, contentVersionId, mediaFilePath, nowISO()]
  );
  if (fs.existsSync(mediaFilePath)) passGate2(storage, contentVersionId);
  return { contentBriefId, contentVersionId };
}

async function withLiveAuthorized(actions, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pub-auth-thumb-canvas-'));
  const filePath = path.join(dir, 'authorized.json');
  fs.writeFileSync(filePath, JSON.stringify(actions));
  const saved = { p: config.authorizedExternalActionsPath, m: config.runMode, a: config.autonomousEnabled };
  config.authorizedExternalActionsPath = filePath;
  config.runMode = 'LIVE';
  config.autonomousEnabled = true;
  try {
    return await fn();
  } finally {
    config.authorizedExternalActionsPath = saved.p;
    config.runMode = saved.m;
    config.autonomousEnabled = saved.a;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Mock adapter: records, at the moment of handoff, the bytes of the file it was given. */
class MockAdapter extends PublicationProvider {
  constructor() {
    super();
    this.publishCalls = [];
    this.thumbnailCalls = [];
  }
  get id() { return 'mock'; }
  async publish(request) {
    this.publishCalls.push(request);
    return { status: PUBLICATION_RESULT_STATUS.SUCCESS, provider: 'mock', providerItemId: 'VIDCANVAS', providerUrl: 'https://youtu.be/VIDCANVAS' };
  }
  async publishThumbnail(args) {
    const bytes = fs.readFileSync(args.thumbnailFilePath);
    this.thumbnailCalls.push({ ...args, handoffSha256: crypto.createHash('sha256').update(bytes).digest('hex'), handoffBytes: bytes.length, handoffSignature: bytes.subarray(0, 8) });
    return { status: PUBLICATION_RESULT_STATUS.SUCCESS, provider: 'mock' };
  }
}

async function publishWithMock(envRenderer) {
  // Private directory: the pipeline writes <dir>/thumbnail.png next to the media file, so a shared dir would race with other test files.
  const mediaDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pub-thumb-canvas-'));
  const mediaFilePath = path.join(mediaDir, 'media.mp4');
  fs.writeFileSync(mediaFilePath, 'fake mp4 bytes');
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  const { contentBriefId, contentVersionId } = seedFullyEligibleContent(storage, { mediaFilePath, workingTitle: TITLE });
  const adapter = new MockAdapter();
  const savedEnv = process.env.THUMBNAIL_RENDERER;
  if (envRenderer === undefined) delete process.env.THUMBNAIL_RENDERER; else process.env.THUMBNAIL_RENDERER = envRenderer;
  try {
    return await withLiveAuthorized([`publish:mock:${contentVersionId}`], async () => {
      const result = await runPublication({ storage, contentBriefId, provider: 'mock', adapter });
      const mediaArtifact = storage.get('SELECT * FROM media_artifacts WHERE content_version_id = ?', [contentVersionId]);
      const snapshot = { result, adapter, mediaArtifact, thumbnailExists: mediaArtifact.thumbnail_path ? fs.existsSync(mediaArtifact.thumbnail_path) : false };
      if (snapshot.thumbnailExists) snapshot.diskSha256 = sha256(mediaArtifact.thumbnail_path);
      if (snapshot.thumbnailExists) snapshot.diskBytes = fs.readFileSync(mediaArtifact.thumbnail_path);
      return snapshot;
    });
  } finally {
    if (savedEnv === undefined) delete process.env.THUMBNAIL_RENDERER; else process.env.THUMBNAIL_RENDERER = savedEnv;
    if (storage) {
      const row = storage.get('SELECT thumbnail_path FROM media_artifacts WHERE content_version_id = ?', [contentVersionId]);
      cleanup(storage, dbPath, mediaFilePath, row?.thumbnail_path);
    }
    fs.rmSync(mediaDir, { recursive: true, force: true });
  }
}

function assertHandoff(s) {
  assert.equal(s.result.outcome, 'PUBLISHED');
  assert.equal(s.result.publication.thumbnail_status, 'SUCCESS');
  assert.ok(s.mediaArtifact.thumbnail_path, 'thumbnail_path persisted');
  assert.ok(s.thumbnailExists, 'thumbnail file exists on disk');

  // Persisted checksum is the real checksum of the real file.
  assert.equal(s.mediaArtifact.thumbnail_checksum, s.diskSha256);

  // The file is a 1280x720 PNG within YouTube's 2MB API limit.
  assert.ok(s.diskBytes.subarray(0, 8).equals(PNG_SIGNATURE));
  assert.equal(s.diskBytes.readUInt32BE(16), 1280);
  assert.equal(s.diskBytes.readUInt32BE(20), 720);
  assert.ok(s.diskBytes.length <= MAX_THUMBNAIL_BYTES);

  // Upload handoff: after the video id was confirmed, exactly this file, with exactly these bytes.
  assert.equal(s.adapter.publishCalls.length, 1);
  assert.equal(s.adapter.thumbnailCalls.length, 1);
  const call = s.adapter.thumbnailCalls[0];
  assert.equal(call.videoId, 'VIDCANVAS');
  assert.equal(call.thumbnailFilePath, s.mediaArtifact.thumbnail_path);
  assert.equal(call.handoffSha256, s.mediaArtifact.thumbnail_checksum, 'adapter received the file whose checksum was persisted');
}

test('default (canvas) renderer: thumbnail path + checksum persisted and the same bytes are handed to the adapter', async () => {
  const s = await publishWithMock(undefined);
  assertHandoff(s);

  // Prove the pipeline really used the canvas renderer: its output equals a direct canvas render of the same title.
  const probe = path.join(os.tmpdir(), `canvas-probe-${crypto.randomUUID()}.png`);
  try {
    const r = generateThumbnailDetailed(TITLE, probe);
    assert.equal(r.renderer, 'canvas');
    assert.equal(sha256(probe), s.mediaArtifact.thumbnail_checksum);
  } finally {
    fs.rmSync(probe, { force: true });
  }
});

test('THUMBNAIL_RENDERER=ffmpeg: the pipeline persists and hands off the FFmpeg fallback output identically', async () => {
  const s = await publishWithMock('ffmpeg');
  assertHandoff(s);

  const probe = path.join(os.tmpdir(), `ffmpeg-probe-${crypto.randomUUID()}.png`);
  try {
    generateThumbnailFfmpeg(TITLE, probe);
    assert.equal(sha256(probe), s.mediaArtifact.thumbnail_checksum);
  } finally {
    fs.rmSync(probe, { force: true });
  }
});
