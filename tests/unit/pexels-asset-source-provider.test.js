import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { PexelsAssetSourceProvider, boundPexelsQuery, PEXELS_MAX_QUERY_LENGTH } from '../../src/providers/asset/PexelsAssetSourceProvider.js';
import { ASSET_FAILURE_KIND, isAssetAcquisitionFailure } from '../../src/providers/asset/AssetSourceProvider.js';
import { validateAcquiredAsset } from '../../src/asset-provisioning/validate.js';

const KEY = 'pexels-test-key-NOT-REAL-0123456789';

function jsonResponse(status, body, headers = {}) {
  return { ok: status >= 200 && status < 300, status, headers, json: async () => body, text: async () => JSON.stringify(body) };
}
function binaryResponse(status, bytes) {
  return { ok: status >= 200 && status < 300, status, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) };
}
function freshDir() {
  return path.join(os.tmpdir(), `pexels-provider-test-${Date.now()}-${Math.random()}`);
}

const IMG_BYTES = Buffer.from('fake-jpeg-bytes-for-test');
const VID_BYTES = Buffer.from('fake-mp4-bytes-for-test');

function photo(over = {}) {
  return {
    id: 3573351,
    width: 3066,
    height: 3968,
    url: 'https://www.pexels.com/photo/trees-during-day-3573351/',
    photographer: 'Lukas Rodriguez',
    photographer_url: 'https://www.pexels.com/@lukas-rodriguez-1845331',
    photographer_id: 1845331,
    src: {
      original: 'https://images.pexels.com/photos/3573351/pexels-photo-3573351.png',
      large2x: 'https://images.pexels.com/photos/3573351/pexels-photo-3573351.png?auto=compress&cs=tinysrgb&dpr=2&h=650&w=940',
      large: 'https://images.pexels.com/photos/3573351/pexels-photo-3573351.png?auto=compress&cs=tinysrgb&h=650&w=940'
    },
    ...over
  };
}

function video(over = {}) {
  return {
    id: 1448735,
    width: 4096,
    height: 2160,
    url: 'https://www.pexels.com/video/video-of-forest-1448735/',
    duration: 32,
    user: { id: 574687, name: 'Ruvim Miksanskiy', url: 'https://www.pexels.com/@digitech' },
    video_files: [
      { id: 58649, quality: 'sd', file_type: 'video/mp4', width: 640, height: 338, link: 'https://player.vimeo.com/external/291648067.sd.mp4?profile_id=164' },
      { id: 58650, quality: 'hd', file_type: 'video/mp4', width: 2048, height: 1080, link: 'https://player.vimeo.com/external/291648067.hd.mp4?profile_id=175' },
      { id: 58651, quality: 'hd', file_type: 'video/mp4', width: 4096, height: 2160, link: 'https://player.vimeo.com/external/291648067.hd.mp4?profile_id=172' },
      { id: 58652, quality: 'hd', file_type: 'video/mp4', width: 1366, height: 720, link: 'https://player.vimeo.com/external/291648067.hd.mp4?profile_id=174' },
      { id: 58655, quality: 'hls', file_type: 'video/mp4', width: null, height: null, link: 'https://player.vimeo.com/external/291648067.m3u8?s=x' }
    ],
    ...over
  };
}

/** Serves a search body for the API host and bytes for everything else, recording every call. */
function makeFetch({ search, download = () => binaryResponse(200, IMG_BYTES) }) {
  const calls = [];
  const impl = async (url, init = {}) => {
    const u = String(url);
    calls.push({ url: u, init });
    if (u.startsWith('https://api.pexels.com/')) return typeof search === 'function' ? search(u, init) : search;
    return download(u, init);
  };
  return { impl, calls };
}

function provider(fetchImpl, over = {}) {
  const downloadDir = freshDir();
  const p = new PexelsAssetSourceProvider({ fetchImpl, apiKeyProvider: () => KEY, downloadDir, ...over });
  return { p, downloadDir, cleanup: () => fs.rmSync(downloadDir, { recursive: true, force: true }) };
}

