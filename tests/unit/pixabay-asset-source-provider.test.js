import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { PixabayAssetSourceProvider, boundPixabayQuery, PIXABAY_MAX_QUERY_LENGTH } from '../../src/providers/asset/PixabayAssetSourceProvider.js';

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body
  };
}

function binaryResponse(status, bytes) {
  return {
    ok: status >= 200 && status < 300,
    status,
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
  };
}

function freshDownloadDir() {
  return path.join(os.tmpdir(), `pixabay-provider-test-${Date.now()}-${Math.random()}`);
}

function cleanupDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

const SAMPLE_IMAGE_HIT = {
  id: 195893,
  pageURL: 'https://pixabay.com/en/blossom-bloom-flower-195893/',
  type: 'photo',
  tags: 'blossom, bloom, flower',
  webformatURL: 'https://pixabay.com/get/35bbf209e13e39d2_640.jpg',
  largeImageURL: 'https://pixabay.com/get/ed6a99fd0a76647_1280.jpg',
  user: 'Josch13'
};

const SAMPLE_VIDEO_HIT = {
  id: 125,
  pageURL: 'https://pixabay.com/videos/id-125/',
  type: 'film',
  tags: 'flowers, yellow, blossom',
  videos: {
    large: { url: 'https://cdn.pixabay.com/video/large.mp4', width: 1920, height: 1080, size: 100 },
    medium: { url: 'https://cdn.pixabay.com/video/medium.mp4', width: 1280, height: 720, size: 50 },
    small: { url: 'https://cdn.pixabay.com/video/small.mp4', width: 640, height: 360, size: 20 },
    tiny: { url: 'https://cdn.pixabay.com/video/tiny.mp4', width: 480, height: 270, size: 10 }
  },
  user: 'Coverr-Free-Footage'
};

test('id is "pixabay"', () => {
  const provider = new PixabayAssetSourceProvider({ apiKeyProvider: () => 'key123' });
  assert.equal(provider.id, 'pixabay');
});

test('healthCheck: true when an API key is configured, false when missing -- never calls the network', async () => {
  let fetchCalls = 0;
  const fetchImpl = async () => { fetchCalls++; throw new Error('should not be called'); };

  const withKey = new PixabayAssetSourceProvider({ fetchImpl, apiKeyProvider: () => 'key123' });
  assert.equal(await withKey.healthCheck(), true);

  const withoutKey = new PixabayAssetSourceProvider({ fetchImpl, apiKeyProvider: () => undefined });
  assert.equal(await withoutKey.healthCheck(), false);

  assert.equal(fetchCalls, 0, 'healthCheck must never perform a network call');
});

test('acquireVisualAsset: missing query throws (request validation)', async () => {
  const provider = new PixabayAssetSourceProvider({ apiKeyProvider: () => 'key123' });
  await assert.rejects(
    () => provider.acquireVisualAsset({ assetTypes: ['image'] }),
    /non-empty query/
  );
});

test('acquireVisualAsset: missing API key returns a MISSING_API_KEY failure, never throws, never calls the network', async () => {
  let fetchCalls = 0;
  const fetchImpl = async () => { fetchCalls++; throw new Error('should not be called'); };
  const provider = new PixabayAssetSourceProvider({ fetchImpl, apiKeyProvider: () => undefined });

  const result = await provider.acquireVisualAsset({ query: 'a lighthouse', assetTypes: ['image'] });
  assert.equal(result.failure.kind, 'MISSING_API_KEY');
  assert.equal(fetchCalls, 0);
});

test('acquireVisualAsset: unsupported asset type returns an UNSUPPORTED_ASSET_TYPE failure without calling the network', async () => {
  let fetchCalls = 0;
  const fetchImpl = async () => { fetchCalls++; throw new Error('should not be called'); };
  const provider = new PixabayAssetSourceProvider({ fetchImpl, apiKeyProvider: () => 'key123' });

  const result = await provider.acquireVisualAsset({ query: 'a lighthouse', assetTypes: ['audio_clip'] });
  assert.equal(result.failure.kind, 'UNSUPPORTED_ASSET_TYPE');
  assert.equal(fetchCalls, 0);
});

