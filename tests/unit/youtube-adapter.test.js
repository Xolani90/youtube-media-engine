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

/**
 * ---------------------------------------------------------------------
 * Resumable media upload: a transient (500/502/503/504) media PUT is
 * RECONCILED with a zero-byte status PUT, never blindly resent. No real
 * network: every fetch is a mock; sleep is injected and recorded.
 * ---------------------------------------------------------------------
 */

const SESSION_A = 'https://upload.example.com/session/A';
const SESSION_B = 'https://upload.example.com/session/B';
const CHUNK = 256 * 1024;

const rStatus = (status, headers = {}, body = {}) => jsonResponse(status, body, headers);
// 308 "resume incomplete": `committed` bytes are stored (no Range header when 0).
const r308 = (committed) => rStatus(308, committed > 0 ? { range: `bytes=0-${committed - 1}` } : {});
const rDone = () => rStatus(200, {}, { id: 'YTVIDEOID', status: { privacyStatus: 'private' } });

function requestOfSize(size) {
  const mediaFilePath = path.join(os.tmpdir(), `yt-adapter-${crypto.randomUUID()}.mp4`);
  fs.writeFileSync(mediaFilePath, Buffer.alloc(size, 7));
  return baseRequest({ mediaFilePath });
}

/**
 * sessions: { [sessionUrl]: [response, ...] } consumed in call order, media and
 * status PUTs alike; any PUT beyond the script throws "unexpected PUT".
 * initiates: session URLs returned by successive resumable initiations.
 */
function resumableHarness({ sessions = {}, initiates = [SESSION_A], initiateResponses = null }) {
  const h = { puts: [], initiateCount: 0, stateHistory: [], sleeps: [] };
  const queues = new Map(Object.entries(sessions).map(([url, q]) => [url, [...q]]));
  const pendingInitiates = [...initiates];
  const fetchImpl = makeFetchMock([
    ['oauth2.googleapis.com/token', () => jsonResponse(200, { access_token: 'tok' })],
    ['upload/youtube/v3/videos', () => {
      h.initiateCount += 1;
      if (initiateResponses) {
        // Scripted initiate outcomes (response objects, or functions that may throw).
        const next = initiateResponses.shift();
        return typeof next === 'function' ? next() : next;
      }
      return jsonResponse(200, {}, { location: pendingInitiates.shift() });
    }],
    ['upload.example.com/session/', (url, init) => {
      const range = init.headers['Content-Range'];
      h.puts.push({ url: String(url), range });
      const next = queues.get(String(url))?.shift();
      if (!next) {
        throw new Error(`unexpected PUT ${url} ${range}`);
      }
      return next;
    }]
  ]);
  h.adapter = new YouTubeAdapter({
    fetchImpl,
    credentialsProvider: fakeCredentials,
    sleep: async (ms) => { h.sleeps.push(ms); }
  });
  h.context = { providerState: null, saveProviderState: (state) => { h.stateHistory.push(state); } };
  h.mediaPuts = (url) => h.puts.filter((p) => (!url || p.url === url) && !p.range.startsWith('bytes */'));
  h.statusPuts = (url) => h.puts.filter((p) => (!url || p.url === url) && p.range.startsWith('bytes */'));
  return h;
}

test('ambiguous: an explicit rejection (401/403/400) of the RECONCILIATION request after a media PUT 503 stays AMBIGUOUS -- one media PUT, one status PUT, no resend, state retained', async () => {
  for (const rejection of [401, 403, 400]) {
    const request = baseRequest();
    const size = fs.statSync(request.mediaFilePath).size;
    // media PUT -> 503, reconciliation -> explicit rejection; any further PUT throws "unexpected PUT".
    const h = resumableHarness({ sessions: { [SESSION_A]: [rStatus(503), rStatus(rejection)] } });

    const result = await h.adapter.publish(request, h.context);

    assert.equal(result.status, PUBLICATION_RESULT_STATUS.AMBIGUOUS, `HTTP ${rejection}`);
    assert.notEqual(result.status, PUBLICATION_RESULT_STATUS.EXPLICIT_FAILURE, `HTTP ${rejection}`);
    assert.ok(!('errorClass' in result), `HTTP ${rejection}: no explicit-failure classification may leak`);
    assert.equal(result.reconciliationInfo.phase, 'UPLOAD_BODY', `HTTP ${rejection}`);
    assert.equal(result.reconciliationInfo.note, `upload_reconciliation_rejected_${rejection}`);
    assert.equal(result.reconciliationInfo.sessionUrl, SESSION_A, `HTTP ${rejection}: session URL retained`);
    assert.ok(!('providerItemId' in result), `HTTP ${rejection}`);

    assert.equal(
      h.puts.filter((p) => p.range === `bytes 0-${size - 1}/${size}`).length,
      1,
      `HTTP ${rejection}: media chunk sent exactly once`
    );
    assert.equal(h.puts.filter((p) => p.range === `bytes */${size}`).length, 1, `HTTP ${rejection}: exactly one reconciliation PUT`);
    assert.deepEqual(h.stateHistory, [{ sessionUrl: SESSION_A }], `HTTP ${rejection}: provider state retained, never cleared`);

    fs.rmSync(request.mediaFilePath, { force: true });
  }
});

