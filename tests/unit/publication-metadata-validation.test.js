import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  normalizeTitle, normalizeDescription, InvalidPublicationMetadataError,
  TITLE_MAX_LENGTH, DESCRIPTION_MAX_LENGTH
} from '../../src/publication/metadataValidation.js';
import { buildPublicationRequest } from '../../src/publication/PublicationRequest.js';
import { SqliteStorageDriver } from '../../src/storage/SqliteStorageDriver.js';
import { runPublication } from '../../src/publication/pipeline.js';
import { PublicationProvider } from '../../src/publication/PublicationProvider.js';
import { PUBLICATION_RESULT_STATUS } from '../../src/publication/constants.js';
import { config } from '../../src/config/index.js';
import { passGate2 } from '../helpers/gate2.js';

// --- Part 1: pure normalizeTitle()/normalizeDescription() unit tests. ---
// No storage/DB involved -- these run independently of the sqlite
// native-module environment issue that affects the integration tests below.

test('normalizeTitle: a valid title remains unchanged', () => {
  assert.equal(normalizeTitle('How Solar Panels Actually Work'), 'How Solar Panels Actually Work');
});

test('normalizeTitle: < and > are removed', () => {
  assert.equal(normalizeTitle('Top 5 <script> Tricks>'), 'Top 5 script Tricks');
});

test('normalizeTitle: a title exactly 100 characters is accepted unchanged', () => {
  const title = 'A'.repeat(TITLE_MAX_LENGTH);
  assert.equal(normalizeTitle(title), title);
  assert.equal(normalizeTitle(title).length, TITLE_MAX_LENGTH);
});

test('normalizeTitle: a title over 100 characters is deterministically truncated', () => {
  const title = 'B'.repeat(TITLE_MAX_LENGTH + 37);
  const result = normalizeTitle(title);
  assert.equal(result.length, TITLE_MAX_LENGTH);
  assert.equal(result, 'B'.repeat(TITLE_MAX_LENGTH));
  // Deterministic: running it again produces the exact same result.
  assert.equal(normalizeTitle(title), result);
});

test('normalizeTitle: an empty title fails', () => {
  assert.throws(() => normalizeTitle(''), InvalidPublicationMetadataError);
});

test('normalizeTitle: a title that is only < and > (empty after sanitization) fails', () => {
  assert.throws(() => normalizeTitle('<<>>'), InvalidPublicationMetadataError);
});

test('normalizeTitle: a non-string title fails', () => {
  assert.throws(() => normalizeTitle(undefined), InvalidPublicationMetadataError);
  assert.throws(() => normalizeTitle(null), InvalidPublicationMetadataError);
  assert.throws(() => normalizeTitle(42), InvalidPublicationMetadataError);
  assert.throws(() => normalizeTitle({}), InvalidPublicationMetadataError);
});

test('normalizeDescription: a valid description remains unchanged, preserving line breaks', () => {
  const description = 'Line one.\nLine two.\n\nLine four.';
  assert.equal(normalizeDescription(description), description);
});

test('normalizeDescription: a description exactly 5000 characters is accepted unchanged', () => {
  const description = 'C'.repeat(DESCRIPTION_MAX_LENGTH);
  assert.equal(normalizeDescription(description), description);
  assert.equal(normalizeDescription(description).length, DESCRIPTION_MAX_LENGTH);
});

test('normalizeDescription: a description over 5000 characters is truncated deterministically', () => {
  const description = 'D'.repeat(DESCRIPTION_MAX_LENGTH + 123);
  const result = normalizeDescription(description);
  assert.equal(result.length, DESCRIPTION_MAX_LENGTH);
  assert.equal(result, 'D'.repeat(DESCRIPTION_MAX_LENGTH));
});

test('normalizeDescription: an empty description is valid (matches the existing viewer_promise-missing fallback)', () => {
  assert.equal(normalizeDescription(''), '');
});