test('acquireVisualAsset: valid image search request is well-formed', async () => {
  let capturedUrl;
  const downloadDir = freshDownloadDir();
  const fetchImpl = async (url) => {
    if (!capturedUrl) {
      capturedUrl = url;
      return jsonResponse(200, { total: 1, totalHits: 1, hits: [SAMPLE_IMAGE_HIT] });
    }
    return binaryResponse(200, Buffer.from('fake-jpeg-bytes'));
  };
  const provider = new PixabayAssetSourceProvider({ fetchImpl, apiKeyProvider: () => 'key123', downloadDir });

  try {
    await provider.acquireVisualAsset({ query: 'yellow flowers', assetTypes: ['image'] });
    const parsed = new URL(capturedUrl);
    assert.equal(parsed.origin + parsed.pathname, 'https://pixabay.com/api/');
    assert.equal(parsed.searchParams.get('key'), 'key123');
    assert.equal(parsed.searchParams.get('q'), 'yellow flowers');
    assert.equal(parsed.searchParams.get('image_type'), 'photo');
  } finally {
    cleanupDir(downloadDir);
  }
});

test('acquireVisualAsset: valid video search request is well-formed and hits the videos endpoint', async () => {
  let capturedUrl;
  const downloadDir = freshDownloadDir();
  const fetchImpl = async (url) => {
    if (!capturedUrl) {
      capturedUrl = url;
      return jsonResponse(200, { total: 1, totalHits: 1, hits: [SAMPLE_VIDEO_HIT] });
    }
    return binaryResponse(200, Buffer.from('fake-mp4-bytes'));
  };
  const provider = new PixabayAssetSourceProvider({ fetchImpl, apiKeyProvider: () => 'key123', downloadDir });

  try {
    await provider.acquireVisualAsset({ query: 'yellow flowers', assetTypes: ['video_clip'] });
    const parsed = new URL(capturedUrl);
    assert.equal(parsed.origin + parsed.pathname, 'https://pixabay.com/api/videos/');
    assert.equal(parsed.searchParams.get('key'), 'key123');
  } finally {
    cleanupDir(downloadDir);
  }
});

test('acquireVisualAsset: image candidate selection prefers largeImageURL and downloads/checksums it', async () => {
  const downloadDir = freshDownloadDir();
  const fileBytes = Buffer.from('fake-jpeg-bytes-for-checksum-test');
  let downloadedUrl;
  const fetchImpl = async (url) => {
    if (url.startsWith('https://pixabay.com/api/?')) {
      return jsonResponse(200, { total: 1, totalHits: 1, hits: [SAMPLE_IMAGE_HIT] });
    }
    downloadedUrl = url;
    return binaryResponse(200, fileBytes);
  };
  const provider = new PixabayAssetSourceProvider({ fetchImpl, apiKeyProvider: () => 'key123', downloadDir });

  try {
    const result = await provider.acquireVisualAsset({ query: 'yellow flowers', assetTypes: ['image'] });

    assert.equal(downloadedUrl, SAMPLE_IMAGE_HIT.largeImageURL);
    assert.equal(result.assetType, 'image');
    assert.ok(fs.existsSync(result.location));
    assert.equal(fs.readFileSync(result.location).toString(), fileBytes.toString());

    const expectedChecksum = crypto.createHash('sha256').update(fileBytes).digest('hex');
    assert.equal(result.checksum, expectedChecksum);
    assert.equal(result.origin, SAMPLE_IMAGE_HIT.pageURL);
    assert.equal(result.verificationStatus, 'UNVERIFIED');
    assert.equal(result.attributionRequired, false);
    assert.match(result.license, /Pixabay/);
  } finally {
    cleanupDir(downloadDir);
  }
});

test('acquireVisualAsset: video candidate selection prefers the medium rendition', async () => {
  const downloadDir = freshDownloadDir();
  let downloadedUrl;
  const fetchImpl = async (url) => {
    if (url.includes('/api/videos/')) {
      return jsonResponse(200, { total: 1, totalHits: 1, hits: [SAMPLE_VIDEO_HIT] });
    }
    downloadedUrl = url;
    return binaryResponse(200, Buffer.from('fake-mp4-bytes'));
  };
  const provider = new PixabayAssetSourceProvider({ fetchImpl, apiKeyProvider: () => 'key123', downloadDir });

  try {
    const result = await provider.acquireVisualAsset({ query: 'yellow flowers', assetTypes: ['video_clip'] });
    assert.equal(downloadedUrl, SAMPLE_VIDEO_HIT.videos.medium.url);
    assert.equal(result.assetType, 'video_clip');
  } finally {
    cleanupDir(downloadDir);
  }
});

