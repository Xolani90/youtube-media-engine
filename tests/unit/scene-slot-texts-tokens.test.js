import { test } from 'node:test';
import assert from 'node:assert/strict';
import { segmentCaptions, computeCaptionTiming } from '../../src/media/captionTiming.js';
import { computeSequenceSlotTexts } from '../../src/media/visualSequencing.js';

const TEXT = 'Usage grew 51.3% in 2025 per blog.google. GPT-4.5 leads the field. Is it true? Yes! Claude 3.5 is out. It is fast.';

function slotsFor(duration) {
  const captions = segmentCaptions(TEXT);
  const timing = computeCaptionTiming(captions, duration);
  return { captions, slots: computeSequenceSlotTexts(timing) };
}

/** Each slot must equal a run of whole consecutive captions joined by a space. */
function assertWholeCaptionRuns(captions, slots) {
  let i = 0;
  for (const slot of slots) {
    let acc = '';
    while (i < captions.length && acc !== slot) {
      acc = acc ? acc + ' ' + captions[i] : captions[i];
      i += 1;
    }
    assert.equal(acc, slot, 'slot is not a run of whole captions: ' + slot);
  }
  assert.equal(i, captions.length, 'every caption is used by exactly one slot');
}

for (const duration of [20, 4]) {
  test('slot texts at ' + duration + 's are whole-caption runs and keep decimals/versions/domains intact', () => {
    const { captions, slots } = slotsFor(duration);
    assert.ok(slots.length >= 1);
    assertWholeCaptionRuns(captions, slots);
    assert.equal(slots.join(' '), captions.join(' '), 'no text lost or reordered');
    for (const token of ['51.3%', 'GPT-4.5', 'blog.google.', '3.5']) {
      assert.equal(slots.filter((s) => s.includes(token)).length, 1, token + ' sits whole in exactly one slot');
    }
    for (const s of slots) assert.doesNotMatch(s, /^\d+\.$|\s\d+\.$/, 'no slot ends on a bare number-dot fragment');
  });
}

test('slot texts are deterministic for identical input', () => {
  assert.deepEqual(slotsFor(20).slots, slotsFor(20).slots);
});
