import { test } from 'node:test';
import assert from 'node:assert/strict';

import { segmentCaptions, computeCaptionTiming } from '../../src/media/captionTiming.js';

// --- segmentCaptions -----

test('segmentCaptions: single sentence produces a single caption', () => {
  const result = segmentCaptions('This is one sentence.', 80);
  assert.deepEqual(result, ['This is one sentence.']);
});

test('segmentCaptions: multiple sentences produce one caption per sentence, in order', () => {
  const result = segmentCaptions('First sentence. Second sentence! Third one?', 80);
  assert.deepEqual(result, ['First sentence.', 'Second sentence!', 'Third one?']);
});

test('segmentCaptions: a sentence exceeding maxLength is split at word boundaries into <= maxLength chunks', () => {
  const longSentence = 'This is a very long sentence that definitely exceeds the small maximum caption length we are testing with here.';
  const result = segmentCaptions(longSentence, 30);
  assert.ok(result.length > 1);
  for (const caption of result) {
    assert.ok(caption.length <= 30, `caption "${caption}" (${caption.length} chars) exceeds max length 30`);
  }
  // No text lost: rejoining the captions reproduces every word of the input.
  assert.equal(result.join(' '), longSentence);
});

test('segmentCaptions: punctuation boundaries are respected (sentence-ending punctuation stays with its sentence)', () => {
  const result = segmentCaptions('Is this a question? Yes it is! Great.', 80);
  assert.deepEqual(result, ['Is this a question?', 'Yes it is!', 'Great.']);
});

test('segmentCaptions: excess/irregular whitespace is normalized, never produces empty captions', () => {
  const result = segmentCaptions('  First sentence.    Second   sentence.  ', 80);
  assert.deepEqual(result, ['First sentence.', 'Second sentence.']);
  assert.ok(result.every((c) => c.trim().length > 0));
});

test('segmentCaptions: empty and whitespace-only input returns an empty array (no captions, nothing to lose)', () => {
  assert.deepEqual(segmentCaptions('', 80), []);
  assert.deepEqual(segmentCaptions('   ', 80), []);
  assert.deepEqual(segmentCaptions(undefined, 80), []);
  assert.deepEqual(segmentCaptions(null, 80), []);
});

test('segmentCaptions: never silently loses script text — every non-whitespace token reappears in the output', () => {
  const text = 'Alpha beta gamma. Delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau upsilon phi chi psi omega.';
  const result = segmentCaptions(text, 40);
  const originalWords = text.replace(/\s+/g, ' ').trim().split(' ');
  const resultWords = result.join(' ').split(' ');
  assert.deepEqual(resultWords, originalWords);
});

test('segmentCaptions: a single word longer than maxLength is kept whole, not split mid-word', () => {
  const result = segmentCaptions('Supercalifragilisticexpialidocious.', 10);
  assert.equal(result.length, 1);
  assert.equal(result[0], 'Supercalifragilisticexpialidocious.');
});

test('segmentCaptions: is deterministic — identical input produces identical output on repeated calls', () => {
  const text = 'Determinism matters. Repeated calls must agree exactly.';
  const a = segmentCaptions(text, 80);
  const b = segmentCaptions(text, 80);
  assert.deepEqual(a, b);
});

// --- computeCaptionTiming -----

test('computeCaptionTiming: a single caption gets the entire narration duration', () => {
  const timing = computeCaptionTiming(['Only caption.'], 5);
  assert.equal(timing.length, 1);
  assert.equal(timing[0].start_seconds, 0);
  assert.equal(timing[0].duration_seconds, 5);
});

test('computeCaptionTiming: duration is proportional to caption character-length share, not equal division', () => {
  // Lengths chosen so the proportional shares are clean: 4 / 20 = 20%, 10 / 20 = 50%, 6 / 20 = 30%.
  const captions = ['AAAA', 'BBBBBBBBBB', 'CCCCCC']; // 4, 10, 6 chars
  const timing = computeCaptionTiming(captions, 10);

  assert.equal(timing[0].duration_seconds, 2); // 20% of 10
  assert.equal(timing[1].duration_seconds, 5); // 50% of 10
  // Last caption absorbs the exact remainder rather than being independently computed.
  assert.equal(timing[2].duration_seconds, 3); // remaining 30%
});

