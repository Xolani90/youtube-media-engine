import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { SqliteStorageDriver } from '../../src/storage/SqliteStorageDriver.js';
import { runAssetProvisioning } from '../../src/asset-provisioning/pipeline.js';
import { resolveSceneRelevance, assessAssetRelevance } from '../../src/asset-provisioning/sceneRelevanceCheck.js';
import { AssetSourceProvider } from '../../src/providers/asset/AssetSourceProvider.js';

const nowISO = () => new Date().toISOString();
const SCRIPT = [
  'Small business owners lose hours every week to paperwork. Most of it is invoices and tax forms.',
  'A laptop and a simple template can cut that time in half. Owners who automate invoices report fewer errors.',
  'Coffee shop owners often plan inventory on paper documents. A shared spreadsheet replaces those notes quickly.',
  'Modern office tools are cheap and easy to try. Start with one task and measure the time saved.',
  'Then repeat the process for payroll and tax reminders. Each small win compounds across the year.',
  'The result is more time for customers and less time lost to admin. That is the real return on automation.'
].join(' ');
const IDEAS = 'business owner, laptop, modern office, coffee shop interior, planning documents';

function setup() {
  const dbPath = path.join(os.tmpdir(), `rel-${Date.now()}-${Math.random()}.db`);
  const storage = new SqliteStorageDriver({ dbPath });
  storage.migrate();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rel-files-'));
  const oppId = crypto.randomUUID(); const briefId = crypto.randomUUID(); const scriptId = crypto.randomUUID(); const cvId = crypto.randomUUID();
  storage.run(`INSERT INTO opportunities (id, title, source, discovered_at, status) VALUES (?, 'T', 'rss', ?, 'DISCOVERED')`, [oppId, nowISO()]);
  storage.run(`INSERT INTO content_briefs (id, opportunity_id, working_title, core_question, target_audience, viewer_promise, hook, angle, narrative_structure, key_claims, counterpoints, original_insights, visual_ideas, monetization_opportunities, risk_assessment, created_at) VALUES (?, ?, 'T', 'Q', 'A', 'P', 'H', 'Angle', 'S', '[]', 'C', 'I', ?, 'M', 'R', ?)`, [briefId, oppId, IDEAS, nowISO()]);
  storage.run(`INSERT INTO scripts (id, content_brief_id, version, body, claim_links, created_at) VALUES (?, ?, 1, ?, '[]', ?)`, [scriptId, briefId, SCRIPT, nowISO()]);
  storage.run(`INSERT INTO content_versions (id, content_brief_id, script_id, state, created_at) VALUES (?, ?, ?, 'PRODUCED', ?)`, [cvId, briefId, scriptId, nowISO()]);
  storage.run(`INSERT INTO productions (id, content_version_id, script_id, artifact_type, artifact_path, artifact_checksum, manifest_json, created_at) VALUES (?, ?, ?, 'production_manifest_v1', '/tmp/m.json', 'deadbeef', '{}', ?)`, [crypto.randomUUID(), cvId, scriptId, nowISO()]);
  const cleanup = () => { storage.close(); for (const f of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) fs.rmSync(f, { force: true }); fs.rmSync(dir, { recursive: true, force: true }); };
  return { storage, briefId, dir, cleanup };
}

class Provider extends AssetSourceProvider {
  constructor(dir) { super(); this.dir = dir; this.n = 0; this.calls = []; }
  get id() { return 'fake'; }
  async healthCheck() { return true; }
  async acquireVisualAsset(p) {
    this.calls.push(p.query);
    const id = `img-${++this.n}`;
    const file = path.join(this.dir, `${id}.jpg`);
    fs.writeFileSync(file, `bytes-${id}`);
    return { assetType: 'image', location: file, checksum: crypto.createHash('sha256').update(`bytes-${id}`).digest('hex'), origin: `https://x/${id}`, license: 'L', provenanceNotes: `provider=fake; query=${p.query}`, verificationStatus: 'UNVERIFIED' };
  }
}

const ON = { enabled: true, minScore: 0.1 };
const okRanker = (score) => ({ text, images }) => ({ ok: true, fallback: false, ranking: [{ path: images[0], score, rank: 0 }] });
const downRanker = ({ images }) => ({ ok: false, fallback: true, reason: 'model missing', ranking: images.map((p, rank) => ({ path: p, score: null, rank })) });

test('config: off by default; on requires model dir and a calibrated threshold, no silent defaults', () => {
  assert.equal(resolveSceneRelevance({}).enabled, false);
  assert.equal(resolveSceneRelevance({ SCENE_RELEVANCE: 'off' }).enabled, false);
  assert.throws(() => resolveSceneRelevance({ SCENE_RELEVANCE: 'maybe' }), /must be "on" or "off"/);
  assert.throws(() => resolveSceneRelevance({ SCENE_RELEVANCE: 'on' }), /MODEL_DIR/);
  assert.throws(() => resolveSceneRelevance({ SCENE_RELEVANCE: 'on', SCENE_RELEVANCE_MODEL_DIR: 'm' }), /MIN_SCORE/);
  assert.throws(() => resolveSceneRelevance({ SCENE_RELEVANCE: 'on', SCENE_RELEVANCE_MODEL_DIR: 'm', SCENE_RELEVANCE_MIN_SCORE: 'abc' }), /number/);
  assert.deepEqual({ ...resolveSceneRelevance({ SCENE_RELEVANCE: 'on', SCENE_RELEVANCE_MODEL_DIR: 'm', SCENE_RELEVANCE_MIN_SCORE: '0.12' }) }, { enabled: true, minScore: 0.12 });
});