test('normalizeDescription: a non-string description fails', () => {
  assert.throws(() => normalizeDescription(undefined), InvalidPublicationMetadataError);
  assert.throws(() => normalizeDescription(null), InvalidPublicationMetadataError);
  assert.throws(() => normalizeDescription(123), InvalidPublicationMetadataError);
});

// --- Part 2: buildPublicationRequest() applies normalization at the sole
// existing metadata-assembly point. Plain objects only -- no storage. ---

function minimalArgs({ workingTitle = 'My Video', viewerPromise = 'Promise' } = {}) {
  return {
    contentVersion: { id: 'cv-1' },
    script: { id: 'script-1' },
    contentBrief: { id: 'brief-1', working_title: workingTitle, viewer_promise: viewerPromise },
    mediaArtifact: { id: 'media-1', artifact_path: '/tmp/x.mp4', artifact_checksum: 'chk', duration_seconds: 5 }
  };
}

test('buildPublicationRequest: normalized title/description reach the built request unchanged when already valid', () => {
  const request = buildPublicationRequest(minimalArgs());
  assert.equal(request.title, 'My Video');
  assert.equal(request.description, 'Promise');
});

test('buildPublicationRequest: a title with < / > is sanitized in the built request', () => {
  const request = buildPublicationRequest(minimalArgs({ workingTitle: 'Best <b>Tips</b>' }));
  assert.equal(request.title, 'Best bTips/b');
});

test('buildPublicationRequest: an over-length title is truncated in the built request', () => {
  const request = buildPublicationRequest(minimalArgs({ workingTitle: 'E'.repeat(TITLE_MAX_LENGTH + 10) }));
  assert.equal(request.title.length, TITLE_MAX_LENGTH);
});

test('buildPublicationRequest: an empty working_title throws InvalidPublicationMetadataError', () => {
  assert.throws(() => buildPublicationRequest(minimalArgs({ workingTitle: '' })), InvalidPublicationMetadataError);
});

// --- Part 3: integration through the real publication pipeline, with a
// mock adapter -- mirrors tests/unit/publication-pipeline.test.js's own
// conventions (SqliteStorageDriver, PublicationProvider mock, LIVE-mode
// authorization override) without modifying that shared file. Requires
// better-sqlite3's native binary; see the "TESTS" section of the report
// for this sandbox's known environment limitation. ---

