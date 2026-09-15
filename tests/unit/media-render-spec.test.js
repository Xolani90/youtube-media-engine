import { test } from 'node:test';
import assert from 'node:assert/strict';

import { selectVisualAssets, computeVisualTiming } from '../../src/media/visualTiming.js';
import { buildRenderSpec, renderSpecChecksum } from '../../src/media/renderSpec.js';

// --- selectVisualAssets -----

test('selectVisualAssets: keeps only image/video_clip assets, preserves input order', () => {
  const assets = [
    { id: 'a1', asset_type: 'image' },
    { id: 'a2', asset_type: 'audio' },
    { id: 'a3', asset_type: 'video_clip' },
    { id: 'a4', asset_type: 'music' }
  ];
  const result = selectVisualAssets(assets);
  assert.deepEqual(result.map((a) => a.id), ['a1', 'a3']);
});

test('selectVisualAssets: empty/undefined input returns empty array', () => {
  assert.deepEqual(selectVisualAssets([]), []);
  assert.deepEqual(selectVisualAssets(undefined), []);
});

// --- computeVisualTiming -----

test('computeVisualTiming: N assets each receive an equal, ordered, non-overlapping portion summing to the total duration', () => {
  const assets = [
    { id: 'a1', asset_type: 'image', location: '/a1.png' },
    { id: 'a2', asset_type: 'image', location: '/a2.png' },
    { id: 'a3', asset_type: 'image', location: '/a3.png' }
  ];
  const timing = computeVisualTiming(assets, 9);

  assert.equal(timing.length, 3);
  assert.deepEqual(timing.map((t) => t.asset_id), ['a1', 'a2', 'a3']);
  assert.equal(timing[0].start_seconds, 0);
  assert.equal(timing[0].duration_seconds, 3);
  assert.equal(timing[1].start_seconds, 3);
  assert.equal(timing[2].start_seconds, 6);

  const total = timing.reduce((sum, t) => sum + t.duration_seconds, 0);
  assert.equal(total, 9);
});

test('computeVisualTiming: last segment absorbs floating-point rounding remainder, still sums exactly to total duration', () => {
  const assets = [
    { id: 'a1', asset_type: 'image', location: '/a1.png' },
    { id: 'a2', asset_type: 'image', location: '/a2.png' },
    { id: 'a3', asset_type: 'image', location: '/a3.png' }
  ];
  const timing = computeVisualTiming(assets, 10);

  const total = timing.reduce((sum, t) => sum + t.duration_seconds, 0);
  assert.equal(total, 10);
  // Equal share (10/3 = 3.333...) applies to the first two; the last absorbs the remainder.
  assert.equal(timing[0].duration_seconds, 3.333);
  assert.equal(timing[1].duration_seconds, 3.333);
  assert.equal(timing[2].duration_seconds, 3.334);
});

test('computeVisualTiming: single asset gets the entire duration', () => {
  const assets = [{ id: 'a1', asset_type: 'image', location: '/a1.png' }];
  const timing = computeVisualTiming(assets, 5.5);
  assert.equal(timing.length, 1);
  assert.equal(timing[0].start_seconds, 0);
  assert.equal(timing[0].duration_seconds, 5.5);
});

test('computeVisualTiming: zero assets returns empty timing', () => {
  assert.deepEqual(computeVisualTiming([], 10), []);
});

test('computeVisualTiming: non-positive duration throws', () => {
  const assets = [{ id: 'a1', asset_type: 'image', location: '/a1.png' }];
  assert.throws(() => computeVisualTiming(assets, 0));
  assert.throws(() => computeVisualTiming(assets, -1));
});

// --- buildRenderSpec / renderSpecChecksum -----

function sampleVisualTiming() {
  return [
    { asset_id: 'a1', asset_type: 'image', location: '/a1.png', start_seconds: 0, duration_seconds: 5 }
  ];
}

test('buildRenderSpec: deterministic construction — identical inputs produce identical checksum', () => {
  const contentVersion = { id: 'cv1' };
  const params = {
    contentVersion,
    narrationPath: '/dir/narration.wav',
    narrationDurationSeconds: 5,
    visualTiming: sampleVisualTiming()
  };

  const spec1 = buildRenderSpec(params);
  const spec2 = buildRenderSpec(params);
  const { checksum: c1 } = renderSpecChecksum(spec1);
  const { checksum: c2 } = renderSpecChecksum(spec2);
  assert.equal(c1, c2);
});

test('buildRenderSpec: different visual asset ordering changes the checksum', () => {
  const contentVersion = { id: 'cv1' };
  const timingA = [
    { asset_id: 'a1', asset_type: 'image', location: '/a1.png', start_seconds: 0, duration_seconds: 2.5 },
    { asset_id: 'a2', asset_type: 'image', location: '/a2.png', start_seconds: 2.5, duration_seconds: 2.5 }
  ];
  const timingB = [timingA[1], timingA[0]];

  const specA = buildRenderSpec({ contentVersion, narrationPath: '/n.wav', narrationDurationSeconds: 5, visualTiming: timingA });
  const specB = buildRenderSpec({ contentVersion, narrationPath: '/n.wav', narrationDurationSeconds: 5, visualTiming: timingB });

  const { checksum: cA } = renderSpecChecksum(specA);
  const { checksum: cB } = renderSpecChecksum(specB);
  assert.notEqual(cA, cB);
});

test('buildRenderSpec: carries narration path/duration and output format params through verbatim', () => {
  const contentVersion = { id: 'cv1' };
  const spec = buildRenderSpec({
    contentVersion,
    narrationPath: '/dir/narration.wav',
    narrationDurationSeconds: 12.345,
    visualTiming: sampleVisualTiming(),
    width: 1280,
    height: 720,
    fps: 24
  });

  assert.equal(spec.content_version_id, 'cv1');
  assert.equal(spec.narration.path, '/dir/narration.wav');
  assert.equal(spec.narration.duration_seconds, 12.345);
  assert.equal(spec.output.width, 1280);
  assert.equal(spec.output.height, 720);
  assert.equal(spec.output.fps, 24);
  assert.deepEqual(spec.visual_timing, sampleVisualTiming());
});

test('buildRenderSpec: never includes a timestamp/non-deterministic field', () => {
  const contentVersion = { id: 'cv1' };
  const spec = buildRenderSpec({
    contentVersion,
    narrationPath: '/dir/narration.wav',
    narrationDurationSeconds: 5,
    visualTiming: sampleVisualTiming()
  });
  const { json } = renderSpecChecksum(spec);
  assert.ok(!json.includes('created_at'));
  assert.ok(!json.includes('timestamp'));
});
