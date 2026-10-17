import test from 'node:test';
import assert from 'node:assert/strict';
import { selectPerScene } from '../../src/asset-provisioning/sceneCandidateSelection.js';

const pool = (...ids) => ids.map((id) => ({ id }));
const scoreFrom = (m) => (si, c) => (m[si] && c.id in m[si] ? m[si][c.id] : NaN);

test('picks the best-scoring candidate within each scene own pool only', () => {
  const r = selectPerScene({ scenes: [0, 1], pools: [pool('a1', 'a2'), pool('b1', 'b2')],
    scoreFrom: undefined, scoreFor: scoreFrom({ 0: { a1: 0.01, a2: 0.09 }, 1: { b1: 0.08, b2: 0.02 } }) });
  assert.deepEqual(r.map((x) => x.pick), ['a2', 'b1']);
  assert.equal(r[0].reason, 'ranked_over_first_hit');
  assert.equal(r[1].reason, 'first_hit_is_best');
});

test('an image from another scene pool is never considered (no global forcing)', () => {
  const r = selectPerScene({ scenes: [0, 1], pools: [pool('a1'), pool('b1')],
    scoreFor: scoreFrom({ 0: { a1: -0.5 }, 1: { b1: -0.5 } }) });
  assert.deepEqual(r.map((x) => x.pick), ['a1', 'b1']); // low scores are still own-pool picks
});

test('unscored scene falls back to the first hit', () => {
  const r = selectPerScene({ scenes: [0], pools: [pool('a1', 'a2')], scoreFor: () => null });
  assert.equal(r[0].pick, 'a1'); assert.equal(r[0].reason, 'unscored_first_hit');
});

test('empty pool yields no pick', () => {
  const r = selectPerScene({ scenes: [0], pools: [[]], scoreFor: () => 1 });
  assert.equal(r[0].pick, null);
});

test('adjacent reuse is kept (caller folds the span); non-adjacent reuse is skipped', () => {
  const adj = selectPerScene({ scenes: [0, 1], pools: [pool('x', 'a'), pool('x', 'b')],
    scoreFor: scoreFrom({ 0: { x: 0.9, a: 0.1 }, 1: { x: 0.8, b: 0.1 } }) });
  assert.deepEqual(adj.map((r) => r.pick), ['x', 'x']); assert.equal(adj[1].reusesPrevious, true);
  const far = selectPerScene({ scenes: [0, 1, 2], pools: [pool('x'), pool('y'), pool('x', 'z')],
    scoreFor: scoreFrom({ 0: { x: 0.9 }, 1: { y: 0.5 }, 2: { x: 0.8, z: 0.1 } }) });
  assert.equal(far[2].pick, 'z');
});

test('deterministic: equal scores keep pool order', () => {
  const a = selectPerScene({ scenes: [0], pools: [pool('p', 'q')], scoreFor: () => 0.5 });
  assert.equal(a[0].pick, 'p');
});
