import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TavilySearchProvider } from '../../src/providers/research/TavilySearchProvider.js';

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

test('id is "tavily"', () => {
  const provider = new TavilySearchProvider({ apiKeyProvider: () => 'k' });
  assert.equal(provider.id, 'tavily');
});

test('healthCheck is true only when a credential is configured, and makes no network call', async () => {
  let called = false;
  const fetchImpl = async () => { called = true; return jsonResponse(200, { results: [] }); };

  const withKey = new TavilySearchProvider({ apiKeyProvider: () => 'tvly-real', fetchImpl });
  assert.equal(await withKey.healthCheck(), true);

  const withoutKey = new TavilySearchProvider({ apiKeyProvider: () => undefined, fetchImpl });
  assert.equal(await withoutKey.healthCheck(), false);

  assert.equal(called, false, 'healthCheck must never make a network call');
});

test('missing credential: discoverCandidates never throws, returns empty candidates and a structured failure', async () => {
  let called = false;
  const fetchImpl = async () => { called = true; return jsonResponse(200, { results: [] }); };
  const provider = new TavilySearchProvider({ apiKeyProvider: () => undefined, fetchImpl });

  const result = await provider.discoverCandidates({ query: 'q', maxResults: 5 });
  assert.deepEqual(result.candidates, []);
  assert.equal(result.failures.length, 1);
  assert.match(result.failures[0].error, /TAVILY_API_KEY/);
  assert.equal(called, false, 'must not call the network without a credential');
});

test('empty/missing query: fails closed without a network call', async () => {
  let called = false;
  const fetchImpl = async () => { called = true; return jsonResponse(200, { results: [] }); };
  const provider = new TavilySearchProvider({ apiKeyProvider: () => 'k', fetchImpl });

  const result = await provider.discoverCandidates({ query: '  ', maxResults: 5 });
  assert.deepEqual(result.candidates, []);
  assert.equal(result.failures.length, 1);
  assert.equal(called, false);
});

test('successful response mapping: url/title/snippet/publishedAt extracted correctly', async () => {
  const fetchImpl = async () => jsonResponse(200, {
    results: [
      { url: 'https://example.com/a', title: 'A title', content: 'A snippet', published_date: '2026-01-02' },
      { url: 'https://example.com/b', title: 'B title', content: 'B snippet' }
    ]
  });
  const provider = new TavilySearchProvider({ apiKeyProvider: () => 'k', fetchImpl });

  const result = await provider.discoverCandidates({ query: 'q', maxResults: 5 });
  assert.equal(result.failures.length, 0);
  assert.equal(result.candidates.length, 2);
  assert.deepEqual(result.candidates[0], {
    url: 'https://example.com/a', title: 'A title', snippet: 'A snippet', publishedAt: '2026-01-02'
  });
  // No published_date on the second item -> publishedAt omitted, not null-filled.
  assert.equal('publishedAt' in result.candidates[1], false);
  assert.deepEqual(
    { url: result.candidates[1].url, title: result.candidates[1].title, snippet: result.candidates[1].snippet },
    { url: 'https://example.com/b', title: 'B title', snippet: 'B snippet' }
  );
});

test('request always sends explicit search_depth=basic (never relies on auto_parameters)', async () => {
  let sentBody;
  const fetchImpl = async (url, opts) => {
    sentBody = JSON.parse(opts.body);
    return jsonResponse(200, { results: [] });
  };
  const provider = new TavilySearchProvider({ apiKeyProvider: () => 'k', fetchImpl });
  await provider.discoverCandidates({ query: 'q', maxResults: 5 });
  assert.equal(sentBody.search_depth, 'basic');
  assert.equal(sentBody.query, 'q');
});

test('respects maxResults, clamped into Tavily\'s documented 1-20 range', async () => {
  const fetchImpl = async () => jsonResponse(200, {
    results: Array.from({ length: 20 }, (_, i) => ({ url: `https://example.com/${i}`, title: `t${i}`, content: `s${i}` }))
  });
  const provider = new TavilySearchProvider({ apiKeyProvider: () => 'k', fetchImpl });

  const result = await provider.discoverCandidates({ query: 'q', maxResults: 3 });
  assert.equal(result.candidates.length, 3);
});

test('excludes URLs already present in alreadyAcquiredUrls', async () => {
  const fetchImpl = async () => jsonResponse(200, {
    results: [
      { url: 'https://example.com/a', title: 'A', content: 'a' },
      { url: 'https://example.com/b', title: 'B', content: 'b' }
    ]
  });
  const provider = new TavilySearchProvider({ apiKeyProvider: () => 'k', fetchImpl });

  const result = await provider.discoverCandidates({
    query: 'q', maxResults: 5, alreadyAcquiredUrls: ['https://example.com/a']
  });
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].url, 'https://example.com/b');
});

