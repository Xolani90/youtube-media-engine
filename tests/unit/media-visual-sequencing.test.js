import { test } from 'node:test';
import assert from 'node:assert/strict';

import { computeVisualSequencing } from '../../src/media/visualSequencing.js';
import { computeVisualTiming } from '../../src/media/visualTiming.js';

function asset(id) {
  return { id, asset_type: 'image', location: `/${id}.png` };
}

/** Caption timing fixture: N equal-length, gap-free, duration-exact segments — same shape captionTiming.js actually produces. */
function evenCaptions(n, totalDuration) {
  const each = totalDuration / n;
  return Array.from({ length: n }, (_, i) => ({
    text: `caption ${i}`,
    start_seconds: Math.round(i * each * 1000) / 1000,
    duration_seconds: i === n - 1
      ? Math.round((totalDuration - i * each) * 1000) / 1000
      : Math.round(each * 1000) / 1000
  }));
}

// --- basic shape / fallback -----

test('one visual asset: entire duration, regardless of caption structure', () => {
  const timing = computeVisualSequencing([asset('a1')], evenCaptions(4, 10), 10);
  assert.equal(timing.length, 1);
  assert.equal(timing[0].start_seconds, 0);
  assert.equal(timing[0].duration_seconds, 10);
});

test('no caption structure (empty array) falls back to plain equal-division timing, unchanged', () => {
  const assets = [asset('a1'), asset('a2'), asset('a3')];
  const sequenced = computeVisualSequencing(assets, [], 9);
  const plain = computeVisualTiming(assets, 9);
  assert.deepEqual(sequenced, plain);
});

test('no caption structure (null/undefined) also falls back to plain equal-division timing', () => {
  const assets = [asset('a1'), asset('a2')];
  assert.deepEqual(computeVisualSequencing(assets, null, 8), computeVisualTiming(assets, 8));
  assert.deepEqual(computeVisualSequencing(assets, undefined, 8), computeVisualTiming(assets, 8));
});

// --- multiple visuals, multiple caption segments -----

test('multiple visuals + multiple long-enough caption segments: visual cuts land on caption boundaries', () => {
  // 4 captions of 3s each (>= min duration), 2 assets -> assets cycle a1,a2,a1,a2 across the 4 caption-aligned segments.
  const assets = [asset('a1'), asset('a2')];
  const captions = evenCaptions(4, 12);
  const timing = computeVisualSequencing(assets, captions, 12);

  assert.equal(timing.length, 4);
  assert.deepEqual(timing.map((t) => t.asset_id), ['a1', 'a2', 'a1', 'a2']);
  assert.deepEqual(timing.map((t) => t.start_seconds), [0, 3, 6, 9]);
  assert.deepEqual(timing.map((t) => t.duration_seconds), [3, 3, 3, 3]);
});

// --- determinism -----

test('deterministic: identical inputs produce identical output on repeated calls', () => {
  const assets = [asset('a1'), asset('a2'), asset('a3')];
  const captions = evenCaptions(5, 11.5);
  const a = computeVisualSequencing(assets, captions, 11.5);
  const b = computeVisualSequencing(assets, captions, 11.5);
  assert.deepEqual(a, b);
});

// --- no gaps / no overlaps -----

test('no gaps and no overlaps across the full sequenced timeline', () => {
  const assets = [asset('a1'), asset('a2'), asset('a3')];
  const captions = evenCaptions(7, 13.7);
  const timing = computeVisualSequencing(assets, captions, 13.7);
  for (let i = 1; i < timing.length; i++) {
    const prevEnd = Math.round((timing[i - 1].start_seconds + timing[i - 1].duration_seconds) * 1000) / 1000;
    assert.equal(timing[i].start_seconds, prevEnd);
  }
});

// --- exact total duration -----

test('first segment starts at 0 and the final segment ends at exactly narrationDurationSeconds', () => {
  const assets = [asset('a1'), asset('a2')];
  const captions = evenCaptions(6, 17.777);
  const timing = computeVisualSequencing(assets, captions, 17.777);
  assert.equal(timing[0].start_seconds, 0);
  const last = timing[timing.length - 1];
  assert.equal(Math.round((last.start_seconds + last.duration_seconds) * 1000) / 1000, 17.777);
});

test('sum of durations equals narrationDurationSeconds exactly', () => {
  const assets = [asset('a1'), asset('a2'), asset('a3')];
  const captions = evenCaptions(9, 22.222);
  const timing = computeVisualSequencing(assets, captions, 22.222);
  const total = Math.round(timing.reduce((sum, t) => sum + t.duration_seconds, 0) * 1000) / 1000;
  assert.equal(total, 22.222);
});

// --- excessive number of assets -----

