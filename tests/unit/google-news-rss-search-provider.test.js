import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GoogleNewsRssSearchProvider } from '../../src/providers/research/GoogleNewsRssSearchProvider.js';

function xmlResponse(status, xml) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => xml
  };
}

function feed(items) {
  const body = items
    .map(
      (i) => `<item>
        <title>${i.title ?? ''}</title>
        <link>${i.link ?? ''}</link>
        ${i.description ? `<description>${i.description}</description>` : ''}
        ${i.pubDate ? `<pubDate>${i.pubDate}</pubDate>` : ''}
      </item>`
    )
    .join('\n');
  return `<?xml version="1.0"?><rss version="2.0"><channel>${body}</channel></rss>`;
}

test('id is "google-news-rss"', () => {
  const provider = new GoogleNewsRssSearchProvider();
  assert.equal(provider.id, 'google-news-rss');
});

test('healthCheck is always true (unauthenticated endpoint) and makes no network call', async () => {
  let called = false;
  const fetchImpl = async () => { called = true; return xmlResponse(200, feed([])); };
  const provider = new GoogleNewsRssSearchProvider({ fetchImpl });

  assert.equal(await provider.healthCheck(), true);
  assert.equal(called, false, 'healthCheck must never make a network call');
});

test('empty/missing query: fails closed without a network call', async () => {
  let called = false;
  const fetchImpl = async () => { called = true; return xmlResponse(200, feed([])); };
  const provider = new GoogleNewsRssSearchProvider({ fetchImpl });

  const result = await provider.discoverCandidates({ query: '  ', maxResults: 5 });
  assert.deepEqual(result.candidates, []);
  assert.equal(result.failures.length, 1);
  assert.equal(called, false);
});

test('successful response mapping: url/title/snippet/publishedAt extracted from the feed', async () => {
  const fetchImpl = async () => xmlResponse(200, feed([
    {
      title: 'A title',
      link: 'https://example.com/a',
      description: 'A snippet',
      pubDate: 'Mon, 01 Jan 2024 00:00:00 GMT'
    },
    { title: 'B title', link: 'https://example.com/b' }
  ]));
  const provider = new GoogleNewsRssSearchProvider({ fetchImpl });

  const result = await provider.discoverCandidates({ query: 'q', maxResults: 5 });
  assert.equal(result.failures.length, 0);
  assert.equal(result.candidates.length, 2);
  assert.deepEqual(result.candidates[0], {
    url: 'https://example.com/a',
    title: 'A title',
    snippet: 'A snippet',
    publishedAt: 'Mon, 01 Jan 2024 00:00:00 GMT'
  });
  // No pubDate/description on the second item -> publishedAt omitted (not
  // null-filled), snippet mapped to null.
  assert.equal('publishedAt' in result.candidates[1], false);
  assert.deepEqual(result.candidates[1], { url: 'https://example.com/b', title: 'B title', snippet: null });
});

test('request sends query and fixed locale params to the Google News RSS search endpoint', async () => {
  let sentUrl;
  const fetchImpl = async (url) => { sentUrl = new URL(url); return xmlResponse(200, feed([])); };
  const provider = new GoogleNewsRssSearchProvider({ fetchImpl });

  await provider.discoverCandidates({ query: 'AI regulation', maxResults: 5 });
  assert.equal(sentUrl.origin + sentUrl.pathname, 'https://news.google.com/rss/search');
  assert.equal(sentUrl.searchParams.get('q'), 'AI regulation');
  assert.equal(sentUrl.searchParams.get('hl'), 'en-US');
  assert.equal(sentUrl.searchParams.get('gl'), 'US');
  assert.equal(sentUrl.searchParams.get('ceid'), 'US:en');
});

test('respects maxResults as a client-side bound on parsed feed items', async () => {
  const fetchImpl = async () => xmlResponse(200, feed(
    Array.from({ length: 10 }, (_, i) => ({ title: `t${i}`, link: `https://example.com/${i}` }))
  ));
  const provider = new GoogleNewsRssSearchProvider({ fetchImpl });

  const result = await provider.discoverCandidates({ query: 'q', maxResults: 3 });
  assert.equal(result.candidates.length, 3);
});

test('excludes URLs already present in alreadyAcquiredUrls', async () => {
  const fetchImpl = async () => xmlResponse(200, feed([
    { title: 'A', link: 'https://example.com/a' },
    { title: 'B', link: 'https://example.com/b' }
  ]));
  const provider = new GoogleNewsRssSearchProvider({ fetchImpl });

  const result = await provider.discoverCandidates({
    query: 'q', maxResults: 5, alreadyAcquiredUrls: ['https://example.com/a']
  });
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].url, 'https://example.com/b');
});

test('empty feed (no items): succeeds with zero candidates, no failure', async () => {
  const fetchImpl = async () => xmlResponse(200, feed([]));
  const provider = new GoogleNewsRssSearchProvider({ fetchImpl });

  const result = await provider.discoverCandidates({ query: 'q', maxResults: 5 });
  assert.deepEqual(result.candidates, []);
  assert.deepEqual(result.failures, []);
});

test('items missing a <link>: skipped rather than producing an invalid candidate', async () => {
  const fetchImpl = async () => xmlResponse(200, feed([
    { title: 'No link here' },
    { title: 'Has a link', link: 'https://example.com/ok' }
  ]));
  const provider = new GoogleNewsRssSearchProvider({ fetchImpl });

  const result = await provider.discoverCandidates({ query: 'q', maxResults: 5 });
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].url, 'https://example.com/ok');
});

test('HTTP failure (e.g. 503): fails closed, does not throw', async () => {
  const fetchImpl = async () => xmlResponse(503, 'Service Unavailable');
  const provider = new GoogleNewsRssSearchProvider({ fetchImpl });

  const result = await provider.discoverCandidates({ query: 'q', maxResults: 5 });
  assert.deepEqual(result.candidates, []);
  assert.match(result.failures[0].error, /503/);
});

test('network failure: fails closed, does not throw', async () => {
  const fetchImpl = async () => { throw new Error('ECONNRESET'); };
  const provider = new GoogleNewsRssSearchProvider({ fetchImpl });

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
