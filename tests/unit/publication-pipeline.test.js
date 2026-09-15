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

/**
 * These tests exercise the provider-neutral core only, via a mock
 * adapter conforming to PublicationProvider -- never the real YouTube
 * adapter, and never real network/credentials. Every real caller
 * reaches D-C2 through config.runMode/config.autonomousEnabled/
 * config.authorizedExternalActionsPath, so (mirroring
 * tests/unit/side-effect-authorization.test.js's own convention) these
 * tests mutate that same config object for the duration of each test
 * and restore it afterward, rather than threading a parallel
 * test-only override through runPublication.
 */

function freshStorage() {
  const dbPath = path.join(os.tmpdir(), `pub-pipeline-${Date.now()}-${Math.random()}.db`);
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

function seedFullyEligibleContent(storage, { mediaFilePath }) {
  const opportunityId = crypto.randomUUID();
  storage.run(`INSERT INTO opportunities (id, title, source, discovered_at, status) VALUES (?, 'T', 'rss', ?, 'DISCOVERED')`, [opportunityId, nowISO()]);
  const contentBriefId = crypto.randomUUID();
  storage.run(
    `INSERT INTO content_briefs
      (id, opportunity_id, working_title, core_question, target_audience, viewer_promise,
       hook, angle, narrative_structure, key_claims, counterpoints, original_insights, visual_ideas,
       monetization_opportunities, risk_assessment, created_at)
     VALUES (?, ?, 'My Video', 'Q', 'A', 'Promise', 'H', 'Angle', 'Structure', '[]', 'C', 'I', 'V', 'M', 'R', ?)`,
    [contentBriefId, opportunityId, nowISO()]
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
  return { contentBriefId, contentVersionId, mediaArtifactId };
}

function withLiveAuthorized(actions, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pub-auth-'));
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

class MockAdapter extends PublicationProvider {
  constructor(resultOrFn) {
    super();
    this._resultOrFn = resultOrFn;
    this.calls = [];
  }
  get id() {
    return 'mock';
  }
  async publish(request) {
    this.calls.push(request);
    return typeof this._resultOrFn === 'function' ? this._resultOrFn(request) : this._resultOrFn;
  }
}

test('NOT_YET_RENDERED when Media Production has not rendered anything', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  const opportunityId = crypto.randomUUID();
  storage.run(`INSERT INTO opportunities (id, title, source, discovered_at, status) VALUES (?, 'T', 'rss', ?, 'DISCOVERED')`, [opportunityId, nowISO()]);
  const contentBriefId = crypto.randomUUID();
  storage.run(
    `INSERT INTO content_briefs (id, opportunity_id, working_title, created_at) VALUES (?, ?, 'T', ?)`,
    [contentBriefId, opportunityId, nowISO()]
  );
  const scriptId = crypto.randomUUID();
  storage.run(`INSERT INTO scripts (id, content_brief_id, version, body, claim_links, created_at) VALUES (?, ?, 1, 'Body.', '[]', ?)`, [scriptId, contentBriefId, nowISO()]);
  const contentVersionId = crypto.randomUUID();
  storage.run(`INSERT INTO content_versions (id, content_brief_id, script_id, state, created_at) VALUES (?, ?, ?, 'PRODUCED', ?)`, [contentVersionId, contentBriefId, scriptId, nowISO()]);

  const result = await runPublication({ storage, contentBriefId, provider: 'mock', adapter: new MockAdapter({}) });
  assert.equal(result.outcome, 'NOT_YET_RENDERED');

  cleanup(storage, dbPath);
});

test('AUTHORIZATION_DENIED when D-C2 denies (SIMULATION default) -- adapter never called', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  const videoFile = path.join(os.tmpdir(), `pub-video-${crypto.randomUUID()}.mp4`);
  fs.writeFileSync(videoFile, 'fake mp4 bytes');
  const { contentBriefId } = seedFullyEligibleContent(storage, { mediaFilePath: videoFile });

  const adapter = new MockAdapter({ status: PUBLICATION_RESULT_STATUS.SUCCESS, provider: 'mock', providerItemId: 'abc', providerUrl: 'https://example.com/abc' });
  // Default config in this test process is SIMULATION / autonomousEnabled=false, so no override needed.
  const result = await runPublication({ storage, contentBriefId, provider: 'mock', adapter });

  assert.equal(result.outcome, 'AUTHORIZATION_DENIED');
  assert.equal(adapter.calls.length, 0);
  const row = storage.get('SELECT * FROM publications WHERE content_version_id IS NOT NULL');
  assert.equal(row, undefined);

  cleanup(storage, dbPath, videoFile);
});

test('confirmed SUCCESS: persists a PUBLISHED row and transitions PRODUCED -> PUBLISHED', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  const videoFile = path.join(os.tmpdir(), `pub-video-${crypto.randomUUID()}.mp4`);
  fs.writeFileSync(videoFile, 'fake mp4 bytes');
  const { contentBriefId, contentVersionId } = seedFullyEligibleContent(storage, { mediaFilePath: videoFile });

  const result = await withLiveAuthorized([`publish:mock:${contentVersionId}`], async () => {
    const adapter = new MockAdapter({ status: PUBLICATION_RESULT_STATUS.SUCCESS, provider: 'mock', providerItemId: 'vid123', providerUrl: 'https://youtu.be/vid123' });
    return runPublication({ storage, contentBriefId, provider: 'mock', adapter });
  });

  assert.equal(result.outcome, 'PUBLISHED');
  assert.equal(result.publication.status, 'PUBLISHED');
  assert.equal(result.publication.provider_item_id, 'vid123');
  assert.equal(result.publication.provider_url, 'https://youtu.be/vid123');

  const cv = storage.get('SELECT * FROM content_versions WHERE id = ?', [contentVersionId]);
  assert.equal(cv.state, 'PUBLISHED');

  cleanup(storage, dbPath, videoFile);
});

