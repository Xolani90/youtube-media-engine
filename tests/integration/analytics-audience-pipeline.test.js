import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { YouTubeAnalyticsAdapter } from '../../src/analytics/youtube/YouTubeAnalyticsAdapter.js';
import { runWindowCollection } from '../../src/analytics/windowCollection.js';
import { generateRecommendations, buildRecommendations, loadEvidence, listRecommendations } from '../../src/analytics/recommendations.js';

// Collection -> persistence -> recommendations, end to end, with the REAL adapter
// (fake fetch returning API-shaped JSON: string elapsedVideoTimeRatio), a REAL
// migrated database, the REAL window runner and the REAL recommendation
// generator. The responses are API-shaped, not recorded live data.

const PUBLISHED_AT = '2026-09-01T10:00:00.000Z';
const NOW = '2026-10-01T00:00:00.000Z';

async function openStorage() {
  const dbPath = path.join(os.tmpdir(), `analytics-aud-${process.pid}-${Date.now()}-${Math.random()}.db`);
  try {
    const { SqliteStorageDriver } = await import('../../src/storage/SqliteStorageDriver.js');
    const storage = new SqliteStorageDriver({ dbPath });
    await storage.migrate();
    return { storage, cleanup: () => { storage.close(); for (const s of ['', '-wal', '-shm']) fs.rmSync(dbPath + s, { force: true }); } };
  } catch (err) {
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
function seed(storage, n) {
  storage.run(`INSERT INTO system_runs (id, mode, autonomous_enabled, started_at, config_snapshot) VALUES (?, 'LIVE', 1, ?, '{}')`, [`run${n}`, PUBLISHED_AT]);
  storage.run(
    `INSERT INTO publications (id, content_version_id, media_artifact_id, provider, status, request_json, provider_item_id, result_json, created_at, updated_at)
     VALUES (?, ?, ?, 'youtube', 'PUBLISHED', ?, ?, ?, ?, ?)`,
    [`pub${n}`, `cv${n}`, `ma${n}`, JSON.stringify({ requestedPublishAt: null }), `vidAAAAAA${n}`, JSON.stringify({ confirmedVisibility: 'public' }), PUBLISHED_AT, PUBLISHED_AT]
  );
  storage.run(`INSERT INTO decision_log (id, run_id, subject_type, subject_id, decision, reason, created_at) VALUES (?, ?, 'content_version', ?, 'PUBLISHED', ?, ?)`,
    [`dl${n}`, `run${n}`, `cv${n}`, `publication_pub${n}_persisted`, PUBLISHED_AT]);
}

// ---- API-shaped fake YouTube Analytics ----
const RET_H = [
  { name: 'elapsedVideoTimeRatio', columnType: 'DIMENSION', dataType: 'STRING' },
  { name: 'audienceWatchRatio', columnType: 'METRIC', dataType: 'FLOAT' },
  { name: 'relativeRetentionPerformance', columnType: 'METRIC', dataType: 'FLOAT' }
];
const TRAF_H = [
  { name: 'insightTrafficSourceType', columnType: 'DIMENSION', dataType: 'STRING' },
  { name: 'views', columnType: 'METRIC', dataType: 'INTEGER' },
  { name: 'estimatedMinutesWatched', columnType: 'METRIC', dataType: 'INTEGER' }
];
const BASE_H = ['video', 'views', 'likes', 'comments', 'shares', 'estimatedMinutesWatched', 'averageViewDuration', 'averageViewPercentage', 'impressions', 'impressionsClickThroughRate'].map((name) => ({ name }));
const retentionRows = (at50) => Array.from({ length: 100 }, (_, i) => [((i + 1) / 100).toFixed(2), Math.round(Math.pow(at50, ((i + 1) / 100) * 2) * 1e6) / 1e6, 0.5]);
const AT50 = { 1: 0.2, 2: 0.58, 3: 0.6, 4: 0.62 }; // video 1 retains badly
const TRAFFIC = {
  1: [['RELATED_VIDEO', 800, 300], ['YT_SEARCH', 100, 40], ['SHORTS', 100, 30]],
  2: [['YT_SEARCH', 500, 200], ['RELATED_VIDEO', 300, 100], ['SHORTS', 200, 60]],
  3: [['YT_SEARCH', 520, 200], ['RELATED_VIDEO', 280, 100], ['SHORTS', 200, 60]],
  4: [['YT_SEARCH', 480, 200], ['RELATED_VIDEO', 320, 100], ['SHORTS', 200, 60]]
};
const ok = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });

function makeAdapter(overrides = {}) {
  const log = { report: [], retention: [], traffic: [] };
  const fetchImpl = async (url) => {
    if (String(url).startsWith('https://oauth2.googleapis.com/token')) return ok({ access_token: 'tok' });
    const q = new URL(url).searchParams;
    const dims = q.get('dimensions');
    const ids = (q.get('filters') ?? '').replace('video==', '').split(',');
    if (dims === 'video') { log.report.push(ids); return overrides.report?.() ?? ok({ columnHeaders: BASE_H, rows: ids.map((id) => [id, 100, 5, 1, 0, 50, 30, 40, 5000, 4]) }); }
    const n = Number(ids[0].slice(-1));
    if (dims === 'elapsedVideoTimeRatio') {
      log.retention.push(ids[0]);
      return overrides.retention?.(n) ?? ok({ columnHeaders: RET_H, rows: retentionRows(AT50[n]) });
    }
    if (dims === 'insightTrafficSourceType') {
      log.traffic.push(ids[0]);
      return overrides.traffic?.(n) ?? ok({ columnHeaders: TRAF_H, rows: TRAFFIC[n] });
    }
    throw new Error(`unexpected report ${dims}`);
  };
  const adapter = new YouTubeAnalyticsAdapter({ fetchImpl, sleepImpl: async () => {}, credentialsProvider: () => ({ clientId: 'c', clientSecret: 's', refreshToken: 'r' }) });
  return { adapter, log };
}
const lockFile = () => path.join(os.tmpdir(), `aud-lock-${process.pid}-${Math.random()}.lock`);
async function setup(overrides) {
  const { storage, cleanup } = await openStorage();
  storage.run('PRAGMA foreign_keys = OFF');
  for (const n of [1, 2, 3, 4]) seed(storage, n);
  return { storage, cleanup, ...makeAdapter(overrides), lp: lockFile() };
}

