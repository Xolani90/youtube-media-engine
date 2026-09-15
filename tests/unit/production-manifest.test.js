import { test } from 'node:test';
import assert from 'node:assert/strict';

import { canonicalStringify, sha256, buildManifest } from '../../src/production/manifest.js';

test('canonicalStringify: key order does not affect output', () => {
  const a = { b: 1, a: 2, c: { z: 1, y: 2 } };
  const b = { a: 2, c: { y: 2, z: 1 }, b: 1 };
  assert.equal(canonicalStringify(a), canonicalStringify(b));
});

test('canonicalStringify: array element order IS preserved (not sorted)', () => {
  const a = { list: [3, 1, 2] };
  const b = { list: [1, 2, 3] };
  assert.notEqual(canonicalStringify(a), canonicalStringify(b));
});

test('sha256: identical input yields identical checksum', () => {
  assert.equal(sha256('hello world'), sha256('hello world'));
});

test('sha256: different input yields different checksum', () => {
  assert.notEqual(sha256('hello world'), sha256('hello there'));
});

test('buildManifest: excludes any timestamp/non-deterministic field, identical inputs -> identical manifest JSON', () => {
  const params = {
    contentVersion: { id: 'cv1' },
    script: { id: 's1', version: 1, body: 'Body text.' },
    contentBrief: { id: 'b1', working_title: 'T' },
    assets: [
      { id: 'a1', asset_type: 'image', location: '/x.png', checksum: 'abc', origin: 'stock', license: 'CC-BY',
        attribution_required: 1, attribution_text: 'Credit X', usage_restrictions: null, verification_status: 'VERIFIED', usage_context: 'thumbnail' }
    ]
  };
  const m1 = canonicalStringify(buildManifest(params));
  const m2 = canonicalStringify(buildManifest(params));
  assert.equal(m1, m2);
  assert.equal(sha256(m1), sha256(m2));
  assert.ok(!m1.includes('created_at'), 'manifest body must never include a timestamp field');
});

test('buildManifest: preserves D-G2 asset provenance fields verbatim, does not reinterpret usage_restrictions', () => {
  const manifest = buildManifest({
    contentVersion: { id: 'cv1' },
    script: { id: 's1', version: 1, body: 'Body.' },
    contentBrief: { id: 'b1', working_title: 'T' },
    assets: [
      { id: 'a1', asset_type: 'video_clip', location: '/clip.mp4', checksum: 'sum', origin: 'partner',
        license: 'proprietary', attribution_required: 0, attribution_text: null,
        usage_restrictions: 'no derivative works; free-text, not parsed', verification_status: 'VERIFIED', usage_context: 'b-roll' }
    ]
  });
  assert.equal(manifest.assets[0].usage_restrictions, 'no derivative works; free-text, not parsed');
  assert.equal(manifest.assets[0].verification_status, 'VERIFIED');
  assert.equal(manifest.assets[0].asset_id, 'a1');
});