test('idempotency: a second invocation after confirmed PUBLISHED returns the existing record and never calls the adapter again', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  const videoFile = path.join(os.tmpdir(), `pub-video-${crypto.randomUUID()}.mp4`);
  fs.writeFileSync(videoFile, 'fake mp4 bytes');
  const { contentBriefId, contentVersionId } = seedFullyEligibleContent(storage, { mediaFilePath: videoFile });

  await withLiveAuthorized([`publish:mock:${contentVersionId}`], async () => {
    const adapter = new MockAdapter({ status: PUBLICATION_RESULT_STATUS.SUCCESS, provider: 'mock', providerItemId: 'vid123', providerUrl: 'https://youtu.be/vid123' });
    const first = await runPublication({ storage, contentBriefId, provider: 'mock', adapter });
    assert.equal(first.outcome, 'PUBLISHED');

    const adapter2 = new MockAdapter({ status: PUBLICATION_RESULT_STATUS.SUCCESS, provider: 'mock', providerItemId: 'SHOULD_NOT_HAPPEN', providerUrl: 'x' });
    const second = await runPublication({ storage, contentBriefId, provider: 'mock', adapter: adapter2 });
    assert.equal(second.outcome, 'ALREADY_PUBLISHED');
    assert.equal(second.publication.provider_item_id, 'vid123');
    assert.equal(adapter2.calls.length, 0, 'adapter must never be invoked once a confirmed publication exists');
  });

  cleanup(storage, dbPath, videoFile);
});

test('explicit provider failure: content_version remains PRODUCED, no lifecycle transition, safe to retry later', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  const videoFile = path.join(os.tmpdir(), `pub-video-${crypto.randomUUID()}.mp4`);
  fs.writeFileSync(videoFile, 'fake mp4 bytes');
  const { contentBriefId, contentVersionId } = seedFullyEligibleContent(storage, { mediaFilePath: videoFile });

  const result = await withLiveAuthorized([`publish:mock:${contentVersionId}`], async () => {
    const adapter = new MockAdapter({ status: PUBLICATION_RESULT_STATUS.EXPLICIT_FAILURE, provider: 'mock', errorClass: 'REJECTED_METADATA', retryable: false });
    return runPublication({ storage, contentBriefId, provider: 'mock', adapter });
  });

  assert.equal(result.outcome, 'PROVIDER_FAILURE');
  assert.equal(result.publication.status, 'FAILED');
  const cv = storage.get('SELECT * FROM content_versions WHERE id = ?', [contentVersionId]);
  assert.equal(cv.state, 'PRODUCED');

  cleanup(storage, dbPath, videoFile);
});