test('assess: accepts above, rejects below, flags worker-down and unscorable, skips non-images explicitly', () => {
  const asset = { assetType: 'image', location: '/x.jpg' };
  assert.equal(assessAssetRelevance({ sceneText: 't', asset, relevance: ON, ranker: okRanker(0.2) }).accept, true);
  const low = assessAssetRelevance({ sceneText: 't', asset, relevance: ON, ranker: okRanker(0.05) });
  assert.deepEqual([low.accept, low.reason], [false, 'low_scene_relevance']);
  assert.equal(assessAssetRelevance({ sceneText: 't', asset, relevance: ON, ranker: downRanker }).reason, 'relevance_unavailable');
  assert.equal(assessAssetRelevance({ sceneText: 't', asset, relevance: ON, ranker: () => { throw new Error('x'); } }).reason, 'relevance_unavailable');
  assert.equal(assessAssetRelevance({ sceneText: 't', asset, relevance: ON, ranker: ({ images }) => ({ ok: true, fallback: false, ranking: [{ path: images[0], score: null, rank: 0 }] }) }).reason, 'relevance_unscorable');
  const v = assessAssetRelevance({ sceneText: 't', asset: { assetType: 'video', location: '/v.mp4' }, relevance: ON, ranker: okRanker(0) });
  assert.deepEqual([v.applied, v.accept, v.note], [false, true, 'relevance_not_applied_non_image']);
  assert.equal(assessAssetRelevance({ sceneText: 't', asset, relevance: { enabled: false }, ranker: okRanker(0) }).applied, false);
});

test('pipeline: flag off behaves as before and the ranker is never called', async () => {
  const { storage, briefId, dir, cleanup } = setup();
  try {
    let called = 0;
    const r = await runAssetProvisioning({ storage, contentBriefId: briefId, provider: new Provider(dir), multiScene: true, relevance: { enabled: false }, relevanceRanker: () => { called++; return downRanker({ images: [] }); } });
    assert.equal(r.outcome, 'PROVISIONED'); assert.equal(called, 0);
  } finally { cleanup(); }
});

test('pipeline: passing candidates are recorded with their score in provenance', async () => {
  const { storage, briefId, dir, cleanup } = setup();
  try {
    const r = await runAssetProvisioning({ storage, contentBriefId: briefId, provider: new Provider(dir), multiScene: true, relevance: ON, relevanceRanker: okRanker(0.31) });
    assert.equal(r.outcome, 'PROVISIONED');
    const rows = storage.all('SELECT provenance_notes, verification_status FROM assets');
    assert.ok(rows.length >= 2);
    for (const row of rows) { assert.match(row.provenance_notes, /sceneRelevance=0\.3100/); assert.equal(row.verification_status, 'UNVERIFIED'); }
  } finally { cleanup(); }
});

test('pipeline: rejected candidates are never recorded and their files are deleted; scene 1 fails closed', async () => {
  const { storage, briefId, dir, cleanup } = setup();
  try {
    const r = await runAssetProvisioning({ storage, contentBriefId: briefId, provider: new Provider(dir), multiScene: true, relevance: ON, relevanceRanker: okRanker(0.01) });
    assert.equal(r.outcome, 'NO_ASSET_ACQUIRED');
    assert.equal(r.reason, 'low_scene_relevance');
    assert.equal(storage.all('SELECT id FROM assets').length, 0, 'nothing recorded');
    assert.equal(fs.readdirSync(dir).length, 0, 'rejected downloads removed');
  } finally { cleanup(); }
});

test('pipeline: later scenes failing relevance are skipped with a reason, scene 1 still attaches', async () => {
  const { storage, briefId, dir, cleanup } = setup();
  try {
    let n = 0;
    const ranker = ({ images }) => ({ ok: true, fallback: false, ranking: [{ path: images[0], score: ++n === 1 ? 0.5 : 0.01, rank: 0 }] });
    const r = await runAssetProvisioning({ storage, contentBriefId: briefId, provider: new Provider(dir), multiScene: true, relevance: ON, relevanceRanker: ranker });
    assert.equal(r.outcome, 'PROVISIONED');
    assert.equal(storage.all('SELECT id FROM assets').length, 1);
    assert.ok(r.sceneReport.skipped_scenes.length > 0);
    assert.ok(r.sceneReport.skipped_scenes.every((s) => s.reason === 'low_scene_relevance'));
  } finally { cleanup(); }
});

test('pipeline: worker down with the flag on fails closed, never silently accepts', async () => {
  const { storage, briefId, dir, cleanup } = setup();
  try {
    const r = await runAssetProvisioning({ storage, contentBriefId: briefId, provider: new Provider(dir), multiScene: true, relevance: ON, relevanceRanker: downRanker });
    assert.equal(r.outcome, 'NO_ASSET_ACQUIRED');
    assert.equal(r.reason, 'relevance_unavailable');
    assert.equal(storage.all('SELECT id FROM assets').length, 0);
  } finally { cleanup(); }
});

test('pipeline: relevance misconfiguration throws instead of falling back', async () => {
  const prev = { ...process.env };
  process.env.SCENE_RELEVANCE = 'on'; delete process.env.SCENE_RELEVANCE_MODEL_DIR;
  const { storage, briefId, dir, cleanup } = setup();
  try {
    await assert.rejects(() => runAssetProvisioning({ storage, contentBriefId: briefId, provider: new Provider(dir) }), /SCENE_RELEVANCE_MODEL_DIR/);
  } finally { cleanup(); for (const k of Object.keys(process.env)) if (!(k in prev)) delete process.env[k]; Object.assign(process.env, prev); }
});
