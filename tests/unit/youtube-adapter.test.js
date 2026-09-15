import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { YouTubeAdapter } from '../../src/publication/youtube/YouTubeAdapter.js';
import { PUBLICATION_RESULT_STATUS } from '../../src/publication/constants.js';

function fakeCredentials() {
  return { clientId: 'client', clientSecret: 'secret', refreshToken: 'refresh' };
}

function tmpVideoFile() {
  const p = path.join(os.tmpdir(), `yt-adapter-${crypto.randomUUID()}.mp4`);
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
    ...overrides
  };
}

/** Builds a fetch mock that dispatches by URL substring, in call order for a given URL. */
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

function jsonResponse(status, body, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => headers[k] ?? null },
    json: async () => body
  };
}

test('SUCCESS: confirmed video id from a real-shaped resumable upload flow', async () => {
  const request = baseRequest();
  const fetchImpl = makeFetchMock([
    ['oauth2.googleapis.com/token', () => jsonResponse(200, { access_token: 'tok123' })],
    ['upload/youtube/v3/videos', () => jsonResponse(200, {}, { location: 'https://upload.example.com/session/abc' })],
    ['upload.example.com/session/abc', () => jsonResponse(200, { id: 'YTVIDEOID', status: { privacyStatus: 'private' } })]
  ]);
  const adapter = new YouTubeAdapter({ fetchImpl, credentialsProvider: fakeCredentials });

  const result = await adapter.publish(request);

  assert.equal(result.status, PUBLICATION_RESULT_STATUS.SUCCESS);
  assert.equal(result.provider, 'youtube');
  assert.equal(result.providerItemId, 'YTVIDEOID');
  assert.equal(result.providerUrl, 'https://youtu.be/YTVIDEOID');

  fs.rmSync(request.mediaFilePath, { force: true });
});

test('CREDENTIALS_UNAVAILABLE: missing credentials is an explicit failure, no network call attempted', async () => {
  const request = baseRequest();
  let called = false;
  const fetchImpl = async () => {
    called = true;
    throw new Error('should not be called');
  };
  const adapter = new YouTubeAdapter({ fetchImpl, credentialsProvider: () => ({}) });

  const result = await adapter.publish(request);

  assert.equal(result.status, PUBLICATION_RESULT_STATUS.EXPLICIT_FAILURE);
  assert.equal(result.errorClass, 'CREDENTIALS_UNAVAILABLE');
  assert.equal(result.retryable, false);
  assert.equal(called, false);

  fs.rmSync(request.mediaFilePath, { force: true });
});

test('MEDIA_FILE_MISSING: explicit failure when the artifact file is not on disk', async () => {
  const request = baseRequest({ mediaFilePath: path.join(os.tmpdir(), `nope-${crypto.randomUUID()}.mp4`) });
  const fetchImpl = makeFetchMock([
    ['oauth2.googleapis.com/token', () => jsonResponse(200, { access_token: 'tok123' })]
  ]);
  const adapter = new YouTubeAdapter({ fetchImpl, credentialsProvider: fakeCredentials });

  const result = await adapter.publish(request);
  assert.equal(result.status, PUBLICATION_RESULT_STATUS.EXPLICIT_FAILURE);
  assert.equal(result.errorClass, 'MEDIA_FILE_MISSING');
});

test('explicit provider rejection (4xx on initiate) is translated to EXPLICIT_FAILURE, not ambiguous', async () => {
  const request = baseRequest();
  const fetchImpl = makeFetchMock([
    ['oauth2.googleapis.com/token', () => jsonResponse(200, { access_token: 'tok123' })],
    ['upload/youtube/v3/videos', () => jsonResponse(400, { error: { message: 'invalid metadata' } })]
  ]);
  const adapter = new YouTubeAdapter({ fetchImpl, credentialsProvider: fakeCredentials });

  const result = await adapter.publish(request);
  assert.equal(result.status, PUBLICATION_RESULT_STATUS.EXPLICIT_FAILURE);
  assert.match(result.errorClass, /initiate_upload_rejected_400/);
  assert.equal(result.retryable, false);

  fs.rmSync(request.mediaFilePath, { force: true });
});

