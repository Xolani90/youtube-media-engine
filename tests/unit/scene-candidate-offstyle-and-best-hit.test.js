import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildHitScreen } from '../../src/asset-provisioning/candidateGate.js';
import { PixabayAssetSourceProvider } from '../../src/providers/asset/PixabayAssetSourceProvider.js';

const NARRATION = 'A franchisee cut cash reconciliation time with automated workflows in the restaurant.';

test('gate: toy, figurine and AI-generated tags are rejected unless the scene asks for them', () => {
  const screen = buildHitScreen({ sceneText: NARRATION, query: 'cash register restaurant' });
  assert.deepEqual(screen({ tags: 'toy, cash register, play money' }), { accept: false, reason: 'off_style_tag:toy' });
  assert.deepEqual(screen({ tags: 'lego, restaurant, minifigure' }), { accept: false, reason: 'off_style_tag:lego' });
  assert.deepEqual(screen({ tags: 'cash register, ai generated, restaurant' }), { accept: false, reason: 'off_style_tag:ai generated' });
  assert.deepEqual(screen({ tags: 'cartoon, restaurant' }), { accept: false, reason: 'off_style_tag:cartoon' });
  assert.equal(screen({ tags: 'cash register, restaurant, cashier' }).accept, true);
});

test('gate: a scene about toys may still use toy imagery', () => {
  const screen = buildHitScreen({ sceneText: 'The company designs a new toy for children.', query: 'toy workshop' });
  assert.equal(screen({ tags: 'toy, workshop, children' }).accept, true);
});

test('gate: "ai" as a topical tag is NOT an off-style tag (only "generated" phrasing is)', () => {
  const screen = buildHitScreen({ sceneText: 'AI tools help developers write code faster.', query: 'software developer coding' });
  assert.equal(screen({ tags: 'ai, developer, software, coding' }).accept, true);
});

test('gate: score() ranks tag overlap, query words counting double', () => {
  const screen = buildHitScreen({ sceneText: NARRATION, query: 'cash register' });
  const generic = screen.score({ tags: 'business, office' });
  const onTopic = screen.score({ tags: 'cash register, restaurant, cashier' });
  assert.ok(onTopic > generic, `${onTopic} should beat ${generic}`);
});

function fakeFetch(hits, seen = []) {
  let downloads = 0;
  const impl = async (url) => {
    if (String(url).includes('pixabay.com/api')) { seen.push(String(url)); return { ok: true, status: 200, json: async () => ({ hits }) }; }
    downloads++;
    return { ok: true, status: 200, arrayBuffer: async () => Buffer.from(`bytes-${url}`) };
  };
  return { impl, downloads: () => downloads };
}
const hit = (id, tags) => ({ id, tags, pageURL: `https://pixabay.com/p/${id}`, user: 'u', largeImageURL: `https://cdn/${id}.jpg` });

test('provider: with a screen it asks for a wider pool and picks the best-matching accepted hit', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'best-'));
  const seen = [];
  const f = fakeFetch([hit(1, 'toy, cash register'), hit(2, 'business, office, laptop'), hit(3, 'cash register, restaurant, cashier')], seen);
  const p = new PixabayAssetSourceProvider({ fetchImpl: f.impl, apiKeyProvider: () => 'k', downloadDir: dir });
  const r = await p.acquireVisualAsset({ query: 'cash register', assetTypes: ['image'], screenHit: buildHitScreen({ sceneText: NARRATION, query: 'cash register' }) });
  assert.match(r.provenanceNotes, /pixabayId=3/);
  assert.match(r.provenanceNotes, /screenRejected=1:off_style_tag:toy/);
  assert.equal(new URL(seen[0]).searchParams.get('per_page'), '20');
  assert.equal(f.downloads(), 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('provider: without a screen the request and choice are unchanged (per_page 3, first hit)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'best-'));
  const seen = [];
  const f = fakeFetch([hit(1, 'a'), hit(2, 'b')], seen);
  const p = new PixabayAssetSourceProvider({ fetchImpl: f.impl, apiKeyProvider: () => 'k', downloadDir: dir });
  const r = await p.acquireVisualAsset({ query: 'q', assetTypes: ['image'] });
  assert.match(r.provenanceNotes, /pixabayId=1/);
  assert.equal(new URL(seen[0]).searchParams.get('per_page'), '3');
  fs.rmSync(dir, { recursive: true, force: true });
});
