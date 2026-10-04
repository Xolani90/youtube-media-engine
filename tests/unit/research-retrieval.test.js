import { test } from 'node:test';
import assert from 'node:assert/strict';
import { retrieveSource, extractText, isGoogleNewsRssWrapperPage } from '../../src/research/retrieval.js';

function fakeFetch({ ok = true, status = 200, text = '<html><body>Hello world</body></html>', contentType = 'text/html', responseUrl } = {}) {
  return async (requestUrl) => ({
    ok, status,
    url: responseUrl !== undefined ? responseUrl : requestUrl,
    headers: { get: (h) => (h.toLowerCase() === 'content-type' ? contentType : null) },
    text: async () => text
  });
}

// Small, realistic-shaped stand-in for the demonstrated Google News RSS
// wrapper/interstitial response (NOT the real ~567 KB page — same
// observable characteristics: bare "Google News" <title>, no <article>
// element, and body text that strips down to "Google News").
const GOOGLE_NEWS_WRAPPER_HTML =
  '<html><head><title>Google News</title></head><body><c-wiz></c-wiz></body></html>';

const GOOGLE_NEWS_ARTICLE_URL = 'https://news.google.com/rss/articles/CBMiW0FVX3lxTE9kT2t4QWVHS3diRXpOWV90RFhEMTh5SWp0RU9TRFl1dmJENEtZMnJDWXNsdkNpSHd0MDQ5YzhCVDZBUzlrN00wUVY5Q2hMMUpyWlRVcW5NYnJXVDg?oc=5';

test('extractText strips tags/scripts/styles and collapses whitespace', () => {
  const html = '<html><head><style>.a{}</style></head><body><script>evil()</script><p>Hello   world</p></body></html>';
  assert.equal(extractText(html, 'text/html'), 'Hello world');
});

test('extractText returns null for a non-text content-type', () => {
  assert.equal(extractText('binarydata', 'image/png'), null);
});

test('extractText returns null for content that reduces to nothing', () => {
  assert.equal(extractText('<html><body>   </body></html>', 'text/html'), null);
});

test('retrieveSource returns SUCCESS with extracted content on a normal 200 response', async () => {
  const text = '<html><body>The tool measurably cuts costs.</body></html>';
  const result = await retrieveSource('https://example.com', { fetchImpl: fakeFetch({ text }) });
  assert.equal(result.status, 'SUCCESS');
  assert.equal(result.content, 'The tool measurably cuts costs.');
  assert.equal(result.retrievalMethod, 'plain');
});

test('retrieveSource: tiny HTTP 200 boilerplate is CONTENT_UNPARSEABLE, not SUCCESS (Pass 46)', async () => {
  const result = await retrieveSource('https://example.com', { fetchImpl: fakeFetch(), readerBaseUrl: null });
  assert.equal(result.status, 'CONTENT_UNPARSEABLE');
  assert.equal(result.content, null);
});

test('retrieveSource returns FAILED on a non-ok HTTP status', async () => {
  const result = await retrieveSource('https://example.com', { fetchImpl: fakeFetch({ ok: false, status: 500 }) });
  assert.equal(result.status, 'FAILED');
  assert.match(result.error, /500/);
});

test('retrieveSource returns FAILED when the fetch itself throws (network error/timeout)', async () => {
  const fetchImpl = async () => { throw new Error('network down'); };
  const result = await retrieveSource('https://example.com', { fetchImpl });
  assert.equal(result.status, 'FAILED');
});

test('retrieveSource returns CONTENT_UNPARSEABLE for binary content-type', async () => {
  const result = await retrieveSource('https://example.com/file.bin', { fetchImpl: fakeFetch({ contentType: 'application/octet-stream', text: 'binarydata' }) });
  assert.equal(result.status, 'CONTENT_UNPARSEABLE');
});

test('retrieveSource returns CONTENT_UNPARSEABLE for a real-shaped Google News RSS article-wrapper response', async () => {
  const result = await retrieveSource(GOOGLE_NEWS_ARTICLE_URL, {
    fetchImpl: fakeFetch({ text: GOOGLE_NEWS_WRAPPER_HTML })
  });
  assert.equal(result.status, 'CONTENT_UNPARSEABLE');
  assert.equal(result.content, null);
});

test('retrieveSource does not accept the demonstrated "Google News" extracted content as SUCCESS for a Google News RSS article URL', async () => {
  const result = await retrieveSource(GOOGLE_NEWS_ARTICLE_URL, {
    fetchImpl: fakeFetch({ text: GOOGLE_NEWS_WRAPPER_HTML })
  });
  // extractText(GOOGLE_NEWS_WRAPPER_HTML) alone would produce exactly
  // "Google News" (11 chars) and, without the wrapper guard, would have
  // been accepted as SUCCESS -- confirm it is not.
  assert.equal(extractText(GOOGLE_NEWS_WRAPPER_HTML, 'text/html'), 'Google News');
  assert.notEqual(result.status, 'SUCCESS');
});

