import { test } from 'node:test';
import assert from 'node:assert/strict';
import { YouTubeAnalyticsAdapter, isValidIsoDate } from '../../src/analytics/youtube/YouTubeAnalyticsAdapter.js';

const RET_H = [
  { name: 'elapsedVideoTimeRatio', columnType: 'DIMENSION', dataType: 'STRING' },
  { name: 'audienceWatchRatio', columnType: 'METRIC', dataType: 'FLOAT' },
  { name: 'relativeRetentionPerformance', columnType: 'METRIC', dataType: 'FLOAT' }
];
const okJson = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });
const status = (code, text = '') => ({ ok: code >= 200 && code < 300, status: code, json: async () => ({}), text: async () => text });
const ARGS = { videoId: 'vidAAAAAAA1', periodStart: '2026-09-02', periodEnd: '2026-09-08' };

function harness({ report, token = () => okJson({ access_token: 'tok' }), credentials = { clientId: 'c', clientSecret: 's', refreshToken: 'r' } }) {
  const log = { tokenCalls: 0, reportCalls: 0, sleeps: [], auth: [] };
  const fetchImpl = async (url, init) => {
    if (String(url).startsWith('https://oauth2.googleapis.com/token')) { log.tokenCalls += 1; return token(log.tokenCalls); }
    log.reportCalls += 1;
    log.auth.push(init?.headers?.Authorization);
    return report(log.reportCalls);
  };
  const adapter = new YouTubeAnalyticsAdapter({ fetchImpl, sleepImpl: async (ms) => { log.sleeps.push(ms); }, credentialsProvider: () => credentials });
  return { adapter, log };
}

// ---- A. relativeRetentionPerformance range (documented 0..1) ----------------
const rrpOf = async (value) => {
  const { adapter } = harness({ report: () => okJson({ columnHeaders: RET_H, rows: [['0.01', 0.9, value], ['0.02', 0.8, 0.5]] }) });
  const r = await adapter.collectRetentionCurve(ARGS);
  assert.equal(r.status, 'SUCCESS');
  return r.points[0];
};

test('relativeRetentionPerformance: documented 0..1 range -- 0, fractions, 0.5 and 1 are kept (zero stays a real zero)', async () => {
  for (const v of [0, 0.000001, 0.25, 0.5, 0.999999, 1, '0', '0.75', '1']) {
    const p = await rrpOf(v);
    assert.equal(p.relativeRetentionPerformance, Number(v), `kept ${JSON.stringify(v)}`);
  }
});

test('relativeRetentionPerformance: values outside the documented 0..1 range (including -1 and negative fractions) are unavailable, never clamped or zeroed; audienceWatchRatio is unaffected', async () => {
  for (const v of [-1, -0.5, -0.000001, -2, 1.000001, 1.5, 2, '-1', '-0.5', 'abc', '', NaN, Infinity, null]) {
    const p = await rrpOf(v);
    assert.equal(p.relativeRetentionPerformance, null, `null for ${JSON.stringify(v)}`);
    assert.equal(p.audienceWatchRatio, 0.9, 'audienceWatchRatio is a different metric and keeps its own value');
  }
});

test('audienceWatchRatio is NOT bound by the 0..1 rule: re-watches above 1 are kept, negatives are not', async () => {
  const { adapter } = harness({ report: () => okJson({ columnHeaders: RET_H, rows: [['0.01', 1.2, 0.5], ['0.02', -0.1, 0.5], ['0.03', 0, 0.5]] }) });
  const r = await adapter.collectRetentionCurve(ARGS);
  const by = Object.fromEntries(r.points.map((p) => [p.ratio, p.audienceWatchRatio]));
  assert.equal(by[0.01], 1.2);
  assert.equal(by[0.02], null);
  assert.equal(by[0.03], 0);
});

// ---- B. calendar-date validation --------------------------------------------
test('isValidIsoDate: real calendar dates only', () => {
  for (const ok of ['2026-09-02', '2028-02-29', '2000-02-29', '2026-12-31', '2026-01-01', '2026-02-28']) assert.equal(isValidIsoDate(ok), true, ok);
  for (const bad of ['2026-02-30', '2026-02-29', '2100-02-29', '1900-02-29', '2026-13-01', '2026-00-10', '2026-04-31', '2026-06-31', '2026-01-00', '2026-01-32',
    '2026-9-2', '20260902', '2026/09/02', ' 2026-09-02', '2026-09-02 ', '2026-09-02T00:00:00Z', 'yesterday', '', '0000-01-01', '1969-12-31', null, undefined, 20260902, new Date('2026-09-02')]) {
    assert.equal(isValidIsoDate(bad), false, `rejected ${JSON.stringify(bad)}`);
  }
});

