import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectShortFormSegment } from '../../src/media/shortFormSelection.js';
import { buildCaptionForceStyle } from '../../src/media/render.js';
import { CAPTION_DEFAULTS, SHORT_FORM_CAPTION_DEFAULTS } from '../../src/media/constants.js';

test('short-form cut prefers the last SENTENCE end inside the cap over a later mid-sentence chunk boundary', () => {
  const captionTiming = [
    { text: 'First sentence ends here.', start_seconds: 0, duration_seconds: 30 },
    { text: 'The second one starts and', start_seconds: 30, duration_seconds: 20 },
    { text: 'keeps going while long-term', start_seconds: 50, duration_seconds: 8 },
    { text: 'and finally ends.', start_seconds: 58, duration_seconds: 12 }
  ];
  const r = selectShortFormSegment({ visualTiming: captionTiming, captionTiming, narrationDurationSeconds: 70, maxDurationSeconds: 60 });
  assert.equal(r.selected, true);
  assert.equal(r.endSeconds, 30);
});

test('closing quote/bracket after the terminal punctuation still counts as a sentence end', () => {
  const captionTiming = [
    { text: 'He said \u201Cdone.\u201D', start_seconds: 0, duration_seconds: 40 },
    { text: 'and then more words', start_seconds: 40, duration_seconds: 15 },
    { text: 'tail', start_seconds: 55, duration_seconds: 20 }
  ];
  const r = selectShortFormSegment({ visualTiming: captionTiming, captionTiming, narrationDurationSeconds: 75, maxDurationSeconds: 60 });
  assert.equal(r.endSeconds, 40);
});

test('no sentence end inside the cap: falls back to the nearest boundary (previous behaviour)', () => {
  const captionTiming = [
    { text: 'no terminal punctuation', start_seconds: 0, duration_seconds: 25 },
    { text: 'still none', start_seconds: 25, duration_seconds: 25 },
    { text: 'end.', start_seconds: 50, duration_seconds: 30 }
  ];
  const r = selectShortFormSegment({ visualTiming: captionTiming, captionTiming, narrationDurationSeconds: 80, maxDurationSeconds: 60 });
  assert.equal(r.endSeconds, 50);
});

test('long-form caption style is unchanged when no captionStyle is given', () => {
  const s = buildCaptionForceStyle({ height: 720 });
  assert.match(s, new RegExp(`FontSize=${CAPTION_DEFAULTS.FONT_SIZE}(,|$)`));
  assert.match(s, new RegExp(`MarginV=${CAPTION_DEFAULTS.MARGIN_V}(,|$)`));
  assert.doesNotMatch(s, /MarginL/);
});

test('short-form caption style converts output pixels to libass units for the 1920px frame', () => {
  const s = buildCaptionForceStyle({
    height: 1920,
    captionStyle: { fontSizePx: SHORT_FORM_CAPTION_DEFAULTS.FONT_SIZE_PX, marginVPx: SHORT_FORM_CAPTION_DEFAULTS.MARGIN_V_PX, marginHPx: SHORT_FORM_CAPTION_DEFAULTS.MARGIN_H_PX }
  });
  assert.match(s, /FontSize=10(,|$)/);  // 66px * 288/1920 = 9.9
  assert.match(s, /MarginV=63(,|$)/);   // 420px * 288/1920 = 63
  assert.match(s, /MarginL=14,MarginR=14/);
});
