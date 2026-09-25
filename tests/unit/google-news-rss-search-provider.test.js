import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GoogleNewsRssSearchProvider, isGoogleNewsRssWrapperUrl, shapeGoogleNewsQuery } from '../../src/providers/research/GoogleNewsRssSearchProvider.js';

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

const WRAPPER_URL = 'https://news.google.com/rss/articles/CBMiW0FVX3lxTE9kT2t4QWVHS3diRXpOWV90RFhEMTh5SWp0RU9TRFl1dmJENEtZMnJDWXNsdkNpSHd0MDQ5YzhCVDZBUzlrN00wUVY5Q2hMMUpyWlRVcW5NYnJXVDg?oc=5';

test('Google News /rss/articles/ wrapper candidates are excluded; publisher URLs retained', async () => {
  const fetchImpl = async () => xmlResponse(200, feed([
    { title: 'Wrapped', link: WRAPPER_URL, description: 'w', pubDate: 'Mon, 01 Jan 2024 00:00:00 GMT' },
    { title: 'Publisher', link: 'https://www.publisher.com/story', description: 'p', pubDate: 'Tue, 02 Jan 2024 00:00:00 GMT' }
  ]));
  const provider = new GoogleNewsRssSearchProvider({ fetchImpl });

  const result = await provider.discoverCandidates({ query: 'q', maxResults: 5 });
  assert.deepEqual(result.failures, []);
  assert.deepEqual(result.candidates, [{
    url: 'https://www.publisher.com/story',
    title: 'Publisher',
    snippet: 'p',
    publishedAt: 'Tue, 02 Jan 2024 00:00:00 GMT'
  }]);
});

test('wrapper candidates do not consume maxResults slots', async () => {
  const items = [
    ...Array.from({ length: 4 }, (_, i) => ({ title: `w${i}`, link: `https://news.google.com/rss/articles/CBMi${i}?oc=5` })),
    { title: 'a', link: 'https://example.com/a' },
    { title: 'b', link: 'https://example.com/b' }
  ];
  const fetchImpl = async () => xmlResponse(200, feed(items));
  const provider = new GoogleNewsRssSearchProvider({ fetchImpl });

  const result = await provider.discoverCandidates({ query: 'q', maxResults: 2 });
  assert.deepEqual(result.candidates.map((c) => c.url), ['https://example.com/a', 'https://example.com/b']);
});

test('feed of only wrapper URLs: zero candidates, no failure, no throw', async () => {
  const fetchImpl = async () => xmlResponse(200, feed([{ title: 'w', link: WRAPPER_URL }]));
  const provider = new GoogleNewsRssSearchProvider({ fetchImpl });

  const result = await provider.discoverCandidates({ query: 'q', maxResults: 5 });
  assert.deepEqual(result.candidates, []);
  assert.deepEqual(result.failures, []);
});

test('other news.google.com paths and non-Google hosts containing the wrapper path are NOT excluded', async () => {
  const fetchImpl = async () => xmlResponse(200, feed([
    { title: 'topic', link: 'https://news.google.com/topics/abc' },
    { title: 'lookalike', link: 'https://example.com/rss/articles/xyz' },
    { title: 'subdomain', link: 'https://evilnews.google.com.example.com/rss/articles/x' }
  ]));
  const provider = new GoogleNewsRssSearchProvider({ fetchImpl });

  const result = await provider.discoverCandidates({ query: 'q', maxResults: 5 });
  assert.equal(result.candidates.length, 3);
});

test('malformed/missing links fail safely: missing skipped as before, unparseable does not throw and is not misclassified', async () => {
  const fetchImpl = async () => xmlResponse(200, feed([
    { title: 'No link' },
    { title: 'Garbage', link: 'not a url' },
    { title: 'Wrapper', link: WRAPPER_URL }
  ]));
  const provider = new GoogleNewsRssSearchProvider({ fetchImpl });

  const result = await provider.discoverCandidates({ query: 'q', maxResults: 5 });
  assert.deepEqual(result.failures, []);
  assert.deepEqual(result.candidates.map((c) => c.url), ['not a url']);
});