test('5xx on initiate is AMBIGUOUS, never assumed success or failure', async () => {
  const request = baseRequest();
  const fetchImpl = makeFetchMock([
    ['oauth2.googleapis.com/token', () => jsonResponse(200, { access_token: 'tok123' })],
    ['upload/youtube/v3/videos', () => jsonResponse(503, {})]
  ]);
  const adapter = new YouTubeAdapter({ fetchImpl, credentialsProvider: fakeCredentials });

  const result = await adapter.publish(request);
  assert.equal(result.status, PUBLICATION_RESULT_STATUS.AMBIGUOUS);
  assert.ok(result.reconciliationInfo);

  fs.rmSync(request.mediaFilePath, { force: true });
});

test('network error during file PUT is AMBIGUOUS with reconciliation info, never a fabricated success', async () => {
  const request = baseRequest();
  const fetchImpl = makeFetchMock([
    ['oauth2.googleapis.com/token', () => jsonResponse(200, { access_token: 'tok123' })],
    ['upload/youtube/v3/videos', () => jsonResponse(200, {}, { location: 'https://upload.example.com/session/xyz' })],
    ['upload.example.com/session/xyz', () => {
      throw new Error('socket hang up');
    }]
  ]);
  const adapter = new YouTubeAdapter({ fetchImpl, credentialsProvider: fakeCredentials });

  const result = await adapter.publish(request);
  assert.equal(result.status, PUBLICATION_RESULT_STATUS.AMBIGUOUS);
  assert.equal(result.reconciliationInfo.phase, 'UPLOAD_BODY');
  assert.equal(result.reconciliationInfo.sessionUrl, 'https://upload.example.com/session/xyz');
  assert.ok(!('providerItemId' in result));

  fs.rmSync(request.mediaFilePath, { force: true });
});

test('a 2xx upload response with no video id is AMBIGUOUS, never fabricated as SUCCESS', async () => {
  const request = baseRequest();
  const fetchImpl = makeFetchMock([
    ['oauth2.googleapis.com/token', () => jsonResponse(200, { access_token: 'tok123' })],
    ['upload/youtube/v3/videos', () => jsonResponse(200, {}, { location: 'https://upload.example.com/session/weird' })],
    ['upload.example.com/session/weird', () => jsonResponse(200, {})]
  ]);
  const adapter = new YouTubeAdapter({ fetchImpl, credentialsProvider: fakeCredentials });

  const result = await adapter.publish(request);
  assert.equal(result.status, PUBLICATION_RESULT_STATUS.AMBIGUOUS);
  assert.equal(result.reconciliationInfo.note, 'no_video_id_in_response');

  fs.rmSync(request.mediaFilePath, { force: true });
});

test('privacyStatus defaults to private, and scheduling is passed through only when requested', async () => {
  let capturedBody = null;
  const request = baseRequest({ requestedPublishAt: '2027-01-01T00:00:00Z' });
  const fetchImpl = makeFetchMock([
    ['oauth2.googleapis.com/token', () => jsonResponse(200, { access_token: 'tok123' })],
    ['upload/youtube/v3/videos', (url, init) => {
      capturedBody = JSON.parse(init.body);
      return jsonResponse(200, {}, { location: 'https://upload.example.com/session/sched' });
    }],
    ['upload.example.com/session/sched', () => jsonResponse(200, { id: 'SCHED1' })]
  ]);
  const adapter = new YouTubeAdapter({ fetchImpl, credentialsProvider: fakeCredentials });

  const result = await adapter.publish(request);
  assert.equal(result.status, PUBLICATION_RESULT_STATUS.SUCCESS);
  assert.equal(capturedBody.status.privacyStatus, 'private');
  assert.equal(capturedBody.status.publishAt, '2027-01-01T00:00:00Z');

  fs.rmSync(request.mediaFilePath, { force: true });
});

test('no secrets appear in any normalized result', async () => {
  const request = baseRequest();
  const fetchImpl = makeFetchMock([
    ['oauth2.googleapis.com/token', () => jsonResponse(200, { access_token: 'super-secret-token' })],
    ['upload/youtube/v3/videos', () => jsonResponse(401, { error: 'invalid_token' })]
  ]);
  const adapter = new YouTubeAdapter({ fetchImpl, credentialsProvider: fakeCredentials });

  const result = await adapter.publish(request);
  const serialized = JSON.stringify(result);
  assert.ok(!serialized.includes('super-secret-token'));

  fs.rmSync(request.mediaFilePath, { force: true });
});
