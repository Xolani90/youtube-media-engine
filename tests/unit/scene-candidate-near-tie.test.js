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

// ---- Diagnostics are computed over the ELIGIBLE candidates (reuse rule applied) ----
// A candidate already used by a NON-adjacent earlier scene is skipped by the reuse rule.
// It must not appear as the runner-up, in the margin, in the spread, or in nearTie.
const pools3 = (third) => [pool('x'), pool('m'), third]; // scene 0 picks x, scene 1 is the adjacent filler
const run3 = (sc, third, opts = {}) => selectPerScene({
  scenes: [0, 1, 2], pools: pools3(third), scoreFor: (_s, c) => sc[c.id], ...opts
})[2];

test('eligible diagnostics: skipped used candidate is not the runner-up; margin and spread cover eligible only', () => {
  const r = run3({ x: 0.9, m: 0.5, y: 0.6, z: 0.1 }, pool('x', 'y', 'z'));
  assert.equal(r.pick, 'y');
  assert.equal(r.score, 0.6);
  assert.equal(r.runnerUp, 'z');
  assert.equal(r.runnerUpScore, 0.1);
  assert.equal(r.margin, 0.5);
  assert.equal(r.spread, 0.5);
  assert.equal(r.nearTie, false); // old code reported margin 0 / nearTie true against skipped x
  assert.equal(r.skippedUsed, true);
});

test('eligible diagnostics: nearTie reflects the eligible candidates, not the skipped one', () => {
  const close = run3({ x: 0.9, m: 0.5, y: 0.6, z: 0.595, w: 0.1 }, pool('x', 'y', 'z', 'w'));
  assert.equal(close.pick, 'y');
  assert.equal(close.runnerUp, 'z');
  assert.equal(close.margin, 0.005);
  assert.equal(close.spread, 0.5);
  assert.equal(close.nearTie, true); // genuinely close: y vs z
  assert.equal(close.skippedUsed, true);
});

test('eligible diagnostics: a candidate skipped by reuse does not widen the spread', () => {
  const r = run3({ x: 0.99, m: 0.5, y: 0.2, z: 0.1 }, pool('x', 'y', 'z'));
  assert.equal(r.spread, 0.1); // 0.2 - 0.1, not 0.99 - 0.1
  assert.equal(r.margin, 0.1);
  assert.equal(r.runnerUp, 'z');
});

test('eligible diagnostics: no skip means skippedUsed is false and results match the plain case', () => {
  const r = run({ a: 0.05, b: 0.11, c: 0.06 });
  assert.equal(r.skippedUsed, false);
  assert.equal(r.runnerUp, 'c');
  assert.equal(r.margin, 0.05);
  assert.equal(r.spread, 0.06);
});

test('eligible diagnostics: a single eligible candidate has no runner-up', () => {
  const r = run3({ x: 0.9, m: 0.5, y: 0.6 }, pool('x', 'y')); // x skipped, y is the only eligible
  assert.equal(r.pick, 'y');
  assert.equal(r.runnerUp, null);
  assert.equal(r.runnerUpScore, null);
  assert.equal(r.margin, null);
  assert.equal(r.spread, 0);
  assert.equal(r.nearTie, false);
  assert.equal(r.skippedUsed, true);
});

test('eligible diagnostics: equal scores among eligible candidates (exact tie) keep the documented nearTie contract', () => {
  const r = run3({ x: 0.9, m: 0.5, y: 0.5, z: 0.5, w: 0.5 }, pool('x', 'y', 'z', 'w'));
  assert.equal(r.pick, 'y'); // lowest index wins, unchanged
  assert.equal(r.runnerUp, 'z');
  assert.equal(r.margin, 0);
  assert.equal(r.spread, 0);
  assert.equal(r.nearTie, false); // spread 0: ranking carries no signal; flagged by margin 0 / spread 0, not nearTie
  assert.equal(r.skippedUsed, true);
});

test('eligible diagnostics: skipping an equally scored used candidate is not a skip of a higher score', () => {
  // x was used by non-adjacent scene 0 and ranks first by index at scene 2; y has the same score.
  const r = run3({ x: 0.7, m: 0.5, y: 0.7, z: 0.2 }, pool('x', 'y', 'z'));
  assert.equal(r.pick, 'y');
  assert.equal(r.skippedUsed, false); // no higher-scoring candidate was skipped
  assert.equal(r.runnerUp, 'z');
});

test('eligible diagnostics: skippedUsed stays true when a strictly higher score was skipped', () => {
  const r = run3({ x: 0.71, m: 0.5, y: 0.7, z: 0.2 }, pool('x', 'y', 'z'));
  assert.equal(r.pick, 'y');
  assert.equal(r.skippedUsed, true);
});

