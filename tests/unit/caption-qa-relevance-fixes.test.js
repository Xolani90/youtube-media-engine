import test from 'node:test';
import assert from 'node:assert/strict';
import { segmentCaptions } from '../../src/media/captionTiming.js';
import { resolveQaThresholds, QA_THRESHOLDS } from '../../src/media/qaWorker.js';
import { FINISH_AUDIO_TARGETS } from '../../src/media/finish.js';
import { LOUDNORM_TARGETS } from '../../src/media/render.js';
import { buildHitScreen } from '../../src/asset-provisioning/candidateGate.js';

test('captions: a dash glued between words gets spaces so no word is split', () => {
  const out = segmentCaptions('Owners lose hours in fast-casual restaurants—unless they automate.');
  assert.deepEqual(out, ['Owners lose hours in fast-casual restaurants — unless they automate.']);
  assert.ok(out.every((c) => !/\bs — /.test(c)));
});

test('captions: text without dashes is unchanged', () => {
  assert.deepEqual(segmentCaptions('A simple sentence. Another one.'), ['A simple sentence.', 'Another one.']);
});

test('QA: finished files are judged against the finish target, unfinished against the render target', () => {
  assert.equal(resolveQaThresholds({}).loudness.target_lufs, LOUDNORM_TARGETS.I);
  const t = resolveQaThresholds({ finished_audio_target: true });
  assert.equal(t.loudness.target_lufs, FINISH_AUDIO_TARGETS.I);
  assert.equal(t.true_peak.target_dbtp, FINISH_AUDIO_TARGETS.TP);
  assert.equal(t.loudness.warn_abs_deviation_lu, QA_THRESHOLDS.loudness.warn_abs_deviation_lu);
});

test('footage: a hit that only shares generic scene words with the scene is rejected when the query has content words', () => {
  const screen = buildHitScreen({ sceneText: 'Testing across 30,000 products showed higher engagement.', query: 'baseball merchandise' });
  assert.equal(screen({ id: 1, pageURL: 'a', tags: 'moon, night, products, sky' }).accept, false);
  assert.equal(screen({ id: 2, pageURL: 'b', tags: 'baseball, merchandise, store' }).accept, true);
});

test('footage: with no query the scene text still decides', () => {
  const screen = buildHitScreen({ sceneText: 'Coffee shop owners plan inventory.', query: '' });
  assert.equal(screen({ id: 1, pageURL: 'a', tags: 'coffee, cafe' }).accept, true);
  assert.equal(screen({ id: 2, pageURL: 'b', tags: 'moon, night' }).accept, false);
});
