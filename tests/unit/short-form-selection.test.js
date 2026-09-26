import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectShortFormSegment, trimVisualTiming, trimCaptionTiming } from '../../src/media/shortFormSelection.js';

// --- selectShortFormSegment ---

test('narration already within the cap: the whole thing is the segment', () => {
  const result = selectShortFormSegment({
    visualTiming: [{ start_seconds: 0, duration_seconds: 10 }],
    captionTiming: [{ start_seconds: 0, duration_seconds: 10 }],
    narrationDurationSeconds: 10,
    maxDurationSeconds: 60
  });
  assert.equal(result.selected, true);
  assert.equal(result.startSeconds, 0);
  assert.equal(result.endSeconds, 10);
});

test('narration longer than the cap: cuts at the nearest existing boundary at or before the cap', () => {
  const captionTiming = [
    { start_seconds: 0, duration_seconds: 20 },
    { start_seconds: 20, duration_seconds: 20 },
    { start_seconds: 40, duration_seconds: 20 },
    { start_seconds: 60, duration_seconds: 20 }
  ];
  const result = selectShortFormSegment({
    visualTiming: captionTiming,
    captionTiming,
    narrationDurationSeconds: 80,
    maxDurationSeconds: 60
  });
  assert.equal(result.selected, true);
  assert.equal(result.startSeconds, 0);
  // Boundaries are 20/40/60/80; 60 is the largest <= the 60s cap.
  assert.equal(result.endSeconds, 60);
});

test('maximum duration is respected: the selected end is never greater than the cap', () => {
  const captionTiming = [
    { start_seconds: 0, duration_seconds: 15 },
    { start_seconds: 15, duration_seconds: 15 },
    { start_seconds: 30, duration_seconds: 15 },
    { start_seconds: 45, duration_seconds: 15 },
    { start_seconds: 60, duration_seconds: 15 }
  ];
  const result = selectShortFormSegment({
    visualTiming: captionTiming,
    captionTiming,
    narrationDurationSeconds: 75,
    maxDurationSeconds: 50
  });
  assert.equal(result.selected, true);
  assert.ok(result.endSeconds <= 50);
  assert.equal(result.endSeconds, 45);
});

test('timing boundaries remain valid: the selected end always equals an existing caption/visual boundary (or the full narration duration)', () => {
  const visualTiming = [
    { start_seconds: 0, duration_seconds: 12 },
    { start_seconds: 12, duration_seconds: 12 },
    { start_seconds: 24, duration_seconds: 12 }
  ];
  const captionTiming = [
    { start_seconds: 0, duration_seconds: 8 },
    { start_seconds: 8, duration_seconds: 8 },
    { start_seconds: 16, duration_seconds: 8 },
    { start_seconds: 24, duration_seconds: 8 }
  ];
  const result = selectShortFormSegment({ visualTiming, captionTiming, narrationDurationSeconds: 36, maxDurationSeconds: 20 });
  assert.equal(result.selected, true);
  const boundaries = new Set([
    ...visualTiming.map((v) => Math.round((v.start_seconds + v.duration_seconds) * 1000) / 1000),
    ...captionTiming.map((c) => Math.round((c.start_seconds + c.duration_seconds) * 1000) / 1000)
  ]);
  assert.ok(boundaries.has(result.endSeconds));
});

test('no valid segment fails safely: the very first boundary already exceeds the cap', () => {
  const timing = [{ start_seconds: 0, duration_seconds: 90 }];
  const result = selectShortFormSegment({
    visualTiming: timing,
    captionTiming: timing,
    narrationDurationSeconds: 90,
    maxDurationSeconds: 60
  });
  assert.equal(result.selected, false);
  assert.equal(result.reason, 'NO_VALID_SEGMENT');
});

test('fails safely on a non-positive narration duration', () => {
  const result = selectShortFormSegment({ visualTiming: [], captionTiming: [], narrationDurationSeconds: 0, maxDurationSeconds: 60 });
  assert.equal(result.selected, false);
  assert.equal(result.reason, 'NO_NARRATION_DURATION');
});

// --- trimVisualTiming / trimCaptionTiming ---

test('trimVisualTiming clips the segment straddling the cut and drops everything after it', () => {
  const visualTiming = [
    { start_seconds: 0, duration_seconds: 10, asset_id: 'a' },
    { start_seconds: 10, duration_seconds: 10, asset_id: 'b' },
    { start_seconds: 20, duration_seconds: 10, asset_id: 'c' }
  ];
  const trimmed = trimVisualTiming(visualTiming, 15);
  assert.equal(trimmed.length, 2);
  assert.equal(trimmed[0].asset_id, 'a');
  assert.equal(trimmed[0].duration_seconds, 10);
  assert.equal(trimmed[1].asset_id, 'b');
  assert.equal(trimmed[1].duration_seconds, 5);
  const total = trimmed.reduce((sum, s) => sum + s.duration_seconds, 0);
  assert.equal(Math.round(total * 1000) / 1000, 15);
});

test('trimCaptionTiming mirrors the same clipping discipline', () => {
  const captionTiming = [
    { start_seconds: 0, duration_seconds: 4, text: 'one' },
    { start_seconds: 4, duration_seconds: 4, text: 'two' },
    { start_seconds: 8, duration_seconds: 4, text: 'three' }
  ];
  const trimmed = trimCaptionTiming(captionTiming, 6);
  assert.equal(trimmed.length, 2);
  assert.equal(trimmed[1].text, 'two');
  assert.equal(trimmed[1].duration_seconds, 2);
});