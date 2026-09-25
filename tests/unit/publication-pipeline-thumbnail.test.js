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
import { passGate2 } from '../helpers/gate2.js';

/**
 * Phase 2B integration tests: thumbnail generation + YouTube thumbnail
 * upload as wired into runPublication(). Identical fixture/harness
 * pattern to tests/unit/publication-pipeline.test.js (deliberately
 * re-implemented locally rather than imported, per this repository's
 * existing per-test-file decoupling convention -- see that file's own
 * seedAsset()/withLiveAuthorized() precedent).
 *
 * NOTE: as with every other test in this repository that touches
 * SqliteStorageDriver, these require a working native better-sqlite3
 * binary for this platform. See KNOWN LIMITATIONS in the Phase 2B
 * report for this environment's pre-existing ERR_DLOPEN_FAILED issue.
 */

function freshStorage() {
  const dbPath = path.join(os.tmpdir(), `pub-pipeline-thumb-${Date.now()}-${Math.random()}.db`);
  return { storage: new SqliteStorageDriver({ dbPath }), dbPath };
}

function cleanup(storage, dbPath, ...files) {
  storage.close();
  fs.rmSync(dbPath, { force: true });
  fs.rmSync(`${dbPath}-wal`, { force: true });
  fs.rmSync(`${dbPath}-shm`, { force: true });
  for (const f of files) fs.rmSync(f, { force: true });
}

function nowISO() {
  return new Date().toISOString();
}

function seedFullyEligibleContent(storage, { mediaFilePath, workingTitle = 'My Video' }) {
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
  const mediaArtifactId = crypto.randomUUID();
  storage.run(
    `INSERT INTO media_artifacts
      (id, production_id, content_version_id, render_spec_json, render_spec_checksum,
       narration_path, narration_duration_seconds, artifact_path, artifact_checksum,
       duration_seconds, width, height, video_codec, audio_codec, created_at)
     VALUES (?, ?, ?, '{}', 'chk', '/tmp/n.wav', 5.0, ?, 'chk2', 5.0, 1280, 720, 'h264', 'aac', ?)`,
    [mediaArtifactId, productionId, contentVersionId, mediaFilePath, nowISO()]
  );
  if (fs.existsSync(mediaFilePath)) passGate2(storage, contentVersionId);
  return { contentBriefId, contentVersionId, mediaArtifactId };
}

function withLiveAuthorized(actions, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pub-auth-thumb-'));
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
  });
}

function tmpMediaFile() {
  const p = path.join(os.tmpdir(), `pub-thumb-media-${crypto.randomUUID()}.mp4`);
  fs.writeFileSync(p, 'fake mp4 bytes');
  return p;
}

/** Mock adapter: publish() always SUCCEEDs; publishThumbnail() behavior injected per test. */
class MockAdapterWithThumbnail extends PublicationProvider {
  constructor({ publishResult, thumbnailResultOrFn }) {
    super();
    this._publishResult = publishResult;
    this._thumbnailResultOrFn = thumbnailResultOrFn;
    this.publishCalls = [];
    this.thumbnailCalls = [];
  }
  get id() { return 'mock'; }
  async publish(request) {
    this.publishCalls.push(request);
    return this._publishResult;
  }
  async publishThumbnail(args) {
    this.thumbnailCalls.push(args);
    return typeof this._thumbnailResultOrFn === 'function' ? this._thumbnailResultOrFn(args) : this._thumbnailResultOrFn;
  }
}

/** Mock adapter with NO publishThumbnail method at all -- pre-Phase-2B shape. */
class MockAdapterNoThumbnail extends PublicationProvider {
  constructor(result) {
    super();
    this._result = result;
    this.publishCalls = [];
  }
  get id() { return 'mock'; }
  async publish(request) {
    this.publishCalls.push(request);
    return this._result;
  }
}

