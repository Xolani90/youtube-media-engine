import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import { SqliteStorageDriver } from '../../src/storage/SqliteStorageDriver.js';
import { runPublication } from '../../src/publication/pipeline.js';
import { PublicationProvider } from '../../src/publication/PublicationProvider.js';
import { PUBLICATION_RESULT_STATUS } from '../../src/publication/constants.js';
import { AssetProvenanceRepository } from '../../src/state/AssetProvenance.js';
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

/** Identical helper/pattern to tests/integration/media-production-pipeline-e2e.test.js's own seedVisualAsset. */
function seedAsset(storage, contentVersionId, verificationStatus) {
  const repo = new AssetProvenanceRepository(storage);
  const assetId = repo.recordAsset({ assetType: 'image', location: '/tmp/not-read-by-publication.png', verificationStatus });
  repo.recordUsage({ assetId, contentVersionId, usageContext: 'b-roll' });
  return assetId;
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

/**
 * ---------------------------------------------------------------------
 * SQLITE_BUSY_SNAPSHOT regression coverage.
 *
 * The claim transaction's `raceExisting` SELECT establishes connection
 * A's deferred-transaction read snapshot. If a second, independent
 * connection commits a conflicting write to the same database file
 * after that SELECT returns but before A's own INSERT, A's write hits
 * a real, unmocked SQLITE_BUSY_SNAPSHOT the moment SQLite tries to
 * upgrade A's now-stale snapshot -- exactly the production race
 * described in the confirmed defect. `BusySnapshotStorage` reproduces
 * this deterministically (no sleeps/timing) by wrapping the real
 * `SqliteStorageDriver` and, immediately after the real `raceExisting`
 * read returns from inside the claim transaction, opening a second raw
 * better-sqlite3 connection to the same file and committing the
 * conflicting write itself.
 * ---------------------------------------------------------------------
 */

const RACE_EXISTING_SQL = 'SELECT * FROM publications WHERE content_version_id = ? AND provider = ?';

class BusySnapshotStorage {
  constructor(inner, dbPath, { triggers = 1, conflictingWrite }) {
    this.inner = inner;
    this.dbPath = dbPath;
    this._inTransaction = false;
    this._triggersRemaining = triggers;
    this._conflictingWrite = conflictingWrite;
    this.triggerCount = 0;
  }
  run(sql, params) {
    return this.inner.run(sql, params);
  }
  all(sql, params) {
    return this.inner.all(sql, params);
  }
  get(sql, params) {
    const result = this.inner.get(sql, params);
    // Only the raceExisting re-check made from *inside* the claim
    // transaction establishes the snapshot we want to make stale --
    // the identical-looking idempotency SELECT at step 3 runs in
    // autocommit mode, outside any transaction, and must not trigger.
    if (this._inTransaction && this._triggersRemaining > 0 && sql === RACE_EXISTING_SQL) {
      this._triggersRemaining -= 1;
      this.triggerCount += 1;
      this._conflictingWrite(this.dbPath);
    }
    return result;
  }
  transaction(fn) {
    this._inTransaction = true;
    try {
      return this.inner.transaction(fn);
    } finally {
      this._inTransaction = false;
    }
  }
  close() {
    return this.inner.close();
  }
}

/** A second, independent connection commits a competing publication row. */
function conflictingPublicationInsert(status, contentVersionId, mediaArtifactId, provider) {
  return (dbPath) => {
    const raw = new Database(dbPath);
    try {
      const id = crypto.randomUUID();
      const now = nowISO();
      raw.prepare(
        `INSERT INTO publications
          (id, content_version_id, media_artifact_id, provider, status, request_json, attempt_count, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, '{}', 1, ?, ?)`
      ).run(id, contentVersionId, mediaArtifactId, provider, status, now, now);
    } finally {
      raw.close();
    }
  };
}

/** A second, independent connection commits an unrelated write -- no competing publication row. */
function conflictingUnrelatedWrite() {
  return (dbPath) => {
    const raw = new Database(dbPath);
    try {
      raw.prepare(
        `INSERT INTO decision_log (id, run_id, subject_type, subject_id, decision, reason, created_at)
         VALUES (?, NULL, 'test', 'busy-snapshot-regression', 'TEST_WRITE', 'unrelated_writer_conflict', ?)`
      ).run(crypto.randomUUID(), nowISO());
    } finally {
      raw.close();
    }
  };
}

test('BUSY_SNAPSHOT + competing PENDING row: AMBIGUOUS/concurrent_attempt_in_progress, no provider call', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  const videoFile = path.join(os.tmpdir(), `pub-video-${crypto.randomUUID()}.mp4`);
  fs.writeFileSync(videoFile, 'fake mp4 bytes');
  const { contentBriefId, contentVersionId, mediaArtifactId } = seedFullyEligibleContent(storage, { mediaFilePath: videoFile });

  const wrapped = new BusySnapshotStorage(storage, dbPath, {
    triggers: 1,
    conflictingWrite: conflictingPublicationInsert('PENDING', contentVersionId, mediaArtifactId, 'mock')
  });

  await withLiveAuthorized([`publish:mock:${contentVersionId}`], async () => {
    const adapter = new MockAdapter({ status: PUBLICATION_RESULT_STATUS.SUCCESS, provider: 'mock', providerItemId: 'x', providerUrl: 'y' });
    const result = await runPublication({ storage: wrapped, contentBriefId, provider: 'mock', adapter });
    assert.equal(result.outcome, 'AMBIGUOUS');
    assert.equal(result.reason, 'concurrent_attempt_in_progress');
    assert.equal(adapter.calls.length, 0);
  });
  assert.equal(wrapped.triggerCount, 1, 'the reproduction hook must actually have fired');

  cleanup(storage, dbPath, videoFile);
});