test('full path: collect -> persist -> recommend. Retention (string ratios) and traffic shares drive PENDING findings', async () => {
  const { storage, cleanup, adapter, log, lp } = await setup();
  try {
    const run = await runWindowCollection({ storage, adapter, now: () => NOW, lockPath: lp });
    assert.equal(run.status, 'OK');
    assert.equal(run.audience.result.collected, 16); // 4 videos x 2 windows x {retention, traffic}
    assert.equal(run.audience.result.failed, 0);

    const rows = storage.all('SELECT * FROM analytics_audience_snapshots');
    assert.equal(rows.length, 16);
    assert.ok(rows.every((r) => r.status === 'SUCCESS' && r.summary_json));
    const ret = rows.find((r) => r.kind === 'RETENTION' && r.provider_item_id === 'vidAAAAAA1' && r.period_end === '2026-09-08');
    const summary = JSON.parse(ret.summary_json);
    assert.equal(summary.at50, 0.2);
    assert.equal(summary.pointCount, 100);
    assert.equal(typeof summary.at25, 'number');
    const points = JSON.parse(ret.result_json).points;
    assert.equal(points.length, 100);
    assert.ok(points.every((p, i, a) => typeof p.ratio === 'number' && (i === 0 || a[i - 1].ratio < p.ratio)), 'persisted curve is numeric and ordered');
    const traf = JSON.parse(rows.find((r) => r.kind === 'TRAFFIC_SOURCES' && r.provider_item_id === 'vidAAAAAA1').summary_json);
    assert.deepEqual(traf, { totalViews: 1000, totalViewsComplete: true, zeroViews: false, shares: { RELATED_VIDEO: 0.8, YT_SEARCH: 0.1, SHORTS: 0.1 } });

    // Scalar collection is unchanged: batched per-video report, once per exact period.
    assert.equal(log.report.length, 2);
    assert.ok(log.report.every((ids) => ids.length === 4));
    assert.equal(storage.all('SELECT * FROM analytics_snapshots').length, 8);

    const gen = generateRecommendations({ storage, now: () => NOW });
    assert.equal(gen.status, 'OK');
    const recs = listRecommendations(storage, { status: 'PENDING' });
    const find = (metric, w, item) => recs.find((r) => r.metric === metric && r.window_kind === w && r.provider_item_id === item);
    for (const w of ['24H', '7D']) {
      const r50 = find('retention_at_50', w, 'vidAAAAAA1');
      assert.ok(r50, `retention_at_50 finding in ${w}`);
      assert.equal(r50.direction, 'BELOW_BASELINE');
      assert.equal(r50.subject_value, 0.2);
      assert.equal(r50.baseline_median, 0.6);
      assert.equal(r50.baseline_count, 3);
      assert.ok(find('retention_at_25', w, 'vidAAAAAA1'));
      assert.equal(find('traffic_share_yt_search', w, 'vidAAAAAA1').direction, 'BELOW_BASELINE');
      assert.equal(find('traffic_share_related_video', w, 'vidAAAAAA1').direction, 'ABOVE_BASELINE');
    }
    const ev = JSON.parse(find('retention_at_50', '7D', 'vidAAAAAA1').evidence_json);
    assert.ok(ev.snapshotId && ev.baselineSnapshotIds.length === 3);
    assert.equal(ev.context.steepestDrop.fromRatio, 0.01, 'steepest drop of an exponential decay is at the start of the curve');
    // Comparable videos produce no finding.
    assert.equal(recs.filter((r) => r.provider_item_id === 'vidAAAAAA3' && r.metric.startsWith('retention')).length, 0);

    // Idempotent generation; and a second collection run makes no further audience requests.
    const before = { retention: log.retention.length, traffic: log.traffic.length, report: log.report.length };
    const snapsBefore = JSON.stringify(storage.all('SELECT * FROM analytics_audience_snapshots ORDER BY id'));
    const again = await runWindowCollection({ storage, adapter, now: () => NOW, lockPath: lp });
    assert.equal(again.status, 'OK');
    assert.equal(again.audience.result, null, 'nothing due, nothing requested');
    assert.deepEqual({ retention: log.retention.length, traffic: log.traffic.length, report: log.report.length }, before);
    assert.equal(JSON.stringify(storage.all('SELECT * FROM analytics_audience_snapshots ORDER BY id')), snapsBefore);
    assert.equal(generateRecommendations({ storage, now: () => NOW }).created, 0);
    assert.equal(fs.existsSync(lp), false);
  } finally { cleanup(); fs.rmSync(lp, { force: true }); }
});

test('unavailable is not zero: withheld retention is stored UNAVAILABLE, excluded by name, never a baseline value, and never re-requested', async () => {
  const { storage, cleanup, adapter, log, lp } = await setup({
    retention: (n) => (n === 2 ? ok({ columnHeaders: RET_H }) : null) // video 2: no rows (low volume)
  });
  try {
    await runWindowCollection({ storage, adapter, now: () => NOW, lockPath: lp });
    const un = storage.all(`SELECT * FROM analytics_audience_snapshots WHERE provider_item_id = 'vidAAAAAA2' AND kind = 'RETENTION'`);
    assert.equal(un.length, 2);
    assert.ok(un.every((r) => r.status === 'UNAVAILABLE' && r.summary_json === null && r.failure_reason === 'NO_USABLE_RETENTION_POINTS'));

    const built = buildRecommendations(loadEvidence(storage), { now: NOW });
    assert.ok(built.exclusions.some((e) => e.publicationId === 'pub2' && e.reason === 'audience_retention_unavailable'));
    assert.ok(!built.exclusions.some((e) => e.publicationId === 'pub2' && e.reason.startsWith('audience_traffic')), 'its traffic report is still usable');
    const ret50 = built.candidates.filter((c) => c.metric === 'retention_at_50' && c.window === '7D');
    assert.ok(ret50.every((c) => c.providerItemId !== 'vidAAAAAA2'), 'video 2 has no retention measurement at all');
    assert.ok(ret50.every((c) => c.baselineCount === 2), 'every baseline is the other 2 videos that HAVE retention data; video 2 is not counted as 0');
    const c1 = ret50.find((c) => c.providerItemId === 'vidAAAAAA1');
    assert.equal(c1.baselineMedian, 0.61);
    assert.equal(c1.direction, 'BELOW_BASELINE');

    const calls = log.retention.length;
    await runWindowCollection({ storage, adapter, now: () => '2026-10-02T00:00:00.000Z', lockPath: lp });
    assert.equal(log.retention.length, calls, 'settled UNAVAILABLE is final; no repeat requests');
  } finally { cleanup(); fs.rmSync(lp, { force: true }); }
});

