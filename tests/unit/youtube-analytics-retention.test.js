import { test } from 'node:test';
import assert from 'node:assert/strict';
import { YouTubeAnalyticsAdapter, parseApiNumber } from '../../src/analytics/youtube/YouTubeAnalyticsAdapter.js';

// API-shaped fixtures (NOT recorded live responses -- no credentials were
// available). Shape per the YouTube Analytics API: dimension values for
// elapsedVideoTimeRatio and insightTrafficSourceType are STRINGS; metrics are numbers.
const RETENTION_HEADERS = [
  { name: 'elapsedVideoTimeRatio', columnType: 'DIMENSION', dataType: 'STRING' },
  { name: 'audienceWatchRatio', columnType: 'METRIC', dataType: 'FLOAT' },
  { name: 'relativeRetentionPerformance', columnType: 'METRIC', dataType: 'FLOAT' }
];
const TRAFFIC_HEADERS = [
  { name: 'insightTrafficSourceType', columnType: 'DIMENSION', dataType: 'STRING' },
  { name: 'views', columnType: 'METRIC', dataType: 'INTEGER' },
  { name: 'estimatedMinutesWatched', columnType: 'METRIC', dataType: 'INTEGER' }
];
/** 100 grid points, ratio "0.01".."1.00" (strings), linear decay from 1.0 with a cliff at 0.30. */
function retentionRows() {
  const rows = [];
  for (let i = 1; i <= 100; i++) {
    const ratio = (i / 100).toFixed(2);
    let awr = 1 - i * 0.005;
    if (i >= 30) awr -= 0.2;
    rows.push([ratio, Math.round(awr * 1e6) / 1e6, 0.5]);
  }
  return rows;
}
const okJson = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });
const status = (code, text = '') => ({ ok: code >= 200 && code < 300, status: code, json: async () => ({}), text: async () => text });

function adapterFor(handler) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    if (String(url).startsWith('https://oauth2.googleapis.com/token')) return okJson({ access_token: 'tok' });
    calls.push({ url: new URL(url), init });
    return handler(calls.length, calls.at(-1));
  };
  const adapter = new YouTubeAnalyticsAdapter({
    fetchImpl, sleepImpl: async () => {},
    credentialsProvider: () => ({ clientId: 'c', clientSecret: 's', refreshToken: 'r' })
  });
  return { adapter, calls };
}
const ARGS = { videoId: 'vidAAAAAAA1', periodStart: '2026-09-02', periodEnd: '2026-09-08' };

test('parseApiNumber: numeric strings parse; empty, malformed, NaN, Infinity and non-scalars are null', () => {
  assert.equal(parseApiNumber('0.01'), 0.01);
  assert.equal(parseApiNumber(' 0.5 '), 0.5);
  assert.equal(parseApiNumber('1'), 1);
  assert.equal(parseApiNumber('1e-2'), 0.01);
  assert.equal(parseApiNumber(0.25), 0.25);
  assert.equal(parseApiNumber(0), 0); // a genuine zero stays zero
  assert.equal(parseApiNumber('0'), 0);
  for (const bad of ['', '   ', 'abc', '0.5x', '0x10', '1,5', 'NaN', 'Infinity', '-Infinity', '1e999', NaN, Infinity, -Infinity, null, undefined, true, {}, [], [1]]) {
    assert.equal(parseApiNumber(bad), null, `expected null for ${JSON.stringify(bad)}`);
  }
});

test('retention request shape: single video filter, string-dimension report, bearer token', async () => {
  const { adapter, calls } = adapterFor(() => okJson({ columnHeaders: RETENTION_HEADERS, rows: retentionRows() }));
  await adapter.collectRetentionCurve(ARGS);
  assert.equal(calls.length, 1);
  const q = calls[0].url.searchParams;
  assert.equal(calls[0].url.origin + calls[0].url.pathname, 'https://youtubeanalytics.googleapis.com/v2/reports');
  assert.equal(q.get('dimensions'), 'elapsedVideoTimeRatio');
  assert.equal(q.get('metrics'), 'audienceWatchRatio,relativeRetentionPerformance');
  assert.equal(q.get('filters'), 'video==vidAAAAAAA1');
  assert.equal(q.get('ids'), 'channel==MINE');
  assert.equal(q.get('startDate'), '2026-09-02');
  assert.equal(q.get('endDate'), '2026-09-08');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer tok');
});