for (const [name, method] of [['retention', 'collectRetentionCurve'], ['traffic', 'collectTrafficSources']]) {
  test(`${name}: impossible dates, invalid leap days and reversed periods are rejected before any request; single-day and leap-day periods are accepted`, async () => {
    const h = harness({ report: () => okJson({ columnHeaders: [], rows: [] }) });
    const bads = [
      { periodStart: '2026-02-30' }, { periodEnd: '2026-02-30' }, { periodStart: '2027-02-29', periodEnd: '2027-03-01' },
      { periodStart: '2026-13-01' }, { periodStart: '2026-00-10' }, { periodEnd: '2026-04-31' },
      { periodStart: '2026-09-09', periodEnd: '2026-09-08' },           // end earlier than start by one day
      { periodStart: '2027-01-01', periodEnd: '2026-12-31' },           // reversed across a year boundary
      { periodStart: '2026-9-02' }, { periodEnd: '2026/09/08' }, { periodStart: '' }, { periodEnd: null }, { periodStart: 20260902 }
    ];
    for (const bad of bads) {
      const r = await h.adapter[method]({ ...ARGS, ...bad });
      assert.equal(r.status, 'PERMANENT_FAILURE', JSON.stringify(bad));
      assert.equal(r.errorClass, 'INVALID_PERIOD', JSON.stringify(bad));
    }
    assert.equal(h.log.tokenCalls, 0, 'no token exchange for an invalid period');
    assert.equal(h.log.reportCalls, 0, 'no report request for an invalid period');
    // Boundaries that MUST pass validation (they reach the network layer)
    for (const ok of [{ periodStart: '2026-09-02', periodEnd: '2026-09-02' }, { periodStart: '2028-02-29', periodEnd: '2028-02-29' },
      { periodStart: '2028-02-28', periodEnd: '2028-03-01' }, { periodStart: '2026-12-31', periodEnd: '2027-01-01' }]) {
      const before = h.log.reportCalls;
      const r = await h.adapter[method]({ ...ARGS, ...ok });
      assert.notEqual(r.errorClass, 'INVALID_PERIOD', JSON.stringify(ok));
      assert.equal(h.log.reportCalls, before + 1, `request issued for ${JSON.stringify(ok)}`);
    }
  });
}

// ---- C. parity between collect() and the audience request path --------------
const COLLECT = (a) => a.collect({ videoIds: [ARGS.videoId], periodStart: ARGS.periodStart, periodEnd: ARGS.periodEnd });
const RETENTION = (a) => a.collectRetentionCurve(ARGS);
const TRAFFIC = (a) => a.collectTrafficSources(ARGS);

const OK_COLLECT = okJson({ columnHeaders: [{ name: 'video' }, { name: 'views' }], rows: [[ARGS.videoId, 12]] });
const OK_RETENTION = okJson({ columnHeaders: RET_H, rows: [['0.01', 1, 0.5]] });