test('BUSY_SNAPSHOT + competing PUBLISHED row: ALREADY_PUBLISHED, no provider call', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  const videoFile = path.join(os.tmpdir(), `pub-video-${crypto.randomUUID()}.mp4`);
  fs.writeFileSync(videoFile, 'fake mp4 bytes');
  const { contentBriefId, contentVersionId, mediaArtifactId } = seedFullyEligibleContent(storage, { mediaFilePath: videoFile });

  const wrapped = new BusySnapshotStorage(storage, dbPath, {
    triggers: 1,
    conflictingWrite: conflictingPublicationInsert('PUBLISHED', contentVersionId, mediaArtifactId, 'mock')
  });

  await withLiveAuthorized([`publish:mock:${contentVersionId}`], async () => {
    const adapter = new MockAdapter({ status: PUBLICATION_RESULT_STATUS.SUCCESS, provider: 'mock', providerItemId: 'x', providerUrl: 'y' });
    const result = await runPublication({ storage: wrapped, contentBriefId, provider: 'mock', adapter });
    assert.equal(result.outcome, 'ALREADY_PUBLISHED');
    assert.equal(adapter.calls.length, 0);
  });
  assert.equal(wrapped.triggerCount, 1);

  cleanup(storage, dbPath, videoFile);
});

test('BUSY_SNAPSHOT + competing FAILED row: current AMBIGUOUS/concurrent_attempt_in_progress semantics preserved, no provider call', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  const videoFile = path.join(os.tmpdir(), `pub-video-${crypto.randomUUID()}.mp4`);
  fs.writeFileSync(videoFile, 'fake mp4 bytes');
  const { contentBriefId, contentVersionId, mediaArtifactId } = seedFullyEligibleContent(storage, { mediaFilePath: videoFile });

  const wrapped = new BusySnapshotStorage(storage, dbPath, {
    triggers: 1,
    conflictingWrite: conflictingPublicationInsert('FAILED', contentVersionId, mediaArtifactId, 'mock')
  });

  await withLiveAuthorized([`publish:mock:${contentVersionId}`], async () => {
    const adapter = new MockAdapter({ status: PUBLICATION_RESULT_STATUS.SUCCESS, provider: 'mock', providerItemId: 'x', providerUrl: 'y' });
    const result = await runPublication({ storage: wrapped, contentBriefId, provider: 'mock', adapter });
    assert.equal(result.outcome, 'AMBIGUOUS');
    assert.equal(result.reason, 'concurrent_attempt_in_progress');
    assert.equal(adapter.calls.length, 0);
  });
  assert.equal(wrapped.triggerCount, 1);

  cleanup(storage, dbPath, videoFile);
});

test('BUSY_SNAPSHOT + competing AMBIGUOUS row: AMBIGUOUS/concurrent_attempt_in_progress, no provider call', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  const videoFile = path.join(os.tmpdir(), `pub-video-${crypto.randomUUID()}.mp4`);
  fs.writeFileSync(videoFile, 'fake mp4 bytes');
  const { contentBriefId, contentVersionId, mediaArtifactId } = seedFullyEligibleContent(storage, { mediaFilePath: videoFile });

  const wrapped = new BusySnapshotStorage(storage, dbPath, {
    triggers: 1,
    conflictingWrite: conflictingPublicationInsert('AMBIGUOUS', contentVersionId, mediaArtifactId, 'mock')
  });

  await withLiveAuthorized([`publish:mock:${contentVersionId}`], async () => {
    const adapter = new MockAdapter({ status: PUBLICATION_RESULT_STATUS.SUCCESS, provider: 'mock', providerItemId: 'x', providerUrl: 'y' });
    const result = await runPublication({ storage: wrapped, contentBriefId, provider: 'mock', adapter });
    assert.equal(result.outcome, 'AMBIGUOUS');
    assert.equal(result.reason, 'concurrent_attempt_in_progress');
    assert.equal(adapter.calls.length, 0);
  });
  assert.equal(wrapped.triggerCount, 1);

  cleanup(storage, dbPath, videoFile);
});