test('more visual assets than caption-aligned segments: trailing unused assets are consolidated out, not force-fit', () => {
  // 2 long-enough caption segments, 5 assets -> only 2 segments exist, so only the first 2 assets are used.
  const assets = [asset('a1'), asset('a2'), asset('a3'), asset('a4'), asset('a5')];
  const captions = evenCaptions(2, 8);
  const timing = computeVisualSequencing(assets, captions, 8);
  assert.equal(timing.length, 2);
  assert.deepEqual(timing.map((t) => t.asset_id), ['a1', 'a2']);
});

// --- more segments than assets: reuse -----

test('more caption-aligned segments than assets: assets are reused cyclically in stable order', () => {
  const assets = [asset('a1'), asset('a2')];
  const captions = evenCaptions(5, 15); // 5 segments of 3s each, well above the minimum
  const timing = computeVisualSequencing(assets, captions, 15);
  assert.equal(timing.length, 5);
  assert.deepEqual(timing.map((t) => t.asset_id), ['a1', 'a2', 'a1', 'a2', 'a1']);
});

// --- minimum-duration protection -----

test('minimum-duration protection: short caption segments are merged so no visual interval is shown for an unusable flash', () => {
  const assets = [asset('a1'), asset('a2')];
  // 10 captions across only 5 seconds -> each caption segment is 0.5s,
  // well under the default 1.5s minimum, forcing merges.
  const captions = evenCaptions(10, 5);
  const timing = computeVisualSequencing(assets, captions, 5, { minVisualDurationSeconds: 1.5 });
  for (const t of timing) {
    assert.ok(t.duration_seconds >= 1.5 - 1e-9, `segment duration ${t.duration_seconds} is below the minimum`);
  }
  // Still exact total coverage despite merging.
  const total = Math.round(timing.reduce((sum, t) => sum + t.duration_seconds, 0) * 1000) / 1000;
  assert.equal(total, 5);
});

test('minimum-duration protection: a too-short trailing segment merges backward into its predecessor', () => {
  const assets = [asset('a1'), asset('a2')];
  // 3 captions of 4s, 4s, 0.5s (8.5s total): the last segment alone is
  // below the 1.5s minimum and has no successor to merge forward into.
  const captions = [
    { text: 'a', start_seconds: 0, duration_seconds: 4 },
    { text: 'b', start_seconds: 4, duration_seconds: 4 },
    { text: 'c', start_seconds: 8, duration_seconds: 0.5 }
  ];
  const timing = computeVisualSequencing(assets, captions, 8.5, { minVisualDurationSeconds: 1.5 });
  assert.equal(timing.length, 2);
  assert.equal(timing[0].duration_seconds, 4);
  assert.equal(timing[1].start_seconds, 4);
  assert.equal(timing[1].duration_seconds, 4.5);
});

// --- very short narration -----

test('very short narration: still produces a valid, gap-free, exact-duration timeline (collapses to one segment below the minimum)', () => {
  const assets = [asset('a1'), asset('a2')];
  const captions = evenCaptions(3, 0.6); // three tiny caption segments, well under the minimum
  const timing = computeVisualSequencing(assets, captions, 0.6);
  assert.equal(timing.length, 1);
  assert.equal(timing[0].start_seconds, 0);
  assert.equal(timing[0].duration_seconds, 0.6);
});

// --- stable asset ordering -----

test('stable asset ordering: assets are assigned in their given input order, not re-sorted', () => {
  const assets = [asset('zeta'), asset('alpha'), asset('mid')];
  const captions = evenCaptions(3, 9);
  const timing = computeVisualSequencing(assets, captions, 9);
  assert.deepEqual(timing.map((t) => t.asset_id), ['zeta', 'alpha', 'mid']);
});

// --- empty/invalid input handling (matches visualTiming.js's own conventions) -----

test('zero visual assets returns an empty array, matching computeVisualTiming', () => {
  assert.deepEqual(computeVisualSequencing([], evenCaptions(3, 9), 9), []);
  assert.deepEqual(computeVisualSequencing(undefined, evenCaptions(3, 9), 9), []);
});

test('non-positive narrationDurationSeconds throws, matching computeVisualTiming', () => {
  const assets = [asset('a1'), asset('a2')];
  const captions = evenCaptions(3, 9);
  assert.throws(() => computeVisualSequencing(assets, captions, 0));
  assert.throws(() => computeVisualSequencing(assets, captions, -1));
});

test('asset_type and location are carried through onto each sequenced segment', () => {
  const assets = [{ id: 'a1', asset_type: 'video_clip', location: '/clip.mp4' }, asset('a2')];
  const captions = evenCaptions(2, 6);
  const timing = computeVisualSequencing(assets, captions, 6);
  assert.equal(timing[0].asset_type, 'video_clip');
  assert.equal(timing[0].location, '/clip.mp4');
});
