import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectMeasurements, buildRecommendations, MIN_TRAFFIC_VIEWS_FOR_SHARE } from '../../src/analytics/recommendations.js';
import { planAudienceCollection, summarizeRetention, summarizeTraffic } from '../../src/analytics/audienceCollection.js';

const PUBLISHED_AT = '2026-09-01T10:00:00.000Z';
const NOW = '2026-10-01T00:00:00.000Z';
const W7 = { start: '2026-09-02', end: '2026-09-08' };

const pub = (n, over = {}) => ({
  id: `pub${n}`, provider: 'youtube', provider_item_id: `vid${n}`, status: 'PUBLISHED', content_version_id: `cv${n}`,
  request_json: JSON.stringify({ requestedPublishAt: null }), result_json: JSON.stringify({ confirmedVisibility: 'public' }),
  published_at: PUBLISHED_AT, run_mode: 'LIVE', ...over
});
const aud = (n, kind, summary, over = {}) => ({
  id: `a${n}${kind}`, publication_id: `pub${n}`, provider: 'youtube', provider_item_id: `vid${n}`, kind,
  period_start: W7.start, period_end: W7.end, collected_at: '2026-09-20T00:00:00.000Z', status: 'SUCCESS',
  failure_reason: null, summary_json: summary === null ? null : JSON.stringify(summary), result_json: '{}', ...over
});
const ev = (publications, audienceSnapshots) => ({ provider: 'youtube', publications, snapshots: [], audienceSnapshots });
const ret = (at25, at50) => ({ at10: null, at25, at50, at75: null, steepestDrop: { fromRatio: 0.3, toRatio: 0.31, drop: 0.2 }, pointCount: 100 });
const traf = (search, total = 1000, extra = {}) => ({ totalViews: total, totalViewsComplete: true, zeroViews: false, shares: { YT_SEARCH: search }, ...extra });
const reasons = (r, window = '7D') => r.exclusions.filter((e) => e.window === window).map((e) => e.reason);

test('retention measurement rules: exact window, SUCCESS only, settled, identity, summary present; reasons name the status', () => {
  const pubs = [1, 2, 3, 4, 5, 6, 7].map((n) => pub(n));
  const snaps = [
    aud(1, 'RETENTION', ret(0.7, 0.5)),
    aud(2, 'RETENTION', null, { status: 'UNAVAILABLE', failure_reason: 'NO_USABLE_RETENTION_POINTS' }),
    aud(3, 'RETENTION', null, { status: 'RATE_LIMITED' }),
    aud(4, 'RETENTION', ret(0.7, 0.5), { collected_at: '2026-09-09T00:00:00.000Z' }), // before usable (D+2 after end+1)
    aud(5, 'RETENTION', ret(0.7, 0.5), { provider_item_id: 'someoneElse' }),
    aud(6, 'RETENTION', ret(0.7, 0.5), { period_end: '2026-09-07' }), // not the exact window
    aud(7, 'RETENTION', 'oops')
  ];
  snaps[6].summary_json = '{not json';
  const r = collectMeasurements(ev(pubs, snaps), { now: NOW });
  const used = r.measurements.filter((m) => m.window === '7D' && m.metric.startsWith('retention'));
  assert.deepEqual([...new Set(used.map((m) => m.publication.id))], ['pub1']);
  const byPub = (id) => r.exclusions.filter((e) => e.publicationId === id && e.window === '7D' && e.reason.startsWith('audience_retention')).map((e) => e.reason);
  assert.deepEqual(byPub('pub2'), ['audience_retention_unavailable']);
  assert.deepEqual(byPub('pub3'), ['audience_retention_rate_limited']);
  assert.deepEqual(byPub('pub4'), ['audience_retention_snapshot_collected_before_data_settled']);
  assert.deepEqual(byPub('pub5'), ['audience_retention_snapshot_identity_mismatch']);
  assert.deepEqual(byPub('pub6'), ['audience_retention_no_snapshot_for_exact_window']);
  assert.deepEqual(byPub('pub7'), ['audience_retention_summary_missing']);
  assert.ok(r.audienceCollectionNeeded.some((c) => c.publicationId === 'pub6' && c.kind === 'RETENTION' && c.periodEnd === '2026-09-08'));
});

test('a retention point that was not reported (null) is excluded, never measured as 0; a genuine 0 is kept', () => {
  const r = collectMeasurements(ev([pub(1), pub(2)], [aud(1, 'RETENTION', ret(null, 0.4)), aud(2, 'RETENTION', ret(0, 0))]), { now: NOW });
  const m = r.measurements.filter((x) => x.window === '7D');
  assert.deepEqual(m.map((x) => [x.publication.id, x.metric, x.value]).sort(), [['pub1', 'retention_at_50', 0.4], ['pub2', 'retention_at_25', 0], ['pub2', 'retention_at_50', 0]].sort());
  assert.ok(r.exclusions.some((e) => e.publicationId === 'pub1' && e.reason === 'retention_at_25_missing_or_invalid'));
});