test('BUSY_SNAPSHOT with no competing publication row: exactly one bounded retry succeeds, provider called exactly once', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  const videoFile = path.join(os.tmpdir(), `pub-video-${crypto.randomUUID()}.mp4`);
  fs.writeFileSync(videoFile, 'fake mp4 bytes');
  const { contentBriefId, contentVersionId } = seedFullyEligibleContent(storage, { mediaFilePath: videoFile });

  // Only ONE trigger: the retry attempt must run against an
  // uncontested, fresh snapshot and succeed.
  const wrapped = new BusySnapshotStorage(storage, dbPath, {
    triggers: 1,
    conflictingWrite: conflictingUnrelatedWrite()
  });

  await withLiveAuthorized([`publish:mock:${contentVersionId}`], async () => {
    const adapter = new MockAdapter({ status: PUBLICATION_RESULT_STATUS.SUCCESS, provider: 'mock', providerItemId: 'vid999', providerUrl: 'https://youtu.be/vid999' });
    const result = await runPublication({ storage: wrapped, contentBriefId, provider: 'mock', adapter });

    assert.equal(result.outcome, 'PUBLISHED');
    assert.equal(result.publication.status, 'PUBLISHED');
    assert.equal(result.publication.provider_item_id, 'vid999');
    assert.equal(adapter.calls.length, 1, 'provider must be called exactly once, not duplicated by the retry');
  });
  assert.equal(wrapped.triggerCount, 1, 'exactly one fresh retry must have been provoked');

  const rows = storage.all('SELECT * FROM publications WHERE content_version_id = ?', [contentVersionId]);
  assert.equal(rows.length, 1, 'no duplicate publication row from the retry');

  const cv = storage.get('SELECT * FROM content_versions WHERE id = ?', [contentVersionId]);
  assert.equal(cv.state, 'PUBLISHED');

  cleanup(storage, dbPath, videoFile);
});

test('BUSY_SNAPSHOT bounded retry: a second conflict on the retry itself is not retried again, no provider call, defined AMBIGUOUS result', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  const videoFile = path.join(os.tmpdir(), `pub-video-${crypto.randomUUID()}.mp4`);
  fs.writeFileSync(videoFile, 'fake mp4 bytes');
  const { contentBriefId, contentVersionId } = seedFullyEligibleContent(storage, { mediaFilePath: videoFile });

  // Two triggers: the original attempt AND the one bounded retry both
  // hit a stale-snapshot conflict from another writer.
  const wrapped = new BusySnapshotStorage(storage, dbPath, {
    triggers: 2,
    conflictingWrite: conflictingUnrelatedWrite()
  });

  await withLiveAuthorized([`publish:mock:${contentVersionId}`], async () => {
    const adapter = new MockAdapter({ status: PUBLICATION_RESULT_STATUS.SUCCESS, provider: 'mock', providerItemId: 'x', providerUrl: 'y' });
    const result = await runPublication({ storage: wrapped, contentBriefId, provider: 'mock', adapter });

    assert.equal(result.outcome, 'AMBIGUOUS');
    assert.ok(result.reason, 'a defined diagnostic reason must be present');
    assert.equal(adapter.calls.length, 0, 'no provider call once bounded recovery is exhausted');
  });
  assert.equal(wrapped.triggerCount, 2, 'exactly the original attempt + one retry must have been provoked, no more');

  const rows = storage.all('SELECT * FROM publications WHERE content_version_id = ?', [contentVersionId]);
  assert.equal(rows.length, 0, 'no publication row should have been left behind by the exhausted retry');

  cleanup(storage, dbPath, videoFile);
});

/** Delegates every call to a real storage driver except that its `transaction` throws a supplied error exactly once. */
class ThrowOnceStorage {
  constructor(inner, err) {
    this.inner = inner;
    this.err = err;
    this.thrown = false;
  }
  run(sql, params) {
    return this.inner.run(sql, params);
  }
  all(sql, params) {
    return this.inner.all(sql, params);
  }
  get(sql, params) {
    return this.inner.get(sql, params);
  }
  transaction(fn) {
    if (!this.thrown) {
      this.thrown = true;
      throw this.err;
    }
    return this.inner.transaction(fn);
  }
  close() {
    return this.inner.close();
  }
}

test('an ordinary non-SQLITE_BUSY_SNAPSHOT exception from the claim transaction propagates unchanged, never converted to AMBIGUOUS', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  const videoFile = path.join(os.tmpdir(), `pub-video-${crypto.randomUUID()}.mp4`);
  fs.writeFileSync(videoFile, 'fake mp4 bytes');
  const { contentBriefId, contentVersionId } = seedFullyEligibleContent(storage, { mediaFilePath: videoFile });

  // A fresh eligible content_version has no pre-existing PENDING row,
  // so the claim transaction (step 6) is the first storage.transaction
  // call runPublication makes -- the only call this wrapper intercepts.
  const simulatedErr = Object.assign(new Error('simulated ordinary SQLite busy, not a snapshot conflict'), { code: 'SQLITE_BUSY' });
  const wrapped = new ThrowOnceStorage(storage, simulatedErr);

  await withLiveAuthorized([`publish:mock:${contentVersionId}`], async () => {
    const adapter = new MockAdapter({ status: PUBLICATION_RESULT_STATUS.SUCCESS, provider: 'mock', providerItemId: 'x', providerUrl: 'y' });
    await assert.rejects(
      () => runPublication({ storage: wrapped, contentBriefId, provider: 'mock', adapter }),
      (thrown) => thrown === simulatedErr
    );
    assert.equal(adapter.calls.length, 0);
  });

  cleanup(storage, dbPath, videoFile);
});

