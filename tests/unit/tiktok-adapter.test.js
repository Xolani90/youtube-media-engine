import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { TikTokAdapter } from '../../src/publication/tiktok/TikTokAdapter.js';
import { PUBLICATION_RESULT_STATUS } from '../../src/publication/constants.js';

function fakeCredentials() {
  return { clientKey: 'key', clientSecret: 'secret', refreshToken: 'refresh' };
}

function tmpVideoFile() {
  const p = path.join(os.tmpdir(), `tiktok-adapter-${crypto.randomUUID()}.mp4`);
  fs.writeFileSync(p, 'fake mp4 bytes');
  return p;
}

function baseRequest(overrides = {}) {
  return {
    contentVersionId: 'cv1',
    title: 'Test title',
    description: 'Test description',
    mediaFilePath: tmpVideoFile(),
    mediaChecksum: 'chk',
    durationSeconds: 5,
    requestedPublishAt: null,
    requestedVisibility: null,
    ...overrides
  };
}

function makeFetchMock(responders) {
  return async (url, init) => {
    for (const [match, respond] of responders) {
      if (url.toString().includes(match)) {
        return respond(url, init);
      }
    }
    throw new Error(`Unmocked fetch call: ${url}`);
  };
}

function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function noSleep() {
  return () => Promise.resolve();
}

test('SUCCESS: confirmed post id after init -> upload -> PUBLISH_COMPLETE status', async () => {
  const request = baseRequest();
  const fetchImpl = makeFetchMock([
    ['oauth/token', () => jsonResponse(200, { access_token: 'tok123' })],
    ['post/publish/video/init', () => jsonResponse(200, { data: { publish_id: 'pub123', upload_url: 'https://upload.example.com/session/abc' }, error: { code: 'ok' } })],
    ['upload.example.com/session/abc', () => ({ ok: false, status: 201, json: async () => ({}) })],
    ['post/publish/status/fetch', () => jsonResponse(200, { data: { status: 'PUBLISH_COMPLETE', publicaly_available_post_id: ['TT_POST_ID'] } })]
  ]);
  const adapter = new TikTokAdapter({ fetchImpl, credentialsProvider: fakeCredentials, sleepImpl: noSleep() });

  const result = await adapter.publish(request);

  assert.equal(result.status, PUBLICATION_RESULT_STATUS.SUCCESS);
  assert.equal(result.provider, 'tiktok');
  assert.equal(result.providerItemId, 'TT_POST_ID');
  assert.match(result.providerUrl, /TT_POST_ID/);

  fs.rmSync(request.mediaFilePath, { force: true });
});

test('CREDENTIALS_UNAVAILABLE: missing credentials is an explicit failure, no network call attempted', async () => {
  const request = baseRequest();
  let called = false;
  const fetchImpl = async () => {
    called = true;
    throw new Error('should not be called');
  };
  const adapter = new TikTokAdapter({ fetchImpl, credentialsProvider: () => ({}), sleepImpl: noSleep() });

  const result = await adapter.publish(request);

  assert.equal(result.status, PUBLICATION_RESULT_STATUS.EXPLICIT_FAILURE);
  assert.equal(result.errorClass, 'CREDENTIALS_UNAVAILABLE');
  assert.equal(result.retryable, false);
  assert.equal(called, false);

  fs.rmSync(request.mediaFilePath, { force: true });
});

test('MEDIA_FILE_MISSING: an already-deleted artifact is an explicit failure', async () => {
  const request = baseRequest({ mediaFilePath: '/nonexistent/path/video.mp4' });
  const fetchImpl = makeFetchMock([
    ['oauth/token', () => jsonResponse(200, { access_token: 'tok123' })]
  ]);
  const adapter = new TikTokAdapter({ fetchImpl, credentialsProvider: fakeCredentials, sleepImpl: noSleep() });

  const result = await adapter.publish(request);

  assert.equal(result.status, PUBLICATION_RESULT_STATUS.EXPLICIT_FAILURE);
  assert.equal(result.errorClass, 'MEDIA_FILE_MISSING');
});