test('zero views and unlisted sources never become fabricated percentages', async () => {
  const { storage, cleanup, adapter, lp } = await setup({
    traffic: (n) => {
      if (n === 3) return ok({ columnHeaders: TRAF_H, rows: [['YT_SEARCH', 0, 0], ['SHORTS', 0, 0]] }); // zero views
      if (n === 4) return ok({ columnHeaders: TRAF_H, rows: [['YT_SEARCH', 700, 200], ['RELATED_VIDEO', 300, 100]] }); // SHORTS not listed
      return null;
    }
  });
  try {
    await runWindowCollection({ storage, adapter, now: () => NOW, lockPath: lp });
    const s3 = JSON.parse(storage.get(`SELECT summary_json FROM analytics_audience_snapshots WHERE provider_item_id = 'vidAAAAAA3' AND kind = 'TRAFFIC_SOURCES' AND period_end = '2026-09-08'`).summary_json);
    assert.equal(s3.zeroViews, true);
    assert.deepEqual(s3.shares, { YT_SEARCH: null, SHORTS: null });
    assert.ok(!JSON.stringify(s3).includes('NaN'));

    const built = buildRecommendations(loadEvidence(storage), { now: NOW });
    const ex = (pub, reason) => built.exclusions.some((e) => e.publicationId === pub && e.reason === reason);
    assert.ok(ex('pub3', 'traffic_share_yt_search_missing_or_invalid'), 'zero-view video is excluded, not measured as 0%');
    assert.ok(ex('pub3', 'traffic_share_related_video_missing_or_invalid'), 'unlisted source on a zero-view video is excluded too');
    assert.ok(ex('pub4', 'traffic_share_shorts_missing_or_invalid'), 'a source the report did not list is excluded, not assumed 0%');
    for (const c of built.candidates) {
      if (c.metric.startsWith('traffic_share')) assert.ok(!['vidAAAAAA3'].includes(c.providerItemId) && c.subjectValue > 0);
    }
  } finally { cleanup(); fs.rmSync(lp, { force: true }); }
});

test('API failures: 403 aborts the run with AUTH_FAILURE rows (no zeros, no summary), retried only after the cool-down', async () => {
  let deny = true;
  const { storage, cleanup, adapter, log, lp } = await setup({
    retention: () => (deny ? { ok: false, status: 403, text: async () => '{"error":{"code":403}}', json: async () => ({}) } : null)
  });
  try {
    const r1 = await runWindowCollection({ storage, adapter, now: () => NOW, lockPath: lp });
    assert.equal(r1.audience.result.aborted, true);
    assert.equal(r1.status, 'OK', 'scalar run succeeded: an audience-only failure never fails it');
    assert.equal(r1.aborted, false, 'top-level aborted describes the scalar run only');
    assert.equal(r1.audience.status, 'FAILED');
    assert.equal(r1.overallStatus, 'PARTIAL', 'combined view still surfaces the audience failure');
    const rows = storage.all('SELECT * FROM analytics_audience_snapshots');
    assert.equal(rows.length, 1, 'run stopped at the first auth failure; nothing after it was requested');
    assert.equal(rows[0].status, 'AUTH_FAILURE');
    assert.equal(rows[0].summary_json, null);
    assert.equal(log.traffic.length, 0);

    const early = await runWindowCollection({ storage, adapter, now: () => '2026-10-01T05:00:00.000Z', lockPath: lp });
    assert.equal(early.audience.result, null, 'inside cool-down: nothing requested');
    assert.equal(early.audience.plan.holdReason, 'account_level_failure_cooling_down');
    assert.equal(early.audience.plan.targets.length, 0);
    assert.equal(log.traffic.length, 0, 'no probing of other reports during an account-level cool-down');
    assert.equal(storage.all('SELECT * FROM analytics_audience_snapshots').length, 1);

    deny = false;
    const late = await runWindowCollection({ storage, adapter, now: () => '2026-10-01T06:00:00.000Z', lockPath: lp });
    assert.equal(late.status, 'OK');
    assert.equal(late.overallStatus, 'OK');
    assert.equal(storage.all(`SELECT * FROM analytics_audience_snapshots WHERE status = 'SUCCESS'`).length, 16);
  } finally { cleanup(); fs.rmSync(lp, { force: true }); }
});