/**
 * ---------------------------------------------------------------------
 * FAILED-retry regression coverage.
 *
 * FAILED is documented (0010_publication.sql, PublicationProvider.js)
 * as safe to retry -- no external side effect occurred. These tests
 * prove that a legitimate sequential runPublication() call after a
 * FAILED result reclaims the existing row (never inserting a second
 * one) rather than being misreported as a concurrent race.
 * ---------------------------------------------------------------------
 */

test('FAILED can be retried successfully: same row is reused, provider called exactly once, ends PUBLISHED', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  const videoFile = path.join(os.tmpdir(), `pub-video-${crypto.randomUUID()}.mp4`);
  fs.writeFileSync(videoFile, 'fake mp4 bytes');
  const { contentBriefId, contentVersionId } = seedFullyEligibleContent(storage, { mediaFilePath: videoFile });

  await withLiveAuthorized([`publish:mock:${contentVersionId}`], async () => {
    const failingAdapter = new MockAdapter({ status: PUBLICATION_RESULT_STATUS.EXPLICIT_FAILURE, provider: 'mock', errorClass: 'REJECTED_METADATA', retryable: false });
    const first = await runPublication({ storage, contentBriefId, provider: 'mock', adapter: failingAdapter });
    assert.equal(first.publication.status, 'FAILED');
    const failedPublicationId = first.publication.id;

    const succeedingAdapter = new MockAdapter({ status: PUBLICATION_RESULT_STATUS.SUCCESS, provider: 'mock', providerItemId: 'vid-retry-ok', providerUrl: 'https://youtu.be/vid-retry-ok' });
    const second = await runPublication({ storage, contentBriefId, provider: 'mock', adapter: succeedingAdapter });

    assert.equal(second.outcome, 'PUBLISHED');
    assert.equal(second.publication.status, 'PUBLISHED');
    assert.equal(second.publication.id, failedPublicationId, 'the retry must reuse the same publication row, not create a new one');
    assert.equal(second.publication.provider_item_id, 'vid-retry-ok');
    assert.equal(succeedingAdapter.calls.length, 1, 'the provider must be called exactly once during the retry attempt');
    assert.equal(failingAdapter.calls.length, 1, 'the first attempt still only called the provider once');
  });

  const rows = storage.all('SELECT * FROM publications WHERE content_version_id = ?', [contentVersionId]);
  assert.equal(rows.length, 1, 'no duplicate publication row for this (content_version, provider)');
  assert.equal(rows[0].status, 'PUBLISHED');
  assert.equal(rows[0].attempt_count, 2, 'attempt_count must reflect the second attempt');

  const cv = storage.get('SELECT * FROM content_versions WHERE id = ?', [contentVersionId]);
  assert.equal(cv.state, 'PUBLISHED');

  cleanup(storage, dbPath, videoFile);
});

test('FAILED retry can fail again: status remains FAILED, content_version remains PRODUCED, no duplicate row', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  const videoFile = path.join(os.tmpdir(), `pub-video-${crypto.randomUUID()}.mp4`);
  fs.writeFileSync(videoFile, 'fake mp4 bytes');
  const { contentBriefId, contentVersionId } = seedFullyEligibleContent(storage, { mediaFilePath: videoFile });

  await withLiveAuthorized([`publish:mock:${contentVersionId}`], async () => {
    const firstAdapter = new MockAdapter({ status: PUBLICATION_RESULT_STATUS.EXPLICIT_FAILURE, provider: 'mock', errorClass: 'REJECTED_METADATA', retryable: false });
    const first = await runPublication({ storage, contentBriefId, provider: 'mock', adapter: firstAdapter });
    assert.equal(first.publication.status, 'FAILED');
    const firstPublicationId = first.publication.id;

    const secondAdapter = new MockAdapter({ status: PUBLICATION_RESULT_STATUS.EXPLICIT_FAILURE, provider: 'mock', errorClass: 'REJECTED_METADATA', retryable: false });
    const second = await runPublication({ storage, contentBriefId, provider: 'mock', adapter: secondAdapter });

    assert.equal(second.outcome, 'PROVIDER_FAILURE');
    assert.equal(second.publication.status, 'FAILED');
    assert.equal(second.publication.id, firstPublicationId, 'still the same row, not a new one');
    assert.equal(secondAdapter.calls.length, 1);
  });

  const rows = storage.all('SELECT * FROM publications WHERE content_version_id = ?', [contentVersionId]);
  assert.equal(rows.length, 1, 'no duplicate publication row exists');
  assert.equal(rows[0].status, 'FAILED');
  assert.equal(rows[0].attempt_count, 2);

  const cv = storage.get('SELECT * FROM content_versions WHERE id = ?', [contentVersionId]);
  assert.equal(cv.state, 'PRODUCED');

  cleanup(storage, dbPath, videoFile);
});

