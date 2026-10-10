import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { rankEntries, cosine, validateRankRequest, resolveTimeoutMs, rankSceneImages, fallbackResult } from '../../src/media/sceneRelevance.js';

const FAKE = fileURLToPath(new URL('../helpers/fakeSceneWorker.js', import.meta.url));
const opts = (mode, extra = {}) => ({ workerPath: FAKE, timeoutMs: 15000, env: { ...process.env, FAKE_MODE: mode }, ...extra });

test('rankEntries sorts by score desc and keeps input order on ties', () => {
  const r = rankEntries([{ path: 'a', score: 0.2 }, { path: 'b', score: 0.9 }, { path: 'c', score: 0.2 }]);
  assert.deepEqual(r.map((x) => x.path), ['b', 'a', 'c']);
  assert.deepEqual(r.map((x) => x.rank), [0, 1, 2]);
});

test('rankEntries is stable under float noise below 1e-6', () => {
  const r = rankEntries([{ path: 'a', score: 0.5 }, { path: 'b', score: 0.5 + 1e-9 }]);
  assert.deepEqual(r.map((x) => x.path), ['a', 'b']);
});

test('cosine basics and errors', () => {
  assert.equal(Math.round(cosine([1, 0], [1, 0]) * 1e6) / 1e6, 1);
  assert.equal(Math.round(cosine([1, 0], [0, 1]) * 1e6) / 1e6, 0);
  assert.throws(() => cosine([1], [1, 2]), /length mismatch/);
  assert.throws(() => cosine([0, 0], [1, 1]), /zero-norm/);
});

test('validateRankRequest rejects bad input', () => {
  assert.throws(() => validateRankRequest({ text: ' ', images: ['a'] }), /non-empty/);
  assert.throws(() => validateRankRequest({ text: 'x', images: [] }), /non-empty array/);
  assert.throws(() => validateRankRequest({ text: 'x', images: ['a', 'a'] }), /unique/);
  assert.throws(() => validateRankRequest({ text: 'x'.repeat(2001), images: ['a'] }), /exceeds/);
});

test('resolveTimeoutMs defaults and validates', () => {
  assert.equal(resolveTimeoutMs({}), 5 * 60 * 1000);
  assert.equal(resolveTimeoutMs({ SCENE_RELEVANCE_TIMEOUT_MS: '1000' }), 1000);
  assert.throws(() => resolveTimeoutMs({ SCENE_RELEVANCE_TIMEOUT_MS: '-1' }), /positive number/);
});

test('worker success ranks matching image first', () => {
  const r = rankSceneImages({ text: 'red sunset', images: ['/x/blue.png', '/x/red.png', '/x/green.png'] }, opts('ok'));
  assert.equal(r.ok, true);
  assert.equal(r.ranking[0].path, '/x/red.png');
});

test('identical runs give identical rankings', () => {
  const req = { text: 'red sunset', images: ['/x/blue.png', '/x/red.png', '/x/green.png'] };
  assert.deepEqual(rankSceneImages(req, opts('ok')), rankSceneImages(req, opts('ok')));
});

test('undecodable image is reported and ranked last, not fatal', () => {
  const r = rankSceneImages({ text: 'red x', images: ['/x/bad.png', '/x/red.png'] }, opts('ok'));
  assert.equal(r.ok, true);
  assert.equal(r.ranking.at(-1).path, '/x/bad.png');
  assert.equal(r.ranking.at(-1).score, null);
  assert.equal(r.errors[0].path, '/x/bad.png');
});

test('worker crash falls back to original order with explicit reason', () => {
  const images = ['/x/b.png', '/x/a.png'];
  const r = rankSceneImages({ text: 'a', images }, opts('crash'));
  assert.equal(r.fallback, true);
  assert.match(r.reason, /model file missing/);
  assert.deepEqual(r.ranking.map((x) => x.path), images);
});

test('worker timeout falls back', () => {
  const r = rankSceneImages({ text: 'a', images: ['/x/a.png'] }, opts('hang', { timeoutMs: 500 }));
  assert.equal(r.fallback, true);
  assert.match(r.reason, /timed out/);
});

test('missing worker file falls back instead of throwing', () => {
  const r = rankSceneImages({ text: 'a', images: ['/x/a.png'] }, { workerPath: '/nonexistent/w.js', timeoutMs: 5000 });
  assert.equal(r.fallback, true);
});

test('fallbackResult shape', () => {
  assert.deepEqual(fallbackResult(['p'], 'r'), { ok: false, fallback: true, reason: 'r', ranking: [{ path: 'p', score: null, rank: 0 }] });
});

test('real worker without model dir fails explicitly and falls back', () => {
  const env = { ...process.env }; delete env.SCENE_RELEVANCE_MODEL_DIR;
  const r = rankSceneImages({ text: 'a', images: ['/x/a.png'] }, { timeoutMs: 20000, env });
  assert.equal(r.fallback, true);
  assert.match(r.reason, /SCENE_RELEVANCE_MODEL_DIR is not set/);
});