// ---- A. Valid response and mapping -------------------------------------

test('id is "pexels" and healthCheck reflects key presence without a network call', async () => {
  const f = makeFetch({ search: jsonResponse(200, {}) });
  assert.equal(new PexelsAssetSourceProvider({ fetchImpl: f.impl, apiKeyProvider: () => KEY }).id, 'pexels');
  assert.equal(await new PexelsAssetSourceProvider({ fetchImpl: f.impl, apiKeyProvider: () => KEY }).healthCheck(), true);
  assert.equal(await new PexelsAssetSourceProvider({ fetchImpl: f.impl, apiKeyProvider: () => undefined }).healthCheck(), false);
  assert.equal(await new PexelsAssetSourceProvider({ fetchImpl: f.impl, apiKeyProvider: () => '   ' }).healthCheck(), false);
  assert.equal(f.calls.length, 0);
});

test('A: valid photo response maps to a complete, UNVERIFIED, local-path asset', async () => {
  const f = makeFetch({ search: jsonResponse(200, { total_results: 1, photos: [photo()] }) });
  const { p, downloadDir, cleanup } = provider(f.impl);
  try {
    const r = await p.acquireVisualAsset({ query: 'quiet forest path', assetTypes: ['image'] });
    assert.equal(isAssetAcquisitionFailure(r), false);
    assert.equal(r.assetType, 'image');
    assert.ok(r.location.startsWith(downloadDir));
    assert.ok(r.location.endsWith('.png'), 'extension follows the downloaded URL, not a guess');
    assert.ok(!/^[a-z]+:\/\//i.test(r.location), 'never a hotlinked URL');
    assert.equal(r.checksum, crypto.createHash('sha256').update(IMG_BYTES).digest('hex'));
    assert.equal(r.origin, 'https://www.pexels.com/photo/trees-during-day-3573351/');
    assert.equal(r.license, 'Pexels License');
    assert.equal(r.verificationStatus, 'UNVERIFIED');
    assert.equal(r.attributionRequired, true);
    assert.match(r.attributionText, /^Photo by Lukas Rodriguez on Pexels \(https:\/\/www\.pexels\.com\/photo\/trees-during-day-3573351\/\)/);
    assert.match(r.attributionText, /provided by Pexels \(https:\/\/www\.pexels\.com\)/);
    assert.match(r.provenanceNotes, /^provider=pexels; pexelsId=3573351; assetType=image; sourceUrl=https:\/\/www\.pexels\.com\/photo\//);
    assert.match(r.provenanceNotes, /creator=Lukas Rodriguez/);
    assert.match(r.provenanceNotes, /creatorUrl=https:\/\/www\.pexels\.com\/@lukas-rodriguez-1845331/);
    assert.match(r.provenanceNotes, /license=Pexels License/);
    assert.match(r.provenanceNotes, /provider-level/);
    assert.match(r.usageRestrictions, /may NOT be sold or distributed as-is/i);
    assert.deepEqual(validateAcquiredAsset(r), { valid: true });
    assert.equal(fs.readFileSync(r.location).equals(IMG_BYTES), true);
  } finally { cleanup(); }
});

test('A: photo request uses the documented endpoint, a raw Authorization header, and no key in the URL', async () => {
  const f = makeFetch({ search: jsonResponse(200, { photos: [photo()] }) });
  const { p, cleanup } = provider(f.impl);
  try {
    await p.acquireVisualAsset({ query: 'quiet forest path', assetTypes: ['image'] });
    const search = f.calls[0];
    assert.ok(search.url.startsWith('https://api.pexels.com/v1/search?'));
    const params = new URL(search.url).searchParams;
    assert.equal(params.get('query'), 'quiet forest path');
    assert.equal(params.get('orientation'), 'landscape');
    assert.equal(params.get('per_page'), '5');
    assert.equal(search.init.headers.Authorization, KEY, 'raw key, no Bearer scheme');
    assert.ok(!search.url.includes(KEY), 'key never in the URL');
    assert.ok(search.init.signal, 'search request carries a timeout signal');
  } finally { cleanup(); }
});

test('A: the API key is never sent to the download host', async () => {
  const f = makeFetch({ search: jsonResponse(200, { photos: [photo()] }) });
  const { p, cleanup } = provider(f.impl);
  try {
    await p.acquireVisualAsset({ query: 'forest', assetTypes: ['image'] });
    const dl = f.calls[1];
    assert.ok(dl.url.startsWith('https://images.pexels.com/'));
    assert.equal(dl.init.headers, undefined, 'no headers (and so no Authorization) on the download');
    assert.ok(!JSON.stringify(dl.init).includes(KEY));
  } finally { cleanup(); }
});

test('A: valid video response selects the smallest mp4 in the 1280-1920 band, skipping HLS and oversized files', async () => {
  const f = makeFetch({
    search: jsonResponse(200, { videos: [video()] }),
    download: () => binaryResponse(200, VID_BYTES)
  });
  const { p, cleanup } = provider(f.impl);
  try {
    const r = await p.acquireVisualAsset({ query: 'forest', assetTypes: ['video_clip'] });
    assert.equal(r.assetType, 'video_clip');
    assert.ok(r.location.endsWith('.mp4'));
    assert.ok(f.calls[0].url.startsWith('https://api.pexels.com/v1/videos/search?'), 'new /v1/videos path, not the deprecated /videos path');
    assert.equal(f.calls[1].url, 'https://player.vimeo.com/external/291648067.hd.mp4?profile_id=174', '1366px file: smallest in band');
    assert.equal(r.origin, 'https://www.pexels.com/video/video-of-forest-1448735/');
    assert.match(r.attributionText, /^Video by Ruvim Miksanskiy on Pexels/);
    assert.match(r.provenanceNotes, /^provider=pexels; pexelsId=1448735; assetType=video_clip;/);
    assert.deepEqual(validateAcquiredAsset(r), { valid: true });
  } finally { cleanup(); }
});

test('A: video with only sub-1280 mp4 files picks the widest of them; HLS-only is unusable', async () => {
  const small = video({ video_files: [
    { id: 1, file_type: 'video/mp4', width: 640, height: 360, link: 'https://player.vimeo.com/external/1.sd.mp4' },
    { id: 2, file_type: 'video/mp4', width: 960, height: 540, link: 'https://player.vimeo.com/external/2.sd.mp4' }
  ] });
  const f = makeFetch({ search: jsonResponse(200, { videos: [small] }), download: () => binaryResponse(200, VID_BYTES) });
  const a = provider(f.impl);
  try {
    await a.p.acquireVisualAsset({ query: 'x', assetTypes: ['video_clip'] });
    assert.equal(f.calls[1].url, 'https://player.vimeo.com/external/2.sd.mp4');
  } finally { a.cleanup(); }

  const hlsOnly = video({ video_files: [{ id: 9, file_type: 'video/mp4', width: null, height: null, link: 'https://player.vimeo.com/external/9.m3u8?s=x' }] });
  const f2 = makeFetch({ search: jsonResponse(200, { videos: [hlsOnly] }) });
  const b = provider(f2.impl);
  try {
    const r = await b.p.acquireVisualAsset({ query: 'x', assetTypes: ['video_clip'] });
    assert.equal(r.failure.kind, ASSET_FAILURE_KIND.MALFORMED_RESPONSE);
    assert.equal(f2.calls.length, 1, 'nothing downloaded');
  } finally { b.cleanup(); }
});

test('A: first well-formed hit is used when earlier hits are unusable', async () => {
  const bad = photo({ id: 1, photographer: '' });
  const good = photo({ id: 2, url: 'https://www.pexels.com/photo/second-2/' });
  const f = makeFetch({ search: jsonResponse(200, { photos: [bad, null, good] }) });
  const { p, cleanup } = provider(f.impl);
  try {
    const r = await p.acquireVisualAsset({ query: 'x', assetTypes: ['image'] });
    assert.match(r.provenanceNotes, /pexelsId=2;/);
  } finally { cleanup(); }
});

test('assetTypes defaults to image first; video_clip honoured; unsupported types fail without a request', async () => {
  const f = makeFetch({ search: jsonResponse(200, { photos: [photo()] }) });
  const a = provider(f.impl);
  try {
    const r = await a.p.acquireVisualAsset({ query: 'x' });
    assert.equal(r.assetType, 'image');
  } finally { a.cleanup(); }
  const f2 = makeFetch({ search: jsonResponse(200, {}) });
  const b = provider(f2.impl);
  const r = await b.p.acquireVisualAsset({ query: 'x', assetTypes: ['audio'] });
  assert.equal(r.failure.kind, ASSET_FAILURE_KIND.UNSUPPORTED_ASSET_TYPE);
  assert.equal(f2.calls.length, 0);
});

test('an empty/non-string query throws (programmer error), like the Pixabay provider', async () => {
  const f = makeFetch({ search: jsonResponse(200, {}) });
  const { p } = provider(f.impl);
  await assert.rejects(() => p.acquireVisualAsset({ query: '   ' }), /non-empty query/);
  await assert.rejects(() => p.acquireVisualAsset({}), /non-empty query/);
  assert.equal(f.calls.length, 0);
});

test('long queries are bounded at a word boundary and collapsed', () => {
  assert.equal(boundPexelsQuery('  a   b \n c '), 'a b c');
  const long = ('word '.repeat(40)).trim();
  const out = boundPexelsQuery(long);
  assert.ok(out.length <= PEXELS_MAX_QUERY_LENGTH);
  assert.ok(!out.endsWith(' '));
  assert.equal(boundPexelsQuery('x'.repeat(150)).length, PEXELS_MAX_QUERY_LENGTH);
});

// ---- B. Empty results --------------------------------------------------

test('B: zero photos -> EMPTY_RESULT (provider answered, nothing found), retryable, nothing downloaded', async () => {
  const f = makeFetch({ search: jsonResponse(200, { total_results: 0, photos: [] }) });
  const { p, cleanup } = provider(f.impl);
  try {
    const r = await p.acquireVisualAsset({ query: 'zzzz', assetTypes: ['image'] });
    assert.equal(r.failure.kind, ASSET_FAILURE_KIND.EMPTY_RESULT);
    assert.equal(r.failure.hitCount, 0);
    assert.equal(r.failure.retryable, true);
    assert.equal(f.calls.length, 1);
  } finally { cleanup(); }
});

test('B: zero videos -> EMPTY_RESULT', async () => {
  const f = makeFetch({ search: jsonResponse(200, { videos: [] }) });
  const { p, cleanup } = provider(f.impl);
  try {
    const r = await p.acquireVisualAsset({ query: 'zzzz', assetTypes: ['video_clip'] });
    assert.equal(r.failure.kind, ASSET_FAILURE_KIND.EMPTY_RESULT);
  } finally { cleanup(); }
});

// ---- C. Malformed responses -------------------------------------------

test('C: non-JSON, wrong-shape and unusable-hit bodies are MALFORMED_RESPONSE, never success or EMPTY', async () => {
  const cases = [
    ['not json', { ok: true, status: 200, json: async () => { throw new SyntaxError('bad'); } }],
    ['null body', jsonResponse(200, null)],
    ['array body', jsonResponse(200, [])],
    ['no photos array', jsonResponse(200, { total_results: 3 })],
    ['photos not array', jsonResponse(200, { photos: 'x' })],
    ['videos array for an image request', jsonResponse(200, { videos: [video()] })],
    ['hit missing id', jsonResponse(200, { photos: [photo({ id: undefined })] })],
    ['hit with string id', jsonResponse(200, { photos: [photo({ id: '12' })] })],
    ['hit with non-pexels page url', jsonResponse(200, { photos: [photo({ url: 'https://evil.example/photo/1' })] })],
    ['hit missing creator', jsonResponse(200, { photos: [photo({ photographer: '  ' })] })],
    ['hit with no src', jsonResponse(200, { photos: [photo({ src: undefined })] })],
    ['download url on a foreign host', jsonResponse(200, { photos: [photo({ src: { large2x: 'https://evil.example/x.jpg' } })] })],
    ['download url over http', jsonResponse(200, { photos: [photo({ src: { large2x: 'http://images.pexels.com/x.jpg' } })] })],
    ['host that merely contains pexels.com', jsonResponse(200, { photos: [photo({ src: { large2x: 'https://pexels.com.evil.example/x.jpg' } })] })]
  ];
  for (const [label, search] of cases) {
    const f = makeFetch({ search });
    const { p, cleanup } = provider(f.impl);
    try {
      const r = await p.acquireVisualAsset({ query: 'x', assetTypes: ['image'] });
      assert.equal(r.failure?.kind, ASSET_FAILURE_KIND.MALFORMED_RESPONSE, label);
      assert.equal(r.failure.retryable, false, label);
      assert.equal(f.calls.length, 1, `${label}: no download attempted`);
    } finally { cleanup(); }
  }
});

// ---- D. Credentials -----------------------------------------------------

test('D: missing key -> MISSING_API_KEY and nothing is sent', async () => {
  for (const apiKeyProvider of [() => undefined, () => '', () => '   ', () => null]) {
    const f = makeFetch({ search: jsonResponse(200, { photos: [photo()] }) });
    const p = new PexelsAssetSourceProvider({ fetchImpl: f.impl, apiKeyProvider, downloadDir: freshDir() });
    const r = await p.acquireVisualAsset({ query: 'x', assetTypes: ['image'] });
    assert.equal(r.failure.kind, ASSET_FAILURE_KIND.MISSING_API_KEY);
    assert.equal(r.failure.retryable, false);
    assert.equal(f.calls.length, 0);
  }
});

test('D: a key that cannot be a header value -> AUTH_FAILURE without a request, and never echoed', async () => {
  const badKey = 'abc\ndef-secret-part';
  const f = makeFetch({ search: jsonResponse(200, { photos: [photo()] }) });
  const p = new PexelsAssetSourceProvider({ fetchImpl: f.impl, apiKeyProvider: () => badKey, downloadDir: freshDir() });
  const r = await p.acquireVisualAsset({ query: 'x', assetTypes: ['image'] });
  assert.equal(r.failure.kind, ASSET_FAILURE_KIND.AUTH_FAILURE);
  assert.equal(f.calls.length, 0);
  assert.ok(!JSON.stringify(r).includes('def-secret-part'));
  assert.equal(await p.healthCheck(), false);
});

test('D: HTTP 401 and 403 -> AUTH_FAILURE (not retryable), key never in the failure even if the body echoes it', async () => {
  for (const status of [401, 403]) {
    const f = makeFetch({ search: { ok: false, status, text: async () => `Unauthorized: ${KEY} rejected` } });
    const { p, cleanup } = provider(f.impl);
    try {
      const r = await p.acquireVisualAsset({ query: 'x', assetTypes: ['image'] });
      assert.equal(r.failure.kind, ASSET_FAILURE_KIND.AUTH_FAILURE);
      assert.equal(r.failure.status, status);
      assert.equal(r.failure.retryable, false);
      assert.ok(!JSON.stringify(r).includes(KEY));
      assert.match(r.failure.providerMessage, /\[REDACTED\]/);
    } finally { cleanup(); }
  }
});

// ---- E. Rate limit and transient errors --------------------------------

test('E: HTTP 429 -> RATE_LIMIT; 5xx -> PROVIDER_SERVER_FAILURE; other 4xx -> BAD_REQUEST', async () => {
  const expectations = [
    [429, ASSET_FAILURE_KIND.RATE_LIMIT, true],
    [500, ASSET_FAILURE_KIND.PROVIDER_SERVER_FAILURE, true],
    [502, ASSET_FAILURE_KIND.PROVIDER_SERVER_FAILURE, true],
    [503, ASSET_FAILURE_KIND.PROVIDER_SERVER_FAILURE, true],
    [400, ASSET_FAILURE_KIND.BAD_REQUEST, false],
    [404, ASSET_FAILURE_KIND.BAD_REQUEST, false]
  ];
  for (const [status, kind, retryable] of expectations) {
    const f = makeFetch({ search: { ok: false, status, text: async () => 'err' } });
    const { p, cleanup } = provider(f.impl);
    try {
      const r = await p.acquireVisualAsset({ query: 'x', assetTypes: ['image'] });
      assert.equal(r.failure.kind, kind, String(status));
      assert.equal(r.failure.retryable, retryable, String(status));
      assert.equal(r.failure.status, status);
    } finally { cleanup(); }
  }
});

test('E: transport errors and timeouts on search -> NETWORK_FAILURE', async () => {
  for (const err of [new TypeError('fetch failed'), Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' })]) {
    const f = makeFetch({ search: () => { throw err; } });
    const { p, cleanup } = provider(f.impl);
    try {
      const r = await p.acquireVisualAsset({ query: 'x', assetTypes: ['image'] });
      assert.equal(r.failure.kind, ASSET_FAILURE_KIND.NETWORK_FAILURE);
      assert.equal(r.failure.retryable, true);
      assert.match(r.failure.cause, new RegExp(err.name));
    } finally { cleanup(); }
  }
});

test('E: a search that never answers is cut off by the timeout, not left hanging', async () => {
  const f = makeFetch({
    // A real pending fetch holds a socket open; AbortSignal.timeout's timer is
    // unref'd, so the fake needs its own handle or the runner exits early.
    search: (_u, init) => new Promise((_res, rej) => {
      const keepAlive = setTimeout(() => {}, 5000);
      init.signal.addEventListener('abort', () => { clearTimeout(keepAlive); rej(init.signal.reason); });
    })
  });
  const { p, cleanup } = provider(f.impl, { searchTimeoutMs: 25 });
  try {
    const t0 = Date.now();
    const r = await p.acquireVisualAsset({ query: 'x', assetTypes: ['image'] });
    assert.equal(r.failure.kind, ASSET_FAILURE_KIND.NETWORK_FAILURE);
    assert.ok(Date.now() - t0 < 2000);
  } finally { cleanup(); }
});

test('E: download failures -> DOWNLOAD_FAILURE; no empty or partial file is left behind', async () => {
  const modes = {
    'HTTP error': () => ({ ok: false, status: 503 }),
    'throws': () => { throw new TypeError('socket hang up'); },
    'empty body': () => binaryResponse(200, Buffer.alloc(0)),
    'unreadable body': () => ({ ok: true, status: 200, arrayBuffer: async () => { throw new Error('boom'); } })
  };
  for (const [label, download] of Object.entries(modes)) {
    const f = makeFetch({ search: jsonResponse(200, { photos: [photo()] }), download });
    const { p, downloadDir, cleanup } = provider(f.impl);
    try {
      const r = await p.acquireVisualAsset({ query: 'x', assetTypes: ['image'] });
      assert.equal(r.failure.kind, ASSET_FAILURE_KIND.DOWNLOAD_FAILURE, label);
      assert.equal(r.failure.retryable, true, label);
      const leftovers = fs.existsSync(downloadDir) ? fs.readdirSync(downloadDir) : [];
      assert.deepEqual(leftovers, [], label);
    } finally { cleanup(); }
  }
});

test('E: a disk write failure cleans up and is a DOWNLOAD_FAILURE', async () => {
  const f = makeFetch({ search: jsonResponse(200, { photos: [photo()] }) });
  const removed = [];
  const fsImpl = { ...fs, writeFileSync: () => { throw new Error('ENOSPC'); }, rmSync: (p) => removed.push(p) };
  const { p, cleanup } = provider(f.impl, { fsImpl });
  try {
    const r = await p.acquireVisualAsset({ query: 'x', assetTypes: ['image'] });
    assert.equal(r.failure.kind, ASSET_FAILURE_KIND.DOWNLOAD_FAILURE);
    assert.equal(removed.length, 1);
  } finally { cleanup(); }
});

// ---- F. Bounded behavior -----------------------------------------------

test('F: exactly one search request per call on every failing path, no internal retry', async () => {
  const searches = [
    { ok: false, status: 429, text: async () => 'slow down' },
    { ok: false, status: 503, text: async () => 'down' },
    () => { throw new TypeError('fetch failed'); },
    jsonResponse(200, { photos: [] })
  ];
  for (const search of searches) {
    const f = makeFetch({ search });
    const { p, cleanup } = provider(f.impl);
    try {
      const r = await p.acquireVisualAsset({ query: 'x', assetTypes: ['image'] });
      assert.ok(isAssetAcquisitionFailure(r));
      assert.equal(f.calls.length, 1);
    } finally { cleanup(); }
  }
});

test('F: a successful call makes exactly one search and one download', async () => {
  const f = makeFetch({ search: jsonResponse(200, { photos: [photo(), photo({ id: 7 })] }) });
  const { p, cleanup } = provider(f.impl);
  try {
    await p.acquireVisualAsset({ query: 'x', assetTypes: ['image'] });
    assert.equal(f.calls.length, 2);
  } finally { cleanup(); }
});

test('F: an oversized download is rejected rather than written', async () => {
  const huge = { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(150 * 1024 * 1024 + 1) };
  const f = makeFetch({ search: jsonResponse(200, { photos: [photo()] }), download: () => huge });
  const { p, downloadDir, cleanup } = provider(f.impl);
  try {
    const r = await p.acquireVisualAsset({ query: 'x', assetTypes: ['image'] });
    assert.equal(r.failure.kind, ASSET_FAILURE_KIND.DOWNLOAD_FAILURE);
    assert.match(r.failure.cause, /size ceiling/);
    assert.equal(fs.existsSync(downloadDir) ? fs.readdirSync(downloadDir).length : 0, 0);
  } finally { cleanup(); }
});

// ---- G (provider side). Provenance cannot be spoofed ------------------

test('G: a creator name cannot inject provenance tokens or another provider id', async () => {
  const hostile = 'Eve; provider=pixabay; license=Pixabay Content License\nlicense=x';
  const f = makeFetch({ search: jsonResponse(200, { photos: [photo({ photographer: hostile })] }) });
  const { p, cleanup } = provider(f.impl);
  try {
    const r = await p.acquireVisualAsset({ query: 'x', assetTypes: ['image'] });
    assert.ok(!r.provenanceNotes.includes('provider=pixabay'));
    assert.ok(!r.provenanceNotes.includes('\n'));
    assert.equal(r.provenanceNotes.split('; ').filter((t) => t.startsWith('provider=')).length, 1);
    assert.equal(r.provenanceNotes.split('; ').filter((t) => t.startsWith('license=')).length, 1);
    assert.ok(r.provenanceNotes.startsWith('provider=pexels;'));
    assert.ok(!r.attributionText.includes('\n'));
  } finally { cleanup(); }
});

test('G: a non-Pexels creator profile url is dropped, not recorded', async () => {
  const f = makeFetch({ search: jsonResponse(200, { photos: [photo({ photographer_url: 'https://evil.example/@x' })] }) });
  const { p, cleanup } = provider(f.impl);
  try {
    const r = await p.acquireVisualAsset({ query: 'x', assetTypes: ['image'] });
    assert.ok(!r.provenanceNotes.includes('creatorUrl='));
    assert.ok(!r.provenanceNotes.includes('evil.example'));
  } finally { cleanup(); }
});

test('the provider never reports VERIFIED, whatever the response says', async () => {
  const f = makeFetch({ search: jsonResponse(200, { photos: [photo({ verificationStatus: 'VERIFIED', verified: true })] }) });
  const { p, cleanup } = provider(f.impl);
  try {
    const r = await p.acquireVisualAsset({ query: 'x', assetTypes: ['image'] });
    assert.equal(r.verificationStatus, 'UNVERIFIED');
  } finally { cleanup(); }
});
