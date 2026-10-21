import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildHitScreen, resolveCandidateGateEnabled, parseTags } from '../../src/asset-provisioning/candidateGate.js';
import { planScenes } from '../../src/asset-provisioning/scenePlan.js';
import { PixabayAssetSourceProvider } from '../../src/providers/asset/PixabayAssetSourceProvider.js';

const NARRATION = 'In person workshops are being established to provide direct guidance for small firms.';

test('gate rejects a branded / UI-capture hit the narration never mentions (the Google-homepage case)', () => {
  const screen = buildHitScreen({ sceneText: NARRATION, query: 'workshop' });
  const v = screen({ id: 1, pageURL: 'p1', tags: 'google, chrome, browser, workshop' });
  assert.equal(v.accept, false);
  assert.match(v.reason, /^branded_or_ui_capture_tag:/);
});

test('gate allows a brand tag when the narration itself names it', () => {
  const screen = buildHitScreen({ sceneText: 'Google announced a new Chrome update today.', query: 'google chrome' });
  assert.equal(screen({ id: 1, pageURL: 'p', tags: 'google, chrome, update' }).accept, true);
});

test('gate rejects a hit with tags but no word in common with scene or query; accepts a tagless hit', () => {
  const screen = buildHitScreen({ sceneText: NARRATION, query: 'workshop' });
  assert.equal(screen({ id: 2, pageURL: 'p2', tags: 'sunset, beach, ocean' }).reason, 'no_tag_overlap_with_scene');
  assert.equal(screen({ id: 3, pageURL: 'p3', tags: '' }).accept, true);
  assert.equal(screen({ id: 4, pageURL: 'p4', tags: 'workshop, training, people' }).accept, true);
});

test('gate rejects a hit whose page is already attached', () => {
  const screen = buildHitScreen({ sceneText: NARRATION, query: 'workshop', excludeOrigins: ['p9'] });
  assert.equal(screen({ id: 9, pageURL: 'p9', tags: 'workshop' }).reason, 'duplicate_of_attached_asset');
});

test('env switch: default on, off restores, invalid throws', () => {
  assert.equal(resolveCandidateGateEnabled({}), true);
  assert.equal(resolveCandidateGateEnabled({ SCENE_CANDIDATE_GATE: 'off' }), false);
  assert.throws(() => resolveCandidateGateEnabled({ SCENE_CANDIDATE_GATE: 'maybe' }));
  assert.deepEqual(parseTags('A, b ,,C'), ['a', 'b', 'c']);
});

test('planner: scenes expose their text; no-term scenes get anchored, non-junk queries', () => {
  const body = ['Millions of small firm employees lack access to structured training.', 'A programme aims to close that gap soon.',
    'Funding goes to sector specific resources for retail.', 'Employers say cost is the biggest barrier.',
    'Workshops are being established to provide direct guidance.', 'Critics argue the plan relies on voluntary participation.',
    'Early pilots reported higher confidence among participants.', 'However the pilots were small and not independently evaluated.',
    'Officials plan a wider evaluation before expanding the scheme again.', 'The scheme will be reviewed at the end of next year.'].join(' ');
  const plan = planScenes({ visualIdeas: 'small business owner, office', scriptBody: body, fallbackQuery: 'small business owner, office' });
  assert.ok(plan.length >= 2);
  for (const sc of plan) assert.equal(typeof sc.text, 'string');
  const all = plan.flatMap((s) => s.queries);
  for (const junk of ['pilot among', 'again end', 'among', 'again']) assert.ok(!all.includes(junk), `junk query ${junk}`);
});

function fakeFetch(hits) {
  let downloads = 0;
  const impl = async (url) => {
    if (String(url).includes('pixabay.com/api')) return { ok: true, status: 200, json: async () => ({ hits }) };
    downloads++;
    return { ok: true, status: 200, arrayBuffer: async () => Buffer.from(`bytes-${url}`) };
  };
  return { impl, downloads: () => downloads };
}
const hit = (id, tags, extra = {}) => ({ id, tags, pageURL: `https://pixabay.com/p/${id}`, user: 'u', largeImageURL: `https://cdn/${id}.jpg`, ...extra });

test('provider: with a screen it skips rejected hits and downloads exactly one; evidence lands in provenance notes', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-'));
  const f = fakeFetch([hit(1, 'google, chrome, browser'), hit(2, 'sunset, beach'), hit(3, 'workshop, training')]);
  const p = new PixabayAssetSourceProvider({ fetchImpl: f.impl, apiKeyProvider: () => 'k', downloadDir: dir });
  const r = await p.acquireVisualAsset({ query: 'workshop', assetTypes: ['image'], screenHit: buildHitScreen({ sceneText: NARRATION, query: 'workshop' }) });
  assert.equal(r.verificationStatus, 'UNVERIFIED'); // rights status is never promoted
  assert.match(r.provenanceNotes, /pixabayId=3/);
  assert.match(r.provenanceNotes, /query=workshop/);
  assert.match(r.provenanceNotes, /screenRejected=1:branded_or_ui_capture_tag:google\|2:no_tag_overlap_with_scene/);
  assert.equal(f.downloads(), 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('provider: every hit rejected -> structured EMPTY_RESULT (no fabricated asset, no download)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-'));
  const f = fakeFetch([hit(1, 'google, chrome'), hit(2, 'sunset')]);
  const p = new PixabayAssetSourceProvider({ fetchImpl: f.impl, apiKeyProvider: () => 'k', downloadDir: dir });
  const r = await p.acquireVisualAsset({ query: 'workshop', assetTypes: ['image'], screenHit: buildHitScreen({ sceneText: NARRATION, query: 'workshop' }) });
  assert.equal(r.failure.kind, 'EMPTY_RESULT');
  assert.equal(r.failure.hitCount, 2);
  assert.match(r.failure.cause, /no_hit_passed_screen/);
  assert.equal(f.downloads(), 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('provider: without a screen behaviour is unchanged (hits[0] only, notes carry no search evidence)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-'));
  const f = fakeFetch([hit(1, 'google, chrome'), hit(2, 'workshop')]);
  const p = new PixabayAssetSourceProvider({ fetchImpl: f.impl, apiKeyProvider: () => 'k', downloadDir: dir });
  const r = await p.acquireVisualAsset({ query: 'workshop', assetTypes: ['image'] });
  assert.match(r.provenanceNotes, /pixabayId=1/);
  assert.ok(!/query=|screenRejected/.test(r.provenanceNotes));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('provider: a screen that throws fails closed (hit rejected)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-'));
  const f = fakeFetch([hit(1, 'workshop')]);
  const p = new PixabayAssetSourceProvider({ fetchImpl: f.impl, apiKeyProvider: () => 'k', downloadDir: dir });
  const r = await p.acquireVisualAsset({ query: 'workshop', assetTypes: ['image'], screenHit: () => { throw new Error('boom'); } });
  assert.equal(r.failure.kind, 'EMPTY_RESULT');
  fs.rmSync(dir, { recursive: true, force: true });
});