test('FAILED retry can become ambiguous: status becomes AMBIGUOUS, content_version remains PRODUCED, no automatic third attempt', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  const videoFile = path.join(os.tmpdir(), `pub-video-${crypto.randomUUID()}.mp4`);
  fs.writeFileSync(videoFile, 'fake mp4 bytes');
  const { contentBriefId, contentVersionId } = seedFullyEligibleContent(storage, { mediaFilePath: videoFile });

  await withLiveAuthorized([`publish:mock:${contentVersionId}`], async () => {
    const firstAdapter = new MockAdapter({ status: PUBLICATION_RESULT_STATUS.EXPLICIT_FAILURE, provider: 'mock', errorClass: 'REJECTED_METADATA', retryable: false });
    const first = await runPublication({ storage, contentBriefId, provider: 'mock', adapter: firstAdapter });
    assert.equal(first.publication.status, 'FAILED');
    const firstPublicationId = first.publication.id;

    const ambiguousAdapter = new MockAdapter({ status: PUBLICATION_RESULT_STATUS.AMBIGUOUS, provider: 'mock', reason: 'network_timeout_during_upload' });
    const second = await runPublication({ storage, contentBriefId, provider: 'mock', adapter: ambiguousAdapter });

    assert.equal(second.outcome, 'AMBIGUOUS');
    assert.equal(second.publication.status, 'AMBIGUOUS');
    assert.equal(second.publication.id, firstPublicationId);
    assert.equal(ambiguousAdapter.calls.length, 1);

    // A subsequent call must NOT auto-retry -- this exercises the
    // existing, unmodified AMBIGUOUS idempotency branch (step 3).
    const thirdAdapter = new MockAdapter({ status: PUBLICATION_RESULT_STATUS.SUCCESS, provider: 'mock', providerItemId: 'z', providerUrl: 'y' });
    const third = await runPublication({ storage, contentBriefId, provider: 'mock', adapter: thirdAdapter });
    assert.equal(third.outcome, 'AMBIGUOUS');
    assert.equal(third.reason, 'previously_ambiguous_not_auto_retried');
    assert.equal(thirdAdapter.calls.length, 0, 'no automatic further attempt occurs');
  });

  const rows = storage.all('SELECT * FROM publications WHERE content_version_id = ?', [contentVersionId]);
  assert.equal(rows.length, 1, 'still just the one, reused row');
  assert.equal(rows[0].status, 'AMBIGUOUS');

  const cv = storage.get('SELECT * FROM content_versions WHERE id = ?', [contentVersionId]);
  assert.equal(cv.state, 'PRODUCED');

  cleanup(storage, dbPath, videoFile);
});