test('eligible diagnostics: zero scores are real scores, and zero spread is handled', () => {
  const allZero = run({ a: 0, b: 0, c: 0 });
  assert.equal(allZero.pick, 'a');
  assert.equal(allZero.reason, 'first_hit_is_best');
  assert.equal(allZero.score, 0);
  assert.equal(allZero.margin, 0);
  assert.equal(allZero.spread, 0);
  assert.equal(allZero.nearTie, false);
  const mixed = run({ a: 0, b: 0.2, c: 0 });
  assert.equal(mixed.pick, 'b');
  assert.equal(mixed.runnerUp, 'a'); // equal scores: lower index first
  assert.equal(mixed.margin, 0.2);
  assert.equal(mixed.spread, 0.2);
  assert.equal(mixed.nearTie, false);
  const lone = run({ a: 0 });
  assert.equal(lone.pick, 'a'); assert.equal(lone.score, 0); assert.equal(lone.runnerUp, null);
});

test('reuse policy unchanged: when every scored candidate was used earlier, the top score is still picked and nothing is excluded', () => {
  const sc = { x: 0.9, p: 0.8, m: 0.1 };
  const out = selectPerScene({
    scenes: [0, 1, 2, 3], pools: [pool('x'), pool('p'), pool('m'), pool('x', 'p')], scoreFor: (_s, c) => sc[c.id]
  });
  const r = out[3];
  assert.equal(r.pick, 'x');
  assert.equal(r.skippedUsed, false); // fallback: nothing was excluded
  assert.equal(r.runnerUp, 'p');
  assert.equal(r.margin, 0.1);
  assert.equal(r.spread, 0.1);
  assert.equal(r.nearTie, false);
});

test('reuse policy unchanged: the immediately previous scene may be reused and is not a skip', () => {
  const sc = { x: 0.9, y: 0.4 };
  const out = selectPerScene({
    scenes: [0, 1], pools: [pool('x'), pool('x', 'y')], scoreFor: (_s, c) => sc[c.id]
  });
  assert.equal(out[1].pick, 'x');
  assert.equal(out[1].reusesPrevious, true);
  assert.equal(out[1].skippedUsed, false);
  assert.equal(out[1].runnerUp, 'y');
  assert.equal(out[1].margin, 0.5);
});

test('ordering and determinism unchanged: equal scores pick the lowest index, repeat runs are identical, inputs are not mutated', () => {
  const scenes = [0, 1, 2];
  const pools = [pool('x', 'a'), pool('m', 'b'), pool('x', 'c', 'd')];
  const sc = { x: 0.7, a: 0.7, m: 0.5, b: 0.5, c: 0.6, d: 0.6 };
  const snapshot = JSON.stringify({ scenes, pools });
  const args = { scenes, pools, scoreFor: (_s, c) => sc[c.id] };
  const a = selectPerScene(args);
  const b = selectPerScene(args);
  assert.deepEqual(a, b);
  assert.equal(JSON.stringify({ scenes, pools }), snapshot);
  assert.deepEqual(a.map((r) => r.pick), ['x', 'm', 'c']); // scene 2: x used by scene 0 -> c over d (lower index)
  assert.equal(a[2].runnerUp, 'd');
  assert.equal(a[2].margin, 0);
});

test('selection policy unchanged: picks equal the original rule over many seeded random pools', () => {
  let seed = 20261018;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
  for (let n = 0; n < 300; n++) {
    const sceneCount = 2 + Math.floor(rnd() * 5);
    const ids = ['a', 'b', 'c', 'd', 'e', 'f'];
    const pools = []; const scores = [];
    for (let s = 0; s < sceneCount; s++) {
      const size = Math.floor(rnd() * 5); // 0..4, includes empty pools
      const chosen = ids.filter(() => rnd() < size / 6).slice(0, size);
      pools.push(chosen.map((id) => ({ id })));
      scores.push(Object.fromEntries(chosen.map((id) => [id, Math.round(rnd() * 5) / 5]))); // coarse -> many ties and zeros
    }
    const out = selectPerScene({ scenes: Array.from({ length: sceneCount }, (_, i) => i), pools, scoreFor: (si, c) => scores[si][c.id] });
    // independent reference of the ORIGINAL pick rule
    const picks = [];
    for (let si = 0; si < sceneCount; si++) {
      const pl = pools[si];
      if (pl.length === 0) { picks.push(null); continue; }
      const scored = pl.map((c, ci) => ({ ci, id: c.id, score: scores[si][c.id] }));
      const used = new Set(picks.slice(0, Math.max(0, si - 1)).filter(Boolean));
      const order = [...scored].sort((x, y) => (y.score - x.score) || (x.ci - y.ci));
      picks.push((order.find((e) => !used.has(e.id)) ?? order[0]).id);
      // diagnostics invariants on every scored scene
      const r = out[si];
      assert.equal(r.pick, picks[si], `case ${n} scene ${si}`);
      assert.ok(r.margin === null || r.margin >= 0);
      assert.ok(r.spread >= (r.margin ?? 0));
      assert.notEqual(r.runnerUp, r.pick);
      if (r.skippedUsed) assert.ok(order[0].score > r.score);
    }
  }
});
