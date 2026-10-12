import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  windowPeriods, collectMeasurements, buildRecommendations, generateRecommendations, decideRecommendation,
  listRecommendations, DATA_LATENCY_DAYS
} from '../../src/analytics/recommendations.js';

// Publication published 2026-09-01T10:00Z => 24H = 2026-09-02, 7D = 2026-09-02..2026-09-08.
const PUBLISHED_AT = '2026-09-01T10:00:00.000Z';
const NOW = '2026-10-01T00:00:00.000Z';
const W24 = { start: '2026-09-02', end: '2026-09-02' };
const W7 = { start: '2026-09-02', end: '2026-09-08' };

function pub(n, over = {}) {
  return {
    id: `pub${n}`, provider: 'youtube', provider_item_id: `vid${n}`, status: 'PUBLISHED', content_version_id: `cv${n}`,
    request_json: JSON.stringify({ requestedPublishAt: null }), result_json: JSON.stringify({ confirmedVisibility: 'public' }),
    published_at: PUBLISHED_AT, run_mode: 'LIVE', ...over
  };
}
function snap(n, w, over = {}) {
  return {
    id: `snap${n}-${w.start}-${w.end}`, publication_id: `pub${n}`, provider: 'youtube', provider_item_id: `vid${n}`,
    period_start: w.start, period_end: w.end, collected_at: '2026-09-20T00:00:00.000Z', status: 'SUCCESS',
    views: 500, impressions: 5000, impressions_ctr: 4, average_view_percentage: 40, ...over
  };
}
const ev = (publications, snapshots) => ({ provider: 'youtube', publications, snapshots });

test('windows are fixed UTC days after the publish date', () => {
  assert.deepEqual(windowPeriods(PUBLISHED_AT), { '24H': W24, '7D': W7 });
  assert.equal(windowPeriods('not a date'), null);
});

test('valid comparison: outlier vs median of >=2 comparable videos yields a candidate', () => {
  const pubs = [pub(1), pub(2), pub(3)];
  const snaps = [snap(1, W7, { average_view_percentage: 20 }), snap(2, W7, { average_view_percentage: 40 }), snap(3, W7, { average_view_percentage: 44 })];
  const r = buildRecommendations(ev(pubs, snaps), { now: NOW });
  assert.equal(r.status, 'OK');
  const c = r.candidates.find((x) => x.metric === 'average_view_percentage' && x.window === '7D');
  assert.equal(c.providerItemId, 'vid1');
  assert.equal(c.direction, 'BELOW_BASELINE');
  assert.equal(c.baselineCount, 2);
  assert.equal(c.baselineMedian, 42);
  assert.match(c.summary, /Descriptive only/);
});

test('fewer than 3 comparable videos is explicit INSUFFICIENT_DATA, never a guess', () => {
  const r = buildRecommendations(ev([pub(1), pub(2)], [snap(1, W7), snap(2, W7, { average_view_percentage: 10 })]), { now: NOW });
  assert.equal(r.status, 'INSUFFICIENT_DATA');
  assert.equal(r.candidates.length, 0);
  assert.ok(r.reasons.some((x) => x.startsWith('fewer_than_3_comparable_measurements')));
  assert.equal(buildRecommendations(ev([], []), { now: NOW }).status, 'INSUFFICIENT_DATA');
});

test('overlapping or arbitrary periods are never used; collection need is reported', () => {
  const bad = [
    snap(1, { start: '2026-09-01', end: '2026-09-08' }),   // starts on publish day
    snap(2, { start: '2026-09-02', end: '2026-09-09' }),   // 8 days
    snap(3, { start: '2026-09-02', end: '2026-09-07' })    // 6 days
  ];
  const r = collectMeasurements(ev([pub(1), pub(2), pub(3)], bad), { now: NOW });
  assert.equal(r.measurements.length, 0);
  assert.ok(r.exclusions.some((e) => e.reason === 'no_snapshot_for_exact_window' && e.window === '7D'));
  assert.deepEqual(r.collectionNeeded.filter((c) => c.publicationId === 'pub1' && c.window === '7D').map((c) => [c.periodStart, c.periodEnd]), [['2026-09-02', '2026-09-08']]);
});

test('windows not yet settled are excluded (data latency)', () => {
  const justAfter = new Date(Date.parse('2026-09-09T00:00:00Z') + (DATA_LATENCY_DAYS * 86400000) - 1).toISOString();
  const early = collectMeasurements(ev([pub(1)], [snap(1, W7)]), { now: justAfter });
  assert.ok(early.exclusions.some((e) => e.reason === 'window_not_yet_usable' && e.window === '7D'));
  const settled = collectMeasurements(ev([pub(1)], [snap(1, W7)]), { now: new Date(Date.parse(justAfter) + 1).toISOString() });
  assert.ok(settled.measurements.some((m) => m.window === '7D'));
  const early2 = collectMeasurements(ev([pub(1)], [snap(1, W7, { collected_at: '2026-09-09T12:00:00.000Z' })]), { now: NOW });
  assert.ok(early2.exclusions.some((e) => e.reason === 'snapshot_collected_before_data_settled'));
});

