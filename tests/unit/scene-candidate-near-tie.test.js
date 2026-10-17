import test from 'node:test';
import assert from 'node:assert/strict';
import { selectPerScene, NEAR_TIE_FRACTION } from '../../src/asset-provisioning/sceneCandidateSelection.js';

const pool = (...ids) => ids.map((id) => ({ id }));
const run = (scores, opts = {}) => selectPerScene({
  scenes: [0], pools: [pool(...Object.keys(scores))], scoreFor: (_s, c) => scores[c.id], ...opts
})[0];

test('near-tie: the pick is unchanged by diagnostics (best score, then lower index)', () => {
  const r = run({ a: 0.0953, b: 0.0954, c: 0.05 });
  assert.equal(r.pick, 'b');
  assert.equal(r.reason, 'ranked_over_first_hit');
  assert.equal(r.score, 0.0954);
  assert.equal(r.firstHitScore, 0.0953);
});

test('near-tie: a 0.0001 lead in a wide pool is flagged with runner-up and margin', () => {
  const r = run({ a: 0.0953, b: 0.0954, c: 0.05 });
  assert.equal(r.runnerUp, 'a');
  assert.equal(r.margin, 0.0001);
  assert.equal(r.spread, 0.0454);
  assert.equal(r.nearTie, true);
});

test('near-tie: a clear lead is not flagged', () => {
  const r = run({ a: 0.05, b: 0.11, c: 0.06 });
  assert.equal(r.pick, 'b');
  assert.equal(r.runnerUp, 'c');
  assert.equal(r.nearTie, false);
});

test('near-tie: threshold is a parameter, default exported', () => {
  assert.equal(NEAR_TIE_FRACTION, 0.1);
  const scores = { a: 0.08, b: 0.1, c: 0.0 }; // margin 0.02, spread 0.1 -> 20%
  assert.equal(run(scores).nearTie, false);
  assert.equal(run(scores, { nearTieFraction: 0.25 }).nearTie, true);
});

test('near-tie: single scored candidate or identical scores never flag a tie', () => {
  const one = run({ a: 0.07 });
  assert.equal(one.runnerUp, null); assert.equal(one.margin, null); assert.equal(one.nearTie, false);
  const flat = run({ a: 0.07, b: 0.07 });
  assert.equal(flat.pick, 'a'); assert.equal(flat.spread, 0); assert.equal(flat.nearTie, false);
});

test('near-tie: unscored and empty-pool paths keep their old shape', () => {
  const unscored = selectPerScene({ scenes: [0], pools: [pool('a', 'b')], scoreFor: () => NaN })[0];
  assert.equal(unscored.reason, 'unscored_first_hit'); assert.equal(unscored.pick, 'a');
  assert.equal('nearTie' in unscored, false);
  const empty = selectPerScene({ scenes: [0], pools: [[]], scoreFor: () => 0 })[0];
  assert.equal(empty.reason, 'empty_pool');
});

test('near-tie: earlier-scene skip rule still applies and runner-up excludes the pick', () => {
  const scenes = [0, 1, 2];
  const pools = [pool('x', 'y'), pool('p', 'q'), pool('x', 'z')];
  const sc = [{ x: 0.2, y: 0.1 }, { p: 0.2, q: 0.1 }, { x: 0.3, z: 0.29 }];
  const out = selectPerScene({ scenes, pools, scoreFor: (si, c) => sc[si][c.id] });
  assert.equal(out[2].pick, 'z'); // x was used by non-adjacent scene 0
  assert.notEqual(out[2].runnerUp, out[2].pick);
});