test('traffic share needs a complete report with enough views; shares outside 0..1 or unlisted sources are excluded', () => {
  const pubs = [1, 2, 3, 4, 5].map((n) => pub(n));
  const snaps = [
    aud(1, 'TRAFFIC_SOURCES', traf(0.4, MIN_TRAFFIC_VIEWS_FOR_SHARE)),
    aud(2, 'TRAFFIC_SOURCES', traf(0.4, MIN_TRAFFIC_VIEWS_FOR_SHARE - 1)),
    aud(3, 'TRAFFIC_SOURCES', traf(0.4, 1000, { totalViewsComplete: false })),
    aud(4, 'TRAFFIC_SOURCES', { ...traf(0.4), shares: { SHORTS: 1 } }), // search not listed
    aud(5, 'TRAFFIC_SOURCES', traf(1.5))
  ];
  const r = collectMeasurements(ev(pubs, snaps), { now: NOW });
  assert.deepEqual(r.measurements.filter((m) => m.window === '7D' && m.metric === 'traffic_share_yt_search').map((m) => m.publication.id), ['pub1']);
  const ex = (id, metric) => r.exclusions.find((e) => e.publicationId === id && e.window === '7D' && e.reason.startsWith(metric))?.reason;
  assert.equal(ex('pub2', 'traffic_share_yt_search'), 'traffic_share_yt_search_views_below_minimum');
  assert.equal(ex('pub3', 'traffic_share_yt_search'), 'traffic_share_yt_search_views_below_minimum');
  assert.equal(ex('pub4', 'traffic_share_yt_search'), 'traffic_share_yt_search_missing_or_invalid');
  assert.equal(ex('pub5', 'traffic_share_yt_search'), 'traffic_share_yt_search_missing_or_invalid');
});

test('audience evidence is optional: evidence without audienceSnapshots yields no audience exclusions or measurements', () => {
  const r = collectMeasurements({ provider: 'youtube', publications: [pub(1)], snapshots: [] }, { now: NOW });
  assert.ok(r.exclusions.every((e) => !e.reason.startsWith('audience_')));
  assert.deepEqual(r.audienceCollectionNeeded, []);
});

test('audience findings use the existing baseline rules: need 3 comparable videos, relative threshold, descriptive text', () => {
  const pubs = [1, 2, 3].map((n) => pub(n));
  let r = buildRecommendations(ev(pubs, [aud(1, 'RETENTION', ret(0.7, 0.2)), aud(2, 'RETENTION', ret(0.7, 0.6))]), { now: NOW });
  assert.equal(r.candidates.length, 0);
  assert.ok(r.reasons.some((x) => x.startsWith('fewer_than_3_comparable_measurements_for_7D_retention_at_50')));
  r = buildRecommendations(ev(pubs, [aud(1, 'RETENTION', ret(0.7, 0.2)), aud(2, 'RETENTION', ret(0.7, 0.6)), aud(3, 'RETENTION', ret(0.7, 0.62))]), { now: NOW });
  const c = r.candidates.find((x) => x.metric === 'retention_at_50' && x.providerItemId === 'vid1');
  assert.equal(c.direction, 'BELOW_BASELINE');
  assert.match(c.summary, /Descriptive only/);
  assert.deepEqual(c.evidence.context.steepestDrop, { fromRatio: 0.3, toRatio: 0.31, drop: 0.2 });
  // Evidence references name the table the ids belong to (audience ids are NOT analytics_snapshots ids).
  assert.equal(c.evidence.snapshotTable, 'analytics_audience_snapshots');
  assert.equal(c.evidence.snapshotKind, 'RETENTION');
  assert.ok(c.evidence.snapshotId);
  assert.equal(c.evidence.baselineSnapshotIds.length, 2);
  assert.equal(c.evidence.periodStart, '2026-09-02');
  // Scalar findings keep their original evidence shape (no table tag added).
  const scalarSnap = (n, pct) => ({ id: `scalar${n}`, publication_id: `pub${n}`, provider: 'youtube', provider_item_id: `vid${n}`, period_start: '2026-09-02', period_end: '2026-09-08',
    collected_at: '2026-10-01T00:00:00.000Z', status: 'SUCCESS', average_view_percentage: pct, impressions_ctr: 4, impressions: 5000 });
  const scalar = buildRecommendations({ ...ev(pubs, []), snapshots: [scalarSnap(1, 10), scalarSnap(2, 50), scalarSnap(3, 52)] }, { now: NOW }).candidates
    .filter((x) => x.metric === 'average_view_percentage' && x.providerItemId === 'vid1');
  assert.ok(scalar.length > 0, 'a scalar finding exists, so the shape assertion below is not vacuous');
  for (const x of scalar) { assert.equal(x.evidence.snapshotTable, undefined); assert.equal(x.evidence.snapshotKind, undefined); assert.equal(x.evidence.snapshotId, 'scalar1'); }
});