test('successful publish generates a thumbnail artifact and uploads it after the video id is confirmed', async () => {
  const mediaFilePath = tmpMediaFile();
  const { storage, dbPath } = freshStorage();
  const { contentBriefId, contentVersionId } = seedFullyEligibleContent(storage, { mediaFilePath, workingTitle: 'A Great Video Title' });
  const adapter = new MockAdapterWithThumbnail({
    publishResult: { status: PUBLICATION_RESULT_STATUS.SUCCESS, provider: 'mock', providerItemId: 'VID123', providerUrl: 'https://youtu.be/VID123' },
    thumbnailResultOrFn: { status: PUBLICATION_RESULT_STATUS.SUCCESS, provider: 'mock' }
  });

  await withLiveAuthorized([{ action: `publish:mock:${contentVersionId}` }], async () => {
    const result = await runPublication({ storage, contentBriefId, provider: 'mock', adapter });
    assert.equal(result.outcome, 'PUBLISHED');
    assert.equal(result.publication.thumbnail_status, 'SUCCESS');

    // Thumbnail artifact was generated and recorded on media_artifacts.
    const mediaArtifact = storage.get('SELECT * FROM media_artifacts WHERE content_version_id = ?', [contentVersionId]);
    assert.ok(mediaArtifact.thumbnail_path, 'thumbnail_path should be set');
    assert.ok(fs.existsSync(mediaArtifact.thumbnail_path), 'thumbnail file should exist on disk');
    assert.ok(mediaArtifact.thumbnail_checksum);

    // Thumbnail upload happened AFTER the video upload, with the confirmed video id.
    assert.equal(adapter.publishCalls.length, 1);
    assert.equal(adapter.thumbnailCalls.length, 1);
    assert.equal(adapter.thumbnailCalls[0].videoId, 'VID123');
    assert.equal(adapter.thumbnailCalls[0].thumbnailFilePath, mediaArtifact.thumbnail_path);

    fs.rmSync(mediaArtifact.thumbnail_path, { force: true });
  });

  cleanup(storage, dbPath, mediaFilePath);
});

test('thumbnail failure does not falsely report a failed or unpublished video, and does not revert PUBLISHED', async () => {
  const mediaFilePath = tmpMediaFile();
  const { storage, dbPath } = freshStorage();
  const { contentBriefId, contentVersionId } = seedFullyEligibleContent(storage, { mediaFilePath });
  const adapter = new MockAdapterWithThumbnail({
    publishResult: { status: PUBLICATION_RESULT_STATUS.SUCCESS, provider: 'mock', providerItemId: 'VID456', providerUrl: 'https://youtu.be/VID456' },
    thumbnailResultOrFn: { status: PUBLICATION_RESULT_STATUS.EXPLICIT_FAILURE, provider: 'mock', errorClass: 'BAD_IMAGE', retryable: false }
  });

  await withLiveAuthorized([{ action: `publish:mock:${contentVersionId}` }], async () => {
    const result = await runPublication({ storage, contentBriefId, provider: 'mock', adapter });
    assert.equal(result.outcome, 'PUBLISHED', 'video publication itself must still report success');
    assert.equal(result.publication.status, 'PUBLISHED');
    assert.equal(result.publication.provider_item_id, 'VID456');
    assert.equal(result.publication.thumbnail_status, 'FAILED');

    const cv = storage.get('SELECT * FROM content_versions WHERE id = ?', [contentVersionId]);
    assert.equal(cv.state, 'PUBLISHED');
  });

  cleanup(storage, dbPath, mediaFilePath);
});

test('resume/retry after a thumbnail failure retries only the thumbnail and never uploads a second video', async () => {
  const mediaFilePath = tmpMediaFile();
  const { storage, dbPath } = freshStorage();
  const { contentBriefId, contentVersionId } = seedFullyEligibleContent(storage, { mediaFilePath });
  let thumbnailAttempt = 0;
  const adapter = new MockAdapterWithThumbnail({
    publishResult: { status: PUBLICATION_RESULT_STATUS.SUCCESS, provider: 'mock', providerItemId: 'VID789', providerUrl: 'https://youtu.be/VID789' },
    thumbnailResultOrFn: () => {
      thumbnailAttempt += 1;
      return thumbnailAttempt === 1
        ? { status: PUBLICATION_RESULT_STATUS.EXPLICIT_FAILURE, provider: 'mock', errorClass: 'TRANSIENT', retryable: true }
        : { status: PUBLICATION_RESULT_STATUS.SUCCESS, provider: 'mock' };
    }
  });

  await withLiveAuthorized([{ action: `publish:mock:${contentVersionId}` }], async () => {
    const first = await runPublication({ storage, contentBriefId, provider: 'mock', adapter });
    assert.equal(first.outcome, 'PUBLISHED');
    assert.equal(first.publication.thumbnail_status, 'FAILED');
    assert.equal(adapter.publishCalls.length, 1);
    assert.equal(adapter.thumbnailCalls.length, 1);

    // Retry: video must NOT be uploaded again; thumbnail must be retried.
    const second = await runPublication({ storage, contentBriefId, provider: 'mock', adapter });
    assert.equal(second.outcome, 'ALREADY_PUBLISHED');
    assert.equal(second.publication.provider_item_id, 'VID789');
    assert.equal(second.publication.thumbnail_status, 'SUCCESS');

    assert.equal(adapter.publishCalls.length, 1, 'video upload must never be repeated');
    assert.equal(adapter.thumbnailCalls.length, 2, 'thumbnail upload should have been retried');
  });

  cleanup(storage, dbPath, mediaFilePath);
});

