import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { SqliteStorageDriver } from '../../src/storage/SqliteStorageDriver.js';
import { runAssetProvisioning } from '../../src/asset-provisioning/pipeline.js';
import { AssetProvenanceRepository } from '../../src/state/AssetProvenance.js';
import { AssetSourceProvider } from '../../src/providers/asset/AssetSourceProvider.js';

function freshStorage() {
  const dbPath = path.join(os.tmpdir(), `asset-provisioning-${Date.now()}-${Math.random()}.db`);
  return { storage: new SqliteStorageDriver({ dbPath }), dbPath };
}

function tempAssetFile(content = 'fake-image-bytes') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asset-provisioning-files-'));
  const filePath = path.join(dir, 'asset.jpg');
  fs.writeFileSync(filePath, content);
  return { dir, filePath };
}

function checksumOf(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function cleanup(storage, dbPath, extraDirs = []) {
  storage.close();
  fs.rmSync(dbPath, { force: true });
  fs.rmSync(`${dbPath}-wal`, { force: true });
  fs.rmSync(`${dbPath}-shm`, { force: true });
  for (const dir of extraDirs) fs.rmSync(dir, { recursive: true, force: true });
}

function nowISO() {
  return new Date().toISOString();
}

function seedOpportunity(storage) {
  const opportunityId = crypto.randomUUID();
  storage.run(
    `INSERT INTO opportunities (id, title, source, discovered_at, status) VALUES (?, 'Test opportunity', 'rss', ?, 'DISCOVERED')`,
    [opportunityId, nowISO()]
  );
  return opportunityId;
}

function seedBrief(storage, opportunityId, { visualIdeas = 'A calm mountain lake at sunrise' } = {}) {
  const id = crypto.randomUUID();
  storage.run(
    `INSERT INTO content_briefs
      (id, opportunity_id, working_title, core_question, target_audience, viewer_promise,
       hook, angle, narrative_structure, key_claims, counterpoints, original_insights, visual_ideas,
       monetization_opportunities, risk_assessment, created_at)
     VALUES (?, ?, 'T', 'Q', 'A', 'P', 'H', 'Angle', 'Structure', '[]', 'C', 'I', ?, 'M', 'R', ?)`,
    [id, opportunityId, visualIdeas, nowISO()]
  );
  return id;
}

/** Seeds a produced content item: opportunity -> brief -> script -> content_version(PRODUCED) -> productions row. */
function seedProducedContent(storage, { visualIdeas = 'A calm mountain lake at sunrise', scriptBody = 'This is the script body. It has more than one sentence.' } = {}) {
  const opportunityId = seedOpportunity(storage);
  const contentBriefId = seedBrief(storage, opportunityId, { visualIdeas });
  const scriptId = crypto.randomUUID();
  storage.run(
    `INSERT INTO scripts (id, content_brief_id, version, body, claim_links, created_at)
     VALUES (?, ?, 1, ?, '[]', ?)`,
    [scriptId, contentBriefId, scriptBody, nowISO()]
  );
  const contentVersionId = crypto.randomUUID();
  storage.run(
    `INSERT INTO content_versions (id, content_brief_id, script_id, state, created_at) VALUES (?, ?, ?, 'PRODUCED', ?)`,
    [contentVersionId, contentBriefId, scriptId, nowISO()]
  );
  const productionId = crypto.randomUUID();
  storage.run(
    `INSERT INTO productions (id, content_version_id, script_id, artifact_type, artifact_path, artifact_checksum, manifest_json, created_at)
     VALUES (?, ?, ?, 'production_manifest_v1', '/tmp/manifest.json', 'deadbeef', '{}', ?)`,
    [productionId, contentVersionId, scriptId, nowISO()]
  );
  return { contentBriefId, scriptId, contentVersionId };
}

/** Minimal fake AssetSourceProvider for deterministic tests. */
class FakeProvider extends AssetSourceProvider {
  constructor(resultOrFn) {
    super();
    this._resultOrFn = resultOrFn;
  }
  get id() { return 'fake'; }
  async healthCheck() { return true; }
  async acquireVisualAsset(params) {
    if (typeof this._resultOrFn === 'function') return this._resultOrFn(params);
    return this._resultOrFn;
  }
}


const SCRIPT = [
  'Small business owners lose hours every week to paperwork. Most of it is invoices and tax forms.',
  'A laptop and a simple template can cut that time in half. Owners who automate invoices report fewer errors.',
  'Coffee shop owners often plan inventory on paper documents. A shared spreadsheet replaces those notes quickly.',
  'Modern office tools are cheap and easy to try. Start with one task and measure the time saved.',
  'Then repeat the process for payroll and tax reminders. Each small win compounds across the year.',
  'The result is more time for customers and less time lost to admin. That is the real return on automation.'
].join(' ');
const IDEAS = 'business owner, laptop, modern office, coffee shop interior, planning documents';


/** Emulates the Pixabay contract: a pool of hits per query; honours screenHit by taking the first accepted hit. */
function poolProvider(dir) {
  const calls = [];
  const provider = new FakeProvider((p) => {
    calls.push(p.query);
    const n = calls.length;
    // The candidate gate now requires an accepted hit to overlap the scene's
    // visual query. Keep this fixture focused on its actual contract
    // (duplicate rejection followed by an eligible alternative), rather than
    // accidentally relying on generic words shared only with narration.
    const queryTags = String(p.query).replace(/[^a-z0-9]+/gi, ',');
    const pool = [
      { id: 'shared', pageURL: 'https://x/shared', tags: `business, owner, laptop, office, ${queryTags}` },
      { id: `own-${n}`, pageURL: `https://x/own-${n}`, tags: `business, owner, laptop, office, desk, ${queryTags}` }
    ];
    const chosen = p.screenHit ? pool.find((h) => p.screenHit(h).accept) : pool[0];
    if (!chosen) return { failure: { kind: 'EMPTY_RESULT', provider: 'fake', query: p.query, hitCount: pool.length, retryable: false } };
    const filePath = path.join(dir, `${chosen.id}.jpg`);
    fs.writeFileSync(filePath, `bytes-${chosen.id}`);
    return { assetType: 'image', location: filePath, checksum: checksumOf(filePath), origin: chosen.pageURL, verificationStatus: 'UNVERIFIED' };
  });
  return { provider, calls };
}

test('variety: a duplicate top hit no longer costs the scene its asset (gate on) but does with the gate off', async () => {
  const run = async (gate) => {
    const prev = process.env.SCENE_CANDIDATE_GATE;
    process.env.SCENE_CANDIDATE_GATE = gate;
    try {
      const { storage, dbPath } = freshStorage();
      await storage.migrate();
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-'));
      const { contentBriefId } = seedProducedContent(storage, { visualIdeas: IDEAS, scriptBody: SCRIPT });
      const { provider } = poolProvider(dir);
      const r = await runAssetProvisioning({ storage, contentBriefId, provider, multiScene: true });
      const origins = storage.all('SELECT origin, verification_status FROM assets');
      cleanup(storage, dbPath, [dir]);
      return { r, origins };
    } finally {
      if (prev === undefined) delete process.env.SCENE_CANDIDATE_GATE; else process.env.SCENE_CANDIDATE_GATE = prev;
    }
  };
  const off = await run('off');
  const on = await run('on');
  assert.ok(on.r.additionalAssets.length > off.r.additionalAssets.length, 'gate on must fill more scenes');
  assert.equal(new Set(on.origins.map((o) => o.origin)).size, on.origins.length, 'no duplicate assets attached');
  assert.equal(on.r.sceneReport.accepted_assets, on.r.sceneReport.planned_scenes, 'every planned scene filled');
  for (const o of on.origins) assert.equal(o.verification_status, 'UNVERIFIED'); // rights gate untouched
});