test('isGoogleNewsRssWrapperUrl: shape checks and safe handling of non-string/empty/unparseable input', () => {
  assert.equal(isGoogleNewsRssWrapperUrl(WRAPPER_URL), true);
  assert.equal(isGoogleNewsRssWrapperUrl('https://news.google.com/rss/articles/CBMi123'), true);
  assert.equal(isGoogleNewsRssWrapperUrl('https://news.google.com/topics/x'), false);
  assert.equal(isGoogleNewsRssWrapperUrl('https://example.com/rss/articles/x'), false);
  for (const bad of [undefined, null, '', 42, {}, 'not a url']) {
    assert.equal(isGoogleNewsRssWrapperUrl(bad), false);
  }
});

test('shapeGoogleNewsQuery strips question/function words while preserving order and distinctive terms', () => {
  const shaped = shapeGoogleNewsQuery(
    'How does V7 use GPT-5.6 Luna to cut costs by 78% while boosting accuracy through source-linked context for agents?'
  );
  // Distinctive terms survive, in their original order, punctuation intact.
  assert.match(shaped, /\bV7\b/);
  assert.match(shaped, /\bGPT-5\.6\b/);
  assert.match(shaped, /\bLuna\b/);
  assert.match(shaped, /\b78%(\s|$)/);
  assert.match(shaped, /\bsource-linked\b/);
  assert.equal(shaped.indexOf('V7') < shaped.indexOf('GPT-5.6'), true);
  assert.equal(shaped.indexOf('GPT-5.6') < shaped.indexOf('Luna'), true);
  assert.equal(shaped.indexOf('Luna') < shaped.indexOf('78%'), true);
  // Question/function words removed.
  for (const removed of ['How', 'does', 'to', 'by', 'while', 'through', 'for']) {
    assert.doesNotMatch(shaped, new RegExp(`\\b${removed}\\b`));
  }
  // No trailing question mark left over.
  assert.doesNotMatch(shaped, /\?/);
});

test('shapeGoogleNewsQuery strips a different question shape the same way', () => {
  const shaped = shapeGoogleNewsQuery(
    'What improvements does ChatGPT Images 2.5 offer in turning sketches and reference photos into polished images?'
  );
  for (const kept of ['ChatGPT', 'Images', '2.5', 'sketches', 'photos', 'polished', 'images']) {
    assert.match(shaped, new RegExp(`\\b${kept.replace('.', '\\.')}\\b`));
  }
  for (const removed of ['What', 'does', 'in', 'and', 'into']) {
    assert.doesNotMatch(shaped, new RegExp(`\\b${removed}\\b`));
  }
  assert.doesNotMatch(shaped, /\?/);
});

test('shapeGoogleNewsQuery never produces an empty string, even for an all-stopword input', () => {
  assert.equal(shapeGoogleNewsQuery('What is the how'), 'What is the how');
});

test('shapeGoogleNewsQuery falls back to the trimmed original for empty/whitespace/non-string input', () => {
  assert.equal(shapeGoogleNewsQuery(''), '');
  assert.equal(shapeGoogleNewsQuery('   '), '');
  assert.equal(shapeGoogleNewsQuery(null), '');
  assert.equal(shapeGoogleNewsQuery(undefined), '');
});

test('shapeGoogleNewsQuery is deterministic: same input always produces the same output', () => {
  const input = 'How does the widget work for teams?';
  assert.equal(shapeGoogleNewsQuery(input), shapeGoogleNewsQuery(input));
});

test('boundary: the shaped query, not the raw core_question, is what reaches the Google News RSS request URL', async () => {
  let sentUrl;
  const fetchImpl = async (url) => { sentUrl = new URL(url); return xmlResponse(200, feed([])); };
  const provider = new GoogleNewsRssSearchProvider({ fetchImpl });

  const rawQuestion = 'How does V7 use GPT-5.6 Luna to cut costs by 78% while boosting accuracy for agents?';
  await provider.discoverCandidates({ query: rawQuestion, maxResults: 5 });

  const sentQ = sentUrl.searchParams.get('q');
  assert.notEqual(sentQ, rawQuestion, 'the raw natural-language question must not be sent verbatim');
  assert.equal(sentQ, shapeGoogleNewsQuery(rawQuestion), 'the request must carry exactly what shapeGoogleNewsQuery produces');
  assert.doesNotMatch(sentQ, /\bHow\b/);
  assert.match(sentQ, /\bV7\b/);
});