test('real-shaped retention (string ratios) yields a nonempty, ascending curve with correct summary points', async () => {
  const shuffled = retentionRows().reverse(); // out of order on purpose
  const { adapter } = adapterFor(() => okJson({ columnHeaders: RETENTION_HEADERS, rows: shuffled }));
  const r = await adapter.collectRetentionCurve(ARGS);
  assert.equal(r.status, 'SUCCESS');
  assert.equal(r.points.length, 100);
  assert.deepEqual(r.points.slice(0, 3).map((p) => p.ratio), [0.01, 0.02, 0.03]);
  assert.ok(r.points.every((p, i, a) => i === 0 || a[i - 1].ratio < p.ratio), 'strictly ascending');
  assert.ok(r.points.every((p) => typeof p.ratio === 'number'), 'ratios are numbers, not strings');
  assert.equal(r.summary.pointCount, 100);
  assert.equal(r.summary.at10, 0.95);
  assert.equal(r.summary.at25, 0.875);
  assert.equal(r.summary.at50, 0.55);
  assert.equal(r.summary.at75, 0.425);
  // cliff: 0.29 -> 0.30 drops 0.005 + 0.2
  assert.deepEqual(r.summary.steepestDrop, { fromRatio: 0.29, toRatio: 0.3, drop: r.summary.steepestDrop.drop });
  assert.ok(Math.abs(r.summary.steepestDrop.drop - 0.205) < 1e-9);
});

test('retention: numbers-as-numbers ratios still work; malformed, empty, NaN, Infinity and out-of-range ratios are dropped and counted', async () => {
  const rows = [
    ['0.10', 0.9, 0.4], [0.2, 0.8, 0.4], ['', 0.7, 0.4], ['abc', 0.7, 0.4], ['NaN', 0.7, 0.4], ['Infinity', 0.7, 0.4],
    ['0', 0.7, 0.4], ['1.01', 0.7, 0.4], ['-0.1', 0.7, 0.4], [null, 0.7, 0.4], ['0.30', 0.6, 0.4], 'not-a-row'
  ];
  const { adapter } = adapterFor(() => okJson({ columnHeaders: RETENTION_HEADERS, rows }));
  const r = await adapter.collectRetentionCurve(ARGS);
  assert.equal(r.status, 'SUCCESS');
  assert.deepEqual(r.points.map((p) => p.ratio), [0.1, 0.2, 0.3]);
  assert.equal(r.summary.dropped.badDimension, 8);
  assert.equal(r.summary.dropped.malformedRow, 1);
});

test('retention: missing/malformed metrics stay null -- never converted to 0 -- and are not used in drops', async () => {
  const rows = [
    ['0.01', 1, 0.5], ['0.02', null, 0.5], ['0.03', '', 0.5], ['0.04', 'NaN', 0.5], ['0.05', -1, 0.5], ['0.06', 0.9, 7], ['0.07', 0.4, null], ['0.08', undefined, 0.5]
  ];
  const { adapter } = adapterFor(() => okJson({ columnHeaders: RETENTION_HEADERS, rows }));
  const r = await adapter.collectRetentionCurve(ARGS);
  assert.equal(r.status, 'SUCCESS');
  const by = Object.fromEntries(r.points.map((p) => [p.ratio, p]));
  for (const k of [0.02, 0.03, 0.04, 0.05, 0.08]) assert.equal(by[k].audienceWatchRatio, null, `ratio ${k} stays null`);
  assert.equal(by[0.06].relativeRetentionPerformance, null, 'rrp > 1 is out of range => null, not clamped');
  assert.equal(by[0.07].relativeRetentionPerformance, null);
  assert.equal(by[0.07].audienceWatchRatio, 0.4);
  // drop 0.06 -> 0.07 is the only adjacent non-null pair (0.9 -> 0.4)
  assert.deepEqual(r.summary.steepestDrop, { fromRatio: 0.06, toRatio: 0.07, drop: 0.5 });
  assert.equal(r.summary.at10, null, 'a summary point that was not reported is null, not 0');
});

