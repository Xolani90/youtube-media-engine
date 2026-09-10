import { test } from 'node:test';
import assert from 'node:assert/strict';
import { retrieveSource, extractText } from '../../src/research/retrieval.js';

function fakeFetch({ ok = true, status = 200, text = '<html><body>Hello world</body></html>', contentType = 'text/html' } = {}) {
  return async () => ({
    ok, status,
    headers: { get: (h) => (h.toLowerCase() === 'content-type' ? contentType : null) },
    text: async () => text
  });
}

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
  const result = await retrieveSource('https://example.com', { fetchImpl: fakeFetch() });
  assert.equal(result.status, 'SUCCESS');
  assert.equal(result.content, 'Hello world');
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