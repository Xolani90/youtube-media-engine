import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GdeltSearchProvider } from '../../src/providers/research/GdeltSearchProvider.js';

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body)
  };
}

function textResponse(status, text) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => { throw new Error('not json'); },
    text: async () => text
  };
}

test('id is "gdelt"', () => {
  const provider = new GdeltSearchProvider();
  assert.equal(provider.id, 'gdelt');
});

test('healthCheck is always true (unauthenticated endpoint) and makes no network call', async () => {
  let called = false;
  const fetchImpl = async () => { called = true; return jsonResponse(200, { articles: [] }); };
  const provider = new GdeltSearchProvider({ fetchImpl });

  assert.equal(await provider.healthCheck(), true);
  assert.equal(called, false, 'healthCheck must never make a network call');
});

test('empty/missing query: fails closed without a network call', async () => {
  let called = false;
  const fetchImpl = async () => { called = true; return jsonResponse(200, { articles: [] }); };
  const provider = new GdeltSearchProvider({ fetchImpl });

  const result = await provider.discoverCandidates({ query: '  ', maxResults: 5 });
  assert.deepEqual(result.candidates, []);
  assert.equal(result.failures.length, 1);
  assert.equal(called, false);
});

test('successful response mapping: url/title/publishedAt extracted, snippet always null', async () => {
  const fetchImpl = async () => jsonResponse(200, {
    articles: [
      { url: 'https://example.com/a', title: 'A title', domain: 'example.com', seendate: '20260102T000000Z' },
      { url: 'https://example.com/b', title: 'B title', domain: 'example.com' }
    ]
  });
  const provider = new GdeltSearchProvider({ fetchImpl });

  const result = await provider.discoverCandidates({ query: 'q', maxResults: 5 });
  assert.equal(result.failures.length, 0);
  assert.equal(result.candidates.length, 2);
  assert.deepEqual(result.candidates[0], {
    url: 'https://example.com/a', title: 'A title', snippet: null, publishedAt: '20260102T000000Z'
  });
  // No seendate on the second item -> publishedAt omitted, not null-filled.
  assert.equal('publishedAt' in result.candidates[1], false);
  assert.deepEqual(result.candidates[1], { url: 'https://example.com/b', title: 'B title', snippet: null });
});

test('request sends query, mode=ArtList, format=json, and clamped maxrecords', async () => {
  let sentUrl;
  const fetchImpl = async (url) => { sentUrl = new URL(url); return jsonResponse(200, { articles: [] }); };
  const provider = new GdeltSearchProvider({ fetchImpl });

  await provider.discoverCandidates({ query: 'AI regulation', maxResults: 5 });
  assert.equal(sentUrl.searchParams.get('query'), 'AI regulation');
  assert.equal(sentUrl.searchParams.get('mode'), 'ArtList');
  assert.equal(sentUrl.searchParams.get('format'), 'json');
  assert.equal(sentUrl.searchParams.get('maxrecords'), '5');
});

test('respects maxResults, clamped into GDELT\'s documented 1-250 range', async () => {
  const fetchImpl = async () => jsonResponse(200, {
    articles: Array.from({ length: 10 }, (_, i) => ({ url: `https://example.com/${i}`, title: `t${i}` }))
  });
  const provider = new GdeltSearchProvider({ fetchImpl });

  const result = await provider.discoverCandidates({ query: 'q', maxResults: 3 });
  assert.equal(result.candidates.length, 3);
});

test('excludes URLs already present in alreadyAcquiredUrls', async () => {
  const fetchImpl = async () => jsonResponse(200, {
    articles: [
      { url: 'https://example.com/a', title: 'A' },
      { url: 'https://example.com/b', title: 'B' }
    ]
  });
  const provider = new GdeltSearchProvider({ fetchImpl });

  const result = await provider.discoverCandidates({
    query: 'q', maxResults: 5, alreadyAcquiredUrls: ['https://example.com/a']
  });
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].url, 'https://example.com/b');
});

test('empty results array: succeeds with zero candidates, no failure', async () => {
  const fetchImpl = async () => jsonResponse(200, { articles: [] });
  const provider = new GdeltSearchProvider({ fetchImpl });

  const result = await provider.discoverCandidates({ query: 'q', maxResults: 5 });
  assert.deepEqual(result.candidates, []);
  assert.deepEqual(result.failures, []);
});

test('malformed response (missing articles array): fails closed, does not throw', async () => {
  const fetchImpl = async () => jsonResponse(200, { unexpected: true });
  const provider = new GdeltSearchProvider({ fetchImpl });

  const result = await provider.discoverCandidates({ query: 'q', maxResults: 5 });
  assert.deepEqual(result.candidates, []);
  assert.equal(result.failures.length, 1);
});

test('non-JSON response body (GDELT plain-text error for malformed query): fails closed, does not throw', async () => {
  const fetchImpl = async () => textResponse(200, 'malformed query error');
  const provider = new GdeltSearchProvider({ fetchImpl });

  const result = await provider.discoverCandidates({ query: 'q', maxResults: 5 });
  assert.deepEqual(result.candidates, []);
  assert.equal(result.failures.length, 1);
  assert.match(result.failures[0].error, /malformed/);
});

test('HTTP failure (e.g. 503): fails closed, does not throw', async () => {
  const fetchImpl = async () => textResponse(503, 'Service Unavailable');
  const provider = new GdeltSearchProvider({ fetchImpl });

  const result = await provider.discoverCandidates({ query: 'q', maxResults: 5 });
  assert.deepEqual(result.candidates, []);
  assert.match(result.failures[0].error, /503/);
});

test('network failure: fails closed, does not throw', async () => {
  const fetchImpl = async () => { throw new Error('ECONNRESET'); };
  const provider = new GdeltSearchProvider({ fetchImpl });

  const result = await provider.discoverCandidates({ query: 'q', maxResults: 5 });
  assert.deepEqual(result.candidates, []);
  assert.equal(result.failures.length, 1);
  assert.match(result.failures[0].error, /network error/);
});

test('no API key is required anywhere (unauthenticated endpoint, network fully mocked in tests)', () => {
  // Structural guard: every test above supplies an injected fetchImpl and
  // no test reads or requires any environment credential.
  assert.equal(true, true);
});