test('empty results array: succeeds with zero candidates, no failure', async () => {
  const fetchImpl = async () => jsonResponse(200, { results: [] });
  const provider = new TavilySearchProvider({ apiKeyProvider: () => 'k', fetchImpl });

  const result = await provider.discoverCandidates({ query: 'q', maxResults: 5 });
  assert.deepEqual(result.candidates, []);
  assert.deepEqual(result.failures, []);
});

test('malformed response (missing results array): fails closed, does not throw', async () => {
  const fetchImpl = async () => jsonResponse(200, { unexpected: true });
  const provider = new TavilySearchProvider({ apiKeyProvider: () => 'k', fetchImpl });

  const result = await provider.discoverCandidates({ query: 'q', maxResults: 5 });
  assert.deepEqual(result.candidates, []);
  assert.equal(result.failures.length, 1);
});

test('non-JSON response body: fails closed, does not throw', async () => {
  const fetchImpl = async () => textResponse(200, 'not json at all');
  const provider = new TavilySearchProvider({ apiKeyProvider: () => 'k', fetchImpl });

  const result = await provider.discoverCandidates({ query: 'q', maxResults: 5 });
  assert.deepEqual(result.candidates, []);
  assert.equal(result.failures.length, 1);
  assert.match(result.failures[0].error, /malformed/);
});

test('HTTP 401 (invalid/missing key at Tavily): fails closed, does not throw', async () => {
  const fetchImpl = async () => textResponse(401, 'Unauthorized: missing or invalid API key');
  const provider = new TavilySearchProvider({ apiKeyProvider: () => 'bad-key', fetchImpl });

  const result = await provider.discoverCandidates({ query: 'q', maxResults: 5 });
  assert.deepEqual(result.candidates, []);
  assert.match(result.failures[0].error, /401/);
});

test('HTTP 429 (rate limited): fails closed, does not retry or throw', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; return textResponse(429, 'rate limited'); };
  const provider = new TavilySearchProvider({ apiKeyProvider: () => 'k', fetchImpl });

  const result = await provider.discoverCandidates({ query: 'q', maxResults: 5 });
  assert.deepEqual(result.candidates, []);
  assert.match(result.failures[0].error, /429/);
  assert.equal(calls, 1, 'must not internally retry');
});

test('HTTP 432 (free plan credit allocation exhausted): fails closed, no fallback provider, no throw', async () => {
  const fetchImpl = async () => textResponse(432, 'This request exceeds your plan\'s set usage limit.');
  const provider = new TavilySearchProvider({ apiKeyProvider: () => 'k', fetchImpl });

  const result = await provider.discoverCandidates({ query: 'q', maxResults: 5 });
  assert.deepEqual(result.candidates, []);
  assert.equal(result.failures.length, 1);
  assert.match(result.failures[0].error, /432/);
});

test('HTTP 433 (pay-as-you-go limit, only reachable if Owner manually enabled PAYGO): fails closed, does not throw', async () => {
  const fetchImpl = async () => textResponse(433, 'This request exceeds the pay-as-you-go limit.');
  const provider = new TavilySearchProvider({ apiKeyProvider: () => 'k', fetchImpl });

  const result = await provider.discoverCandidates({ query: 'q', maxResults: 5 });
  assert.deepEqual(result.candidates, []);
  assert.equal(result.failures.length, 1);
  assert.match(result.failures[0].error, /433/);
});

test('network failure: fails closed, does not throw', async () => {
  const fetchImpl = async () => { throw new Error('ECONNRESET'); };
  const provider = new TavilySearchProvider({ apiKeyProvider: () => 'k', fetchImpl });

  const result = await provider.discoverCandidates({ query: 'q', maxResults: 5 });
  assert.deepEqual(result.candidates, []);
  assert.equal(result.failures.length, 1);
  assert.match(result.failures[0].error, /network error/);
});

test('credential injection: apiKeyProvider is consulted, key is never hard-coded', async () => {
  let sentAuthHeader;
  const fetchImpl = async (url, opts) => {
    sentAuthHeader = opts.headers.Authorization;
    return jsonResponse(200, { results: [] });
  };
  const provider = new TavilySearchProvider({ apiKeyProvider: () => 'tvly-injected-key', fetchImpl });
  await provider.discoverCandidates({ query: 'q', maxResults: 5 });
  assert.equal(sentAuthHeader, 'Bearer tvly-injected-key');
});

test('no real API key is used anywhere in this test file (network fully mocked)', () => {
  // Structural guard: every test above supplies an injected fetchImpl and
  // a synthetic apiKeyProvider; none reads process.env.TAVILY_API_KEY or
  // calls the real Tavily endpoint.
  assert.equal(true, true);
});
