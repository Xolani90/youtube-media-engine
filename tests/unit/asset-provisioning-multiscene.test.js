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

function multiProvider(dir) {
  const calls = [];
  const provider = new FakeProvider((p) => {
    calls.push(p.query);
    const filePath = path.join(dir, `a-${calls.length}.jpg`);
    fs.writeFileSync(filePath, `bytes-${p.query}`);
    return { assetType: 'image', location: filePath, checksum: checksumOf(filePath), origin: `https://x/${encodeURIComponent(p.query)}`, verificationStatus: 'UNVERIFIED' };
  });
  return { provider, calls };
}

test('multi-scene off (explicit): exactly one asset, unchanged b-roll context', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-'));
  const { contentBriefId } = seedProducedContent(storage, { visualIdeas: IDEAS, scriptBody: SCRIPT });
  const { provider, calls } = multiProvider(dir);
  const r = await runAssetProvisioning({ storage, contentBriefId, provider, multiScene: false });
  assert.equal(r.outcome, 'PROVISIONED');
  assert.equal(calls.length, 1);
  assert.equal(calls[0], IDEAS);
  assert.equal(storage.get("SELECT usage_context FROM asset_usages").usage_context, 'b-roll');
  cleanup(storage, dbPath, [dir]);
});

test('multi-scene on: several distinct assets, one claim row, spans in usage_context, no schema change', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-'));
  const { contentBriefId, contentVersionId } = seedProducedContent(storage, { visualIdeas: IDEAS, scriptBody: SCRIPT });
  const { provider, calls } = multiProvider(dir);
  const r = await runAssetProvisioning({ storage, contentBriefId, provider, multiScene: true });
  assert.equal(r.outcome, 'PROVISIONED');
  assert.ok(r.additionalAssets.length >= 1);
  assert.ok(!calls.includes(IDEAS), 'the fused whole-video query is never sent when scene queries exist');
  const usages = storage.all('SELECT * FROM asset_usages WHERE content_version_id = ?', [contentVersionId]);
  assert.ok(usages.length >= 2);
  assert.equal(usages.filter((u) => u.provisioning_claim !== null).length, 1);
  for (const u of usages) assert.match(u.usage_context, /^b-roll scene \d+\/\d+ span /);
  assert.equal(new Set(usages.map((u) => u.asset_id)).size, usages.length);
  for (const a of storage.all('SELECT verification_status FROM assets')) assert.equal(a.verification_status, 'UNVERIFIED');
  // idempotent on re-run
  const again = await runAssetProvisioning({ storage, contentBriefId, provider, multiScene: true });
  assert.equal(again.outcome, 'ALREADY_PROVISIONED');
  assert.equal(storage.all('SELECT * FROM asset_usages').length, usages.length);
  cleanup(storage, dbPath, [dir]);
});

test('multi-scene on: duplicate candidates are rejected and later-scene failures do not fail the stage', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-'));
  const { contentBriefId } = seedProducedContent(storage, { visualIdeas: IDEAS, scriptBody: SCRIPT });
  const same = path.join(dir, 'same.jpg');
  fs.writeFileSync(same, 'one-image');
  const provider = new FakeProvider(() => ({ assetType: 'image', location: same, checksum: checksumOf(same), origin: 'https://x/same', verificationStatus: 'UNVERIFIED' }));
  const r = await runAssetProvisioning({ storage, contentBriefId, provider, multiScene: true });
  assert.equal(r.outcome, 'PROVISIONED');
  assert.equal(r.additionalAssets.length, 0);
  assert.equal(storage.get('SELECT COUNT(*) n FROM assets').n, 1);
  assert.ok(storage.get("SELECT COUNT(*) n FROM decision_log WHERE decision = 'SCENE_ASSET_SKIPPED'").n >= 1);
  cleanup(storage, dbPath, [dir]);
});

test('multi-scene on: too little script falls back to the single-query path', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-'));
  const { contentBriefId } = seedProducedContent(storage, { visualIdeas: 'lake', scriptBody: 'One sentence only.' });
  const { provider, calls } = multiProvider(dir);
  const r = await runAssetProvisioning({ storage, contentBriefId, provider, multiScene: true });
  assert.equal(r.outcome, 'PROVISIONED');
  assert.deepEqual(calls, ['lake']);
  assert.equal(storage.get('SELECT usage_context FROM asset_usages').usage_context, 'b-roll');
  cleanup(storage, dbPath, [dir]);
});
