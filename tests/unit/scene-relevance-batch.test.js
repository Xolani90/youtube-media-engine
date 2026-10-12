import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rankSceneBatch, validateBatchRequest } from '../../src/media/sceneRelevanceBatch.js';
import { orderAssetsForSlots, orderAssetsForSlotsBatch, resolveSceneAssignmentMode, assignAssetsForSlots } from '../../src/media/sceneAssignment.js';
import { computeVisualSequencing, computeSequenceSlotTexts } from '../../src/media/visualSequencing.js';

const FAKE = fileURLToPath(new URL('../helpers/fakeSceneBatchWorker.js', import.meta.url));
const fakeBatch = (env = {}) => (req) => rankSceneBatch(req, { workerPath: FAKE, timeoutMs: 20000, env: { ...process.env, ...env } });
const A = (id) => ({ id, asset_type: 'image', location: `/img/${id}.png` });
const caps = (n, total = 12) => Array.from({ length: n }, (_, i) => ({ text: `scene ${i} text`, start_seconds: i * (total / n), duration_seconds: total / n }));

test('validateBatchRequest rejects bad input', () => {
  assert.throws(() => validateBatchRequest({ texts: [], images: ['a'] }));
  assert.throws(() => validateBatchRequest({ texts: ['a', 'a'], images: ['a'] }));
  assert.throws(() => validateBatchRequest({ texts: ['a'], images: ['a', 'a'] }));
  assert.throws(() => validateBatchRequest({ texts: [' '], images: ['a'] }));
  assert.deepEqual(validateBatchRequest({ texts: ['t'], images: ['p'] }), { texts: ['t'], images: ['p'] });
});

test('score matrix is correct [text][image], undecodable image is null column', () => {
  const r = rankSceneBatch({ texts: ['scene 0 x', 'scene 1 x'], images: ['/a0.png', '/a1.png', '/bad.png'] }, { workerPath: FAKE });
  assert.equal(r.ok, true);
  // fake: text digit is the FIRST digit run -> 0 / 1
  assert.deepEqual(r.scores, [[0.9, 0.1, null], [0.1, 0.9, null]]);
  assert.equal(r.errors.length, 1);
});

test('crash, timeout and invalid matrix all fall back without throwing', () => {
  const req = { texts: ['scene 0'], images: ['/a0.png', '/a1.png'] };
  const crash = rankSceneBatch(req, { workerPath: FAKE, env: { ...process.env, FAKE_MODE: 'crash' } });
  assert.equal(crash.ok, false); assert.match(crash.reason, /model file missing/);
  const hang = rankSceneBatch(req, { workerPath: FAKE, timeoutMs: 300, env: { ...process.env, FAKE_MODE: 'hang' } });
  assert.equal(hang.ok, false); assert.match(hang.reason, /timed out/);
  const bad = rankSceneBatch(req, { workerPath: FAKE, env: { ...process.env, FAKE_MODE: 'badshape' } });
  assert.equal(bad.ok, false); assert.match(bad.reason, /invalid score matrix/);
  assert.equal(rankSceneBatch(req, { workerPath: '/nope/worker.js' }).ok, false);
});

test('batch assignment equals per-slot assignment on the same scores and uses ONE worker call', () => {
  const log = path.join(os.tmpdir(), `fake-calls-${process.pid}-${Date.now()}.log`);
  try {
    const assets = [A('a2'), A('a0'), A('a1')];
    const texts = computeSequenceSlotTexts(caps(3));
    const batched = orderAssetsForSlotsBatch(assets, texts, { rankBatch: fakeBatch({ FAKE_CALL_LOG: log }) });
    // per-slot reference with the same scoring rule
    const perSlot = orderAssetsForSlots(assets, texts, { rank: ({ text, images }) => {
      const d = text.match(/\d+/)[0];
      const ranking = images.map((p) => ({ path: p, score: p.includes(`a${d}.`) ? 0.9 : 0.1 })).sort((x, y) => y.score - x.score).map((e, rank) => ({ ...e, rank }));
      return { ok: true, fallback: false, ranking };
    } });
    assert.deepEqual(batched.map((a) => a.id), ['a0', 'a1', 'a2']);
    assert.deepEqual(batched.map((a) => a.id), perSlot.map((a) => a.id));
    assert.equal(fs.readFileSync(log, 'utf8').trim().split('\n').length, 1);
    assert.equal(fs.readFileSync(log, 'utf8').trim(), '3x3');
    // deterministic
    assert.deepEqual(orderAssetsForSlotsBatch(assets, texts, { rankBatch: fakeBatch() }).map((a) => a.id), batched.map((a) => a.id));
    // feeds sequencing exactly like the per-slot result
    assert.deepEqual(computeVisualSequencing(batched, caps(3), 12).map((t) => t.asset_id), ['a0', 'a1', 'a2']);
  } finally { fs.rmSync(log, { force: true }); }
});

test('slots outnumber assets: cyclic reuse; duplicate slot text sent once', () => {
  const texts = ['scene 0 x', 'scene 1 x', 'scene 0 x', 'scene 1 x'];
  const seen = [];
  const rankBatch = (req) => { seen.push(req); return fakeBatch()(req); };
  const out = orderAssetsForSlotsBatch([A('a1'), A('a0')], texts, { rankBatch });
  assert.deepEqual(out.map((a) => a.id), ['a0', 'a1']);
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0].texts, ['scene 0 x', 'scene 1 x']);
});

test('failure/timeout/invalid/throwing batch keeps the current order', () => {
  const assets = [A('a2'), A('a0'), A('a1')];
  const texts = computeSequenceSlotTexts(caps(3));
  for (const rankBatch of [
    fakeBatch({ FAKE_MODE: 'crash' }),
    () => { throw new Error('boom'); },
    () => ({ ok: true, scores: [[0.1]] }),
    () => ({ ok: false, fallback: true, reason: 'x' })
  ]) {
    assert.deepEqual(orderAssetsForSlotsBatch(assets, texts, { rankBatch }).map((a) => a.id), ['a2', 'a0', 'a1']);
  }
  assert.deepEqual(orderAssetsForSlotsBatch([A('a1'), { id: 'v', asset_type: 'video', location: '/v.mp4' }], ['scene 1'], { rankBatch: fakeBatch() }).map((a) => a.id), ['a1', 'v']);
});

test('mode resolution: off by default, on = per-slot, batch = batched; invalid throws', () => {
  assert.equal(resolveSceneAssignmentMode({}), 'off');
  assert.equal(resolveSceneAssignmentMode({ SCENE_RELEVANCE_ASSIGN: 'on' }), 'on');
  assert.equal(resolveSceneAssignmentMode({ SCENE_RELEVANCE_ASSIGN: 'BATCH' }), 'batch');
  assert.throws(() => resolveSceneAssignmentMode({ SCENE_RELEVANCE_ASSIGN: 'x' }));
});

test('default (off) returns the very same asset array, never calling any ranker', () => {
  const assets = [A('a2'), A('a0')];
  const boom = () => { throw new Error('must not be called'); };
  assert.equal(assignAssetsForSlots(assets, ['scene 0'], { env: {}, rank: boom, rankBatch: boom }), assets);
  // batch mode dispatches to the batch path
  assert.deepEqual(assignAssetsForSlots(assets, ['scene 0 x', 'scene 1 x'], { env: { SCENE_RELEVANCE_ASSIGN: 'batch' }, rankBatch: fakeBatch() }).map((a) => a.id), ['a0', 'a2']);
});