test('retention: a gap in the grid is never bridged when attributing the steepest drop', async () => {
  const rows = [['0.10', 1, 0.5], ['0.50', 0.2, 0.5], ['0.51', 0.19, 0.5]];
  const { adapter } = adapterFor(() => okJson({ columnHeaders: RETENTION_HEADERS, rows }));
  const r = await adapter.collectRetentionCurve(ARGS);
  assert.equal(r.summary.steepestDrop.fromRatio, 0.5);
  assert.ok(Math.abs(r.summary.steepestDrop.drop - 0.01) < 1e-9);
});

test('retention: a monotone-flat curve has steepestDrop null (not 0); duplicates keep the first row', async () => {
  const rows = [['0.01', 0.9, 0.5], ['0.02', 0.9, 0.5], ['0.02', 0.1, 0.5], ['0.03', 0.9, 0.5]];
  const { adapter } = adapterFor(() => okJson({ columnHeaders: RETENTION_HEADERS, rows }));
  const r = await adapter.collectRetentionCurve(ARGS);
  assert.equal(r.summary.steepestDrop, null);
  assert.equal(r.summary.dropped.duplicateRatio, 1);
  assert.equal(r.points.find((p) => p.ratio === 0.02).audienceWatchRatio, 0.9);
});

test('retention: no rows, all-null points, missing columns and wrong shapes are UNAVAILABLE -- never an empty or fabricated curve', async () => {
  const cases = [
    [{ columnHeaders: RETENTION_HEADERS, rows: [] }, 'NO_USABLE_RETENTION_POINTS'],
    [{ columnHeaders: RETENTION_HEADERS }, 'NO_USABLE_RETENTION_POINTS'],
    [{ columnHeaders: RETENTION_HEADERS, rows: [['0.01', null, 0.5], ['0.02', '', 0.5]] }, 'NO_USABLE_RETENTION_POINTS'],
    [{}, 'NO_COLUMN_HEADERS'],
    [{ columnHeaders: [{ name: 'audienceWatchRatio' }], rows: [[1]] }, 'NO_elapsedVideoTimeRatio_DIMENSION_IN_RESPONSE'],
    [{ columnHeaders: [RETENTION_HEADERS[0], RETENTION_HEADERS[2]], rows: [['0.01', 0.5]] }, 'METRIC_COLUMN_MISSING_audienceWatchRatio'],
    [{ columnHeaders: RETENTION_HEADERS, rows: 'oops' }, 'ROWS_NOT_AN_ARRAY']
  ];
  for (const [body, errorClass] of cases) {
    const { adapter } = adapterFor(() => okJson(body));
    const r = await adapter.collectRetentionCurve(ARGS);
    assert.equal(r.status, 'UNAVAILABLE', errorClass);
    assert.equal(r.errorClass, errorClass);
    assert.equal(r.points, undefined);
  }
});

test('retention: columns are read by name, not position', async () => {
  const headers = [RETENTION_HEADERS[2], RETENTION_HEADERS[1], RETENTION_HEADERS[0]];
  const rows = [[0.4, 0.8, '0.50'], [0.4, 0.9, '0.40']];
  const { adapter } = adapterFor(() => okJson({ columnHeaders: headers, rows }));
  const r = await adapter.collectRetentionCurve(ARGS);
  assert.deepEqual(r.points.map((p) => [p.ratio, p.audienceWatchRatio, p.relativeRetentionPerformance]), [[0.4, 0.9, 0.4], [0.5, 0.8, 0.4]]);
});

