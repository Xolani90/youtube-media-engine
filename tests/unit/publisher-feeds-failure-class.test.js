import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyRetrievalFailure, classifySourceFailure, readRetrievalProvenance } from '../../src/publisherFeeds/failureClass.js';
import { FAILURE_CLASS } from '../../src/publisherFeeds/constants.js';
import { provenance } from '../helpers/publisherFeedsFixture.js';

test('401 and 403 are host_access_denied and keep the original status and text', () => {
  for (const code of [401, 403]) {
    const c = classifyRetrievalFailure(`HTTP ${code}`);
    assert.equal(c.failureClass, FAILURE_CLASS.HOST_ACCESS_DENIED);
    assert.equal(c.httpStatus, code);
    assert.equal(c.originalError, `HTTP ${code}`);
  }
});

test('429 is host_rate_limited and keeps its status', () => {
  const c = classifyRetrievalFailure('HTTP 429');
  assert.equal(c.failureClass, FAILURE_CLASS.HOST_RATE_LIMITED);
  assert.equal(c.httpStatus, 429);
});

test('other HTTP statuses are host_http_error', () => {
  for (const code of [400, 404, 410, 500, 502, 503]) {
    const c = classifyRetrievalFailure(`HTTP ${code}`);
    assert.equal(c.failureClass, FAILURE_CLASS.HOST_HTTP_ERROR, String(code));
    assert.equal(c.httpStatus, code);
  }
});

test('recognised network/abort errors are internal_retrieval_failure; unrecognised or absent errors are unclassified; never an HTTP status', () => {
  for (const e of ['fetch failed', 'This operation was aborted']) {
    const c = classifyRetrievalFailure(e);
    assert.equal(c.failureClass, FAILURE_CLASS.INTERNAL_RETRIEVAL_FAILURE, e);
    assert.equal(c.httpStatus, null);
    assert.equal(c.originalError, e);
  }
  for (const e of ['body read failed: terminated', 'ECONNRESET']) {
    const c = classifyRetrievalFailure(e);
    assert.equal(c.failureClass, 'unclassified', e);
    assert.equal(c.httpStatus, null);
    assert.equal(c.originalError, e);
  }
  const none = classifyRetrievalFailure(null);
  assert.equal(none.failureClass, 'unclassified');
  assert.equal(none.detail, 'no_error_recorded');
});

test('a message merely containing "HTTP 403" mid-string is not classified as a host denial', () => {
  assert.equal(classifyRetrievalFailure('upstream said HTTP 403').failureClass, 'unclassified');
});

test('classification never asserts a mechanism (no TLS / Cloudflare / fingerprint claim)', () => {
  const all = [401, 403, 429, 500].map((n) => JSON.stringify(classifyRetrievalFailure(`HTTP ${n}`))).join('');
  assert.doesNotMatch(all, /tls|cloudflare|fingerprint|waf|bot/i);
});

test('classifySourceFailure reads the provenance notes the pipeline persists', () => {
  const c = classifySourceFailure(provenance({ error: 'HTTP 403', method: 'plain' }));
  assert.equal(c.failureClass, FAILURE_CLASS.HOST_ACCESS_DENIED);
  assert.equal(c.retrievalMethod, 'plain');
  assert.equal(c.retrievalStatus, 'FAILED');
});

test('unreadable or foreign notes degrade to unclassified with an explicit detail', () => {
  for (const n of [null, '', 'not json', JSON.stringify({ schema: 'other/v9' })]) {
    const c = classifySourceFailure(n);
    assert.equal(c.failureClass, 'unclassified');
    assert.equal(c.detail, 'provenance_unreadable');
  }
  assert.equal(readRetrievalProvenance('not json'), null);
});
