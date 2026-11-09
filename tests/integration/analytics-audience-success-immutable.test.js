import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { collectAudienceAnalytics } from '../../src/analytics/audienceCollection.js';
import { runWindowCollection } from '../../src/analytics/windowCollection.js';
import { SqliteStorageDriver } from '../../src/storage/SqliteStorageDriver.js';

// A previously SUCCESSful audience snapshot must never be downgraded or replaced by a later attempt,
// even by a caller that bypasses the planner (enforced in SQL, not only in the planner).
const PUBLISHED_AT = '2020-01-01T10:00:00.000Z';
const NOW = '2026-10-01T00:00:00.000Z';
const T = [{ publicationId: 'pub1', periodStart: '2020-01-02', periodEnd: '2020-01-08', kinds: ['RETENTION'] }];

async function open() {
  const dbPath = path.join(os.tmpdir(), `immut-${process.pid}-${Math.random()}.db`);
  const storage = new SqliteStorageDriver({ dbPath });
  await storage.migrate();
  storage.run('PRAGMA foreign_keys = OFF');
  storage.run(`INSERT INTO system_runs (id, mode, autonomous_enabled, started_at, config_snapshot) VALUES ('run1', 'LIVE', 1, ?, '{}')`, [PUBLISHED_AT]);
  storage.run(`INSERT INTO publications (id, content_version_id, media_artifact_id, provider, status, request_json, provider_item_id, result_json, created_at, updated_at)
    VALUES ('pub1', 'cv1', 'ma1', 'youtube', 'PUBLISHED', ?, 'vidAAAAAA1', ?, ?, ?)`, [JSON.stringify({ requestedPublishAt: null }), JSON.stringify({ confirmedVisibility: 'public' }), PUBLISHED_AT, PUBLISHED_AT]);
  storage.run(`INSERT INTO decision_log (id, run_id, subject_type, subject_id, decision, reason, created_at) VALUES ('dl1', 'run1', 'content_version', 'cv1', 'PUBLISHED', 'publication_pub1_persisted', ?)`, [PUBLISHED_AT]);
  return { storage, cleanup: () => { storage.close(); for (const s of ['', '-wal', '-shm']) fs.rmSync(dbPath + s, { force: true }); } };
}
const okRet = { status: 'SUCCESS', summary: { at10: 0.9, at25: 0.7, at50: 0.5, at75: 0.3, steepestDrop: null, pointCount: 100 }, points: [] };
const traffic = async () => ({ status: 'UNAVAILABLE', errorClass: 'no_data' });
const row = (s) => s.get(`SELECT status, failure_reason, summary_json, result_json FROM analytics_audience_snapshots WHERE kind = 'RETENTION'`);

test('SUCCESS snapshot survives a later failed attempt that bypasses the planner (race: SUCCESS lands during the request)', async () => {
  const { storage, cleanup } = await open();
  try {
    // Simulates a concurrent job: the pre-request check sees no SUCCESS, then SUCCESS is written
    // while this job's request is in flight, then this job's request FAILS.
    const racing = {
      collectTrafficSources: traffic,
      collectRetentionCurve: async () => {
        await collectAudienceAnalytics({ storage, adapter: { collectTrafficSources: traffic, collectRetentionCurve: async () => okRet }, targets: T, nowISO: () => NOW });
        return { status: 'TRANSIENT_FAILURE', errorClass: 'http_503' };
      }
    };
    const out = await collectAudienceAnalytics({ storage, adapter: racing, targets: T, nowISO: () => NOW });
    const r = row(storage);
    assert.equal(r.status, 'SUCCESS');
    assert.equal(r.failure_reason, null);
    assert.ok(r.summary_json, 'summary is not nulled');
    assert.equal(out.failed, 0, 'blocked downgrade is not counted as a failure');
    assert.equal(out.alreadyCollected, 1);
    assert.equal(out.requested, 0);
    assert.equal(storage.all(`SELECT id FROM analytics_audience_snapshots`).length, 1);
  } finally { cleanup(); }
});

test('a second SUCCESS does not replace the first (duplicate job keeps the original row)', async () => {
  const { storage, cleanup } = await open();
  try {
    const adapter = { collectTrafficSources: traffic, collectRetentionCurve: async () => okRet };
    await collectAudienceAnalytics({ storage, adapter, targets: T, nowISO: () => '2026-10-01T00:00:00.000Z' });
    const first = storage.get(`SELECT collected_at FROM analytics_audience_snapshots WHERE kind='RETENTION'`);
    await collectAudienceAnalytics({ storage, adapter, targets: T, nowISO: () => '2026-10-02T00:00:00.000Z' });
    assert.equal(storage.get(`SELECT collected_at FROM analytics_audience_snapshots WHERE kind='RETENTION'`).collected_at, first.collected_at);
  } finally { cleanup(); }
});

test('failed rows still retry: FAILED -> SUCCESS upgrades the row; FAILED -> FAILED updates it', async () => {
  const { storage, cleanup } = await open();
  try {
    const fail = { collectTrafficSources: traffic, collectRetentionCurve: async () => ({ status: 'TRANSIENT_FAILURE', errorClass: 'http_503' }) };
    await collectAudienceAnalytics({ storage, adapter: fail, targets: T, nowISO: () => NOW });
    assert.equal(row(storage).status, 'TRANSIENT_FAILURE');
    const fail2 = { collectTrafficSources: traffic, collectRetentionCurve: async () => ({ status: 'TRANSIENT_FAILURE', errorClass: 'http_500' }) };
    await collectAudienceAnalytics({ storage, adapter: fail2, targets: T, nowISO: () => NOW });
    assert.equal(row(storage).failure_reason, 'http_500');
    await collectAudienceAnalytics({ storage, adapter: { collectTrafficSources: traffic, collectRetentionCurve: async () => okRet }, targets: T, nowISO: () => NOW });
    assert.equal(row(storage).status, 'SUCCESS');
    assert.equal(storage.all(`SELECT id FROM analytics_audience_snapshots WHERE kind='RETENTION'`).length, 1);
  } finally { cleanup(); }
});

test('unsupported adapter: explicit AUDIENCE_ADAPTER_UNSUPPORTED, failed, no rows written; scalar status not overwritten', async () => {
  const { storage, cleanup } = await open();
  try {
    const adapter = { collect: async (a) => ({ status: 'SUCCESS', byVideoId: Object.fromEntries(a.videoIds.map((v) => [v, { views: 10, impressions: 2000, impressionsCtr: 5, averageViewPercentage: 50 }])) }) };
    const res = await runWindowCollection({ storage, adapter, now: () => NOW, lockPath: path.join(os.tmpdir(), `u-lock-${process.pid}-${Math.random()}`) });
    assert.equal(res.status, 'OK', 'scalar status stays OK');
    assert.equal(res.audience.status, 'FAILED');
    assert.equal(res.overallStatus, 'PARTIAL');
    assert.match(res.audience.result.error, /AUDIENCE_ADAPTER_UNSUPPORTED/);
    assert.equal(storage.all(`SELECT id FROM analytics_audience_snapshots`).length, 0);
  } finally { cleanup(); }
});
