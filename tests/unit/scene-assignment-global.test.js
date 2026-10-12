import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  maximizeAssignment, orderAssetsForSlotsGlobal, orderAssetsForSlotsBatch,
  resolveSceneAssignmentMode, assignAssetsForSlots
} from '../../src/media/sceneAssignment.js';

const A = (id) => ({ id, asset_type: 'image', location: `/img/${id}.png` });
// Synthetic ranker: matrix keyed by slot text, one score per asset (in asset order).
const matrixRank = (m, { ok = true } = {}) => ({ texts, images }) => (ok
  ? { ok: true, texts, images, scores: texts.map((t) => m[t]) }
  : { ok: false, reason: 'down' });
const ids = (arr) => arr.map((a) => a.id);
const total = (m, slotTexts, order) => slotTexts.reduce((s, t, i) => s + m[t][Number(order[i].id.slice(1))], 0);

// Reported conflict, synthetic: assets a0=server rack, a1=switchgear cabinets.
// Slot "dc" (data centre) likes a1 a little more than a0; slot "sw" needs a1 a lot.
const CONFLICT = { dc: [0.070, 0.074], sw: [0.054, 0.117] };
const CONFLICT_SLOTS = ['dc', 'sw'];

test('greedy loses total score on the reported data-centre vs switchgear conflict; global does not', () => {
  const assets = [A('a0'), A('a1')];
  const greedy = orderAssetsForSlotsBatch(assets, CONFLICT_SLOTS, { rankBatch: matrixRank(CONFLICT) });
  assert.deepEqual(ids(greedy), ['a1', 'a0']);
  assert.ok(Math.abs(total(CONFLICT, CONFLICT_SLOTS, greedy) - (0.074 + 0.054)) < 1e-12);
  const global = orderAssetsForSlotsGlobal(assets, CONFLICT_SLOTS, { rankBatch: matrixRank(CONFLICT) });
  assert.deepEqual(ids(global), ['a0', 'a1']);
  assert.ok(Math.abs(total(CONFLICT, CONFLICT_SLOTS, global) - (0.070 + 0.117)) < 1e-12);
});

test('global total >= greedy total on a 4x4 fixture where greedy is strictly worse', () => {
  const m = { s0: [0.9, 0.8, 0.1, 0.1], s1: [0.9, 0.1, 0.1, 0.1], s2: [0.1, 0.1, 0.7, 0.6], s3: [0.1, 0.1, 0.7, 0.1] };
  const slots = ['s0', 's1', 's2', 's3'];
  const assets = ['a0', 'a1', 'a2', 'a3'].map(A);
  const g = orderAssetsForSlotsBatch(assets, slots, { rankBatch: matrixRank(m) });
  const o = orderAssetsForSlotsGlobal(assets, slots, { rankBatch: matrixRank(m) });
  assert.equal(ids(g)[0], 'a0'); // greedy: s0 takes a0 (0.9), starving s1
  assert.ok(Math.abs(total(m, slots, g) - 1.8) < 1e-12);
  assert.ok(Math.abs(total(m, slots, o) - 3.0) < 1e-12);
  assert.ok(total(m, slots, o) > total(m, slots, g));
  assert.deepEqual(ids(o), ['a1', 'a0', 'a3', 'a2']);
});

test('maximizeAssignment matches brute force on random matrices (incl. rows < cols)', () => {
  let seed = 7; const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648 - 0.3;
  const brute = (M) => { let best = -Infinity; const R = M.length, C = M[0].length;
    const rec = (i, used, sum) => { if (i === R) { best = Math.max(best, sum); return; }
      for (let j = 0; j < C; j++) if (!used.has(j)) { used.add(j); rec(i + 1, used, sum + M[i][j]); used.delete(j); } };
    rec(0, new Set(), 0); return best; };
  for (let k = 0; k < 60; k++) {
    const R = 1 + (k % 4), C = R + (k % 3);
    const M = Array.from({ length: R }, () => Array.from({ length: C }, rnd));
    const cols = maximizeAssignment(M);
    assert.equal(new Set(cols).size, R);
    const sum = cols.reduce((s, j, i) => s + M[i][j], 0);
    assert.ok(Math.abs(sum - brute(M)) < 1e-9, `case ${k}`);
  }
  assert.deepEqual(maximizeAssignment([]), []);
  assert.throws(() => maximizeAssignment([[1], [2]]));
});

test('fewer slots than images: unassigned images follow, no duplicates, total optimal', () => {
  const m = { x: [0.1, 0.9, 0.2, 0.3], y: [0.1, 0.8, 0.7, 0.3] };
  const assets = ['a0', 'a1', 'a2', 'a3'].map(A);
  const out = orderAssetsForSlotsGlobal(assets, ['x', 'y'], { rankBatch: matrixRank(m) });
  assert.deepEqual(ids(out), ['a1', 'a2', 'a0', 'a3']); // x->a1 (0.9) + y->a2 (0.7) = 1.6, optimal
  assert.equal(new Set(ids(out)).size, 4);
});

test('more slots than images: first n slots optimised, length stays n (cyclic reuse by sequencer)', () => {
  const m = { p: [0.9, 0.1], q: [0.8, 0.2], r: [0.1, 0.9] };
  const out = orderAssetsForSlotsGlobal([A('a0'), A('a1')], ['p', 'q', 'r'], { rankBatch: matrixRank(m) });
  assert.equal(out.length, 2);
  assert.deepEqual(ids(out), ['a0', 'a1']); // p,q compete for a0: p+q best = p->a0,q->a1 (0.9+0.2) vs q->a0,p->a1 (0.8+0.1)
});