test('reconciliation after a media PUT 503: server reports the upload COMPLETED -> SUCCESS, no resend', async () => {
  const request = baseRequest();
  const h = resumableHarness({ sessions: { [SESSION_A]: [rStatus(503), rDone()] } });

  const result = await h.adapter.publish(request, h.context);

  assert.equal(result.status, PUBLICATION_RESULT_STATUS.SUCCESS);
  assert.equal(result.providerItemId, 'YTVIDEOID');
  assert.equal(h.mediaPuts().length, 1, 'the chunk was never resent');
  assert.equal(h.statusPuts().length, 1);
  assert.deepEqual(h.stateHistory, [{ sessionUrl: SESSION_A }]);

  fs.rmSync(request.mediaFilePath, { force: true });
});

test('reconciliation after a media PUT 503: server reports an ADVANCED offset -> continue from the server offset, committed bytes never resent', async () => {
  const size = CHUNK * 2;
  const request = requestOfSize(size);
  const h = resumableHarness({ sessions: { [SESSION_A]: [rStatus(503), r308(CHUNK), rDone()] } });

  const result = await h.adapter.publish(request, h.context);

  assert.equal(result.status, PUBLICATION_RESULT_STATUS.SUCCESS);
  assert.deepEqual(
    h.mediaPuts().map((p) => p.range),
    [`bytes 0-${CHUNK - 1}/${size}`, `bytes ${CHUNK}-${size - 1}/${size}`],
    'second media PUT starts at the server-reported offset'
  );
  assert.equal(h.statusPuts().length, 1);

  fs.rmSync(request.mediaFilePath, { force: true });
});

test('reconciliation after a media PUT 503: SAME offset -> the chunk is retried once, honouring Retry-After before reconciling', async () => {
  const request = baseRequest();
  const size = fs.statSync(request.mediaFilePath).size;
  const h = resumableHarness({
    sessions: { [SESSION_A]: [rStatus(503, { 'retry-after': '7' }), r308(0), rDone()] }
  });

  const result = await h.adapter.publish(request, h.context);

  assert.equal(result.status, PUBLICATION_RESULT_STATUS.SUCCESS);
  assert.deepEqual(
    h.mediaPuts().map((p) => p.range),
    [`bytes 0-${size - 1}/${size}`, `bytes 0-${size - 1}/${size}`],
    'same chunk retried because the server committed nothing'
  );
  assert.equal(h.statusPuts().length, 1, 'reconciled between the two media PUTs');
  assert.deepEqual(h.sleeps, [7000], 'Retry-After (7s) honoured');

  fs.rmSync(request.mediaFilePath, { force: true });
});

test('bounded: repeated media 503s at the same offset stop at the per-chunk attempt budget -> AMBIGUOUS, state retained', async () => {
  const request = baseRequest();
  const h = resumableHarness({
    sessions: { [SESSION_A]: [rStatus(503), r308(0), rStatus(503), r308(0), rStatus(503)] }
  });

  const result = await h.adapter.publish(request, h.context);

  assert.equal(result.status, PUBLICATION_RESULT_STATUS.AMBIGUOUS);
  assert.ok(!('errorClass' in result));
  assert.equal(result.reconciliationInfo.phase, 'UPLOAD_BODY');
  assert.equal(result.reconciliationInfo.note, 'upload_body_server_error_503');
  assert.equal(result.reconciliationInfo.sessionUrl, SESSION_A);
  assert.equal(h.mediaPuts().length, 3, 'exactly RESUMABLE_MAX_ATTEMPTS media PUTs');
  assert.equal(h.statusPuts().length, 2, 'reconciled between attempts, not after the last');
  assert.deepEqual(h.sleeps, [1000, 2000], 'attempt-based backoff when no Retry-After');
  assert.deepEqual(h.stateHistory, [{ sessionUrl: SESSION_A }]);

  fs.rmSync(request.mediaFilePath, { force: true });
});

