import { test } from 'node:test';
import assert from 'node:assert/strict';
import { YouTubeAnalyticsAdapter } from '../../src/analytics/youtube/YouTubeAnalyticsAdapter.js';
import { ANALYTICS_RESULT_STATUS } from '../../src/analytics/constants.js';

/**
 * Phase 3 unit tests: YouTubeAnalyticsAdapter in isolation, via
 * dependency-injected fetch/sleep (no network, no timers) -- mirrors
 * the credentialsProvider/fetchImpl injection pattern already used by
 * ../../src/publication/youtube/YouTubeAdapter.js's own tests.
 */

function fakeCredentials() {
  return { clientId: 'client', clientSecret: 'secret', refreshToken: 'refresh' };
}

function tokenResponse() {
  return { ok: true, status: 200, json: async () => ({ access_token: 'tok' }) };
}

test('batches multiple video ids into a single request and normalizes only reported metrics', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    if (String(url).includes('oauth2.googleapis.com')) return tokenResponse();
    return {
      ok: true,
      status: 200,
      json: async () => ({
        columnHeaders: [{ name: 'video' }, { name: 'views' }, { name: 'likes' }],
        rows: [['vid1', 100, 5], ['vid2', 200, 10]]
      })
    };
  };
  const adapter = new YouTubeAnalyticsAdapter({ fetchImpl, credentialsProvider: fakeCredentials });
  const result = await adapter.collect({ videoIds: ['vid1', 'vid2'], periodStart: '2026-09-01', periodEnd: '2026-09-01' });

  assert.equal(result.status, ANALYTICS_RESULT_STATUS.SUCCESS);
  assert.deepEqual(result.byVideoId.vid1, { views: 100, likes: 5 });
  assert.deepEqual(result.byVideoId.vid2, { views: 200, likes: 10 });
  assert.equal(result.byVideoId.vid1.comments, undefined, 'a metric YouTube did not report must never be fabricated');
  // Exactly one token exchange + one batched report call for TWO videos.
  assert.equal(calls.length, 2);
});

test('a video with no row in the response normalizes to null, never zero', async () => {
  const fetchImpl = async (url) => {
    if (String(url).includes('oauth2')) return tokenResponse();
    return { ok: true, status: 200, json: async () => ({ columnHeaders: [{ name: 'video' }, { name: 'views' }], rows: [['vid1', 5]] }) };
  };
  const adapter = new YouTubeAnalyticsAdapter({ fetchImpl, credentialsProvider: fakeCredentials });
  const result = await adapter.collect({ videoIds: ['vid1', 'vid2'], periodStart: '2026-09-01', periodEnd: '2026-09-01' });

  assert.equal(result.byVideoId.vid1.views, 5);
  assert.equal(result.byVideoId.vid2, null);
});

test('401/403 classify as AUTH_FAILURE and are never retried', async () => {
  let reportCalls = 0;
  const fetchImpl = async (url) => {
    if (String(url).includes('oauth2')) return tokenResponse();
    reportCalls += 1;
    return { ok: false, status: 401, text: async () => 'insufficient scope' };
  };
  const adapter = new YouTubeAnalyticsAdapter({ fetchImpl, credentialsProvider: fakeCredentials });
  const result = await adapter.collect({ videoIds: ['vid1'], periodStart: '2026-09-01', periodEnd: '2026-09-01' });

  assert.equal(result.status, ANALYTICS_RESULT_STATUS.AUTH_FAILURE);
  assert.equal(reportCalls, 1);
});

test('429 is retried a bounded number of times, then classifies as RATE_LIMITED', async () => {
  let reportCalls = 0;
  const fetchImpl = async (url) => {
    if (String(url).includes('oauth2')) return tokenResponse();
    reportCalls += 1;
    return { ok: false, status: 429, text: async () => 'quota exceeded' };
  };
  const adapter = new YouTubeAnalyticsAdapter({ fetchImpl, credentialsProvider: fakeCredentials, sleepImpl: async () => {} });
  const result = await adapter.collect({ videoIds: ['vid1'], periodStart: '2026-09-01', periodEnd: '2026-09-01' });

  assert.equal(result.status, ANALYTICS_RESULT_STATUS.RATE_LIMITED);
  assert.equal(reportCalls, 3, 'exactly 1 initial attempt + 2 bounded retries -- never unbounded');
});

test('5xx / network errors are retried a bounded number of times, then classify as TRANSIENT_FAILURE', async () => {
  let reportCalls = 0;
  const fetchImpl = async (url) => {
    if (String(url).includes('oauth2')) return tokenResponse();
    reportCalls += 1;
    return { ok: false, status: 503, text: async () => 'unavailable' };
  };
  const adapter = new YouTubeAnalyticsAdapter({ fetchImpl, credentialsProvider: fakeCredentials, sleepImpl: async () => {} });
  const result = await adapter.collect({ videoIds: ['vid1'], periodStart: '2026-09-01', periodEnd: '2026-09-01' });

  assert.equal(result.status, ANALYTICS_RESULT_STATUS.TRANSIENT_FAILURE);
  assert.equal(reportCalls, 3);
});

test('a malformed/rejected request (4xx other than 401/403/429) classifies as PERMANENT_FAILURE', async () => {
  const fetchImpl = async (url) => {
    if (String(url).includes('oauth2')) return tokenResponse();
    return { ok: false, status: 400, text: async () => 'bad filter' };
  };
  const adapter = new YouTubeAnalyticsAdapter({ fetchImpl, credentialsProvider: fakeCredentials });
  const result = await adapter.collect({ videoIds: ['vid1'], periodStart: '2026-09-01', periodEnd: '2026-09-01' });

  assert.equal(result.status, ANALYTICS_RESULT_STATUS.PERMANENT_FAILURE);
});

test('missing credentials classify as AUTH_FAILURE without making any network call', async () => {
  let called = false;
  const fetchImpl = async () => {
    called = true;
    return { ok: true, status: 200, json: async () => ({}) };
  };
  const adapter = new YouTubeAnalyticsAdapter({ fetchImpl, credentialsProvider: () => ({ clientId: '', clientSecret: '', refreshToken: '' }) });
  const result = await adapter.collect({ videoIds: ['vid1'], periodStart: '2026-09-01', periodEnd: '2026-09-01' });

  assert.equal(result.status, ANALYTICS_RESULT_STATUS.AUTH_FAILURE);
  assert.equal(called, false);
});

test('no video ids requested classifies as PERMANENT_FAILURE without making any network call', async () => {
  let called = false;
  const fetchImpl = async () => {
    called = true;
    return { ok: true, status: 200, json: async () => ({}) };
  };
  const adapter = new YouTubeAnalyticsAdapter({ fetchImpl, credentialsProvider: fakeCredentials });
  const result = await adapter.collect({ videoIds: [], periodStart: '2026-09-01', periodEnd: '2026-09-01' });

  assert.equal(result.status, ANALYTICS_RESULT_STATUS.PERMANENT_FAILURE);
  assert.equal(called, false);
});

test('the adapter exposes only collect() -- no publish/publishThumbnail surface exists', async () => {
  const adapter = new YouTubeAnalyticsAdapter({ fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({}) }) });
  assert.equal(typeof adapter.collect, 'function');
  assert.equal(adapter.publish, undefined);
  assert.equal(adapter.publishThumbnail, undefined);
});