test('computeCaptionTiming: durations sum exactly to narrationDurationSeconds (duration conservation)', () => {
  const captions = ['A short one.', 'A considerably longer caption here.', 'Mid length caption.', 'End.'];
  const timing = computeCaptionTiming(captions, 12.345);
  const total = timing.reduce((sum, c) => sum + c.duration_seconds, 0);
  assert.equal(total, 12.345);
});

test('computeCaptionTiming: first caption starts at exactly 0', () => {
  const timing = computeCaptionTiming(['One.', 'Two.', 'Three.'], 9);
  assert.equal(timing[0].start_seconds, 0);
});

test('computeCaptionTiming: no gaps and no overlaps — each caption starts exactly where the previous one ends', () => {
  const timing = computeCaptionTiming(['Alpha beta gamma.', 'Delta.', 'Epsilon zeta eta theta.'], 15);
  for (let i = 1; i < timing.length; i++) {
    const prevEnd = timing[i - 1].start_seconds + timing[i - 1].duration_seconds;
    assert.equal(timing[i].start_seconds, prevEnd);
  }
});

test('computeCaptionTiming: final caption ends exactly at narrationDurationSeconds', () => {
  const timing = computeCaptionTiming(['One.', 'Two.', 'Three.'], 7.777);
  const last = timing[timing.length - 1];
  assert.equal(last.start_seconds + last.duration_seconds, 7.777);
});

test('computeCaptionTiming: no negative or zero durations', () => {
  const timing = computeCaptionTiming(['A.', 'B.', 'C.', 'D.', 'E.'], 3);
  for (const c of timing) {
    assert.ok(c.duration_seconds > 0, `expected positive duration, got ${c.duration_seconds}`);
  }
});

test('computeCaptionTiming: deterministic — repeated calculation on identical input agrees exactly', () => {
  const captions = ['First caption text.', 'Second, somewhat longer caption text.', 'Third.'];
  const a = computeCaptionTiming(captions, 8.5);
  const b = computeCaptionTiming(captions, 8.5);
  assert.deepEqual(a, b);
});

test('computeCaptionTiming: very short narration still produces positive, gap-free, sum-conserving timing', () => {
  const timing = computeCaptionTiming(['Hi.', 'Bye.'], 0.5);
  assert.equal(timing.length, 2);
  assert.ok(timing[0].duration_seconds > 0);
  assert.ok(timing[1].duration_seconds > 0);
  const total = timing.reduce((sum, c) => sum + c.duration_seconds, 0);
  assert.equal(total, 0.5);
});

test('computeCaptionTiming: rounding/remainder is absorbed entirely by the last caption', () => {
  // 10 / 3 = 3.333... repeating; verifies millisecond rounding + exact-sum behavior.
  const captions = ['AAA', 'AAA', 'AAA']; // equal character length -> equal proportional share
  const timing = computeCaptionTiming(captions, 10);
  assert.equal(timing[0].duration_seconds, 3.333);
  assert.equal(timing[1].duration_seconds, 3.333);
  assert.equal(timing[2].duration_seconds, 3.334);
  const total = timing.reduce((sum, c) => sum + c.duration_seconds, 0);
  assert.equal(total, 10);
});

test('computeCaptionTiming: zero captions returns an empty array', () => {
  assert.deepEqual(computeCaptionTiming([], 10), []);
});

test('computeCaptionTiming: non-positive narrationDurationSeconds throws', () => {
  assert.throws(() => computeCaptionTiming(['One.'], 0));
  assert.throws(() => computeCaptionTiming(['One.'], -1));
});

test('computeCaptionTiming: preserves caption text and ordering verbatim', () => {
  const captions = ['Zebra.', 'Apple.', 'Mango.'];
  const timing = computeCaptionTiming(captions, 6);
  assert.deepEqual(timing.map((c) => c.text), captions);
});