test('acquireVisualAsset: no results returns an EMPTY_RESULT failure', async () => {
  const fetchImpl = async () => jsonResponse(200, { total: 0, totalHits: 0, hits: [] });
  const provider = new PixabayAssetSourceProvider({ fetchImpl, apiKeyProvider: () => 'key123' });

  const result = await provider.acquireVisualAsset({ query: 'a very obscure thing', assetTypes: ['image'] });
  assert.equal(result.failure.kind, 'EMPTY_RESULT');
  assert.equal(result.failure.hitCount, 0);
});

test('acquireVisualAsset: malformed API response (no hits array) returns a MALFORMED_RESPONSE failure', async () => {
  const fetchImpl = async () => jsonResponse(200, { total: 0 });
  const provider = new PixabayAssetSourceProvider({ fetchImpl, apiKeyProvider: () => 'key123' });

  const result = await provider.acquireVisualAsset({ query: 'anything', assetTypes: ['image'] });
  assert.equal(result.failure.kind, 'MALFORMED_RESPONSE');
});

test('acquireVisualAsset: a non-OK search HTTP response (e.g. 429 rate limit) returns a RATE_LIMIT failure, never throws', async () => {
  const fetchImpl = async () => jsonResponse(429, 'API rate limit exceeded');
  const provider = new PixabayAssetSourceProvider({ fetchImpl, apiKeyProvider: () => 'key123' });

  const result = await provider.acquireVisualAsset({ query: 'anything', assetTypes: ['image'] });
  assert.equal(result.failure.kind, 'RATE_LIMIT');
  assert.equal(result.failure.status, 429);
});

test('acquireVisualAsset: download failure (non-OK download response) cleans up and returns a DOWNLOAD_FAILURE failure', async () => {
  const downloadDir = freshDownloadDir();
  const fetchImpl = async (url) => {
    if (url.startsWith('https://pixabay.com/api/?')) {
      return jsonResponse(200, { total: 1, totalHits: 1, hits: [SAMPLE_IMAGE_HIT] });
    }
    return jsonResponse(500, {});
  };
  const provider = new PixabayAssetSourceProvider({ fetchImpl, apiKeyProvider: () => 'key123', downloadDir });

  try {
    const result = await provider.acquireVisualAsset({ query: 'yellow flowers', assetTypes: ['image'] });
    assert.equal(result.failure.kind, 'DOWNLOAD_FAILURE');
    assert.equal(result.failure.status, 500);
    // No partial files should be left behind.
    if (fs.existsSync(downloadDir)) {
      assert.deepEqual(fs.readdirSync(downloadDir), []);
    }
  } finally {
    cleanupDir(downloadDir);
  }
});

test('acquireVisualAsset: an empty downloaded file is treated as a failure, cleaned up, and never returned', async () => {
  const downloadDir = freshDownloadDir();
  const fetchImpl = async (url) => {
    if (url.startsWith('https://pixabay.com/api/?')) {
      return jsonResponse(200, { total: 1, totalHits: 1, hits: [SAMPLE_IMAGE_HIT] });
    }
    return binaryResponse(200, Buffer.alloc(0));
  };
  const provider = new PixabayAssetSourceProvider({ fetchImpl, apiKeyProvider: () => 'key123', downloadDir });

  try {
    const result = await provider.acquireVisualAsset({ query: 'yellow flowers', assetTypes: ['image'] });
    assert.equal(result.failure.kind, 'DOWNLOAD_FAILURE');
    if (fs.existsSync(downloadDir)) {
      assert.deepEqual(fs.readdirSync(downloadDir), []);
    }
  } finally {
    cleanupDir(downloadDir);
  }
});