test('traffic request shape and real-shaped response: rows, descending order, shares sum to 1', async () => {
  const rows = [['SHORTS', 300, 90], ['YT_SEARCH', 100, 40], ['RELATED_VIDEO', 600, 400]];
  const { adapter, calls } = adapterFor(() => okJson({ columnHeaders: TRAFFIC_HEADERS, rows }));
  const r = await adapter.collectTrafficSources(ARGS);
  const q = calls[0].url.searchParams;
  assert.equal(q.get('dimensions'), 'insightTrafficSourceType');
  assert.equal(q.get('metrics'), 'views,estimatedMinutesWatched');
  assert.equal(q.get('sort'), '-views');
  assert.equal(q.get('filters'), 'video==vidAAAAAAA1');
  assert.equal(r.status, 'SUCCESS');
  assert.deepEqual(r.sources.map((s) => s.source), ['RELATED_VIDEO', 'SHORTS', 'YT_SEARCH']);
  assert.deepEqual(r.sources.map((s) => s.viewsShare), [0.6, 0.3, 0.1]);
  assert.equal(r.totalViews, 1000);
  assert.equal(r.totalViewsComplete, true);
  assert.equal(r.zeroViews, false);
  assert.ok(Math.abs(r.sources.reduce((a, s) => a + s.viewsShare, 0) - 1) < 1e-12);
});

test('traffic: views delivered as numeric strings parse; malformed views become null and suppress shares (no partial-total percentages)', async () => {
  const rows = [['YT_SEARCH', '40', '10'], ['SHORTS', 'n/a', '5'], ['EXT_URL', -3, 1], ['bad source', 5, 5], ['YT_CHANNEL', 10, null]];
  const { adapter } = adapterFor(() => okJson({ columnHeaders: TRAFFIC_HEADERS, rows }));
  const r = await adapter.collectTrafficSources(ARGS);
  assert.equal(r.status, 'SUCCESS');
  assert.equal(r.sources.length, 4);
  assert.equal(r.dropped.badDimension, 1);
  assert.equal(r.sources.find((s) => s.source === 'YT_SEARCH').views, 40);
  assert.equal(r.sources.find((s) => s.source === 'SHORTS').views, null);
  assert.equal(r.sources.find((s) => s.source === 'EXT_URL').views, null);
  assert.equal(r.sources.find((s) => s.source === 'YT_CHANNEL').estimatedMinutesWatched, null);
  assert.equal(r.totalViewsComplete, false);
  assert.equal(r.totalViews, null);
  assert.ok(r.sources.every((s) => s.viewsShare === null));
});

test('traffic zero-view handling: all-zero rows are SUCCESS with null shares (no NaN); no rows is UNAVAILABLE, not zero performance', async () => {
  let h = adapterFor(() => okJson({ columnHeaders: TRAFFIC_HEADERS, rows: [['YT_SEARCH', 0, 0], ['SHORTS', '0', 0]] }));
  let r = await h.adapter.collectTrafficSources(ARGS);
  assert.equal(r.status, 'SUCCESS');
  assert.equal(r.zeroViews, true);
  assert.equal(r.totalViews, 0);
  assert.ok(r.sources.every((s) => s.viewsShare === null && s.views === 0));
  assert.ok(!JSON.stringify(r).includes('NaN'));

  for (const body of [{ columnHeaders: TRAFFIC_HEADERS, rows: [] }, { columnHeaders: TRAFFIC_HEADERS }]) {
    h = adapterFor(() => okJson(body));
    r = await h.adapter.collectTrafficSources(ARGS);
    assert.equal(r.status, 'UNAVAILABLE');
    assert.equal(r.errorClass, 'NO_TRAFFIC_ROWS');
    assert.equal(r.totalViews, undefined);
  }
  h = adapterFor(() => okJson({ columnHeaders: [TRAFFIC_HEADERS[0]], rows: [['YT_SEARCH']] }));
  r = await h.adapter.collectTrafficSources(ARGS);
  assert.equal(r.status, 'UNAVAILABLE');
  assert.equal(r.errorClass, 'METRIC_COLUMN_MISSING_views');
});