test('expired session (404/410) found while reconciling: state cleared, ONE bounded fresh-session restart', async () => {
  for (const expiredStatus of [404, 410]) {
    const request = baseRequest();
    const h = resumableHarness({
      initiates: [SESSION_A, SESSION_B],
      sessions: { [SESSION_A]: [rStatus(503), rStatus(expiredStatus)], [SESSION_B]: [rDone()] }
    });

    const result = await h.adapter.publish(request, h.context);

    assert.equal(result.status, PUBLICATION_RESULT_STATUS.SUCCESS, `HTTP ${expiredStatus}`);
    assert.equal(h.initiateCount, 2);
    assert.equal(h.mediaPuts(SESSION_B).length, 1, 'fresh session receives the chunk');
    assert.deepEqual(
      h.stateHistory,
      [{ sessionUrl: SESSION_A }, null, { sessionUrl: SESSION_B }],
      `HTTP ${expiredStatus}: old session cleared before the new one is persisted`
    );

    fs.rmSync(request.mediaFilePath, { force: true });
  }
});

test('expired session again after the single restart: reclaimable EXPLICIT_FAILURE, no third session', async () => {
  const request = baseRequest();
  const h = resumableHarness({
    initiates: [SESSION_A, SESSION_B],
    sessions: { [SESSION_A]: [rStatus(503), rStatus(404)], [SESSION_B]: [rStatus(503), rStatus(410)] }
  });

  const result = await h.adapter.publish(request, h.context);

  assert.equal(result.status, PUBLICATION_RESULT_STATUS.EXPLICIT_FAILURE);
  assert.equal(result.errorClass, 'upload_session_expired');
  assert.equal(h.initiateCount, 2, 'restart is bounded to one');
  assert.deepEqual(h.stateHistory, [{ sessionUrl: SESSION_A }, null, { sessionUrl: SESSION_B }, null]);

  fs.rmSync(request.mediaFilePath, { force: true });
});

/**
 * ---------------------------------------------------------------------
 * Audit fixes 1-4: restore-path reconciliation, bounded zero-progress 308,
 * any-5xx ambiguity, INITIATE_SESSION phase label.
 * ---------------------------------------------------------------------
 */

const restoreContext = (h) => ({ ...h.context, providerState: { sessionUrl: SESSION_A } });

test('restore: a persisted session whose status query is rejected (400/401/403) is AMBIGUOUS -- session retained, no new session, one status PUT, no media PUT, state never cleared', async () => {
  for (const rejection of [403, 401, 400]) {
    const request = baseRequest();
    const size = fs.statSync(request.mediaFilePath).size;
    const h = resumableHarness({ sessions: { [SESSION_A]: [rStatus(rejection)] } });

    const result = await h.adapter.publish(request, restoreContext(h));

    assert.equal(result.status, PUBLICATION_RESULT_STATUS.AMBIGUOUS, `HTTP ${rejection}`);
    assert.ok(!('errorClass' in result), `HTTP ${rejection}: no explicit-failure classification may leak`);
    assert.equal(result.reconciliationInfo.phase, 'UPLOAD_BODY', `HTTP ${rejection}`);
    assert.equal(result.reconciliationInfo.note, `upload_reconciliation_rejected_${rejection}`);
    assert.equal(result.reconciliationInfo.sessionUrl, SESSION_A, `HTTP ${rejection}: persisted session URL retained`);
    assert.ok(!('providerItemId' in result), `HTTP ${rejection}`);
    assert.equal(h.initiateCount, 0, `HTTP ${rejection}: no new resumable session`);
    assert.equal(h.statusPuts().length, 1, `HTTP ${rejection}: exactly one status PUT`);
    assert.equal(h.puts[0].range, `bytes */${size}`);
    assert.equal(h.mediaPuts().length, 0, `HTTP ${rejection}: no media byte sent`);
    assert.deepEqual(h.stateHistory, [], `HTTP ${rejection}: provider state neither cleared nor replaced`);

    fs.rmSync(request.mediaFilePath, { force: true });
  }
});