test('missing analytics never becomes fabricated success: with nothing collected there are no audience findings, and collection is reported as needed', async () => {
  const { storage, cleanup } = await openStorage();
  try {
    storage.run('PRAGMA foreign_keys = OFF');
    for (const n of [1, 2, 3, 4]) seed(storage, n);
    const gen = generateRecommendations({ storage, now: () => NOW });
    assert.equal(gen.created, 0);
    assert.equal(gen.audienceCollectionNeeded.length, 4 * 2 * 2);
    assert.ok(gen.exclusions.some((e) => e.reason === 'audience_retention_no_snapshot_for_exact_window'));
  } finally { cleanup(); }
});

test('adapter without audience methods while audience work is due: explicit unsupported failure, scalar untouched, no silent OK', async () => {
  const { storage, cleanup, lp } = await setup();
  try {
    const calls = [];
    const legacy = { collect: async (a) => { calls.push(a); return { status: 'SUCCESS', byVideoId: Object.fromEntries(a.videoIds.map((v) => [v, { views: 1 }])) }; } };
    const r = await runWindowCollection({ storage, adapter: legacy, now: () => NOW, lockPath: lp });
    assert.equal(r.status, 'OK', 'scalar outcome is independent of the audience configuration problem');
    assert.equal(calls.length, 2);
    assert.equal(r.audience.status, 'FAILED');
    assert.equal(r.audience.result.unsupported, true);
    assert.deepEqual(r.audience.result.missingMethods, ['collectRetentionCurve', 'collectTrafficSources']);
    assert.match(r.audience.result.error, /AUDIENCE_ADAPTER_UNSUPPORTED/);
    assert.equal(r.audience.result.requested, 16, 'individual reports (8 targets x 2 kinds), not targets');
    assert.equal(r.audience.result.failed, 16);
    assert.equal(r.overallStatus, 'PARTIAL');
    assert.equal(storage.all('SELECT * FROM analytics_audience_snapshots').length, 0, 'nothing fabricated or recorded for work that was never attempted');
  } finally { cleanup(); fs.rmSync(lp, { force: true }); }
});

test('plan-only calls nothing and writes nothing, but reports the audience reports that are due', async () => {
  const { storage, cleanup, lp } = await setup();
  try {
    const r = await runWindowCollection({ storage, adapter: null, execute: false, now: () => NOW, lockPath: lp });
    assert.equal(r.status, 'PLANNED');
    assert.equal(r.audience.plan.targets.length, 8);
    assert.equal(storage.all('SELECT * FROM analytics_audience_snapshots').length, 0);
  } finally { cleanup(); fs.rmSync(lp, { force: true }); }
});