test('unverified or non-real evidence is excluded', () => {
  const cases = [
    [pub(1, { run_mode: 'SIMULATION' }), 'run_mode_not_live'],
    [pub(1, { run_mode: null }), 'publication_not_linked_to_a_run'],
    [pub(1, { result_json: JSON.stringify({ confirmedVisibility: 'private' }) }), 'visibility_not_confirmed_public'],
    [pub(1, { result_json: null }), 'visibility_not_confirmed_public'],
    [pub(1, { request_json: JSON.stringify({ requestedPublishAt: '2026-09-05T00:00:00Z' }) }), 'scheduled_publication'],
    [pub(1, { published_at: null }), 'no_persisted_published_decision'],
    [pub(1, { status: 'AMBIGUOUS' }), 'publication_not_confirmed_published'],
    [pub(1, { provider_item_id: null }), 'publication_not_confirmed_published']
  ];
  for (const [p, reason] of cases) {
    const r = collectMeasurements(ev([p], [snap(1, W7)]), { now: NOW });
    assert.equal(r.measurements.length, 0, reason);
    assert.ok(r.exclusions.some((e) => e.reason === reason), reason);
  }
});

test('bad snapshots are excluded: status, identity, NULL/invalid metric, low impressions', () => {
  const run = (s) => collectMeasurements(ev([pub(1)], [s]), { now: NOW });
  assert.ok(run(snap(1, W7, { status: 'UNAVAILABLE' })).exclusions.some((e) => e.reason === 'snapshot_not_success'));
  assert.ok(run(snap(1, W7, { provider_item_id: 'other' })).exclusions.some((e) => e.reason === 'snapshot_identity_mismatch'));
  const nullMetric = run(snap(1, W7, { average_view_percentage: null }));
  assert.ok(nullMetric.exclusions.some((e) => e.reason === 'average_view_percentage_missing_or_invalid'));
  assert.ok(!nullMetric.measurements.some((m) => m.metric === 'average_view_percentage')); // NULL never becomes 0
  assert.ok(run(snap(1, W7, { average_view_percentage: 140 })).exclusions.some((e) => e.reason === 'average_view_percentage_missing_or_invalid'));
  const lowImp = run(snap(1, W7, { impressions: 10 }));
  assert.ok(lowImp.exclusions.some((e) => e.reason === 'impressions_ctr_impressions_below_minimum'));
  assert.ok(lowImp.measurements.some((m) => m.metric === 'average_view_percentage'));
});

test('windows are never mixed: 24H and 7D are compared only within their own window', () => {
  const pubs = [pub(1), pub(2), pub(3)];
  const snaps = [snap(1, W24, { average_view_percentage: 10 }), snap(2, W7, { average_view_percentage: 40 }), snap(3, W7, { average_view_percentage: 44 })];
  const r = buildRecommendations(ev(pubs, snaps), { now: NOW });
  assert.equal(r.status, 'INSUFFICIENT_DATA');
  assert.equal(r.candidates.length, 0);
});

// ---- database-backed: pending/approval flow, idempotency, snapshots untouched ----
async function openStorage() {
  const dbPath = path.join(os.tmpdir(), `analytics-reco-${process.pid}-${Date.now()}-${Math.random()}.db`);
  try {
    const { SqliteStorageDriver } = await import('../../src/storage/SqliteStorageDriver.js');
    const storage = new SqliteStorageDriver({ dbPath });
    await storage.migrate();
    return { storage, cleanup: () => { storage.close(); for (const s of ['', '-wal', '-shm']) fs.rmSync(dbPath + s, { force: true }); } };
  } catch (err) {
    // Environments without a working better-sqlite3 binding: same SQL via node:sqlite.
    if (!/better-sqlite3|dlopen|bindings|Cannot find/i.test(String(err?.message ?? err))) throw err;
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(':memory:');
    const dir = fileURLToPath(new URL('../../src/db/migrations/', import.meta.url));
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) db.exec(fs.readFileSync(path.join(dir, f), 'utf8'));
    return {
      storage: {
        run: (sql, p = []) => { const r = db.prepare(sql).run(...p); return { changes: Number(r.changes) }; },
        all: (sql, p = []) => db.prepare(sql).all(...p),
        get: (sql, p = []) => db.prepare(sql).get(...p)
      },
      cleanup: () => db.close()
    };
  }
}

