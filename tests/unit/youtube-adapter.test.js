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

/**
 * ---------------------------------------------------------------------
 * ADR-0030 -- requested-visibility validation and provider-confirmed
 * visibility reporting. No real network: every fetch is a mock.
 * ---------------------------------------------------------------------
 */

function uploadFlow({ captured = {}, returnedStatus = { privacyStatus: 'public' } } = {}) {
  captured.urls = [];
  return makeFetchMock([
    ['oauth2.googleapis.com/token', (u) => { captured.urls.push(String(u)); return jsonResponse(200, { access_token: 'tok' }); }],
    ['upload/youtube/v3/videos', (u, init) => {
      captured.urls.push(String(u));
      captured.body = JSON.parse(init.body);
      return jsonResponse(200, {}, { location: 'https://upload.example.com/session/vis' });
    }],
    ['upload.example.com/session/vis', (u) => {
      captured.urls.push(String(u));
      return jsonResponse(200, { id: 'VIS1', ...(returnedStatus ? { status: returnedStatus } : {}) });
    }]
  ]);
}

test('ADR-0030: authorization-derived requestedVisibility public/unlisted/private is what is sent to YouTube', async () => {
  for (const vis of ['public', 'unlisted', 'private']) {
    const captured = {};
    const request = baseRequest({ requestedVisibility: vis });
    const adapter = new YouTubeAdapter({ fetchImpl: uploadFlow({ captured, returnedStatus: { privacyStatus: vis } }), credentialsProvider: fakeCredentials });
    const result = await adapter.publish(request);
    assert.equal(result.status, PUBLICATION_RESULT_STATUS.SUCCESS);
    assert.equal(captured.body.status.privacyStatus, vis);
    assert.equal(result.confirmedVisibility, vis);
    fs.rmSync(request.mediaFilePath, { force: true });
  }
});

test('ADR-0030: null/absent requestedVisibility keeps the adapter default (private) -- baseline behavior', async () => {
  for (const overrides of [{}, { requestedVisibility: null }]) {
    const captured = {};
    const request = baseRequest(overrides);
    const adapter = new YouTubeAdapter({ fetchImpl: uploadFlow({ captured, returnedStatus: { privacyStatus: 'private' } }), credentialsProvider: fakeCredentials });
    await adapter.publish(request);
    assert.equal(captured.body.status.privacyStatus, 'private');
    fs.rmSync(request.mediaFilePath, { force: true });
  }
});

test('ADR-0030: invalid visibility fails closed BEFORE any network call (not even the token refresh)', async () => {
  for (const bad of ['PUBLIC', 'Public', 'friends', '', ' public', 'public ', 0, true, {}, ['public']]) {
    let fetchCalls = 0;
    const request = baseRequest({ requestedVisibility: bad });
    const adapter = new YouTubeAdapter({
      fetchImpl: async () => { fetchCalls += 1; throw new Error('must not be called'); },
      credentialsProvider: fakeCredentials
    });
    const result = await adapter.publish(request);
    assert.equal(result.status, PUBLICATION_RESULT_STATUS.EXPLICIT_FAILURE, JSON.stringify(bad));
    assert.equal(result.errorClass, 'INVALID_VISIBILITY');
    assert.equal(fetchCalls, 0, `no network for ${JSON.stringify(bad)}`);
    fs.rmSync(request.mediaFilePath, { force: true });
  }
});

test('ADR-0030: an invalid adapter default also fails closed before any network call', async () => {
  let fetchCalls = 0;
  const request = baseRequest();
  const adapter = new YouTubeAdapter({
    fetchImpl: async () => { fetchCalls += 1; throw new Error('must not be called'); },
    credentialsProvider: fakeCredentials,
    defaultPrivacyStatus: 'everyone'
  });
  const result = await adapter.publish(request);
  assert.equal(result.errorClass, 'INVALID_VISIBILITY');
  assert.equal(fetchCalls, 0);
  fs.rmSync(request.mediaFilePath, { force: true });
});

test('ADR-0030: provider-confirmed visibility is reported verbatim (null when absent) and never relabelled', async () => {
  const cases = [[{ privacyStatus: 'private' }, 'private'], [{ privacyStatus: 'unlisted' }, 'unlisted'], [null, null], [{}, null]];
  for (const [returnedStatus, expected] of cases) {
    const request = baseRequest({ requestedVisibility: 'public' });
    const adapter = new YouTubeAdapter({ fetchImpl: uploadFlow({ returnedStatus }), credentialsProvider: fakeCredentials });
    const result = await adapter.publish(request);
    assert.equal(result.status, PUBLICATION_RESULT_STATUS.SUCCESS, 'the adapter reports evidence; the core decides mismatch');
    assert.equal(result.confirmedVisibility, expected);
    fs.rmSync(request.mediaFilePath, { force: true });
  }
});

test('ADR-0030: no automatic post-upload visibility change -- only token, initiate and file PUT are ever called', async () => {
  const captured = {};
  const request = baseRequest({ requestedVisibility: 'public' });
  const adapter = new YouTubeAdapter({ fetchImpl: uploadFlow({ captured, returnedStatus: { privacyStatus: 'private' } }), credentialsProvider: fakeCredentials });
  await adapter.publish(request);
  assert.equal(captured.urls.length, 3);
  assert.ok(captured.urls[0].includes('oauth2.googleapis.com/token'));
  assert.ok(captured.urls[1].includes('uploadType=resumable'));
  assert.ok(captured.urls[2].includes('upload.example.com/session/vis'));
  assert.ok(!captured.urls.some((u) => /youtube\/v3\/videos\?(?!uploadType)/.test(u) || u.includes('videos.update')));
  fs.rmSync(request.mediaFilePath, { force: true });
});