test('scalar status isolation: audience results never lift a failed scalar run, never fail or abort a clean one', async () => {
  // (a) every scalar report fails transiently (not an abort); audience reports succeed.
  let h = await setup({ report: () => ({ ok: false, status: 500, text: async () => 'boom', json: async () => ({}) }) });
  try {
    const r = await runWindowCollection({ storage: h.storage, adapter: h.adapter, now: () => NOW, lockPath: h.lp });
    assert.equal(r.audience.status, 'OK');
    assert.equal(r.audience.result.collected, 16);
    assert.equal(r.status, 'FAILED', 'scalar failed everywhere; audience success must not turn it into PARTIAL');
    assert.equal(r.aborted, false);
    assert.equal(r.overallStatus, 'PARTIAL', 'the combined view is honest about both');
    assert.equal(h.storage.all('SELECT * FROM analytics_snapshots WHERE status = \'SUCCESS\'').length, 0, 'no scalar snapshot was fabricated');
  } finally { h.cleanup(); fs.rmSync(h.lp, { force: true }); }

  // (b) the audience collector throws outright: scalar run stays OK and not aborted.
  h = await setup();
  try {
    const r = await runWindowCollection({ storage: h.storage, adapter: h.adapter, now: () => NOW, lockPath: h.lp, collectAudience: async () => { throw new Error('kaboom'); } });
    assert.equal(r.status, 'OK');
    assert.equal(r.aborted, false);
    assert.equal(r.audience.status, 'FAILED');
    assert.match(r.audience.result.error, /kaboom/);
    assert.equal(r.overallStatus, 'PARTIAL');
    assert.equal(h.storage.all('SELECT * FROM analytics_snapshots WHERE status = \'SUCCESS\'').length, 8, 'scalar snapshots from this run are intact');
  } finally { h.cleanup(); fs.rmSync(h.lp, { force: true }); }

  // (c) scalar run aborts on an account-level 403: audience is not attempted at all.
  h = await setup({ report: () => ({ ok: false, status: 403, text: async () => 'denied', json: async () => ({}) }) });
  try {
    const r = await runWindowCollection({ storage: h.storage, adapter: h.adapter, now: () => NOW, lockPath: h.lp });
    assert.equal(r.status, 'FAILED');
    assert.equal(r.aborted, true);
    assert.equal(r.audience.result, null);
    assert.equal(r.audience.status, null);
    assert.equal(r.overallStatus, 'FAILED');
    assert.equal(h.log.retention.length + h.log.traffic.length, 0, 'no audience requests after a scalar abort');
    assert.equal(h.storage.all('SELECT * FROM analytics_audience_snapshots').length, 0);
  } finally { h.cleanup(); fs.rmSync(h.lp, { force: true }); }

  // (d) partial audience: some unavailable (withheld retention) is NOT a failure and keeps everything OK.
  h = await setup({ retention: () => ok({ columnHeaders: RET_H, rows: [] }) });
  try {
    const r = await runWindowCollection({ storage: h.storage, adapter: h.adapter, now: () => NOW, lockPath: h.lp });
    assert.equal(r.status, 'OK');
    assert.equal(r.audience.status, 'OK', 'UNAVAILABLE is an honest outcome, not a failure');
    assert.equal(r.overallStatus, 'OK');
    assert.equal(r.audience.result.unavailable, 8);
  } finally { h.cleanup(); fs.rmSync(h.lp, { force: true }); }
});

// ---------------- status / exit-semantics matrix ----------------
const fail = (status, body = 'x') => ({ ok: false, status, text: async () => body, json: async () => ({}) });

test('missing retention method only, and missing traffic method only: each is an explicit unsupported failure naming the method', async () => {
  for (const missing of ['collectRetentionCurve', 'collectTrafficSources']) {
    const { storage, cleanup, adapter, log, lp } = await setup();
    try {
      const partial = { collect: adapter.collect.bind(adapter) };
      for (const m of ['collectRetentionCurve', 'collectTrafficSources']) if (m !== missing) partial[m] = adapter[m].bind(adapter);
      const r = await runWindowCollection({ storage, adapter: partial, now: () => NOW, lockPath: lp });
      assert.equal(r.status, 'OK');
      assert.equal(r.audience.status, 'FAILED');
      assert.deepEqual(r.audience.result.missingMethods, [missing]);
      assert.notEqual(r.overallStatus, 'OK');
      assert.equal(log.retention.length + log.traffic.length, 0, 'the half-capable adapter is not partially used');
    } finally { cleanup(); fs.rmSync(lp, { force: true }); }
  }
});

test('no scalar work due + missing audience method: overall FAILED, never OK or PARTIAL', async () => {
  const { storage, cleanup, adapter, lp } = await setup();
  try {
    await runWindowCollection({ storage, adapter, now: () => NOW, lockPath: lp }); // everything collected
    // new publication => audience due, scalar for it due too; instead make scalar nothing-due by new period-less state:
    storage.run('DELETE FROM analytics_audience_snapshots');
    const r = await runWindowCollection({ storage, adapter: { collect: adapter.collect.bind(adapter) }, now: () => NOW, lockPath: lp });
    assert.equal(r.groups.length, 0, 'no scalar group was due');
    assert.equal(r.status, 'OK');
    assert.equal(r.audience.status, 'FAILED');
    assert.equal(r.overallStatus, 'FAILED');
  } finally { cleanup(); fs.rmSync(lp, { force: true }); }
});