function freshStorage() {
  const dbPath = path.join(os.tmpdir(), `pub-metadata-${Date.now()}-${Math.random()}.db`);
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

function withLiveAuthorized(actions, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pub-metadata-auth-'));
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

/**
 * Local seed helper (deliberately not imported from
 * publication-pipeline.test.js's own seedFullyEligibleContent, per this
 * repository's existing per-stage/per-file decoupling convention --
 * see eligibility.js's docstring): identical fixture shape, but with
 * working_title/viewer_promise parameterized so Phase 2A's title
 * behavior can be exercised end to end.
 */
function seedEligibleContent(storage, { mediaFilePath, workingTitle = 'My Video', viewerPromise = 'Promise' }) {
  const opportunityId = crypto.randomUUID();
  storage.run(`INSERT INTO opportunities (id, title, source, discovered_at, status) VALUES (?, 'T', 'rss', ?, 'DISCOVERED')`, [opportunityId, nowISO()]);
  const contentBriefId = crypto.randomUUID();
  storage.run(
    `INSERT INTO content_briefs
      (id, opportunity_id, working_title, core_question, target_audience, viewer_promise,
       hook, angle, narrative_structure, key_claims, counterpoints, original_insights, visual_ideas,
       monetization_opportunities, risk_assessment, created_at)
     VALUES (?, ?, ?, 'Q', 'A', ?, 'H', 'Angle', 'Structure', '[]', 'C', 'I', 'V', 'M', 'R', ?)`,
    [contentBriefId, opportunityId, workingTitle, viewerPromise, nowISO()]
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
  return { contentBriefId, contentVersionId };
}

test('integration: already-valid metadata publishes unchanged -- existing PUBLISHED behavior is preserved', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  const videoFile = path.join(os.tmpdir(), `pub-metadata-video-${crypto.randomUUID()}.mp4`);
  fs.writeFileSync(videoFile, 'fake mp4 bytes');
  const { contentBriefId, contentVersionId } = seedEligibleContent(storage, { mediaFilePath: videoFile, workingTitle: 'My Video', viewerPromise: 'Promise' });

  const result = await withLiveAuthorized([`publish:mock:${contentVersionId}`], async () => {
    const adapter = new MockAdapter({ status: PUBLICATION_RESULT_STATUS.SUCCESS, provider: 'mock', providerItemId: 'vid1', providerUrl: 'https://youtu.be/vid1' });
    const r = await runPublication({ storage, contentBriefId, provider: 'mock', adapter });
    return { r, adapter };
  });

  assert.equal(result.r.outcome, 'PUBLISHED');
  assert.equal(result.adapter.calls.length, 1);
  assert.equal(result.adapter.calls[0].title, 'My Video');
  assert.equal(result.adapter.calls[0].description, 'Promise');

  cleanup(storage, dbPath, videoFile);
});

test('integration: a normalizable title (contains < / >, and is over 100 chars) reaches the adapter already normalized', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  const videoFile = path.join(os.tmpdir(), `pub-metadata-video-${crypto.randomUUID()}.mp4`);
  fs.writeFileSync(videoFile, 'fake mp4 bytes');
  const dirtyTitle = `${'F'.repeat(TITLE_MAX_LENGTH)}<script>EXTRA`;
  const { contentBriefId, contentVersionId } = seedEligibleContent(storage, { mediaFilePath: videoFile, workingTitle: dirtyTitle });

  const result = await withLiveAuthorized([`publish:mock:${contentVersionId}`], async () => {
    const adapter = new MockAdapter({ status: PUBLICATION_RESULT_STATUS.SUCCESS, provider: 'mock', providerItemId: 'vid2', providerUrl: 'https://youtu.be/vid2' });
    const r = await runPublication({ storage, contentBriefId, provider: 'mock', adapter });
    return { r, adapter };
  });

  assert.equal(result.r.outcome, 'PUBLISHED');
  assert.equal(result.adapter.calls.length, 1);
  const sentTitle = result.adapter.calls[0].title;
  assert.ok(!sentTitle.includes('<') && !sentTitle.includes('>'), 'no < or > reaches the adapter');
  assert.equal(sentTitle.length, TITLE_MAX_LENGTH, 'title is truncated to the YouTube limit before reaching the adapter');

  cleanup(storage, dbPath, videoFile);
});

test('integration: a fundamentally invalid (empty) title never reaches the adapter, and the pipeline reports STRUCTURAL_FAILURE', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  const videoFile = path.join(os.tmpdir(), `pub-metadata-video-${crypto.randomUUID()}.mp4`);
  fs.writeFileSync(videoFile, 'fake mp4 bytes');
  const { contentBriefId, contentVersionId } = seedEligibleContent(storage, { mediaFilePath: videoFile, workingTitle: '' });

  const result = await withLiveAuthorized([`publish:mock:${contentVersionId}`], async () => {
    const adapter = new MockAdapter({ status: PUBLICATION_RESULT_STATUS.SUCCESS, provider: 'mock', providerItemId: 'SHOULD_NOT_HAPPEN', providerUrl: 'x' });
    const r = await runPublication({ storage, contentBriefId, provider: 'mock', adapter });
    return { r, adapter };
  });

  assert.equal(result.r.outcome, 'STRUCTURAL_FAILURE');
  assert.equal(result.r.publication, null);
  assert.equal(result.adapter.calls.length, 0, 'the adapter must never be invoked for fundamentally invalid metadata');
  const row = storage.get('SELECT * FROM publications WHERE content_version_id = ?', [contentVersionId]);
  assert.equal(row, undefined, 'no publications row (not even PENDING) is created for fundamentally invalid metadata');

  cleanup(storage, dbPath, videoFile);
});