test('empty and unusable inputs return current order without calling the ranker', () => {
  let calls = 0; const rb = () => { calls++; return { ok: false }; };
  const assets = [A('a0'), A('a1')];
  assert.deepEqual(ids(orderAssetsForSlotsGlobal([], ['t'], { rankBatch: rb })), []);
  assert.deepEqual(ids(orderAssetsForSlotsGlobal(assets, [], { rankBatch: rb })), ['a0', 'a1']);
  assert.deepEqual(ids(orderAssetsForSlotsGlobal(assets, ['  ', null], { rankBatch: rb })), ['a0', 'a1']);
  assert.deepEqual(ids(orderAssetsForSlotsGlobal([A('a0')], ['t'], { rankBatch: rb })), ['a0']);
  assert.deepEqual(ids(orderAssetsForSlotsGlobal([A('a0'), { id: 'v', asset_type: 'video', location: '/v.mp4' }], ['t', 'u'], { rankBatch: rb })), ['a0', 'v']);
  assert.deepEqual(ids(orderAssetsForSlotsGlobal([A('a0'), { ...A('a1'), location: '/img/a0.png' }], ['t', 'u'], { rankBatch: rb })), ['a0', 'a1']);
  assert.equal(calls, 0);
  assert.equal(orderAssetsForSlotsGlobal(null, ['t'], { rankBatch: rb }).length, 0);
});

test('ranker failure, throw, bad shape and non-finite rows fall back per existing convention', () => {
  const assets = [A('a0'), A('a1')];
  assert.deepEqual(ids(orderAssetsForSlotsGlobal(assets, ['x', 'y'], { rankBatch: matrixRank({}, { ok: false }) })), ['a0', 'a1']);
  assert.deepEqual(ids(orderAssetsForSlotsGlobal(assets, ['x', 'y'], { rankBatch: () => { throw new Error('boom'); } })), ['a0', 'a1']);
  assert.deepEqual(ids(orderAssetsForSlotsGlobal(assets, ['x', 'y'], { rankBatch: () => ({ ok: true, scores: [[1]] }) })), ['a0', 'a1']);
  // slot 0 has an unscorable (null) cell -> unassignable; slot 1 still gets its best (a0); slot 0 takes the free a1
  const m = { x: [null, 0.5], y: [0.9, 0.1] };
  assert.deepEqual(ids(orderAssetsForSlotsGlobal(assets, ['x', 'y'], { rankBatch: matrixRank(m) })), ['a1', 'a0']);
});

test('deterministic tie-breaking: identical inputs give identical output; ties prefer lowest asset index', () => {
  const m = { s0: [0.5, 0.5, 0.5], s1: [0.5, 0.5, 0.5], s2: [0.5, 0.5, 0.5] };
  const assets = ['a0', 'a1', 'a2'].map(A);
  const first = ids(orderAssetsForSlotsGlobal(assets, ['s0', 's1', 's2'], { rankBatch: matrixRank(m) }));
  for (let i = 0; i < 5; i++) assert.deepEqual(ids(orderAssetsForSlotsGlobal(assets, ['s0', 's1', 's2'], { rankBatch: matrixRank(m) })), first);
  assert.deepEqual(first, ['a0', 'a1', 'a2']);
  // duplicate slot texts are valid; each slot still gets a distinct asset
  const dup = ids(orderAssetsForSlotsGlobal(assets, ['s0', 's0', 's0'], { rankBatch: matrixRank(m) }));
  assert.equal(new Set(dup).size, 3);
});

test('never returns duplicate images and does not mutate the input', () => {
  const m = { p: [0.3, 0.9, 0.2], q: [0.3, 0.9, 0.2], r: [0.3, 0.9, 0.2] };
  const assets = ['a0', 'a1', 'a2'].map(A);
  const snapshot = ids(assets);
  const out = orderAssetsForSlotsGlobal(assets, ['p', 'q', 'r'], { rankBatch: matrixRank(m) });
  assert.equal(new Set(ids(out)).size, out.length);
  assert.deepEqual(ids(assets), snapshot);
  assert.notEqual(out, assets);
});

test('mode resolution: global is opt-in; default and existing values unchanged', () => {
  assert.equal(resolveSceneAssignmentMode({}), 'off');
  assert.equal(resolveSceneAssignmentMode({ SCENE_RELEVANCE_ASSIGN: 'global' }), 'global');
  assert.equal(resolveSceneAssignmentMode({ SCENE_RELEVANCE_ASSIGN: ' GLOBAL ' }), 'global');
  assert.equal(resolveSceneAssignmentMode({ SCENE_RELEVANCE_ASSIGN: 'on' }), 'on');
  assert.equal(resolveSceneAssignmentMode({ SCENE_RELEVANCE_ASSIGN: 'batch' }), 'batch');
  assert.equal(resolveSceneAssignmentMode({ SCENE_RELEVANCE_ASSIGN: 'batch-all' }), 'batch-all');
  assert.throws(() => resolveSceneAssignmentMode({ SCENE_RELEVANCE_ASSIGN: 'globl' }));
});

test('dispatcher: global selects the new mode; batch still greedy; off returns the same array', () => {
  const assets = [A('a0'), A('a1')];
  const rankBatch = matrixRank(CONFLICT);
  assert.deepEqual(ids(assignAssetsForSlots(assets, CONFLICT_SLOTS, { env: { SCENE_RELEVANCE_ASSIGN: 'global' }, rankBatch })), ['a0', 'a1']);
  assert.deepEqual(ids(assignAssetsForSlots(assets, CONFLICT_SLOTS, { env: { SCENE_RELEVANCE_ASSIGN: 'batch' }, rankBatch })), ['a1', 'a0']);
  assert.equal(assignAssetsForSlots(assets, CONFLICT_SLOTS, { env: {}, rankBatch }), assets);
});
