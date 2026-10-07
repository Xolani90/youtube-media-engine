import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { PixabayAssetSourceProvider } from '../../src/providers/asset/PixabayAssetSourceProvider.js';
import { ASSET_FAILURE_KIND, assetAcquisitionFailure, isAssetAcquisitionFailure, redactSecrets } from '../../src/providers/asset/AssetSourceProvider.js';

const SECRET = 'SECRET-PIXABAY-KEY-9f8e7d6c';
const QUERY = 'battery factory construction, industrial plant, workers';
const HIT = { id: 1, pageURL: 'https://pixabay.com/photos/x-1/', largeImageURL: 'https://pixabay.com/get/x_1280.jpg', user: 'u' };

const res = (status, body, text) => ({ ok: status >= 200 && status < 300, status, json: async () => body, text: async () => text ?? String(body) });
const bin = (status, bytes) => ({ ok: status >= 200 && status < 300, status, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) });
const isSearch = (url) => url.startsWith('https://pixabay.com/api/');
const dir = () => path.join(os.tmpdir(), `pixabay-fail-${Date.now()}-${Math.random()}`);

function make(fetchImpl, apiKey, downloadDir = dir()) {
  return new PixabayAssetSourceProvider({ fetchImpl, apiKeyProvider: () => apiKey, downloadDir });
}
async function run(fetchImpl, ...keyArg) {
  const apiKey = keyArg.length ? keyArg[0] : SECRET;
  return make(fetchImpl, apiKey).acquireVisualAsset({ query: QUERY, assetTypes: ['image'] });
}

test('HTTP 400 is BAD_REQUEST (not EMPTY_RESULT), non-retryable, carries status/query/provider', async () => {
  const r = await run(async () => res(400, '[ERROR 400] "q" is too long'));
  assert.equal(r.failure.kind, ASSET_FAILURE_KIND.BAD_REQUEST);
  assert.notEqual(r.failure.kind, ASSET_FAILURE_KIND.EMPTY_RESULT);
  assert.equal(r.failure.status, 400);
  assert.equal(r.failure.provider, 'pixabay');
  assert.equal(r.failure.query, QUERY);
  assert.equal(r.failure.retryable, false);
  assert.match(r.failure.providerMessage, /too long/);
});

for (const status of [401, 403]) {
  test(`HTTP ${status} is AUTH_FAILURE (not EMPTY_RESULT), non-retryable`, async () => {
    const r = await run(async () => res(status, 'denied'));
    assert.equal(r.failure.kind, ASSET_FAILURE_KIND.AUTH_FAILURE);
    assert.equal(r.failure.status, status);
    assert.equal(r.failure.retryable, false);
  });
}

test('missing API key is MISSING_API_KEY, non-retryable, and nothing is sent', async () => {
  let calls = 0;
  for (const key of [undefined, '', null]) {
    const r = await run(async () => { calls++; return res(200, { hits: [] }); }, key);
    assert.equal(r.failure.kind, ASSET_FAILURE_KIND.MISSING_API_KEY);
    assert.equal(r.failure.retryable, false);
  }
  assert.equal(calls, 0);
});

test('HTTP 429 is RATE_LIMIT and retryable', async () => {
  const r = await run(async () => res(429, 'API rate limit exceeded'));
  assert.equal(r.failure.kind, ASSET_FAILURE_KIND.RATE_LIMIT);
  assert.equal(r.failure.status, 429);
  assert.equal(r.failure.retryable, true);
});

for (const status of [500, 502, 503]) {
  test(`HTTP ${status} is PROVIDER_SERVER_FAILURE and retryable`, async () => {
    const r = await run(async () => res(status, 'oops'));
    assert.equal(r.failure.kind, ASSET_FAILURE_KIND.PROVIDER_SERVER_FAILURE);
    assert.equal(r.failure.status, status);
    assert.equal(r.failure.retryable, true);
  });
}

test('a thrown transport error is NETWORK_FAILURE and retryable', async () => {
  const r = await run(async () => { throw new TypeError('fetch failed'); });
  assert.equal(r.failure.kind, ASSET_FAILURE_KIND.NETWORK_FAILURE);
  assert.equal(r.failure.status, null);
  assert.equal(r.failure.retryable, true);
  assert.match(r.failure.cause, /fetch failed/);
});