test('planAudienceCollection: usable-window boundary, final vs retryable statuses, cool-down, account-level hold, gate', () => {
  const usableAt = Date.parse('2026-09-11T00:00:00.000Z'); // 7D: end 09-08 +1d +2d
  const pubs = [pub(1)];
  const p = (e, now, o = {}) => planAudienceCollection({ provider: 'youtube', publications: pubs, snapshots: [], audienceSnapshots: e }, { now, ...o });
  // 24H usable 2026-09-05; 7D usable 2026-09-11
  assert.equal(p([], '2026-09-04T23:59:59.999Z').targets.length, 0);
  let plan = p([], '2026-09-05T00:00:00.000Z');
  assert.deepEqual(plan.targets.map((t) => [t.periodStart, t.periodEnd, t.kinds]), [['2026-09-02', '2026-09-02', ['RETENTION', 'TRAFFIC_SOURCES']]]);
  plan = p([], new Date(usableAt).toISOString());
  assert.equal(plan.targets.length, 2);

  const NOW2 = '2026-10-01T00:00:00.000Z';
  const base = (kind, status, collected, w = W7) => aud(1, kind, status === 'SUCCESS' ? {} : null, { status, collected_at: collected, period_start: w.start, period_end: w.end });
  const w24 = { start: '2026-09-02', end: '2026-09-02' };
  const settled = '2026-09-20T00:00:00.000Z';
  const snaps = [
    base('RETENTION', 'SUCCESS', settled), base('TRAFFIC_SOURCES', 'SUCCESS', settled),
    base('RETENTION', 'UNAVAILABLE', settled, w24),            // settled UNAVAILABLE: final
    base('TRAFFIC_SOURCES', 'PERMANENT_FAILURE', settled, w24) // rejected request: final
  ];
  plan = p(snaps, NOW2);
  assert.equal(plan.targets.length, 0);
  assert.deepEqual(plan.final.map((f) => f.status).sort(), ['PERMANENT_FAILURE', 'UNAVAILABLE']);

  // UNAVAILABLE collected BEFORE the data settled is retryable (after cool-down)
  const early = base('RETENTION', 'UNAVAILABLE', '2026-09-03T00:00:00.000Z', w24);
  assert.equal(p([early], NOW2).targets.some((t) => t.kinds.includes('RETENTION') && t.periodEnd === '2026-09-02'), true);

  // TRANSIENT failure: deferred inside the cool-down, due after it, and it does not hold the run
  const tr = base('RETENTION', 'TRANSIENT_FAILURE', '2026-10-01T00:00:00.000Z', w24);
  plan = p([tr], '2026-10-01T05:00:00.000Z', { retryAfterHours: 6 });
  assert.equal(plan.deferred.length, 1);
  assert.equal(plan.holdReason, null);
  assert.equal(p([tr], '2026-10-01T06:00:00.000Z', { retryAfterHours: 6 }).deferred.length, 0);

  // AUTH_FAILURE cooling down holds EVERYTHING
  const af = base('RETENTION', 'AUTH_FAILURE', '2026-10-01T00:00:00.000Z', w24);
  plan = p([af], '2026-10-01T05:00:00.000Z');
  assert.equal(plan.holdReason, 'account_level_failure_cooling_down');
  assert.equal(plan.targets.length, 0);

  // Publication gate: simulated / scheduled publications are never requested
  const gated = planAudienceCollection({ provider: 'youtube', publications: [pub(2, { run_mode: 'SIMULATION' }), pub(3, { request_json: JSON.stringify({ requestedPublishAt: '2026-09-09T00:00:00Z' }) })], snapshots: [], audienceSnapshots: [] }, { now: NOW2 });
  assert.equal(gated.targets.length, 0);
  assert.deepEqual(gated.skipped.map((s) => s.reason).sort(), ['run_mode_not_live', 'scheduled_publication']);
});

test('summarizers keep null as null and never add values', () => {
  const r = summarizeRetention({ summary: { at10: undefined, at25: 0.5, at50: null, at75: 0, steepestDrop: null, pointCount: 3 } });
  assert.deepEqual(r, { at10: null, at25: 0.5, at50: null, at75: 0, steepestDrop: null, pointCount: 3 });
  const t = summarizeTraffic({ totalViews: 0, totalViewsComplete: true, zeroViews: true, sources: [{ source: 'YT_SEARCH', views: 0, viewsShare: null }] });
  assert.deepEqual(t, { totalViews: 0, totalViewsComplete: true, zeroViews: true, shares: { YT_SEARCH: null } });
});
