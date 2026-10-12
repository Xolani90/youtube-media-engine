import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateManifest, rankingMetrics, assignmentMetrics, thresholdTable, evaluate, wilson } from '../../scripts/eval-scene-assignment-quality-lib.js';

// Synthetic matrices test the HARNESS only. They say nothing about SigLIP's real quality.
const manifest = () => ({
  images: [
    { id: 'A', file: 'a', license: 'x', source: 'x' }, { id: 'B', file: 'b', license: 'x', source: 'x' },
    { id: 'C', file: 'c', license: 'x', source: 'x' }, { id: 'X', file: 'x', kind: 'corrupt' }
  ],
  scenes: [
    { id: 's1', text: 'scene one', relevant: ['A'], hardNegatives: ['B'] },
    { id: 's2', text: 'scene two', relevant: ['B'], hardNegatives: [] },
    { id: 's3', text: 'scene three', relevant: [], hardNegatives: ['C'] }
  ]
});
//            A     B     C     X
const GOOD = [[0.30, 0.10, 0.05, null], [0.05, 0.28, 0.10, null], [0.02, 0.03, 0.12, null]];

test('manifest validation: provenance, unique texts, unknown refs, relevant/hard-negative overlap', () => {
  assert.doesNotThrow(() => validateManifest(manifest()));
  const noLicence = manifest(); delete noLicence.images[0].license;
  assert.throws(() => validateManifest(noLicence), /provenance/);
  const dup = manifest(); dup.scenes[1].text = 'scene one';
  assert.throws(() => validateManifest(dup), /unique/);
  const unk = manifest(); unk.scenes[0].relevant = ['nope'];
  assert.throws(() => validateManifest(unk), /unknown image/);
  const both = manifest(); both.scenes[0].hardNegatives = ['A'];
  assert.throws(() => validateManifest(both), /cannot be relevant and a hard negative/);
});

test('ranking metrics: top-1, MRR, hard negative at rank 1, margin, unusable column ignored', () => {
  const m = manifest();
  const r = rankingMetrics(m, [[0.1, 0.3, 0.05, null], ...GOOD.slice(1)]);
  assert.equal(r[0].top1, 'B');
  assert.equal(r[0].top1Relevant, false);
  assert.equal(r[0].top1HardNegative, true);
  assert.equal(r[0].reciprocalRank, 0.5);
  assert.equal(r[1].top1Relevant, true);
  assert.equal(r[1].margin, 0.18);
  assert.equal(r[2].hasRelevant, false);
});

test('assignment on good scores: all relevant scenes correct, but a scene with no relevant image is still filled', () => {
  const m = manifest();
  for (const mode of ['on', 'batch', 'batch-all']) {
    const a = assignmentMetrics(m, GOOD, mode);
    assert.deepEqual(a.picks.slice(0, 2), ['A', 'B'], mode);
    assert.equal(a.rows[2].relevant, false);
    assert.equal(a.noRelevantSceneFilled, 1, `${mode}: no confidence rejection exists, so s3 gets an image anyway`);
    assert.equal(a.hardNegativeSelected, 1); // C chosen for s3
    assert.equal(a.unusableSelected, 0);
  }
});

test('greedy no-reuse forces a weak pick: two scenes wanting the same image', () => {
  const m = manifest();
  const scores = [[0.30, 0.10, 0.05, null], [0.29, 0.12, 0.05, null], [0.02, 0.03, 0.12, null]];
  m.scenes[1].relevant = ['A']; // both s1 and s2 truly want A
  const a = assignmentMetrics(m, scores, 'batch');
  assert.equal(a.picks[0], 'A');
  assert.notEqual(a.picks[1], 'A'); // s2 pushed onto a worse image
  assert.equal(a.rows[1].relevant, false);
  assert.ok(a.forcedOffTop1 >= 1);
});

test('threshold table is descriptive: precision/coverage per observed score', () => {
  const a = assignmentMetrics(manifest(), GOOD, 'batch');
  const t = thresholdTable(a);
  assert.equal(t[0].coverage, 1);
  assert.ok(t.every((x) => x.precision >= 0 && x.precision <= 1));
});

test('evaluate: deterministic, equivalence flags, shape validation, Wilson interval', () => {
  const r1 = evaluate(manifest(), GOOD);
  const r2 = evaluate(manifest(), GOOD);
  assert.equal(JSON.stringify(r1), JSON.stringify(r2));
  assert.equal(r1.ranking.top1Accuracy, 1);
  assert.deepEqual(Object.values(r1.selectionEquivalence), [true, true, true]);
  assert.throws(() => evaluate(manifest(), [[1, 2]]), /shape/);
  assert.deepEqual(wilson(0, 0), null);
  const [lo, hi] = wilson(9, 10);
  assert.ok(lo > 0.55 && hi <= 1);
});