test('FAILED-retry change does not alter existing PUBLISHED/PENDING/AMBIGUOUS idempotency semantics', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();

  // PUBLISHED -> ALREADY_PUBLISHED, adapter never called again.
  {
    const videoFile = path.join(os.tmpdir(), `pub-video-${crypto.randomUUID()}.mp4`);
    fs.writeFileSync(videoFile, 'fake mp4 bytes');
    const { contentBriefId, contentVersionId } = seedFullyEligibleContent(storage, { mediaFilePath: videoFile });
    await withLiveAuthorized([`publish:mock:${contentVersionId}`], async () => {
      const okAdapter = new MockAdapter({ status: PUBLICATION_RESULT_STATUS.SUCCESS, provider: 'mock', providerItemId: 'a', providerUrl: 'b' });
      await runPublication({ storage, contentBriefId, provider: 'mock', adapter: okAdapter });
      const againAdapter = new MockAdapter({ status: PUBLICATION_RESULT_STATUS.SUCCESS, provider: 'mock', providerItemId: 'c', providerUrl: 'd' });
      const result = await runPublication({ storage, contentBriefId, provider: 'mock', adapter: againAdapter });
      assert.equal(result.outcome, 'ALREADY_PUBLISHED');
      assert.equal(againAdapter.calls.length, 0);
    });
    fs.rmSync(videoFile, { force: true });
  }

  // PENDING (interrupted attempt) -> AMBIGUOUS/interrupted_prior_attempt, unchanged.
  {
    const videoFile = path.join(os.tmpdir(), `pub-video-${crypto.randomUUID()}.mp4`);
    fs.writeFileSync(videoFile, 'fake mp4 bytes');
    const { contentVersionId, mediaArtifactId } = seedFullyEligibleContent(storage, { mediaFilePath: videoFile });
    const contentBriefId2 = storage.get('SELECT content_brief_id FROM content_versions WHERE id = ?', [contentVersionId]).content_brief_id;
    const pendingId = crypto.randomUUID();
    storage.run(
      `INSERT INTO publications
        (id, content_version_id, media_artifact_id, provider, status, request_json, attempt_count, created_at, updated_at)
       VALUES (?, ?, ?, 'mock', 'PENDING', '{}', 1, ?, ?)`,
      [pendingId, contentVersionId, mediaArtifactId, nowISO(), nowISO()]
    );
    await withLiveAuthorized([`publish:mock:${contentVersionId}`], async () => {
      const adapter = new MockAdapter({ status: PUBLICATION_RESULT_STATUS.SUCCESS, provider: 'mock', providerItemId: 'e', providerUrl: 'f' });
      const result = await runPublication({ storage, contentBriefId: contentBriefId2, provider: 'mock', adapter });
      assert.equal(result.outcome, 'AMBIGUOUS');
      assert.equal(result.reason, 'interrupted_prior_attempt');
      assert.equal(adapter.calls.length, 0);
    });
    fs.rmSync(videoFile, { force: true });
  }

  // AMBIGUOUS -> AMBIGUOUS/previously_ambiguous_not_auto_retried, unchanged.
  {
    const videoFile = path.join(os.tmpdir(), `pub-video-${crypto.randomUUID()}.mp4`);
    fs.writeFileSync(videoFile, 'fake mp4 bytes');
    const { contentVersionId, mediaArtifactId } = seedFullyEligibleContent(storage, { mediaFilePath: videoFile });
    const contentBriefId3 = storage.get('SELECT content_brief_id FROM content_versions WHERE id = ?', [contentVersionId]).content_brief_id;
    const ambiguousId = crypto.randomUUID();
    storage.run(
      `INSERT INTO publications
        (id, content_version_id, media_artifact_id, provider, status, request_json, attempt_count, created_at, updated_at)
       VALUES (?, ?, ?, 'mock', 'AMBIGUOUS', '{}', 1, ?, ?)`,
      [ambiguousId, contentVersionId, mediaArtifactId, nowISO(), nowISO()]
    );
    await withLiveAuthorized([`publish:mock:${contentVersionId}`], async () => {
      const adapter = new MockAdapter({ status: PUBLICATION_RESULT_STATUS.SUCCESS, provider: 'mock', providerItemId: 'g', providerUrl: 'h' });
      const result = await runPublication({ storage, contentBriefId: contentBriefId3, provider: 'mock', adapter });
      assert.equal(result.outcome, 'AMBIGUOUS');
      assert.equal(result.reason, 'previously_ambiguous_not_auto_retried');
      assert.equal(adapter.calls.length, 0);
    });
    fs.rmSync(videoFile, { force: true });
  }

  cleanup(storage, dbPath);
});

/** A second, independent connection reclaims the same FAILED row concurrently. */
function conflictingReclaim(contentVersionId, provider) {
  return (dbPath) => {
    const raw = new Database(dbPath);
    try {
      raw.prepare(
        `UPDATE publications SET status = 'PENDING', attempt_count = attempt_count + 1, updated_at = ?
         WHERE content_version_id = ? AND provider = ? AND status = 'FAILED'`
      ).run(nowISO(), contentVersionId, provider);
    } finally {
      raw.close();
    }
  };
}

test('concurrency safety: two simultaneous reclaim attempts on the same FAILED row cannot both invoke the provider', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  const videoFile = path.join(os.tmpdir(), `pub-video-${crypto.randomUUID()}.mp4`);
  fs.writeFileSync(videoFile, 'fake mp4 bytes');
  const { contentBriefId, contentVersionId } = seedFullyEligibleContent(storage, { mediaFilePath: videoFile });

  await withLiveAuthorized([`publish:mock:${contentVersionId}`], async () => {
    const firstAdapter = new MockAdapter({ status: PUBLICATION_RESULT_STATUS.EXPLICIT_FAILURE, provider: 'mock', errorClass: 'REJECTED_METADATA', retryable: false });
    await runPublication({ storage, contentBriefId, provider: 'mock', adapter: firstAdapter });

    // A second, independent connection reclaims (FAILED -> PENDING) the
    // exact same row at the moment this run's own reclaim transaction
    // has already read it -- a genuine cross-connection race on the
    // reclaim itself, not merely on the initial SELECT.
    const wrapped = new BusySnapshotStorage(storage, dbPath, {
      triggers: 1,
      conflictingWrite: conflictingReclaim(contentVersionId, 'mock')
    });
    const loserAdapter = new MockAdapter({ status: PUBLICATION_RESULT_STATUS.SUCCESS, provider: 'mock', providerItemId: 'loser', providerUrl: 'x' });
    const result = await runPublication({ storage: wrapped, contentBriefId, provider: 'mock', adapter: loserAdapter });

    assert.equal(result.outcome, 'AMBIGUOUS');
    assert.equal(result.reason, 'concurrent_attempt_in_progress');
    assert.equal(loserAdapter.calls.length, 0, 'the losing concurrent reclaim attempt must never call the provider');
    assert.equal(wrapped.triggerCount, 1, 'the reproduction hook must actually have fired');
  });

  const rows = storage.all('SELECT * FROM publications WHERE content_version_id = ?', [contentVersionId]);
  assert.equal(rows.length, 1, 'still just the one row -- no duplicate from either connection');
  assert.equal(rows[0].status, 'PENDING', 'the winning connection\'s reclaim is the one that took effect');
  assert.equal(rows[0].attempt_count, 2, 'only the single winning reclaim incremented attempt_count');

  cleanup(storage, dbPath, videoFile);
});

