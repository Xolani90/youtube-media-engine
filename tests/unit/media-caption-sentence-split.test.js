import { test } from 'node:test';
import assert from 'node:assert/strict';
import { segmentCaptions, computeCaptionTiming } from '../../src/media/captionTiming.js';

test('S1. decimals, versions and domains are never split mid-token', () => {
  assert.deepEqual(
    segmentCaptions('Usage grew 51.3% in 2025 per blog.google. GPT-4.5 leads. Is it true? Yes!'),
    ['Usage grew 51.3% in 2025 per blog.google.', 'GPT-4.5 leads.', 'Is it true?', 'Yes!']
  );
});

test('S2. closing quotes/brackets and ellipsis stay with their sentence', () => {
  assert.deepEqual(
    segmentCaptions('He said "stop." Then left\u2026 Really? (Yes.) Done.'),
    ['He said "stop."', 'Then left\u2026', 'Really?', '(Yes.)', 'Done.']
  );
});

test('S3. text without terminal punctuation stays one caption; runs of punctuation stay attached', () => {
  assert.deepEqual(segmentCaptions('no punctuation here'), ['no punctuation here']);
  assert.deepEqual(segmentCaptions('Wait... what?!  Fine.'), ['Wait...', 'what?!', 'Fine.']);
});

test('S4. an over-long sentence is still wrapped at word boundaries', () => {
  assert.deepEqual(segmentCaptions('aaa bbb ccc ddd eee fff.', 10), ['aaa bbb', 'ccc ddd', 'eee fff.']);
});

test('S5. segmenting paragraphs joined by a blank line equals segmenting each paragraph alone', () => {
  const paras = ['Usage grew 51.3% this year.', 'Claude 3.5 is out. It is fast.', 'Visit blog.google today.'];
  assert.deepEqual(segmentCaptions(paras.join('\n\n')), paras.flatMap((p) => segmentCaptions(p)));
});

test('S6. caption timing over decimal-bearing text still ends exactly at the narration duration', () => {
  const timing = computeCaptionTiming(segmentCaptions('Usage grew 51.3% this year. It is fast.'), 10);
  assert.equal(timing.length, 2);
  const last = timing[timing.length - 1];
  assert.equal(Math.round((last.start_seconds + last.duration_seconds) * 1000) / 1000, 10);
});