function seed(storage, n, avp) {
  storage.run(`INSERT INTO system_runs (id, mode, autonomous_enabled, started_at, config_snapshot) VALUES (?, 'LIVE', 1, ?, '{}')`, [`run${n}`, PUBLISHED_AT]);
  storage.run(
    `INSERT INTO publications (id, content_version_id, media_artifact_id, provider, status, request_json, provider_item_id, result_json, created_at, updated_at)
     VALUES (?, ?, ?, 'youtube', 'PUBLISHED', ?, ?, ?, ?, ?)`,
    [`pub${n}`, `cv${n}`, `ma${n}`, JSON.stringify({ requestedPublishAt: null }), `vid${n}`, JSON.stringify({ confirmedVisibility: 'public' }), PUBLISHED_AT, PUBLISHED_AT]
  );
  storage.run(
    `INSERT INTO decision_log (id, run_id, subject_type, subject_id, decision, reason, created_at) VALUES (?, ?, 'content_version', ?, 'PUBLISHED', ?, ?)`,
    [`dl${n}`, `run${n}`, `cv${n}`, `publication_pub${n}_persisted`, PUBLISHED_AT]
  );
  storage.run(
    `INSERT INTO analytics_snapshots (id, publication_id, provider, provider_item_id, period_start, period_end, collected_at, views, impressions, impressions_ctr,
       average_view_percentage, status, result_json, created_at) VALUES (?, ?, 'youtube', ?, ?, ?, '2026-09-20T00:00:00.000Z', 500, 5000, 4, ?, 'SUCCESS', '{}', ?)`,
    [`sn${n}`, `pub${n}`, `vid${n}`, W7.start, W7.end, avp, NOW]
  );
}

test('database flow: findings are PENDING, idempotent, snapshots untouched, approval only changes the row', async () => {
  const { storage, cleanup } = await openStorage();
  try {
    storage.run('PRAGMA foreign_keys = OFF');
    seed(storage, 1, 20); seed(storage, 2, 40); seed(storage, 3, 44);
    const before = JSON.stringify(storage.all('SELECT * FROM analytics_snapshots ORDER BY id'));
    const pubsBefore = JSON.stringify(storage.all('SELECT * FROM publications ORDER BY id'));

    const first = generateRecommendations({ storage, now: () => NOW });
    assert.equal(first.status, 'OK');
    assert.equal(first.created, 3); // 20 vs median 42 (below); 40 vs 32 and 44 vs 30 (above)
    const rows = listRecommendations(storage);
    assert.equal(rows.length, 3);
    assert.ok(rows.every((r) => r.status === 'PENDING' && r.decided_at === null));
    assert.equal(rows.find((r) => r.provider_item_id === 'vid1').direction, 'BELOW_BASELINE');

    const again = generateRecommendations({ storage, now: () => NOW });
    assert.equal(again.created, 0);
    assert.equal(again.existing, 3);
    assert.equal(listRecommendations(storage).length, 3);

    assert.throws(() => decideRecommendation({ storage, id: rows[0].id, decision: 'PUBLISH' }));
    const approved = decideRecommendation({ storage, id: rows[0].id, decision: 'APPROVED', note: 'reviewed', now: () => NOW });
    assert.equal(approved.status, 'APPROVED');
    assert.throws(() => decideRecommendation({ storage, id: rows[0].id, decision: 'REJECTED' }), /not PENDING/);
    assert.equal(generateRecommendations({ storage, now: () => NOW }).created, 0);
    assert.equal(listRecommendations(storage, { status: 'PENDING' }).length, 2); // the other two stay pending
    assert.equal(listRecommendations(storage, { status: 'APPROVED' }).length, 1);

    assert.equal(JSON.stringify(storage.all('SELECT * FROM analytics_snapshots ORDER BY id')), before);
    assert.equal(JSON.stringify(storage.all('SELECT * FROM publications ORDER BY id')), pubsBefore);
  } finally { cleanup(); }
});

test('database flow: simulated-run publications yield INSUFFICIENT_DATA and no rows', async () => {
  const { storage, cleanup } = await openStorage();
  try {
    storage.run('PRAGMA foreign_keys = OFF');
    seed(storage, 1, 20); seed(storage, 2, 40); seed(storage, 3, 44);
    storage.run(`UPDATE system_runs SET mode = 'SIMULATION'`);
    const r = generateRecommendations({ storage, now: () => NOW });
    assert.equal(r.status, 'INSUFFICIENT_DATA');
    assert.equal(r.created, 0);
    assert.equal(listRecommendations(storage).length, 0);
  } finally { cleanup(); }
});
