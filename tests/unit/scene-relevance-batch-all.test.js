import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { rankSceneBatch } from '../../src/media/sceneRelevanceBatch.js';
import {
  orderAssetsForSlotsBatch, orderAssetsForSlotsBatchAll, resolveSceneAssignmentMode, assignAssetsForSlots
} from '../../src/media/sceneAssignment.js';
import { computeVisualSequencing, computeSequenceSlotTexts } from '../../src/media/visualSequencing.js';

const FAKE = fileURLToPath(new URL('../helpers/fakeSceneBatchWorker.js', import.meta.url));
const fakeBatch = (env = {}) => (req) => rankSceneBatch(req, { workerPath: FAKE, timeoutMs: 20000, env: { ...process.env, ...env } });
const A = (id) => ({ id, asset_type: 'image', location: `/img/${id}.png` });
const ids = (xs) => xs.map((a) => a.id);
// Fake rule: text "scene <d> ..." scores asset a<d> 0.9, others 0.1.
const T = (d, k = '') => `scene ${d} ${k}`.trim();

test('mode resolution accepts batch-all; default stays off; invalid still throws', () => {
  assert.equal(resolveSceneAssignmentMode({}), 'off');
  assert.equal(resolveSceneAssignmentMode({ SCENE_RELEVANCE_ASSIGN: 'BATCH-ALL' }), 'batch-all');
  assert.equal(resolveSceneAssignmentMode({ SCENE_RELEVANCE_ASSIGN: 'batch' }), 'batch');
  assert.throws(() => resolveSceneAssignmentMode({ SCENE_RELEVANCE_ASSIGN: 'all' }));
});

test('slots beyond asset count are ranked, not cycled; first n slots equal batch', () => {
  const assets = [A('a0'), A('a1'), A('a2')];
  const slots = [T(0, 'x'), T(1, 'x'), T(2, 'x'), T(1, 'y'), T(0, 'y'), T(2, 'y')];
  const out = orderAssetsForSlotsBatchAll(assets, slots, { rankBatch: fakeBatch() });
  assert.deepEqual(ids(out), ['a0', 'a1', 'a2', 'a1', 'a0', 'a2']);
  assert.deepEqual(ids(out.slice(0, 3)), ids(orderAssetsForSlotsBatch(assets, slots, { rankBatch: fakeBatch() })));
  // plain batch returns only the n-asset permutation, so slots 3..5 cycle a0,a1,a2 regardless of text
  const plain = orderAssetsForSlotsBatch(assets, slots, { rankBatch: fakeBatch() });
  assert.equal(plain.length, 3);
  assert.deepEqual([3, 4, 5].map((i) => plain[i % 3].id), ['a0', 'a1', 'a2']);
});

test('best asset blocked by no-immediate-repeat falls to next best within cap', () => {
  const assets = [A('a0'), A('a1'), A('a2')];
  const out = orderAssetsForSlotsBatchAll(assets, [T(0), T(1), T(2), T(2, 'y')], { rankBatch: fakeBatch() });
  assert.notEqual(out[3].id, out[2].id);
});

test('usage cap ceil(slots/n) and no immediate repeat hold; one worker call', () => {
  const assets = [A('a0'), A('a1')];
  const slots = [T(0, 'a'), T(0, 'b'), T(0, 'c'), T(0, 'd'), T(0, 'e'), T(0, 'f')];
  let calls = 0;
  const out = orderAssetsForSlotsBatchAll(assets, slots, { rankBatch: (r) => { calls++; return fakeBatch()(r); } });
  assert.equal(calls, 1);
  assert.equal(out.length, 6);
  for (let i = 1; i < out.length; i++) assert.notEqual(out[i].id, out[i - 1].id);
  for (const a of assets) assert.ok(out.filter((x) => x.id === a.id).length <= 3);
});

test('failure, throw, invalid matrix and non-image assets keep the current order', () => {
  const assets = [A('a1'), A('a0')];
  const slots = [T(0), T(1), T(0, 'z'), T(1, 'z')];
  for (const rankBatch of [fakeBatch({ FAKE_MODE: 'crash' }), () => { throw new Error('boom'); }, () => ({ ok: true, scores: [[0.1]] })]) {
    assert.deepEqual(ids(orderAssetsForSlotsBatchAll(assets, slots, { rankBatch })), ['a1', 'a0']);
  }
  const mixed = [A('a1'), { id: 'v', asset_type: 'video', location: '/v.mp4' }];
  assert.deepEqual(ids(orderAssetsForSlotsBatchAll(mixed, slots, { rankBatch: fakeBatch() })), ['a1', 'v']);
});

test('slots <= assets behaves exactly like batch', () => {
  const assets = [A('a2'), A('a0'), A('a1')];
  const slots = [T(0), T(1), T(2)];
  assert.deepEqual(ids(orderAssetsForSlotsBatchAll(assets, slots, { rankBatch: fakeBatch() })), ids(orderAssetsForSlotsBatch(assets, slots, { rankBatch: fakeBatch() })));
});

test('unscored later slot falls back to cyclic order without repeating the previous asset', () => {
  const assets = [A('a0'), A('a1')];
  const slots = [T(0), T(1), '   ', T(1, 'q')];
  const out = orderAssetsForSlotsBatchAll(assets, slots, { rankBatch: fakeBatch() });
  assert.equal(out.length, 4);
  for (let i = 1; i < out.length; i++) assert.notEqual(out[i].id, out[i - 1].id);
});

test('output feeds computeVisualSequencing: one asset per merged slot, reuse allowed', () => {
  const assets = [A('a0'), A('a1')];
  const caps = Array.from({ length: 6 }, (_, i) => ({ text: T(i % 2, `s${i}`), start_seconds: i * 2, duration_seconds: 2 }));
  const slotTexts = computeSequenceSlotTexts(caps);
  assert.equal(slotTexts.length, 6);
  const seq = assignAssetsForSlots(assets, slotTexts, { env: { SCENE_RELEVANCE_ASSIGN: 'batch-all' }, rankBatch: fakeBatch() });
  const timing = computeVisualSequencing(seq, caps, 12);
  assert.deepEqual(timing.map((t) => t.asset_id), ['a0', 'a1', 'a0', 'a1', 'a0', 'a1']);
  assert.equal(timing.at(-1).start_seconds + timing.at(-1).duration_seconds, 12);
});

test('off remains the identical array; batch mode unchanged', () => {
  const assets = [A('a1'), A('a0')];
  const boom = () => { throw new Error('no'); };
  assert.equal(assignAssetsForSlots(assets, [T(0)], { env: {}, rankBatch: boom }), assets);
  assert.equal(assignAssetsForSlots(assets, [T(0), T(1), T(0, 'z')], { env: { SCENE_RELEVANCE_ASSIGN: 'batch' }, rankBatch: fakeBatch() }).length, 2);
});
