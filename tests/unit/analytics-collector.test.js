import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { SqliteStorageDriver } from '../../src/storage/SqliteStorageDriver.js';
import { collectAnalytics, selectEligiblePublicationsForAnalytics, MAX_VIDEOS_PER_BATCH } from '../../src/analytics/collector.js';
import { ANALYTICS_RESULT_STATUS } from '../../src/analytics/constants.js';

/**
 * Phase 3 integration tests: the analytics collector against a real
 * SQLite database (migration 0024 + the collector's persistence),
 * with a mocked adapter (no network) -- mirrors
 * tests/unit/publication-pipeline-thumbnail.test.js's own harness
 * pattern.
 *
 * NOTE: as with every other test in this repository that touches
 * SqliteStorageDriver, these require a working native better-sqlite3
 * binary for this platform. See the Phase 3 report's KNOWN
 * LIMITATIONS for this environment's pre-existing ERR_DLOPEN_FAILED
 * issue.
 */

function freshStorage() {
  const dbPath = path.join(os.tmpdir(), `analytics-collector-${Date.now()}-${Math.random()}.db`);
  const storage = new SqliteStorageDriver({ dbPath });
  storage.migrate();
  return { storage, dbPath };
}

function cleanup(storage, dbPath) {
  storage.close();
  fs.rmSync(dbPath, { force: true });
  fs.rmSync(`${dbPath}-wal`, { force: true });
  fs.rmSync(`${dbPath}-shm`, { force: true });
}

function nowISO() {
  return new Date().toISOString();
}

/**
 * publications.content_version_id and publications.media_artifact_id
 * are FK-enforced (SqliteStorageDriver runs with `foreign_keys = ON`),
 * so a publications row cannot be inserted against bare random UUIDs --
 * it needs a real, minimal upstream chain first. Mirrors
 * tests/unit/publication-pipeline-thumbnail.test.js's own
 * seedFullyEligibleContent() fixture pattern (deliberately
 * re-implemented locally per this repository's per-test-file
 * decoupling convention), trimmed to just the columns those tables
 * require -- analytics collection never reads Gate2/asset-verification
 * state, so none of that is seeded here.
 */