test('restore: any 5xx (including non-transient 501) on the status query is AMBIGUOUS, session retained', async () => {
  const request = baseRequest();
  const h = resumableHarness({ sessions: { [SESSION_A]: [rStatus(501)] } });

  const result = await h.adapter.publish(request, restoreContext(h));

  assert.equal(result.status, PUBLICATION_RESULT_STATUS.AMBIGUOUS);
  assert.ok(!('errorClass' in result));
  assert.equal(result.reconciliationInfo.phase, 'UPLOAD_BODY');
  assert.equal(result.reconciliationInfo.note, 'upload_status_server_error_501');
  assert.equal(result.reconciliationInfo.sessionUrl, SESSION_A);
  assert.equal(h.initiateCount, 0);
  assert.equal(h.mediaPuts().length, 0);
  assert.deepEqual(h.stateHistory, []);

  fs.rmSync(request.mediaFilePath, { force: true });
});

test('restore: preserved semantics -- 200 completed, 404/410 expired (one fresh session), 308 resumes from the server offset', async () => {
  // completed: SUCCESS with no new session and no media byte.
  {
    const request = baseRequest();
    const h = resumableHarness({ sessions: { [SESSION_A]: [rDone()] } });
    const result = await h.adapter.publish(request, restoreContext(h));
    assert.equal(result.status, PUBLICATION_RESULT_STATUS.SUCCESS);
    assert.equal(result.providerItemId, 'YTVIDEOID');
    assert.equal(h.initiateCount, 0);
    assert.equal(h.mediaPuts().length, 0);
    fs.rmSync(request.mediaFilePath, { force: true });
  }

  // expired: a fresh session is initiated, persisted, and receives the media.
  for (const expiredStatus of [404, 410]) {
    const request = baseRequest();
    const h = resumableHarness({
      initiates: [SESSION_B],
      sessions: { [SESSION_A]: [rStatus(expiredStatus)], [SESSION_B]: [rDone()] }
    });
    const result = await h.adapter.publish(request, restoreContext(h));
    assert.equal(result.status, PUBLICATION_RESULT_STATUS.SUCCESS, `HTTP ${expiredStatus}`);
    assert.equal(h.initiateCount, 1, `HTTP ${expiredStatus}`);
    assert.equal(h.mediaPuts(SESSION_A).length, 0, `HTTP ${expiredStatus}: nothing sent to the expired session`);
    assert.equal(h.mediaPuts(SESSION_B).length, 1, `HTTP ${expiredStatus}`);
    assert.deepEqual(h.stateHistory, [{ sessionUrl: SESSION_B }], `HTTP ${expiredStatus}`);
    fs.rmSync(request.mediaFilePath, { force: true });
  }

  // 308: resume from the server-reported offset without re-initiating.
  {
    const size = CHUNK * 2;
    const request = requestOfSize(size);
    const h = resumableHarness({ sessions: { [SESSION_A]: [r308(CHUNK), rDone()] } });
    const result = await h.adapter.publish(request, restoreContext(h));
    assert.equal(result.status, PUBLICATION_RESULT_STATUS.SUCCESS);
    assert.equal(h.initiateCount, 0);
    assert.deepEqual(h.mediaPuts().map((p) => p.range), [`bytes ${CHUNK}-${size - 1}/${size}`]);
    fs.rmSync(request.mediaFilePath, { force: true });
  }
});