test('publication identity/uniqueness: retrying FAILED never creates a second row for the same (content_version, provider)', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  const videoFile = path.join(os.tmpdir(), `pub-video-${crypto.randomUUID()}.mp4`);
  fs.writeFileSync(videoFile, 'fake mp4 bytes');
  const { contentBriefId, contentVersionId } = seedFullyEligibleContent(storage, { mediaFilePath: videoFile });

  await withLiveAuthorized([`publish:mock:${contentVersionId}`], async () => {
    const failingAdapter = new MockAdapter({ status: PUBLICATION_RESULT_STATUS.EXPLICIT_FAILURE, provider: 'mock', errorClass: 'REJECTED_METADATA', retryable: false });
    await runPublication({ storage, contentBriefId, provider: 'mock', adapter: failingAdapter });

    // Attempting to INSERT a second row for the same (content_version_id,
    // provider) directly must still violate the UNIQUE index -- the fix
    // did not weaken or remove that constraint.
    assert.throws(() => {
      storage.run(
        `INSERT INTO publications
          (id, content_version_id, media_artifact_id, provider, status, request_json, attempt_count, created_at, updated_at)
         VALUES (?, ?, (SELECT media_artifact_id FROM publications WHERE content_version_id = ?), 'mock', 'PENDING', '{}', 1, ?, ?)`,
        [crypto.randomUUID(), contentVersionId, contentVersionId, nowISO(), nowISO()]
      );
    }, /UNIQUE constraint failed/);

    const retryAdapter = new MockAdapter({ status: PUBLICATION_RESULT_STATUS.SUCCESS, provider: 'mock', providerItemId: 'uniq-1', providerUrl: 'uniq-url' });
    await runPublication({ storage, contentBriefId, provider: 'mock', adapter: retryAdapter });
  });

  const rows = storage.all('SELECT * FROM publications WHERE content_version_id = ? AND provider = ?', [contentVersionId, 'mock']);
  assert.equal(rows.length, 1, 'exactly one publication row for this (content_version, provider) throughout');
  assert.equal(rows[0].status, 'PUBLISHED');

  cleanup(storage, dbPath, videoFile);
});

// --- F2-G Open Decision 1 (ADR-0013 §6): publication-time rights gate ------

test('VERIFIED asset: publication proceeds through to the provider call as before', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  const videoFile = path.join(os.tmpdir(), `pub-video-${crypto.randomUUID()}.mp4`);
  fs.writeFileSync(videoFile, 'fake mp4 bytes');
  const { contentBriefId, contentVersionId } = seedFullyEligibleContent(storage, { mediaFilePath: videoFile });
  seedAsset(storage, contentVersionId, 'VERIFIED');

  const result = await withLiveAuthorized([`publish:mock:${contentVersionId}`], async () => {
    const adapter = new MockAdapter({ status: PUBLICATION_RESULT_STATUS.SUCCESS, provider: 'mock', providerItemId: 'vid-verified', providerUrl: 'https://youtu.be/vid-verified' });
    const r = await runPublication({ storage, contentBriefId, provider: 'mock', adapter });
    assert.equal(adapter.calls.length, 1, 'adapter must be called once VERIFIED');
    return r;
  });

  assert.equal(result.outcome, 'PUBLISHED');
  assert.equal(result.publication.provider_item_id, 'vid-verified');

  cleanup(storage, dbPath, videoFile);
});

test('UNVERIFIED asset: ASSET_RIGHTS_BLOCKED, adapter never called, no publications row created', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  const videoFile = path.join(os.tmpdir(), `pub-video-${crypto.randomUUID()}.mp4`);
  fs.writeFileSync(videoFile, 'fake mp4 bytes');
  const { contentBriefId, contentVersionId } = seedFullyEligibleContent(storage, { mediaFilePath: videoFile });
  seedAsset(storage, contentVersionId, 'UNVERIFIED');

  const result = await withLiveAuthorized([`publish:mock:${contentVersionId}`], async () => {
    const adapter = new MockAdapter({ status: PUBLICATION_RESULT_STATUS.SUCCESS, provider: 'mock', providerItemId: 'SHOULD_NOT_HAPPEN', providerUrl: 'x' });
    const r = await runPublication({ storage, contentBriefId, provider: 'mock', adapter });
    assert.equal(adapter.calls.length, 0, 'adapter must never be called for UNVERIFIED');
    return r;
  });

  assert.equal(result.outcome, 'ASSET_RIGHTS_BLOCKED');
  assert.equal(result.reason, 'UNVERIFIED');
  assert.equal(result.publication, null);
  assert.equal(storage.get('SELECT * FROM publications WHERE content_version_id = ?', [contentVersionId]), undefined);

  const cv = storage.get('SELECT * FROM content_versions WHERE id = ?', [contentVersionId]);
  assert.equal(cv.state, 'PRODUCED', 'content_version.state is left unchanged on a rights block (mirrors Media Production, not Production)');

  cleanup(storage, dbPath, videoFile);
});