test('INVALID_VISIBILITY: an unsupported requested visibility is rejected before any network call', async () => {
  const request = baseRequest({ requestedVisibility: 'unlisted' });
  let called = false;
  const fetchImpl = async () => {
    called = true;
    throw new Error('should not be called');
  };
  const adapter = new TikTokAdapter({ fetchImpl, credentialsProvider: fakeCredentials, sleepImpl: noSleep() });

  const result = await adapter.publish(request);

  assert.equal(result.status, PUBLICATION_RESULT_STATUS.EXPLICIT_FAILURE);
  assert.equal(result.errorClass, 'INVALID_VISIBILITY');
  assert.equal(called, false);

  fs.rmSync(request.mediaFilePath, { force: true });
});

test('EXPLICIT_FAILURE: a confirmed FAILED status is reported as explicit, not ambiguous', async () => {
  const request = baseRequest();
  const fetchImpl = makeFetchMock([
    ['oauth/token', () => jsonResponse(200, { access_token: 'tok123' })],
    ['post/publish/video/init', () => jsonResponse(200, { data: { publish_id: 'pub123', upload_url: 'https://upload.example.com/session/abc' }, error: { code: 'ok' } })],
    ['upload.example.com/session/abc', () => ({ ok: false, status: 201, json: async () => ({}) })],
    ['post/publish/status/fetch', () => jsonResponse(200, { data: { status: 'FAILED', fail_reason: 'video_format_check_failed' } })]
  ]);
  const adapter = new TikTokAdapter({ fetchImpl, credentialsProvider: fakeCredentials, sleepImpl: noSleep() });

  const result = await adapter.publish(request);

  assert.equal(result.status, PUBLICATION_RESULT_STATUS.EXPLICIT_FAILURE);
  assert.match(result.errorClass, /video_format_check_failed/);

  fs.rmSync(request.mediaFilePath, { force: true });
});

test('AMBIGUOUS: still processing after the bounded poll window is never fabricated as success', async () => {
  const request = baseRequest();
  const fetchImpl = makeFetchMock([
    ['oauth/token', () => jsonResponse(200, { access_token: 'tok123' })],
    ['post/publish/video/init', () => jsonResponse(200, { data: { publish_id: 'pub123', upload_url: 'https://upload.example.com/session/abc' }, error: { code: 'ok' } })],
    ['upload.example.com/session/abc', () => ({ ok: false, status: 201, json: async () => ({}) })],
    ['post/publish/status/fetch', () => jsonResponse(200, { data: { status: 'PROCESSING_UPLOAD' } })]
  ]);
  const adapter = new TikTokAdapter({ fetchImpl, credentialsProvider: fakeCredentials, sleepImpl: noSleep(), statusPollAttempts: 2 });

  const result = await adapter.publish(request);

  assert.equal(result.status, PUBLICATION_RESULT_STATUS.AMBIGUOUS);
  assert.equal(result.reconciliationInfo.publishId, 'pub123');

  fs.rmSync(request.mediaFilePath, { force: true });
});

test('AMBIGUOUS: init init succeeding with a 5xx is never treated as a blind explicit failure', async () => {
  const request = baseRequest();
  const fetchImpl = makeFetchMock([
    ['oauth/token', () => jsonResponse(200, { access_token: 'tok123' })],
    ['post/publish/video/init', () => ({ ok: false, status: 503, json: async () => ({}) })]
  ]);
  const adapter = new TikTokAdapter({ fetchImpl, credentialsProvider: fakeCredentials, sleepImpl: noSleep() });

  const result = await adapter.publish(request);

  assert.equal(result.status, PUBLICATION_RESULT_STATUS.AMBIGUOUS);

  fs.rmSync(request.mediaFilePath, { force: true });
});