test('bounded: repeated zero-progress 308 responses (no Range, same offset, regressing/oscillating offset) stop at the per-chunk attempt budget -> AMBIGUOUS, session retained', async () => {
  const cases = [
    // No Range header => offset 0 => no progress from offset 0.
    { label: 'no Range header', size: null, queue: [r308(0), r308(0), r308(0), r308(0), r308(0)], mediaPuts: 3 },
    // Advance once, then the same offset is reported repeatedly.
    { label: 'same offset repeated', size: CHUNK * 2, queue: [r308(CHUNK), r308(CHUNK), r308(CHUNK), r308(CHUNK), r308(CHUNK)], mediaPuts: 4 },
    // Advance, then the server oscillates between the advanced and a regressed offset:
    // only progress beyond the high-water mark may reset the budget.
    { label: 'oscillating offset', size: CHUNK * 2, queue: [r308(CHUNK), r308(0), r308(CHUNK), r308(0), r308(CHUNK), r308(0)], mediaPuts: 4 }
  ];

  for (const c of cases) {
    const request = c.size ? requestOfSize(c.size) : baseRequest();
    const h = resumableHarness({ sessions: { [SESSION_A]: c.queue } });

    const result = await h.adapter.publish(request, h.context);

    assert.equal(result.status, PUBLICATION_RESULT_STATUS.AMBIGUOUS, c.label);
    assert.ok(!('errorClass' in result), c.label);
    assert.equal(result.reconciliationInfo.phase, 'UPLOAD_BODY', c.label);
    assert.equal(result.reconciliationInfo.note, 'upload_body_no_progress_308', `${c.label}: terminated by the bound, not by the mock running dry`);
    assert.equal(result.reconciliationInfo.sessionUrl, SESSION_A, c.label);
    assert.equal(h.mediaPuts().length, c.mediaPuts, `${c.label}: bounded number of media PUTs`);
    assert.equal(h.statusPuts().length, 0, `${c.label}: a 308 is itself the server report; no extra status PUT`);
    assert.deepEqual(h.stateHistory, [{ sessionUrl: SESSION_A }], `${c.label}: session state retained`);

    fs.rmSync(request.mediaFilePath, { force: true });
  }
});

test('ambiguous: ANY 5xx media PUT (501/507/520/599, not just 500/502/503/504) is AMBIGUOUS -- sent once, never EXPLICIT_FAILURE, session retained', async () => {
  for (const serverError of [501, 507, 520, 599]) {
    const request = baseRequest();
    const h = resumableHarness({ sessions: { [SESSION_A]: [rStatus(serverError)] } });

    const result = await h.adapter.publish(request, h.context);

    assert.equal(result.status, PUBLICATION_RESULT_STATUS.AMBIGUOUS, `HTTP ${serverError}`);
    assert.notEqual(result.status, PUBLICATION_RESULT_STATUS.EXPLICIT_FAILURE, `HTTP ${serverError}`);
    assert.ok(!('errorClass' in result), `HTTP ${serverError}`);
    assert.ok(!('providerItemId' in result), `HTTP ${serverError}: no fabricated provider item id`);
    assert.equal(result.reconciliationInfo.phase, 'UPLOAD_BODY', `HTTP ${serverError}`);
    assert.equal(result.reconciliationInfo.note, `upload_body_server_error_${serverError}`);
    assert.equal(result.reconciliationInfo.sessionUrl, SESSION_A, `HTTP ${serverError}`);
    assert.equal(h.mediaPuts().length, 1, `HTTP ${serverError}: chunk sent exactly once`);
    assert.equal(h.statusPuts().length, 0, `HTTP ${serverError}`);
    assert.deepEqual(h.stateHistory, [{ sessionUrl: SESSION_A }], `HTTP ${serverError}: state retained`);

    fs.rmSync(request.mediaFilePath, { force: true });
  }
});

test('ambiguous: final status query after all bytes are committed, if rejected (403), is AMBIGUOUS not EXPLICIT_FAILURE', async () => {
  const request = baseRequest();
  const size = fs.statSync(request.mediaFilePath).size;
  // The server reports every byte committed (308 with a full Range); the follow-up status PUT is rejected.
  const h = resumableHarness({ sessions: { [SESSION_A]: [r308(size), rStatus(403)] } });

  const result = await h.adapter.publish(request, h.context);

  assert.equal(result.status, PUBLICATION_RESULT_STATUS.AMBIGUOUS);
  assert.ok(!('errorClass' in result));
  assert.equal(result.reconciliationInfo.note, 'upload_reconciliation_rejected_403');
  assert.equal(result.reconciliationInfo.sessionUrl, SESSION_A);
  assert.equal(h.mediaPuts().length, 1);
  assert.equal(h.statusPuts().length, 1);
  assert.deepEqual(h.stateHistory, [{ sessionUrl: SESSION_A }]);

  fs.rmSync(request.mediaFilePath, { force: true });
});