test('acquireVisualAsset: verificationStatus is always UNVERIFIED, never fabricated as VERIFIED', async () => {
  const downloadDir = freshDownloadDir();
  const fetchImpl = async (url) => {
    if (url.startsWith('https://pixabay.com/api/?')) {
      return jsonResponse(200, { total: 1, totalHits: 1, hits: [SAMPLE_IMAGE_HIT] });
    }
    return binaryResponse(200, Buffer.from('bytes'));
  };
  const provider = new PixabayAssetSourceProvider({ fetchImpl, apiKeyProvider: () => 'key123', downloadDir });

  try {
    const result = await provider.acquireVisualAsset({ query: 'yellow flowers', assetTypes: ['image'] });
    assert.equal(result.verificationStatus, 'UNVERIFIED');
  } finally {
    cleanupDir(downloadDir);
  }
});

test('acquireVisualAsset: provenance mapping includes pixabay id, source URL, and license notes', async () => {
  const downloadDir = freshDownloadDir();
  const fetchImpl = async (url) => {
    if (url.startsWith('https://pixabay.com/api/?')) {
      return jsonResponse(200, { total: 1, totalHits: 1, hits: [SAMPLE_IMAGE_HIT] });
    }
    return binaryResponse(200, Buffer.from('bytes'));
  };
  const provider = new PixabayAssetSourceProvider({ fetchImpl, apiKeyProvider: () => 'key123', downloadDir });

  try {
    const result = await provider.acquireVisualAsset({ query: 'yellow flowers', assetTypes: ['image'] });
    assert.match(result.provenanceNotes, /pixabayId=195893/);
    assert.match(result.provenanceNotes, /sourceUrl=https:\/\/pixabay\.com\/en\/blossom-bloom-flower-195893\//);
    assert.match(result.usageRestrictions, /standalone/);
  } finally {
    cleanupDir(downloadDir);
  }
});

test('boundPixabayQuery: a short query is returned unchanged (whitespace normalized)', () => {
  assert.equal(boundPixabayQuery('  yellow   flowers '), 'yellow flowers');
});

test('boundPixabayQuery: an over-long query is cut at a word boundary within the 100-char limit', () => {
  const long = 'A sweeping cinematic aerial shot of snow-capped mountain peaks at sunrise with drifting clouds and a calm alpine lake below';
  const out = boundPixabayQuery(long);
  assert.ok(long.length > PIXABAY_MAX_QUERY_LENGTH);
  assert.ok(out.length <= PIXABAY_MAX_QUERY_LENGTH);
  assert.ok(long.startsWith(out));
  assert.ok(long[out.length] === ' ', 'must not cut mid-word');
});

test('boundPixabayQuery: exactly 100 characters is kept; a single 150-char token is hard-cut to 100', () => {
  assert.equal(boundPixabayQuery('a'.repeat(100)).length, 100);
  assert.equal(boundPixabayQuery('a'.repeat(150)).length, 100);
});

test('acquireVisualAsset: an over-long query is sent to Pixabay bounded to 100 characters (image and video)', async () => {
  const long = 'word '.repeat(60).trim();
  for (const assetType of ['image', 'video_clip']) {
    let capturedUrl;
    const downloadDir = freshDownloadDir();
    const fetchImpl = async (url) => {
      if (!capturedUrl) {
        capturedUrl = url;
        return jsonResponse(200, { total: 0, totalHits: 0, hits: [] });
      }
      return binaryResponse(200, Buffer.from('x'));
    };
    const provider = new PixabayAssetSourceProvider({ fetchImpl, apiKeyProvider: () => 'key123', downloadDir });
    try {
      await provider.acquireVisualAsset({ query: long, assetTypes: [assetType] });
      const q = new URL(capturedUrl).searchParams.get('q');
      assert.ok(q.length <= PIXABAY_MAX_QUERY_LENGTH, `${assetType} q length ${q.length}`);
    } finally {
      cleanupDir(downloadDir);
    }
  }
});

test('defense in depth: an over-long legacy visual_ideas still yields a query of at most 100 characters', async () => {
  const { deriveVisualQuery } = await import('../../src/asset-provisioning/visualQuery.js');
  const legacy = 'Infographics showing the two-year construction timeline alongside projected hiring phases, and maps highlighting the planned site';
  const q = boundPixabayQuery(deriveVisualQuery({ visual_ideas: legacy }, { body: '' }));
  assert.ok(legacy.length > 100);
  assert.ok(q.length <= PIXABAY_MAX_QUERY_LENGTH);
});
