import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { FacebookReelsAdapter } from '../../src/publication/facebook/FacebookReelsAdapter.js';
import { PUBLICATION_RESULT_STATUS } from '../../src/publication/constants.js';

function fakeCredentials() {
  return { pageId: 'page123', pageAccessToken: 'page-token' };
}

function tmpVideoFile() {
  const p = path.join(os.tmpdir(), `fb-reels-adapter-${crypto.randomUUID()}.mp4`);
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

test('SUCCESS: confirmed video id after start -> upload -> finish, with a clean status check', async () => {
  const request = baseRequest({ requestedVisibility: 'public' });
  const fetchImpl = makeFetchMock([
    ['video_reels', (url, init) => {
      const params = new URLSearchParams(init.body);
      if (params.get('upload_phase') === 'start') {
        return jsonResponse(200, { video_id: 'FBVIDEOID', upload_url: 'https://rupload.facebook.com/video-upload/FBVIDEOID' });
      }
      if (params.get('upload_phase') === 'finish') {
        assert.equal(params.get('video_state'), 'PUBLISHED');
        return jsonResponse(200, { success: true });
      }
      throw new Error(`unexpected upload_phase: ${params.get('upload_phase')}`);
    }],
    ['rupload.facebook.com', () => jsonResponse(200, { success: true })],
    ['FBVIDEOID?fields=status', () => jsonResponse(200, { status: { video_status: 'processing' } })]
  ]);
  const adapter = new FacebookReelsAdapter({ fetchImpl, credentialsProvider: fakeCredentials });

  const result = await adapter.publish(request);

  assert.equal(result.status, PUBLICATION_RESULT_STATUS.SUCCESS);
  assert.equal(result.provider, 'facebook_reels');
  assert.equal(result.providerItemId, 'FBVIDEOID');
  assert.match(result.providerUrl, /FBVIDEOID/);
  assert.equal(result.confirmedVisibility, 'public');

  fs.rmSync(request.mediaFilePath, { force: true });
});

test('CREDENTIALS_UNAVAILABLE: missing page credentials is an explicit failure, no network call attempted', async () => {
  const request = baseRequest();
  let called = false;
  const fetchImpl = async () => {
    called = true;
    throw new Error('should not be called');
  };
  const adapter = new FacebookReelsAdapter({ fetchImpl, credentialsProvider: () => ({}) });

  const result = await adapter.publish(request);

  assert.equal(result.status, PUBLICATION_RESULT_STATUS.EXPLICIT_FAILURE);
  assert.equal(result.errorClass, 'CREDENTIALS_UNAVAILABLE');
  assert.equal(called, false);

  fs.rmSync(request.mediaFilePath, { force: true });
});

test('MEDIA_FILE_MISSING: an already-deleted artifact is an explicit failure', async () => {
  const request = baseRequest({ mediaFilePath: '/nonexistent/path/video.mp4' });
  const adapter = new FacebookReelsAdapter({ fetchImpl: async () => { throw new Error('should not be called'); }, credentialsProvider: fakeCredentials });

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
  const adapter = new FacebookReelsAdapter({ fetchImpl, credentialsProvider: fakeCredentials });

  const result = await adapter.publish(request);

  assert.equal(result.status, PUBLICATION_RESULT_STATUS.EXPLICIT_FAILURE);
  assert.equal(result.errorClass, 'INVALID_VISIBILITY');
  assert.equal(called, false);

  fs.rmSync(request.mediaFilePath, { force: true });
});

test('EXPLICIT_FAILURE: a status check reporting error after a successful finish is reported as explicit failure', async () => {
  const request = baseRequest({ requestedVisibility: 'public' });
  const fetchImpl = makeFetchMock([
    ['video_reels', (url, init) => {
      const params = new URLSearchParams(init.body);
      if (params.get('upload_phase') === 'start') {
        return jsonResponse(200, { video_id: 'FBVIDEOID', upload_url: 'https://rupload.facebook.com/video-upload/FBVIDEOID' });
      }
      return jsonResponse(200, { success: true });
    }],
    ['rupload.facebook.com', () => jsonResponse(200, { success: true })],
    ['FBVIDEOID?fields=status', () => jsonResponse(200, { status: { video_status: 'error', error: { message: 'Resolution too low.' } } })]
  ]);
  const adapter = new FacebookReelsAdapter({ fetchImpl, credentialsProvider: fakeCredentials });

  const result = await adapter.publish(request);

  assert.equal(result.status, PUBLICATION_RESULT_STATUS.EXPLICIT_FAILURE);
  assert.match(result.errorClass, /error/);

  fs.rmSync(request.mediaFilePath, { force: true });
});

test('AMBIGUOUS: finish returning a 2xx with no confirmed success is never fabricated as SUCCESS', async () => {
  const request = baseRequest();
  const fetchImpl = makeFetchMock([
    ['video_reels', (url, init) => {
      const params = new URLSearchParams(init.body);
      if (params.get('upload_phase') === 'start') {
        return jsonResponse(200, { video_id: 'FBVIDEOID', upload_url: 'https://rupload.facebook.com/video-upload/FBVIDEOID' });
      }
      return jsonResponse(200, {});
    }],
    ['rupload.facebook.com', () => jsonResponse(200, { success: true })]
  ]);
  const adapter = new FacebookReelsAdapter({ fetchImpl, credentialsProvider: fakeCredentials });

  const result = await adapter.publish(request);

  assert.equal(result.status, PUBLICATION_RESULT_STATUS.AMBIGUOUS);

  fs.rmSync(request.mediaFilePath, { force: true });
});

test('AMBIGUOUS: a 5xx starting the upload session is never treated as a blind explicit failure', async () => {
  const request = baseRequest();
  const fetchImpl = makeFetchMock([
    ['video_reels', () => ({ ok: false, status: 503, json: async () => ({}) })]
  ]);
  const adapter = new FacebookReelsAdapter({ fetchImpl, credentialsProvider: fakeCredentials });

  const result = await adapter.publish(request);

  assert.equal(result.status, PUBLICATION_RESULT_STATUS.AMBIGUOUS);

  fs.rmSync(request.mediaFilePath, { force: true });
});