test('no scalar work due + audience failure => FAILED; + partial audience => PARTIAL; not-due work is never counted as success', async () => {
  // all audience reports fail transiently; scalar succeeds on run 1
  let trafficFails = true;
  const h = await setup({ retention: () => fail(500), traffic: (n) => (trafficFails || n === 1 ? fail(500) : null) });
  try {
    const r1 = await runWindowCollection({ storage: h.storage, adapter: h.adapter, now: () => NOW, lockPath: h.lp });
    assert.equal(r1.status, 'OK');
    assert.equal(r1.audience.status, 'FAILED');
    const r2 = await runWindowCollection({ storage: h.storage, adapter: h.adapter, now: () => '2026-10-01T07:00:00.000Z', lockPath: h.lp });
    assert.equal(r2.groups.length, 0, 'no scalar work due on the retry run');
    assert.equal(r2.status, 'OK');
    assert.equal(r2.audience.status, 'FAILED');
    assert.equal(r2.overallStatus, 'FAILED', 'only attempted-and-failed work exists; empty scalar work is not a success');
    trafficFails = false; // traffic recovers except video 1; retention still fails
    const r3 = await runWindowCollection({ storage: h.storage, adapter: h.adapter, now: () => '2026-10-01T14:00:00.000Z', lockPath: h.lp });
    assert.equal(r3.groups.length, 0);
    assert.ok(r3.audience.result.collected > 0 && r3.audience.result.failed > 0);
    assert.equal(r3.audience.status, 'PARTIAL');
    assert.equal(r3.overallStatus, 'PARTIAL');
  } finally { h.cleanup(); fs.rmSync(h.lp, { force: true }); }
});

test('audience cooldown: later run reports DEFERRED with the hold reason, probes nothing, is not a new failure and not success', async () => {
  let deny = true;
  const h = await setup({ retention: () => (deny ? fail(403, '{"error":{"code":403}}') : null) });
  try {
    const r1 = await runWindowCollection({ storage: h.storage, adapter: h.adapter, now: () => NOW, lockPath: h.lp });
    assert.equal(r1.audience.status, 'FAILED');
    const before = h.log.retention.length + h.log.traffic.length;
    const r2 = await runWindowCollection({ storage: h.storage, adapter: h.adapter, now: () => '2026-10-01T01:00:00.000Z', lockPath: h.lp });
    assert.equal(r2.audience.status, 'DEFERRED');
    assert.equal(r2.audience.holdReason, 'account_level_failure_cooling_down');
    assert.equal(r2.audience.result, null);
    assert.equal(r2.status, 'OK');
    assert.equal(r2.overallStatus, 'OK', 'cool-down is neither a fresh failure nor audience success; it is reported as DEFERRED');
    assert.equal(h.log.retention.length + h.log.traffic.length, before, 'no audience request during the hold');
    assert.equal(h.storage.all(`SELECT * FROM analytics_audience_snapshots WHERE status = 'SUCCESS'`).length, 0);
  } finally { h.cleanup(); fs.rmSync(h.lp, { force: true }); }
});

test('scalar success + audience success => OK/OK/OK, and scalar failure + audience success keeps scalar FAILED', async () => {
  let h = await setup();
  try {
    const r = await runWindowCollection({ storage: h.storage, adapter: h.adapter, now: () => NOW, lockPath: h.lp });
    assert.deepEqual([r.status, r.audience.status, r.overallStatus], ['OK', 'OK', 'OK']);
  } finally { h.cleanup(); fs.rmSync(h.lp, { force: true }); }
  h = await setup({ report: () => fail(500, 'boom') });
  try {
    const r = await runWindowCollection({ storage: h.storage, adapter: h.adapter, now: () => NOW, lockPath: h.lp });
    assert.deepEqual([r.status, r.audience.status, r.overallStatus], ['FAILED', 'OK', 'PARTIAL']);
  } finally { h.cleanup(); fs.rmSync(h.lp, { force: true }); }
});
