import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeVisualSequencing, computeSequenceSlotTexts } from '../../src/media/visualSequencing.js';
import { orderAssetsForSlots, resolveSceneAssignmentEnabled } from '../../src/media/sceneAssignment.js';

const A = (id) => ({ id, asset_type: 'image', location: `/${id}.png` });
const caps = (n, total = 12) => Array.from({ length: n }, (_, i) => ({ text: `word${i} text`, start_seconds: i * (total / n), duration_seconds: total / n }));
// ranker: prefers image whose name contains the text's first word's digit
const rank = ({ text, images }) => {
  const d = text.match(/\d+/)[0];
  const ranking = images.map((p) => ({ path: p, score: p.includes(`a${d}.`) ? 1 : 0.1 }))
    .sort((x, y) => y.score - x.score).map((e, rank) => ({ ...e, rank }));
  return { ok: true, fallback: false, ranking };
};

test('disabled by default; env parsing', () => {
  assert.equal(resolveSceneAssignmentEnabled({}), false);
  assert.equal(resolveSceneAssignmentEnabled({ SCENE_RELEVANCE_ASSIGN: 'on' }), true);
  assert.throws(() => resolveSceneAssignmentEnabled({ SCENE_RELEVANCE_ASSIGN: 'x' }));
});

test('slot texts match sequencing segments and merge short ones', () => {
  const t = computeSequenceSlotTexts(caps(3));
  assert.deepEqual(t, ['word0 text', 'word1 text', 'word2 text']);
  const short = [{ text: 'a', start_seconds: 0, duration_seconds: 0.5 }, { text: 'b', start_seconds: 0.5, duration_seconds: 5 }];
  assert.equal(computeSequenceSlotTexts(short).length, computeVisualSequencing([A('x'), A('y')], short, 5.5).length);
  assert.deepEqual(computeSequenceSlotTexts([]), []);
});

test('ranking puts best asset in each slot, unused first', () => {
  const assets = [A('a2'), A('a0'), A('a1')];
  const ordered = orderAssetsForSlots(assets, computeSequenceSlotTexts(caps(3)), { rank });
  assert.deepEqual(ordered.map((a) => a.id), ['a0', 'a1', 'a2']);
  const timing = computeVisualSequencing(ordered, caps(3), 12);
  assert.deepEqual(timing.map((t) => t.asset_id), ['a0', 'a1', 'a2']);
});

test('reuse cyclically when slots outnumber assets', () => {
  const ordered = orderAssetsForSlots([A('a1'), A('a0')], computeSequenceSlotTexts(caps(4)), { rank });
  assert.deepEqual(ordered.map((a) => a.id), ['a0', 'a1']);
  const t = computeVisualSequencing(ordered, caps(4), 12);
  assert.deepEqual(t.map((x) => x.asset_id), ['a0', 'a1', 'a0', 'a1']);
});

test('fallback keeps current order on failed/throwing/unusable ranking', () => {
  const assets = [A('a2'), A('a0'), A('a1')];
  const texts = computeSequenceSlotTexts(caps(3));
  for (const bad of [() => ({ ok: false, fallback: true, ranking: [] }), () => { throw new Error('boom'); }, () => ({ ok: true, ranking: [{ path: '/nope.png', score: 1, rank: 0 }] })]) {
    assert.deepEqual(orderAssetsForSlots(assets, texts, { rank: bad }).map((a) => a.id), ['a2', 'a0', 'a1']);
  }
  const mixed = [A('a1'), { id: 'v', asset_type: 'video', location: '/v.mp4' }];
  assert.deepEqual(orderAssetsForSlots(mixed, ['x1', 'y'], { rank }).map((a) => a.id), ['a1', 'v']);
});

test('regression: default path (unordered input) sequencing is unchanged', () => {
  const assets = [A('a2'), A('a0'), A('a1')];
  const before = JSON.stringify(computeVisualSequencing(assets, caps(3), 12));
  computeSequenceSlotTexts(caps(3));
  assert.equal(JSON.stringify(computeVisualSequencing(assets, caps(3), 12)), before);
});