for (const [name, method] of [['retention', 'collectRetentionCurve'], ['traffic', 'collectTrafficSources']]) {
  test(`${name}: API error classification, bounded retry, credentials`, async () => {
    // 429 exhausts after 3 attempts
    let h = adapterFor(() => status(429));
    let r = await h.adapter[method](ARGS);
    assert.equal(r.status, 'RATE_LIMITED');
    assert.equal(h.calls.length, 3);
    // 5xx then success
    h = adapterFor((n) => (n < 3 ? status(503) : okJson({ columnHeaders: method === 'collectRetentionCurve' ? RETENTION_HEADERS : TRAFFIC_HEADERS, rows: method === 'collectRetentionCurve' ? [['0.01', 1, 0.5]] : [['YT_SEARCH', 5, 1]] })));
    r = await h.adapter[method](ARGS);
    assert.equal(r.status, 'SUCCESS');
    assert.equal(h.calls.length, 3);
    // persistent 5xx
    h = adapterFor(() => status(500));
    r = await h.adapter[method](ARGS);
    assert.equal(r.status, 'TRANSIENT_FAILURE');
    assert.equal(h.calls.length, 3);
    // 403 and 401: no retry
    for (const code of [401, 403]) {
      h = adapterFor(() => status(code, '{"error":"forbidden"}'));
      r = await h.adapter[method](ARGS);
      assert.equal(r.status, 'AUTH_FAILURE');
      assert.equal(h.calls.length, 1);
    }
    // 400: permanent, no retry
    h = adapterFor(() => status(400, 'bad query'));
    r = await h.adapter[method](ARGS);
    assert.equal(r.status, 'PERMANENT_FAILURE');
    assert.equal(r.errorClass, 'http_400');
    assert.equal(h.calls.length, 1);
    // network error
    h = adapterFor(() => { throw new Error('ECONNRESET'); });
    r = await h.adapter[method](ARGS);
    assert.equal(r.status, 'TRANSIENT_FAILURE');
    assert.match(r.errorClass, /network_error_ECONNRESET/);
    // unparseable 2xx body
    h = adapterFor(() => ({ ok: true, status: 200, json: async () => { throw new Error('bad json'); } }));
    r = await h.adapter[method](ARGS);
    assert.equal(r.status, 'TRANSIENT_FAILURE');
    // missing credentials: no report request at all
    const calls = [];
    const noCreds = new YouTubeAnalyticsAdapter({ fetchImpl: async (u) => { calls.push(u); return okJson({}); }, credentialsProvider: () => ({}), sleepImpl: async () => {} });
    r = await noCreds[method](ARGS);
    assert.equal(r.status, 'AUTH_FAILURE');
    assert.equal(calls.length, 0);
  });

  test(`${name}: invalid video id / period is rejected before any request (no filter injection)`, async () => {
    const { adapter, calls } = adapterFor(() => okJson({}));
    for (const bad of [{ videoId: 'a,b' }, { videoId: '' }, { videoId: undefined }, { videoId: 'x'.repeat(40) }, { videoId: 'vid AAAAAAA' }, { periodStart: '2026-9-2' }, { periodEnd: 'yesterday' }]) {
      const r = await adapter[method]({ ...ARGS, ...bad });
      assert.equal(r.status, 'PERMANENT_FAILURE');
      assert.match(r.errorClass, /INVALID_(VIDEO_ID|PERIOD)/);
    }
    assert.equal(calls.length, 0);
  });
}

test('existing collect() contract is unchanged: still the batched per-video report, no audience dimensions', async () => {
  const { adapter, calls } = adapterFor(() => okJson({
    columnHeaders: [{ name: 'video' }, { name: 'views' }], rows: [['vidAAAAAAA1', 12]]
  }));
  const r = await adapter.collect({ videoIds: ['vidAAAAAAA1'], periodStart: '2026-09-02', periodEnd: '2026-09-08' });
  assert.equal(r.status, 'SUCCESS');
  assert.deepEqual(r.byVideoId.vidAAAAAAA1, { views: 12 });
  assert.equal(calls[0].url.searchParams.get('dimensions'), 'video');
});