function seedPublicationChain(storage) {
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
  storage.run(`INSERT INTO content_versions (id, content_brief_id, script_id, state, created_at) VALUES (?, ?, ?, 'PUBLISHED', ?)`, [contentVersionId, contentBriefId, scriptId, nowISO()]);
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
     VALUES (?, ?, ?, '{}', 'chk', '/tmp/n.wav', 5.0, '/tmp/v.mp4', 'chk2', 5.0, 1280, 720, 'h264', 'aac', ?)`,
    [mediaArtifactId, productionId, contentVersionId, nowISO()]
  );
  return { contentVersionId, mediaArtifactId };
}

function insertPublication(storage, { id = crypto.randomUUID(), providerItemId, status = 'PUBLISHED', provider = 'youtube' } = {}) {
  const { contentVersionId, mediaArtifactId } = seedPublicationChain(storage);
  storage.run(
    `INSERT INTO publications (id, content_version_id, media_artifact_id, provider, status, request_json, provider_item_id, attempt_count, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, '{}', ?, 1, ?, ?)`,
    [id, contentVersionId, mediaArtifactId, provider, status, providerItemId, nowISO(), nowISO()]
  );
  return id;
}

test('a successful collection normalizes and persists only the metrics YouTube reported', async () => {
  const { storage, dbPath } = freshStorage();
  try {
    const pubId = insertPublication(storage, { providerItemId: 'vid1' });
    const adapter = {
      async collect({ videoIds }) {
        assert.deepEqual(videoIds, ['vid1']);
        return { status: ANALYTICS_RESULT_STATUS.SUCCESS, provider: 'youtube', byVideoId: { vid1: { views: 1000, likes: 42 } } };
      }
    };
    const summary = await collectAnalytics({ storage, adapter, periodStart: '2026-09-01', periodEnd: '2026-09-01' });
    assert.equal(summary.collected, 1);
    const row = storage.get('SELECT * FROM analytics_snapshots WHERE publication_id = ?', [pubId]);
    assert.equal(row.views, 1000);
    assert.equal(row.likes, 42);
    assert.equal(row.comments, null);
    assert.equal(row.impressions_ctr, null);
    assert.equal(row.status, 'SUCCESS');
    assert.equal(row.provider_item_id, 'vid1');
  } finally {
    cleanup(storage, dbPath);
  }
});

test('a metric YouTube omits is stored as NULL, never coerced to zero', async () => {
  const { storage, dbPath } = freshStorage();
  try {
    insertPublication(storage, { providerItemId: 'vid1' });
    const adapter = {
      async collect() {
        return { status: ANALYTICS_RESULT_STATUS.SUCCESS, provider: 'youtube', byVideoId: { vid1: { views: 5 } } };
      }
    };
    await collectAnalytics({ storage, adapter, periodStart: '2026-09-01', periodEnd: '2026-09-01' });
    const row = storage.get('SELECT * FROM analytics_snapshots');
    assert.equal(row.views, 5);
    assert.equal(row.likes, null);
    assert.notEqual(row.likes, 0);
  } finally {
    cleanup(storage, dbPath);
  }
});

test('multiple published videos are collected independently in one batched call', async () => {
  const { storage, dbPath } = freshStorage();
  try {
    insertPublication(storage, { providerItemId: 'vid1' });
    insertPublication(storage, { providerItemId: 'vid2' });
    let calls = 0;
    const adapter = {
      async collect({ videoIds }) {
        calls += 1;
        assert.equal(videoIds.length, 2);
        return { status: ANALYTICS_RESULT_STATUS.SUCCESS, provider: 'youtube', byVideoId: { vid1: { views: 1 }, vid2: { views: 2 } } };
      }
    };
    const summary = await collectAnalytics({ storage, adapter, periodStart: '2026-09-01', periodEnd: '2026-09-01' });
    assert.equal(calls, 1, 'both videos are covered by one batched request');
    assert.equal(summary.collected, 2);
  } finally {
    cleanup(storage, dbPath);
  }
});

test('one video failing does not prevent other eligible videos from being processed', async () => {
  const { storage, dbPath } = freshStorage();
  try {
    insertPublication(storage, { providerItemId: 'vid1' });
    // Force two batches so each is an independent adapter call.
    const ids = [];
    for (let i = 0; i < MAX_VIDEOS_PER_BATCH; i++) ids.push(insertPublication(storage, { providerItemId: `filler${i}` }));

    let call = 0;
    const adapter = {
      async collect({ videoIds }) {
        call += 1;
        if (call === 1) {
          // First batch (the 50 filler videos): transient failure.
          return { status: ANALYTICS_RESULT_STATUS.TRANSIENT_FAILURE, provider: 'youtube', errorClass: 'server_error_503' };
        }
        // Second batch (vid1): succeeds.
        return { status: ANALYTICS_RESULT_STATUS.SUCCESS, provider: 'youtube', byVideoId: Object.fromEntries(videoIds.map((id) => [id, { views: 1 }])) };
      }
    };
    const summary = await collectAnalytics({ storage, adapter, periodStart: '2026-09-01', periodEnd: '2026-09-01' });
    assert.equal(summary.aborted, false);
    assert.equal(summary.failed, MAX_VIDEOS_PER_BATCH);
    assert.equal(summary.collected, 1);
  } finally {
    cleanup(storage, dbPath);
  }
});

test('analytics genuinely unavailable for a video is never recorded as zero performance', async () => {
  const { storage, dbPath } = freshStorage();
  try {
    const pubId = insertPublication(storage, { providerItemId: 'vid1' });
    const adapter = {
      async collect() {
        return { status: ANALYTICS_RESULT_STATUS.SUCCESS, provider: 'youtube', byVideoId: { vid1: null } };
      }
    };
    await collectAnalytics({ storage, adapter, periodStart: '2026-09-01', periodEnd: '2026-09-01' });
    const row = storage.get('SELECT * FROM analytics_snapshots WHERE publication_id = ?', [pubId]);
    assert.equal(row.status, 'UNAVAILABLE');
    assert.equal(row.views, null);
  } finally {
    cleanup(storage, dbPath);
  }
});

test('an authentication failure is classified correctly and aborts remaining batches', async () => {
  const { storage, dbPath } = freshStorage();
  try {
    for (let i = 0; i < MAX_VIDEOS_PER_BATCH + 1; i++) insertPublication(storage, { providerItemId: `vid${i}` });
    let calls = 0;
    const adapter = {
      async collect() {
        calls += 1;
        return { status: ANALYTICS_RESULT_STATUS.AUTH_FAILURE, provider: 'youtube', errorClass: 'http_401' };
      }
    };
    const summary = await collectAnalytics({ storage, adapter, periodStart: '2026-09-01', periodEnd: '2026-09-01' });
    assert.equal(summary.batches, 2);
    assert.equal(calls, 1, 'the second batch is never attempted once an auth failure is confirmed');
    assert.equal(summary.aborted, true);
    const rows = storage.all(`SELECT status FROM analytics_snapshots`);
    assert.ok(rows.every((r) => r.status === 'AUTH_FAILURE'));
  } finally {
    cleanup(storage, dbPath);
  }
});

test('rate-limit failures are recorded distinctly from other failure classes', async () => {
  const { storage, dbPath } = freshStorage();
  try {
    const pubId = insertPublication(storage, { providerItemId: 'vid1' });
    const adapter = { async collect() { return { status: ANALYTICS_RESULT_STATUS.RATE_LIMITED, provider: 'youtube', errorClass: 'RATE_LIMIT_RETRIES_EXHAUSTED' }; } };
    await collectAnalytics({ storage, adapter, periodStart: '2026-09-01', periodEnd: '2026-09-01' });
    const row = storage.get('SELECT * FROM analytics_snapshots WHERE publication_id = ?', [pubId]);
    assert.equal(row.status, 'RATE_LIMITED');
  } finally {
    cleanup(storage, dbPath);
  }
});

test('publication isolation: analytics collection never modifies the publications row it read', async () => {
  const { storage, dbPath } = freshStorage();
  try {
    const pubId = insertPublication(storage, { providerItemId: 'vid1' });
    const before = storage.get('SELECT * FROM publications WHERE id = ?', [pubId]);
    const adapter = { async collect() { return { status: ANALYTICS_RESULT_STATUS.SUCCESS, provider: 'youtube', byVideoId: { vid1: { views: 1 } } }; } };
    await collectAnalytics({ storage, adapter, periodStart: '2026-09-01', periodEnd: '2026-09-01' });
    const after = storage.get('SELECT * FROM publications WHERE id = ?', [pubId]);
    assert.deepEqual(before, after);
  } finally {
    cleanup(storage, dbPath);
  }
});

test('analytics collection never calls a publish- or thumbnail-shaped adapter method', async () => {
  const { storage, dbPath } = freshStorage();
  try {
    insertPublication(storage, { providerItemId: 'vid1' });
    let publishCalled = false;
    let thumbnailCalled = false;
    const adapter = {
      async collect() { return { status: ANALYTICS_RESULT_STATUS.SUCCESS, provider: 'youtube', byVideoId: { vid1: { views: 1 } } }; },
      async publish() { publishCalled = true; },
      async publishThumbnail() { thumbnailCalled = true; }
    };
    await collectAnalytics({ storage, adapter, periodStart: '2026-09-01', periodEnd: '2026-09-01' });
    assert.equal(publishCalled, false);
    assert.equal(thumbnailCalled, false);
  } finally {
    cleanup(storage, dbPath);
  }
});

test('idempotency: repeated collection of the identical period upserts the same row rather than duplicating', async () => {
  const { storage, dbPath } = freshStorage();
  try {
    const pubId = insertPublication(storage, { providerItemId: 'vid1' });
    let views = 10;
    const adapter = { async collect() { return { status: ANALYTICS_RESULT_STATUS.SUCCESS, provider: 'youtube', byVideoId: { vid1: { views } } }; } };
    await collectAnalytics({ storage, adapter, periodStart: '2026-09-01', periodEnd: '2026-09-01' });
    views = 25;
    await collectAnalytics({ storage, adapter, periodStart: '2026-09-01', periodEnd: '2026-09-01' });
    const rows = storage.all('SELECT * FROM analytics_snapshots WHERE publication_id = ?', [pubId]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].views, 25);
  } finally {
    cleanup(storage, dbPath);
  }
});

test('idempotency: collecting a different period for the same publication preserves prior history', async () => {
  const { storage, dbPath } = freshStorage();
  try {
    const pubId = insertPublication(storage, { providerItemId: 'vid1' });
    const adapter = { async collect() { return { status: ANALYTICS_RESULT_STATUS.SUCCESS, provider: 'youtube', byVideoId: { vid1: { views: 1 } } }; } };
    await collectAnalytics({ storage, adapter, periodStart: '2026-09-01', periodEnd: '2026-09-01' });
    await collectAnalytics({ storage, adapter, periodStart: '2026-09-02', periodEnd: '2026-09-02' });
    const rows = storage.all('SELECT * FROM analytics_snapshots WHERE publication_id = ? ORDER BY period_start', [pubId]);
    assert.equal(rows.length, 2);
  } finally {
    cleanup(storage, dbPath);
  }
});

test('only PUBLISHED publications with a confirmed provider_item_id are eligible', async () => {
  const { storage, dbPath } = freshStorage();
  try {
    const published = insertPublication(storage, { providerItemId: 'vid1', status: 'PUBLISHED' });
    insertPublication(storage, { providerItemId: 'vid2', status: 'FAILED' });
    const noId = insertPublication(storage, { providerItemId: null, status: 'PUBLISHED' });
    const eligible = selectEligiblePublicationsForAnalytics(storage, 'youtube');
    assert.equal(eligible.length, 1);
    assert.equal(eligible[0].id, published);
    assert.ok(!eligible.some((p) => p.id === noId));
  } finally {
    cleanup(storage, dbPath);
  }
});

test('an adapter throwing is classified as a permanent failure rather than crashing the run', async () => {
  const { storage, dbPath } = freshStorage();
  try {
    const pubId = insertPublication(storage, { providerItemId: 'vid1' });
    const adapter = { async collect() { throw new Error('boom'); } };
    const summary = await collectAnalytics({ storage, adapter, periodStart: '2026-09-01', periodEnd: '2026-09-01' });
    assert.equal(summary.failed, 1);
    const row = storage.get('SELECT * FROM analytics_snapshots WHERE publication_id = ?', [pubId]);
    assert.equal(row.status, 'PERMANENT_FAILURE');
  } finally {
    cleanup(storage, dbPath);
  }
});