import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeVisualSequencing } from '../../src/media/visualSequencing.js';
import { computeSceneSequencing } from '../../src/media/sceneSequencing.js';
import { planScenes, tileSpans, formatSceneUsageContext, parseSceneUsageContext } from '../../src/asset-provisioning/scenePlan.js';

const asset = (id, order, count, start, end) => ({ id, asset_type: 'image', location: `/x/${id}.jpg`, usage_context: formatSceneUsageContext({ order, count, span: { start, end } }) });
const captions = [0, 5, 10, 15, 20, 25].map((s) => ({ start_seconds: s, duration_seconds: 5, text: 't' }));

test('scene spans map assets to narration time, snapped to caption cuts, tiling the full duration', () => {
  const assets = [asset('a', 1, 3, 0, 0.3), asset('b', 2, 3, 0.3, 0.7), asset('c', 3, 3, 0.7, 1)];
  const t = computeSceneSequencing(assets, captions, 30);
  assert.deepEqual(t.map((x) => x.asset_id), ['a', 'b', 'c']);
  assert.deepEqual(t.map((x) => x.start_seconds), [0, 10, 20]);
  assert.equal(t.reduce((n, x) => n + x.duration_seconds, 0), 30);
  assert.ok(t.every((x) => x.duration_seconds / 30 < 0.4));
});

test('missing scene (gap) is closed by tiling; unplanned assets fall back to null', () => {
  const gap = [asset('a', 1, 3, 0, 0.3), asset('c', 3, 3, 0.7, 1)];
  const t = computeSceneSequencing(gap, captions, 30);
  assert.equal(t.length, 2);
  assert.equal(t[0].duration_seconds + t[1].duration_seconds, 30);
  assert.equal(computeSceneSequencing([{ id: 'a', asset_type: 'image', location: '/a', usage_context: 'b-roll' }, asset('b', 2, 2, 0.5, 1)], captions, 30), null);
  assert.equal(computeSceneSequencing([asset('a', 1, 1, 0, 1)], captions, 30), null);
});

test('scenes that snap onto the same cut are folded, never shown as a flash', () => {
  const t = computeSceneSequencing([asset('a', 1, 3, 0, 0.5), asset('b', 2, 3, 0.5, 0.52), asset('c', 3, 3, 0.52, 1)], captions, 30);
  assert.deepEqual(t.map((x) => x.asset_id), ['a', 'b']);
  assert.equal(t.reduce((n, x) => n + x.duration_seconds, 0), 30);
  assert.ok(t.every((x) => x.duration_seconds >= 1.5));
});

test('planScenes is deterministic and spans are contiguous within 0..1', () => {
  const body = 'Alpha beta gamma delta. Epsilon zeta eta theta. Iota kappa lambda mu. Nu xi omicron pi. Rho sigma tau upsilon. Phi chi psi omega.';
  const a = planScenes({ visualIdeas: 'alpha, rho', scriptBody: body, fallbackQuery: 'alpha, rho' });
  const b = planScenes({ visualIdeas: 'alpha, rho', scriptBody: body, fallbackQuery: 'alpha, rho' });
  assert.deepEqual(a, b);
  assert.ok(a.length >= 2);
  assert.equal(a[0].span.start, 0);
  assert.equal(a.at(-1).span.end, 1);
  for (let i = 1; i < a.length; i++) assert.equal(a[i].span.start, a[i - 1].span.end);
  assert.deepEqual(parseSceneUsageContext(formatSceneUsageContext({ order: 1, count: 2, span: a[0].span })).span, a[0].span);
  assert.equal(tileSpans([{ index: 0, span: { start: 0, end: 0.3 } }, { index: 2, span: { start: 0.7, end: 1 } }])[0].span.end, 0.7);
});

test('single asset without spans keeps the legacy path byte-for-byte', () => {
  const one = [{ id: 'z', asset_type: 'image', location: '/z', usage_context: 'b-roll' }];
  assert.equal(computeSceneSequencing(one, captions, 30), null);
  assert.equal(computeVisualSequencing(one, captions, 30).length, 1);
});