test('successful HTTP with unusable body is MALFORMED_RESPONSE (invalid JSON, no hits array, null body), non-retryable', async () => {
  const badJson = { ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected token'); } };
  for (const response of [badJson, res(200, { total: 0 }), res(200, null), res(200, { hits: 'nope' })]) {
    const r = await run(async () => response);
    assert.equal(r.failure.kind, ASSET_FAILURE_KIND.MALFORMED_RESPONSE);
    assert.equal(r.failure.status, 200);
    assert.equal(r.failure.retryable, false);
  }
});

test('successful HTTP with zero hits stays EMPTY_RESULT (retryable) with hitCount 0', async () => {
  const r = await run(async () => res(200, { total: 0, totalHits: 0, hits: [] }));
  assert.equal(r.failure.kind, ASSET_FAILURE_KIND.EMPTY_RESULT);
  assert.equal(r.failure.status, 200);
  assert.equal(r.failure.hitCount, 0);
  assert.equal(r.failure.retryable, true);
});

test('search OK but download fails is DOWNLOAD_FAILURE (not EMPTY_RESULT), with hitCount and no leftover file', async () => {
  const d = dir();
  try {
    const r = await make(async (url) => (isSearch(url) ? res(200, { hits: [HIT, HIT, HIT] }) : res(503, '')), SECRET, d)
      .acquireVisualAsset({ query: QUERY, assetTypes: ['image'] });
    assert.equal(r.failure.kind, ASSET_FAILURE_KIND.DOWNLOAD_FAILURE);
    assert.equal(r.failure.hitCount, 3);
    assert.equal(r.failure.status, 503);
    assert.equal(r.failure.retryable, true);
    if (fs.existsSync(d)) assert.deepEqual(fs.readdirSync(d), []);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('a download that throws is DOWNLOAD_FAILURE', async () => {
  const r = await make(async (url) => { if (isSearch(url)) return res(200, { hits: [HIT] }); throw new Error('socket hang up'); }, SECRET)
    .acquireVisualAsset({ query: QUERY, assetTypes: ['image'] });
  assert.equal(r.failure.kind, ASSET_FAILURE_KIND.DOWNLOAD_FAILURE);
  assert.match(r.failure.cause, /socket hang up/);
});

test('a successful search and download still returns a normal UNVERIFIED asset (no failure key)', async () => {
  const d = dir();
  try {
    const r = await make(async (url) => (isSearch(url) ? res(200, { hits: [HIT] }) : bin(200, Buffer.from('jpegbytes'))), SECRET, d)
      .acquireVisualAsset({ query: QUERY, assetTypes: ['image'] });
    assert.equal(r.failure, undefined);
    assert.equal(r.assetType, 'image');
    assert.equal(r.verificationStatus, 'UNVERIFIED');
    assert.ok(fs.existsSync(r.location));
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('the API key never appears in any failure, including when a transport error or body echoes it', async () => {
  const echoes = [
    async (url) => { throw new Error(`connect ECONNREFUSED ${url}`); },
    async () => res(400, `bad request key=${SECRET} and again ${SECRET}`),
    async () => res(401, `invalid key ${SECRET}`),
    async () => res(429, `limit for ${SECRET}`),
    async () => res(500, `server saw ${SECRET}`),
    async (url) => { if (isSearch(url)) return res(200, { hits: [HIT] }); throw new Error(`download ${url} ${SECRET}`); }
  ];
  for (const f of echoes) {
    const r = await run(f);
    assert.ok(r.failure, 'expected a failure');
    assert.equal(JSON.stringify(r).includes(SECRET), false, JSON.stringify(r));
  }
});

test('the API key never appears in thrown errors (empty-query validation) or console output', async () => {
  const logged = [];
  const orig = { log: console.log, error: console.error, warn: console.warn };
  console.log = console.error = console.warn = (...a) => logged.push(a.join(' '));
  try {
    await assert.rejects(() => make(async () => res(200, { hits: [] }), SECRET).acquireVisualAsset({ query: '  ', assetTypes: ['image'] }), (e) => !e.message.includes(SECRET));
    await run(async () => res(400, `key=${SECRET}`));
  } finally { Object.assign(console, orig); }
  assert.equal(logged.join('\n').includes(SECRET), false);
});

test('helpers: redactSecrets strips secrets and key= params; assetAcquisitionFailure rejects unknown kinds; type guard', () => {
  assert.equal(redactSecrets(`https://x/?q=a&key=${SECRET}&b=1`, [SECRET]).includes(SECRET), false);
  assert.throws(() => assetAcquisitionFailure({ kind: 'NOPE', provider: 'p' }));
  assert.equal(isAssetAcquisitionFailure(assetAcquisitionFailure({ kind: 'EMPTY_RESULT', provider: 'p' })), true);
  assert.equal(isAssetAcquisitionFailure(null), false);
  assert.equal(isAssetAcquisitionFailure({ assetType: 'image' }), false);
});