const SCENARIOS = [
  ['2xx success', { report: () => OK_COLLECT }, { report: () => OK_RETENTION }],
  ['429 forever -> RATE_LIMITED after 3 attempts', { report: () => status(429) }],
  ['429 then 2xx', { report: (n) => (n < 2 ? status(429) : OK_COLLECT) }, { report: (n) => (n < 2 ? status(429) : OK_RETENTION) }],
  ['500 forever -> TRANSIENT after 3 attempts', { report: () => status(500) }],
  ['503 forever', { report: () => status(503) }],
  ['599 forever', { report: () => status(599) }],
  ['502 twice then 2xx (last permitted retry)', { report: (n) => (n < 3 ? status(502) : OK_COLLECT) }, { report: (n) => (n < 3 ? status(502) : OK_RETENTION) }],
  ['502 three times (no retry left)', { report: (n) => (n < 4 ? status(502) : OK_COLLECT) }],
  ['401 no retry, raw body kept', { report: () => status(401, 'unauthorized') }],
  ['403 no retry, raw body kept', { report: () => status(403, '{"error":"forbidden"}') }],
  ['400 permanent', { report: () => status(400, 'bad') }],
  ['404 permanent', { report: () => status(404, 'nf') }],
  ['418 permanent', { report: () => status(418) }],
  ['429 then 403 (auth after throttle)', { report: (n) => (n < 2 ? status(429) : status(403, 'f')) }],
  ['500 then 400', { report: (n) => (n < 2 ? status(500) : status(400, 'b')) }],
  ['network error forever', { report: () => { throw new Error('ECONNRESET'); } }],
  ['network error then 2xx', { report: (n) => { if (n < 2) throw new Error('ETIMEDOUT'); return OK_COLLECT; } }, { report: (n) => { if (n < 2) throw new Error('ETIMEDOUT'); return OK_RETENTION; } }],
  ['network error then 429 then 500 (shared budget)', { report: (n) => { if (n === 1) throw new Error('E1'); return n === 2 ? status(429) : status(500); } }],
  ['2xx with unparseable body', { report: () => ({ ok: true, status: 200, json: async () => { throw new Error('bad json'); } }) }],
  ['4xx whose text() throws', { report: () => ({ ok: false, status: 400, json: async () => ({}), text: async () => { throw new Error('boom'); } }) }],
  ['token refresh http 400', { token: () => status(400), report: () => OK_COLLECT }],
  ['token refresh http 401', { token: () => status(401), report: () => OK_COLLECT }],
  ['token refresh http 500 (not retried)', { token: () => status(500), report: () => OK_COLLECT }],
  ['token response without access_token', { token: () => okJson({}), report: () => OK_COLLECT }],
  ['token fetch throws', { token: () => { throw new Error('dns'); }, report: () => OK_COLLECT }],
  ['missing credentials', { credentials: {}, report: () => OK_COLLECT }],
  ['partly missing credentials', { credentials: { clientId: 'c', clientSecret: 's' }, report: () => OK_COLLECT }]
];

const transportView = async (call, cfg) => {
  const { adapter, log } = harness(cfg);
  const r = await call(adapter);
  return { status: r.status, errorClass: r.errorClass, raw: r.status === 'SUCCESS' ? undefined : r.raw, provider: r.provider, tokenCalls: log.tokenCalls, reportCalls: log.reportCalls, sleeps: log.sleeps, auth: log.auth };
};

for (const [label, collectCfg, retentionCfg] of SCENARIOS) {
  test(`parity [${label}]: collect(), collectRetentionCurve() and collectTrafficSources() classify and retry identically`, async () => {
    const a = await transportView(COLLECT, collectCfg);
    const b = await transportView(RETENTION, retentionCfg ?? collectCfg);
    const trafficCfg = retentionCfg
      ? { ...retentionCfg, report: (n) => { const v = retentionCfg.report(n); return v === OK_RETENTION ? okJson({ columnHeaders: [{ name: 'insightTrafficSourceType' }, { name: 'views' }, { name: 'estimatedMinutesWatched' }], rows: [['YT_SEARCH', 5, 1]] }) : v; } }
      : collectCfg;
    const c = await transportView(TRAFFIC, trafficCfg);
    for (const other of [b, c]) {
      assert.equal(other.status, a.status, 'status');
      assert.equal(other.errorClass, a.errorClass, 'errorClass');
      assert.equal(other.raw, a.raw, 'raw error body');
      assert.equal(other.provider, a.provider, 'provider');
      assert.equal(other.tokenCalls, a.tokenCalls, 'token exchanges');
      assert.equal(other.reportCalls, a.reportCalls, 'report attempts (bounded retry count)');
      assert.deepEqual(other.sleeps, a.sleeps, 'backoff delays');
      assert.deepEqual(other.auth, a.auth, 'bearer header on every attempt');
    }
    assert.ok(a.reportCalls <= 3, 'never more than 3 attempts');
  });
}

test('parity: the retry bound and the delay are the same fixed values on both paths (3 attempts, 2 sleeps)', async () => {
  for (const call of [COLLECT, RETENTION, TRAFFIC]) {
    const v = await transportView(call, { report: () => status(500) });
    assert.equal(v.reportCalls, 3);
    assert.equal(v.sleeps.length, 2);
    assert.equal(new Set(v.sleeps).size, 1);
  }
});