test('a successful thumbnail is never re-uploaded on a subsequent call (idempotent)', async () => {
  const mediaFilePath = tmpMediaFile();
  const { storage, dbPath } = freshStorage();
  const { contentBriefId, contentVersionId } = seedFullyEligibleContent(storage, { mediaFilePath });
  const adapter = new MockAdapterWithThumbnail({
    publishResult: { status: PUBLICATION_RESULT_STATUS.SUCCESS, provider: 'mock', providerItemId: 'VIDABC', providerUrl: 'https://youtu.be/VIDABC' },
    thumbnailResultOrFn: { status: PUBLICATION_RESULT_STATUS.SUCCESS, provider: 'mock' }
  });

  await withLiveAuthorized([{ action: `publish:mock:${contentVersionId}` }], async () => {
    await runPublication({ storage, contentBriefId, provider: 'mock', adapter });
    await runPublication({ storage, contentBriefId, provider: 'mock', adapter });
    assert.equal(adapter.publishCalls.length, 1);
    assert.equal(adapter.thumbnailCalls.length, 1, 'a SUCCESS thumbnail must never be re-uploaded');
  });

  cleanup(storage, dbPath, mediaFilePath);
});

test('provider without publishThumbnail support: publication behaves exactly as before Phase 2B', async () => {
  const mediaFilePath = tmpMediaFile();
  const { storage, dbPath } = freshStorage();
  const { contentBriefId, contentVersionId } = seedFullyEligibleContent(storage, { mediaFilePath });
  const adapter = new MockAdapterNoThumbnail({ status: PUBLICATION_RESULT_STATUS.SUCCESS, provider: 'mock', providerItemId: 'VIDXYZ', providerUrl: 'https://youtu.be/VIDXYZ' });

  await withLiveAuthorized([{ action: `publish:mock:${contentVersionId}` }], async () => {
    const result = await runPublication({ storage, contentBriefId, provider: 'mock', adapter });
    assert.equal(result.outcome, 'PUBLISHED');
    assert.equal(result.publication.status, 'PUBLISHED');
    assert.equal(result.publication.provider_item_id, 'VIDXYZ');
    // thumbnail_status stays unset -- no thumbnail capability, no attempt, no error.
    assert.ok(result.publication.thumbnail_status == null);
  });

  cleanup(storage, dbPath, mediaFilePath);
});

test('thumbnail upload is never attempted before a confirmed provider video id exists', async () => {
  const mediaFilePath = tmpMediaFile();
  const { storage, dbPath } = freshStorage();
  const { contentBriefId, contentVersionId } = seedFullyEligibleContent(storage, { mediaFilePath });
  const adapter = new MockAdapterWithThumbnail({
    publishResult: { status: PUBLICATION_RESULT_STATUS.EXPLICIT_FAILURE, provider: 'mock', errorClass: 'REJECTED', retryable: true },
    thumbnailResultOrFn: { status: PUBLICATION_RESULT_STATUS.SUCCESS, provider: 'mock' }
  });

  await withLiveAuthorized([{ action: `publish:mock:${contentVersionId}` }], async () => {
    const result = await runPublication({ storage, contentBriefId, provider: 'mock', adapter });
    assert.equal(result.outcome, 'PROVIDER_FAILURE');
    assert.equal(adapter.thumbnailCalls.length, 0, 'no video id was ever confirmed, so no thumbnail call should be made');
  });

  cleanup(storage, dbPath, mediaFilePath);
});