test('INITIATE_SESSION phase: initiate failures that are not explicit rejections keep the baseline phase label and carry no session URL', async () => {
  const cases = [
    { label: 'transient 503 exhausted', responses: [rStatus(503), rStatus(503), rStatus(503)], note: 'initiate_session_server_error_503', initiates: 3, sleeps: [1000, 2000] },
    { label: 'non-transient 501', responses: [rStatus(501)], note: 'initiate_upload_server_error_501', initiates: 1, sleeps: [] },
    { label: 'thrown network error', responses: [() => { throw new Error('socket hang up'); }], note: 'socket hang up', initiates: 1, sleeps: [] }
  ];

  for (const c of cases) {
    const request = baseRequest();
    const h = resumableHarness({ initiateResponses: [...c.responses] });

    const result = await h.adapter.publish(request, h.context);

    assert.equal(result.status, PUBLICATION_RESULT_STATUS.AMBIGUOUS, c.label);
    assert.equal(result.reconciliationInfo.phase, 'INITIATE_SESSION', c.label);
    assert.equal(result.reconciliationInfo.note, c.note, c.label);
    assert.ok(!('sessionUrl' in result.reconciliationInfo), `${c.label}: no session existed`);
    assert.equal(h.initiateCount, c.initiates, c.label);
    assert.deepEqual(h.sleeps, c.sleeps, c.label);
    assert.equal(h.puts.length, 0, `${c.label}: no PUT of any kind`);
    assert.deepEqual(h.stateHistory, [], `${c.label}: nothing persisted`);

    fs.rmSync(request.mediaFilePath, { force: true });
  }
});

test('308 that ADVANCES the offset: next media PUT starts exactly at the server offset and the per-chunk attempt budget resets', async () => {
  const size = CHUNK * 3;
  const request = requestOfSize(size);
  // Two no-progress 308s at offset 0 (budget 3 -> one attempt left), then an advance to CHUNK
  // (budget resets), one no-progress 308 at CHUNK, an advance to 2*CHUNK (resets again), then done.
  // Without the reset the third attempt at CHUNK / the advance bookkeeping would exhaust the budget.
  const h = resumableHarness({
    sessions: { [SESSION_A]: [r308(0), r308(0), r308(CHUNK), r308(CHUNK), r308(CHUNK * 2), rDone()] }
  });

  const result = await h.adapter.publish(request, h.context);

  assert.equal(result.status, PUBLICATION_RESULT_STATUS.SUCCESS);
  assert.deepEqual(
    h.mediaPuts().map((p) => p.range),
    [
      `bytes 0-${CHUNK - 1}/${size}`,
      `bytes 0-${CHUNK - 1}/${size}`,
      `bytes 0-${CHUNK - 1}/${size}`,
      `bytes ${CHUNK}-${CHUNK * 2 - 1}/${size}`,
      `bytes ${CHUNK}-${CHUNK * 2 - 1}/${size}`,
      `bytes ${CHUNK * 2}-${size - 1}/${size}`
    ],
    'each PUT begins exactly at the server-reported offset; the budget restarted after each advance'
  );
  assert.equal(h.statusPuts().length, 0);
  assert.deepEqual(h.sleeps, [], 'a 308 is not a transient failure: no backoff');

  fs.rmSync(request.mediaFilePath, { force: true });
});