test('DISPUTED asset: ASSET_RIGHTS_BLOCKED, adapter never called, no publications row created', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  const videoFile = path.join(os.tmpdir(), `pub-video-${crypto.randomUUID()}.mp4`);
  fs.writeFileSync(videoFile, 'fake mp4 bytes');
  const { contentBriefId, contentVersionId } = seedFullyEligibleContent(storage, { mediaFilePath: videoFile });
  seedAsset(storage, contentVersionId, 'DISPUTED');

  const result = await withLiveAuthorized([`publish:mock:${contentVersionId}`], async () => {
    const adapter = new MockAdapter({ status: PUBLICATION_RESULT_STATUS.SUCCESS, provider: 'mock', providerItemId: 'SHOULD_NOT_HAPPEN', providerUrl: 'x' });
    const r = await runPublication({ storage, contentBriefId, provider: 'mock', adapter });
    assert.equal(adapter.calls.length, 0, 'adapter must never be called for DISPUTED');
    return r;
  });

  assert.equal(result.outcome, 'ASSET_RIGHTS_BLOCKED');
  assert.equal(result.reason, 'DISPUTED');
  assert.equal(result.publication, null);
  assert.equal(storage.get('SELECT * FROM publications WHERE content_version_id = ?', [contentVersionId]), undefined);

  cleanup(storage, dbPath, videoFile);
});

test('status changes to DISPUTED after upstream verification but before Publication runs: Publication observes the current persisted status, not a stale one, and blocks', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  const videoFile = path.join(os.tmpdir(), `pub-video-${crypto.randomUUID()}.mp4`);
  fs.writeFileSync(videoFile, 'fake mp4 bytes');
  const { contentBriefId, contentVersionId } = seedFullyEligibleContent(storage, { mediaFilePath: videoFile });

  // Seeded VERIFIED, exactly as an earlier stage (e.g. Rights
  // Verification/Production/Media Production) would have observed it.
  const assetId = seedAsset(storage, contentVersionId, 'VERIFIED');

  // The status changes in the real, persisted assets table -- via the
  // actual persistence mechanism, never an in-memory variable -- after
  // that earlier observation but before Publication's own gate runs.
  storage.run('UPDATE assets SET verification_status = ? WHERE id = ?', ['DISPUTED', assetId]);

  const result = await withLiveAuthorized([`publish:mock:${contentVersionId}`], async () => {
    const adapter = new MockAdapter({ status: PUBLICATION_RESULT_STATUS.SUCCESS, provider: 'mock', providerItemId: 'SHOULD_NOT_HAPPEN', providerUrl: 'x' });
    const r = await runPublication({ storage, contentBriefId, provider: 'mock', adapter });
    assert.equal(adapter.calls.length, 0, 'adapter must not be called once the current persisted status is DISPUTED');
    return r;
  });

  assert.equal(result.outcome, 'ASSET_RIGHTS_BLOCKED');
  assert.equal(result.reason, 'DISPUTED');

  cleanup(storage, dbPath, videoFile);
});

test('no assets attached: existing behavior is unaffected -- publication proceeds (mirrors NO_VISUAL_ASSETS being a Media Production concern, not Publication\'s)', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  const videoFile = path.join(os.tmpdir(), `pub-video-${crypto.randomUUID()}.mp4`);
  fs.writeFileSync(videoFile, 'fake mp4 bytes');
  const { contentBriefId, contentVersionId } = seedFullyEligibleContent(storage, { mediaFilePath: videoFile });
  // No assets attached at all -- identical to every pre-existing test in
  // this file, which never seeded assets before this change either.

  const result = await withLiveAuthorized([`publish:mock:${contentVersionId}`], async () => {
    const adapter = new MockAdapter({ status: PUBLICATION_RESULT_STATUS.SUCCESS, provider: 'mock', providerItemId: 'no-assets', providerUrl: 'https://youtu.be/no-assets' });
    const r = await runPublication({ storage, contentBriefId, provider: 'mock', adapter });
    assert.equal(adapter.calls.length, 1);
    return r;
  });

  assert.equal(result.outcome, 'PUBLISHED');

  cleanup(storage, dbPath, videoFile);
});