test('ambiguous provider result: no transition, never blindly retried on the next invocation', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  const videoFile = path.join(os.tmpdir(), `pub-video-${crypto.randomUUID()}.mp4`);
  fs.writeFileSync(videoFile, 'fake mp4 bytes');
  const { contentBriefId, contentVersionId } = seedFullyEligibleContent(storage, { mediaFilePath: videoFile });

  await withLiveAuthorized([`publish:mock:${contentVersionId}`], async () => {
    const adapter = new MockAdapter({ status: PUBLICATION_RESULT_STATUS.AMBIGUOUS, provider: 'mock', reconciliationInfo: { note: 'timeout' } });
    const first = await runPublication({ storage, contentBriefId, provider: 'mock', adapter });
    assert.equal(first.outcome, 'AMBIGUOUS');

    const cv = storage.get('SELECT * FROM content_versions WHERE id = ?', [contentVersionId]);
    assert.equal(cv.state, 'PRODUCED');

    const adapter2 = new MockAdapter({ status: PUBLICATION_RESULT_STATUS.SUCCESS, provider: 'mock', providerItemId: 'x', providerUrl: 'y' });
    const second = await runPublication({ storage, contentBriefId, provider: 'mock', adapter: adapter2 });
    assert.equal(second.outcome, 'AMBIGUOUS');
    assert.equal(adapter2.calls.length, 0, 'an ambiguous result must never be auto-retried');
  });

  cleanup(storage, dbPath, videoFile);
});

test('crash recovery: a PENDING row left over from an interrupted attempt is treated as ambiguous, not retried', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  const videoFile = path.join(os.tmpdir(), `pub-video-${crypto.randomUUID()}.mp4`);
  fs.writeFileSync(videoFile, 'fake mp4 bytes');
  const { contentBriefId, contentVersionId, mediaArtifactId } = seedFullyEligibleContent(storage, { mediaFilePath: videoFile });

  // Simulate a crash between claiming the attempt and getting a provider result.
  const publicationId = crypto.randomUUID();
  storage.run(
    `INSERT INTO publications (id, content_version_id, media_artifact_id, provider, status, request_json, attempt_count, created_at, updated_at)
     VALUES (?, ?, ?, 'mock', 'PENDING', '{}', 1, ?, ?)`,
    [publicationId, contentVersionId, mediaArtifactId, nowISO(), nowISO()]
  );

  await withLiveAuthorized([`publish:mock:${contentVersionId}`], async () => {
    const adapter = new MockAdapter({ status: PUBLICATION_RESULT_STATUS.SUCCESS, provider: 'mock', providerItemId: 'x', providerUrl: 'y' });
    const result = await runPublication({ storage, contentBriefId, provider: 'mock', adapter });
    assert.equal(result.outcome, 'AMBIGUOUS');
    assert.equal(adapter.calls.length, 0, 'an interrupted PENDING attempt must never trigger a fresh upload automatically');
  });

  const row = storage.get('SELECT * FROM publications WHERE id = ?', [publicationId]);
  assert.equal(row.status, 'AMBIGUOUS');

  cleanup(storage, dbPath, videoFile);
});

test('ARTIFACT_MISSING when the rendered file no longer exists on disk', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  const missingFile = path.join(os.tmpdir(), `does-not-exist-${crypto.randomUUID()}.mp4`);
  const { contentBriefId, contentVersionId } = seedFullyEligibleContent(storage, { mediaFilePath: missingFile });

  const result = await withLiveAuthorized([`publish:mock:${contentVersionId}`], async () => {
    const adapter = new MockAdapter({ status: PUBLICATION_RESULT_STATUS.SUCCESS, provider: 'mock', providerItemId: 'x', providerUrl: 'y' });
    return runPublication({ storage, contentBriefId, provider: 'mock', adapter });
  });

  assert.equal(result.outcome, 'ARTIFACT_MISSING');

  cleanup(storage, dbPath);
});