test('non-standard 5xx (501/507/520) is AMBIGUOUS at every stage: initiate, media PUT, reconciliation, final status, restore -- never EXPLICIT_FAILURE', async () => {
  for (const serverError of [501, 507, 520]) {
    const tag = `HTTP ${serverError}`;

    // initiate: non-transient, so one attempt, no session, nothing persisted.
    {
      const request = baseRequest();
      const h = resumableHarness({ initiateResponses: [rStatus(serverError)] });
      const result = await h.adapter.publish(request, h.context);
      assert.equal(result.status, PUBLICATION_RESULT_STATUS.AMBIGUOUS, `${tag} initiate`);
      assert.ok(!('errorClass' in result), `${tag} initiate`);
      assert.equal(result.reconciliationInfo.phase, 'INITIATE_SESSION', `${tag} initiate`);
      assert.equal(result.reconciliationInfo.note, `initiate_upload_server_error_${serverError}`);
      assert.equal(h.initiateCount, 1, `${tag} initiate: not blindly retried`);
      assert.equal(h.puts.length, 0, `${tag} initiate`);
      fs.rmSync(request.mediaFilePath, { force: true });
    }

    // reconciliation after a transient media 503: the status PUT itself answers with the odd 5xx.
    {
      const request = baseRequest();
      const h = resumableHarness({ sessions: { [SESSION_A]: [rStatus(503), rStatus(serverError)] } });
      const result = await h.adapter.publish(request, h.context);
      assert.equal(result.status, PUBLICATION_RESULT_STATUS.AMBIGUOUS, `${tag} reconciliation`);
      assert.ok(!('errorClass' in result), `${tag} reconciliation`);
      assert.equal(result.reconciliationInfo.phase, 'UPLOAD_BODY', `${tag} reconciliation`);
      assert.equal(result.reconciliationInfo.note, `upload_status_server_error_${serverError}`);
      assert.equal(result.reconciliationInfo.sessionUrl, SESSION_A, `${tag} reconciliation`);
      assert.equal(h.mediaPuts().length, 1, `${tag} reconciliation: no resend`);
      assert.equal(h.statusPuts().length, 1, `${tag} reconciliation`);
      assert.deepEqual(h.stateHistory, [{ sessionUrl: SESSION_A }], `${tag} reconciliation: state retained`);
      fs.rmSync(request.mediaFilePath, { force: true });
    }

    // final status verification after every byte is committed.
    {
      const request = baseRequest();
      const size = fs.statSync(request.mediaFilePath).size;
      const h = resumableHarness({ sessions: { [SESSION_A]: [r308(size), rStatus(serverError)] } });
      const result = await h.adapter.publish(request, h.context);
      assert.equal(result.status, PUBLICATION_RESULT_STATUS.AMBIGUOUS, `${tag} final status`);
      assert.ok(!('errorClass' in result), `${tag} final status`);
      assert.equal(result.reconciliationInfo.note, `upload_status_server_error_${serverError}`);
      assert.equal(result.reconciliationInfo.sessionUrl, SESSION_A, `${tag} final status`);
      assert.deepEqual(h.stateHistory, [{ sessionUrl: SESSION_A }], `${tag} final status: state retained`);
      fs.rmSync(request.mediaFilePath, { force: true });
    }

    // restore of a persisted session.
    {
      const request = baseRequest();
      const h = resumableHarness({ sessions: { [SESSION_A]: [rStatus(serverError)] } });
      const result = await h.adapter.publish(request, restoreContext(h));
      assert.equal(result.status, PUBLICATION_RESULT_STATUS.AMBIGUOUS, `${tag} restore`);
      assert.ok(!('errorClass' in result), `${tag} restore`);
      assert.equal(result.reconciliationInfo.sessionUrl, SESSION_A, `${tag} restore`);
      assert.equal(h.initiateCount, 0, `${tag} restore`);
      assert.equal(h.mediaPuts().length, 0, `${tag} restore`);
      assert.deepEqual(h.stateHistory, [], `${tag} restore: state untouched`);
      fs.rmSync(request.mediaFilePath, { force: true });
    }
  }
});

test('durability ordering: the session is handed to saveProviderState BEFORE the first media byte is sent', async () => {
  const request = baseRequest();
  const h = resumableHarness({ sessions: { [SESSION_A]: [rDone()] } });
  const putsAtSave = [];
  const context = {
    providerState: null,
    saveProviderState: (state) => { putsAtSave.push({ state, putsSoFar: h.puts.length }); }
  };

  const result = await h.adapter.publish(request, context);

  assert.equal(result.status, PUBLICATION_RESULT_STATUS.SUCCESS);
  assert.deepEqual(putsAtSave, [{ state: { sessionUrl: SESSION_A }, putsSoFar: 0 }]);

  fs.rmSync(request.mediaFilePath, { force: true });
});

test('durability failure: if persisting the new session fails, NO media byte is sent and the result is AMBIGUOUS', async () => {
  const request = baseRequest();
  const h = resumableHarness({ sessions: { [SESSION_A]: [rDone()] } });
  const context = {
    providerState: null,
    saveProviderState: () => { throw new Error('provider_state_not_persisted'); }
  };

  const result = await h.adapter.publish(request, context);

  assert.equal(result.status, PUBLICATION_RESULT_STATUS.AMBIGUOUS);
  assert.ok(!('errorClass' in result));
  assert.equal(result.reconciliationInfo.note, 'provider_state_not_persisted');
  assert.equal(h.puts.length, 0, 'no media byte and no status PUT reached the session');

  fs.rmSync(request.mediaFilePath, { force: true });
});