test('retrieveSource returns SUCCESS for a normal publisher URL with ordinary article HTML', async () => {
  const articleHtml = '<html><head><title>Example Co. reports record results</title></head><body><article><p>Example Co. reported one billion dollars in revenue this quarter.</p></article></body></html>';
  const result = await retrieveSource('https://example.com/news/example-co-results', {
    fetchImpl: fakeFetch({ text: articleHtml })
  });
  assert.equal(result.status, 'SUCCESS');
  assert.match(result.content, /Example Co\. reported one billion dollars/);
});

test('retrieveSource does not reject a news.google.com response merely for its hostname when it contains substantive, non-wrapper content', async () => {
  // Same host + /rss/articles/ path as the wrapper case, but WITHOUT the
  // wrapper content signature (a real <title>, an <article> element) --
  // the guard must key off the content shape, not the hostname alone.
  const substantiveHtml = '<html><head><title>Example Co. reports record results</title></head><body><article><p>Example Co. reported one billion dollars in revenue this quarter.</p></article></body></html>';
  const result = await retrieveSource(GOOGLE_NEWS_ARTICLE_URL, {
    fetchImpl: fakeFetch({ text: substantiveHtml })
  });
  assert.equal(result.status, 'SUCCESS');
  assert.match(result.content, /Example Co\. reported one billion dollars/);
});

test('isGoogleNewsRssWrapperPage requires host, path, bare "Google News" title, and no <article> element together', () => {
  const res = { url: GOOGLE_NEWS_ARTICLE_URL };

  // Full match: wrapper.
  assert.equal(
    isGoogleNewsRssWrapperPage({ url: GOOGLE_NEWS_ARTICLE_URL, res, raw: GOOGLE_NEWS_WRAPPER_HTML }),
    true
  );

  // Wrong host: not a wrapper match.
  assert.equal(
    isGoogleNewsRssWrapperPage({ url: 'https://example.com/a', res: { url: 'https://example.com/a' }, raw: GOOGLE_NEWS_WRAPPER_HTML }),
    false
  );

  // Right host/path, but has an <article> element: not a wrapper match.
  const withArticle = '<html><head><title>Google News</title></head><body><article>real text</article></body></html>';
  assert.equal(
    isGoogleNewsRssWrapperPage({ url: GOOGLE_NEWS_ARTICLE_URL, res, raw: withArticle }),
    false
  );

  // Right host/path, but a different <title>: not a wrapper match.
  const differentTitle = '<html><head><title>Example Co. reports record results</title></head><body>some text</body></html>';
  assert.equal(
    isGoogleNewsRssWrapperPage({ url: GOOGLE_NEWS_ARTICLE_URL, res, raw: differentTitle }),
    false
  );
});

function recordingFetch(response = {}) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    return fakeFetch(response)(url);
  };
  impl.calls = calls;
  return impl;
}

test('retrieveSource sends a descriptive User-Agent header', async () => {
  const fetchImpl = recordingFetch();
  await retrieveSource('https://example.com/a', { fetchImpl });
  const ua = fetchImpl.calls[0].init.headers['User-Agent'];
  assert.match(ua, /^Mozilla\/5\.0 \(compatible; MediaEngineResearchBot\/1\.0; \+https:\/\/github\.com\/Xolani90\/youtube-media-engine\)$/);
});

test('retrieveSource sends an Accept header that requests HTML documents', async () => {
  const fetchImpl = recordingFetch();
  await retrieveSource('https://example.com/a', { fetchImpl });
  assert.match(fetchImpl.calls[0].init.headers.Accept, /text\/html/);
});

test('retrieveSource still passes an AbortSignal to fetch alongside the headers', async () => {
  const fetchImpl = recordingFetch();
  await retrieveSource('https://example.com/a', { fetchImpl });
  assert.ok(fetchImpl.calls[0].init.signal instanceof AbortSignal);
});

test('retrieveSource aborts and returns FAILED when the request exceeds timeoutMs', async () => {
  const fetchImpl = (url, { signal }) => new Promise((_, reject) => {
    signal.addEventListener('abort', () => reject(new Error('aborted')));
  });
  const result = await retrieveSource('https://example.com/slow', { fetchImpl, timeoutMs: 20 });
  assert.equal(result.status, 'FAILED');
  assert.equal(result.error, 'aborted');
  assert.equal(result.retryable, undefined);
});

test('retrieveSource marks HTTP 403 as FAILED and non-retryable', async () => {
  const result = await retrieveSource('https://example.com/a', { fetchImpl: fakeFetch({ ok: false, status: 403 }) });
  assert.equal(result.status, 'FAILED');
  assert.equal(result.error, 'HTTP 403');
  assert.equal(result.retryable, false);
});

test('retrieveSource marks HTTP 401 as FAILED and non-retryable', async () => {
  const result = await retrieveSource('https://example.com/a', { fetchImpl: fakeFetch({ ok: false, status: 401 }) });
  assert.equal(result.status, 'FAILED');
  assert.equal(result.error, 'HTTP 401');
  assert.equal(result.retryable, false);
});

test('retrieveSource does not mark transient statuses (429, 500, 503) as non-retryable', async () => {
  for (const status of [429, 500, 503]) {
    const result = await retrieveSource('https://example.com/a', { fetchImpl: fakeFetch({ ok: false, status }) });
    assert.equal(result.status, 'FAILED');
    assert.equal(result.retryable, undefined, `status ${status}`);
  }
});
