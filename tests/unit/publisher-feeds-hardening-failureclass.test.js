import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyRetrievalFailure } from '../../src/publisherFeeds/failureClass.js';
import { FAILURE_CLASS } from '../../src/publisherFeeds/constants.js';

test('wrapped HTTP errors are classified by status and keep the original text', () => {
  const cases = [
    ['reader HTTP 403', 403, FAILURE_CLASS.HOST_ACCESS_DENIED],
    ['Reader fallback failed: HTTP 429', 429, FAILURE_CLASS.HOST_RATE_LIMITED],
    ['reader_fallback error: HTTP 503', 503, FAILURE_CLASS.HOST_HTTP_ERROR],
    ['fallback: HTTP 401', 401, FAILURE_CLASS.HOST_ACCESS_DENIED],
    ['HTTP 404 Not Found', 404, FAILURE_CLASS.HOST_HTTP_ERROR],
    ['HTTP 500: upstream', 500, FAILURE_CLASS.HOST_HTTP_ERROR],
    ['HTTP 403', 403, FAILURE_CLASS.HOST_ACCESS_DENIED]
  ];
  for (const [text, status, cls] of cases) {
    const c = classifyRetrievalFailure(text);
    assert.equal(c.failureClass, cls, text);
    assert.equal(c.httpStatus, status, text);
    assert.equal(c.originalError, text, text);
  }
});

test('NEGATIVE: unrelated internal failures that merely mention HTTP are never HTTP failures', () => {
  for (const text of ['fetch failed', 'ECONNRESET while contacting proxy', 'timeout after HTTP 403 retry budget', 'parsed page with HTTP 404 links',
    'proxy said HTTP 500 but connection dropped', 'SSL HTTP 403', 'XHTTP 403', 'reader fetch failed (see HTTP 403 in log)', 'HTTP 4033', 'HTTP 40',
    'HTTP 200', 'HTTP 302', 'HTTP 399', 'HTTP 600', 'HTTP 000', 'http2 stream error', 'content could not be parsed into usable text',
    'retrieved content is BLOCKED (challenge), not usable research text']) {
    const c = classifyRetrievalFailure(text);
    // 'fetch failed' is the one positively recognised no-HTTP-response text; every other text is unclassified.
    assert.equal(c.failureClass, text === 'fetch failed' ? FAILURE_CLASS.INTERNAL_RETRIEVAL_FAILURE : 'unclassified', text);
    assert.equal(c.httpStatus, null, text);
    assert.equal(c.originalError, text, text);
  }
});
