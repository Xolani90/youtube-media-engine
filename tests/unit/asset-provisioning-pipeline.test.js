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

// 1. Valid provider result -> asset persisted -----------------------------
test('valid provider result is persisted as an asset', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  const { filePath, dir } = tempAssetFile();
  const { contentBriefId, contentVersionId } = seedProducedContent(storage);
  const provider = new FakeProvider({
    assetType: 'image',
    location: filePath,
    checksum: checksumOf(filePath),
    verificationStatus: 'UNVERIFIED'
  });

  const result = await runAssetProvisioning({ storage, contentBriefId, provider });

  assert.equal(result.outcome, 'PROVISIONED');
  assert.ok(result.asset);
  assert.equal(result.asset.location, filePath);
  assert.equal(result.asset.verification_status, 'UNVERIFIED');

  const row = storage.get('SELECT * FROM assets WHERE id = ?', [result.asset.id]);
  assert.ok(row);

  cleanup(storage, dbPath, [dir]);
});

// 2. Asset usage persisted against correct content version -----------------
test('asset usage is persisted against the correct content_version_id', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  const { filePath, dir } = tempAssetFile();
  const { contentBriefId, contentVersionId } = seedProducedContent(storage);
  const provider = new FakeProvider({ assetType: 'image', location: filePath, verificationStatus: 'UNVERIFIED' });

  const result = await runAssetProvisioning({ storage, contentBriefId, provider });

  const usage = storage.get('SELECT * FROM asset_usages WHERE asset_id = ?', [result.asset.id]);
  assert.equal(usage.content_version_id, contentVersionId);
  assert.equal(usage.usage_context, 'b-roll');

  cleanup(storage, dbPath, [dir]);
});

// 3. Existing suitable asset -> idempotent, no duplicate acquisition -------
test('an existing visual asset usage prevents a second acquisition', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  const { contentBriefId, contentVersionId } = seedProducedContent(storage);
  const repo = new AssetProvenanceRepository(storage);
  const existingAssetId = repo.recordAsset({ assetType: 'image', location: '/tmp/existing.png', verificationStatus: 'UNVERIFIED' });
  repo.recordUsage({ assetId: existingAssetId, contentVersionId, usageContext: 'b-roll' });

  let called = false;
  const provider = new FakeProvider(() => { called = true; return { assetType: 'image', location: '/tmp/should-not-be-used.png' }; });

  const result = await runAssetProvisioning({ storage, contentBriefId, provider });

  assert.equal(result.outcome, 'ALREADY_PROVISIONED');
  assert.equal(called, false);
  const assetCount = storage.get('SELECT COUNT(*) as n FROM assets').n;
  assert.equal(assetCount, 1);
  const usageCount = storage.get('SELECT COUNT(*) as n FROM asset_usages').n;
  assert.equal(usageCount, 1);

  cleanup(storage, dbPath);
});

// 4. Provider returns null -> no persistence -------------------------------
test('provider returning null results in NO_ASSET_ACQUIRED and no persistence', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  const { contentBriefId } = seedProducedContent(storage);
  const provider = new FakeProvider(null);

  const result = await runAssetProvisioning({ storage, contentBriefId, provider });

  assert.equal(result.outcome, 'NO_ASSET_ACQUIRED');
  assert.equal(storage.get('SELECT COUNT(*) as n FROM assets').n, 0);
  assert.equal(storage.get('SELECT COUNT(*) as n FROM asset_usages').n, 0);

  cleanup(storage, dbPath);
});

// 5. Provider throws (network-style failure) -> no persistence ------------
test('provider throwing results in NO_ASSET_ACQUIRED and no persistence', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  const { contentBriefId } = seedProducedContent(storage);
  const provider = new FakeProvider(() => { throw new Error('network down'); });

  const result = await runAssetProvisioning({ storage, contentBriefId, provider });

  assert.equal(result.outcome, 'NO_ASSET_ACQUIRED');
  assert.equal(storage.get('SELECT COUNT(*) as n FROM assets').n, 0);

  cleanup(storage, dbPath);
});

// 6. Invalid asset type -> rejected safely ---------------------------------
test('an unsupported assetType is rejected without persistence', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  const { contentBriefId } = seedProducedContent(storage);
  const provider = new FakeProvider({ assetType: 'audio', location: '/tmp/x.mp3' });

  const result = await runAssetProvisioning({ storage, contentBriefId, provider });

  assert.equal(result.outcome, 'INVALID_PROVIDER_RESULT');
  assert.equal(result.reason, 'UNSUPPORTED_ASSET_TYPE');
  assert.equal(storage.get('SELECT COUNT(*) as n FROM assets').n, 0);

  cleanup(storage, dbPath);
});

// 7. Missing location -> rejected safely -----------------------------------
test('a missing location is rejected without persistence', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  const { contentBriefId } = seedProducedContent(storage);
  const provider = new FakeProvider({ assetType: 'image' });

  const result = await runAssetProvisioning({ storage, contentBriefId, provider });

  assert.equal(result.outcome, 'INVALID_PROVIDER_RESULT');
  assert.equal(result.reason, 'MISSING_LOCATION');

  cleanup(storage, dbPath);
});

// 8. Nonexistent local file -> rejected safely -----------------------------
test('a nonexistent local file is rejected without persistence', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  const { contentBriefId } = seedProducedContent(storage);
  const provider = new FakeProvider({ assetType: 'image', location: '/tmp/does-not-exist-at-all.jpg' });

  const result = await runAssetProvisioning({ storage, contentBriefId, provider });

  assert.equal(result.outcome, 'INVALID_PROVIDER_RESULT');
  assert.equal(result.reason, 'FILE_NOT_FOUND');

  cleanup(storage, dbPath);
});

// 9. Empty local file -> rejected safely -----------------------------------
test('an empty local file is rejected without persistence', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  const { contentBriefId } = seedProducedContent(storage);
  const { filePath, dir } = tempAssetFile('');
  const provider = new FakeProvider({ assetType: 'image', location: filePath });

  const result = await runAssetProvisioning({ storage, contentBriefId, provider });

  assert.equal(result.outcome, 'INVALID_PROVIDER_RESULT');
  assert.equal(result.reason, 'FILE_EMPTY');

  cleanup(storage, dbPath, [dir]);
});

// 10. Checksum mismatch -> rejected safely ---------------------------------
test('a checksum mismatch is rejected without persistence', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  const { contentBriefId } = seedProducedContent(storage);
  const { filePath, dir } = tempAssetFile();
  const provider = new FakeProvider({ assetType: 'image', location: filePath, checksum: 'not-the-real-checksum' });

  const result = await runAssetProvisioning({ storage, contentBriefId, provider });

  assert.equal(result.outcome, 'INVALID_PROVIDER_RESULT');
  assert.equal(result.reason, 'CHECKSUM_MISMATCH');

  cleanup(storage, dbPath, [dir]);
});

// 11. UNVERIFIED provider status is persisted unchanged --------------------
test('UNVERIFIED verificationStatus is persisted unchanged, never promoted', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  const { contentBriefId } = seedProducedContent(storage);
  const { filePath, dir } = tempAssetFile();
  const provider = new FakeProvider({ assetType: 'image', location: filePath, verificationStatus: 'UNVERIFIED' });

  const result = await runAssetProvisioning({ storage, contentBriefId, provider });

  assert.equal(result.outcome, 'PROVISIONED');
  assert.equal(result.asset.verification_status, 'UNVERIFIED');

  cleanup(storage, dbPath, [dir]);
});

// 12. DISPUTED asset is rejected -------------------------------------------
test('a DISPUTED provider result is rejected without persistence', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  const { contentBriefId } = seedProducedContent(storage);
  const { filePath, dir } = tempAssetFile();
  const provider = new FakeProvider({ assetType: 'image', location: filePath, verificationStatus: 'DISPUTED' });

  const result = await runAssetProvisioning({ storage, contentBriefId, provider });

  assert.equal(result.outcome, 'INVALID_PROVIDER_RESULT');
  assert.equal(result.reason, 'DISPUTED_ASSET');
  assert.equal(storage.get('SELECT COUNT(*) as n FROM assets').n, 0);

  cleanup(storage, dbPath, [dir]);
});

// 13. No usable visual context -> no acquisition ---------------------------
test('empty visual_ideas and empty script body results in NO_VISUAL_CONTEXT with no provider call', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  const { contentBriefId } = seedProducedContent(storage, { visualIdeas: '', scriptBody: '' });
  let called = false;
  const provider = new FakeProvider(() => { called = true; return null; });

  const result = await runAssetProvisioning({ storage, contentBriefId, provider });

  assert.equal(result.outcome, 'NO_VISUAL_CONTEXT');
  assert.equal(called, false);

  cleanup(storage, dbPath);
});

test('empty visual_ideas falls back to a deterministic Script-derived query', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  const { contentBriefId } = seedProducedContent(storage, { visualIdeas: '', scriptBody: 'Waterfalls in autumn are stunning. More text follows.' });
  const { filePath, dir } = tempAssetFile();
  let receivedQuery = null;
  const provider = new FakeProvider((params) => {
    receivedQuery = params.query;
    return { assetType: 'image', location: filePath };
  });

  const result = await runAssetProvisioning({ storage, contentBriefId, provider });

  assert.equal(result.outcome, 'PROVISIONED');
  assert.equal(receivedQuery, 'Waterfalls in autumn are stunning');

  cleanup(storage, dbPath, [dir]);
});

// Atomicity: recordAsset() + recordUsage() must be all-or-nothing --------
// Exercises the exact transaction pattern pipeline.js uses
// (storage.transaction(() => { recordAsset(); recordUsage(); })) with a
// genuine, controlled database-level failure -- a foreign key violation
// on asset_usages.content_version_id (enforced: SqliteStorageDriver runs
// `PRAGMA foreign_keys = ON`) -- rather than an artificial mock/boolean.
test('a recordUsage() failure inside the transaction rolls back and leaves no orphaned asset row', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  const repo = new AssetProvenanceRepository(storage);
  const nonexistentContentVersionId = crypto.randomUUID(); // violates the FK on asset_usages.content_version_id

  assert.equal(storage.get('SELECT COUNT(*) as n FROM assets').n, 0);

  assert.throws(() => {
    storage.transaction(() => {
      const assetId = repo.recordAsset({ assetType: 'image', location: '/tmp/atomicity-test.png', verificationStatus: 'UNVERIFIED' });
      repo.recordUsage({
        assetId,
        contentVersionId: nonexistentContentVersionId, // real FK violation -> throws
        usageContext: 'b-roll'
      });
      return assetId;
    });
  });

  // The transaction rolled back: recordAsset()'s write must NOT be persisted.
  assert.equal(storage.get('SELECT COUNT(*) as n FROM assets').n, 0);
  assert.equal(storage.get('SELECT COUNT(*) as n FROM asset_usages').n, 0);

  cleanup(storage, dbPath);
});

test('the successful path still persists both the asset and the usage together', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  const { filePath, dir } = tempAssetFile();
  const { contentBriefId, contentVersionId } = seedProducedContent(storage);
  const provider = new FakeProvider({ assetType: 'image', location: filePath, verificationStatus: 'UNVERIFIED' });

  const result = await runAssetProvisioning({ storage, contentBriefId, provider });

  assert.equal(result.outcome, 'PROVISIONED');
  assert.equal(storage.get('SELECT COUNT(*) as n FROM assets').n, 1);
  const usage = storage.get('SELECT * FROM asset_usages WHERE asset_id = ?', [result.asset.id]);
  assert.ok(usage);
  assert.equal(usage.content_version_id, contentVersionId);

  cleanup(storage, dbPath, [dir]);
});

// 14. No direct SQL writes to asset tables ---------------------------------
test('the pipeline module never references INSERT INTO assets/asset_usages directly', async () => {
  const source = fs.readFileSync(new URL('../../src/asset-provisioning/pipeline.js', import.meta.url), 'utf8');
  assert.ok(!/INSERT\s+INTO\s+assets/i.test(source));
  assert.ok(!/INSERT\s+INTO\s+asset_usages/i.test(source));
});

// 15. Provider abstraction is actually used, not hard-coded Pixabay logic --
test('the pipeline calls the injected provider rather than hard-coding a concrete provider', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  const { contentBriefId } = seedProducedContent(storage);
  const { filePath, dir } = tempAssetFile();
  let calls = 0;
  const provider = new FakeProvider(() => { calls += 1; return { assetType: 'image', location: filePath }; });

  await runAssetProvisioning({ storage, contentBriefId, provider });

  assert.equal(calls, 1);

  const source = fs.readFileSync(new URL('../../src/asset-provisioning/pipeline.js', import.meta.url), 'utf8');
  assert.ok(!/pixabay\.com/i.test(source));
  assert.ok(!/PixabayAssetSourceProvider\s*\(/.test(source));

  cleanup(storage, dbPath, [dir]);
});

// Structural / not-yet-produced guards ---------------------------------------
test('a content_brief with no content_version returns STRUCTURAL_FAILURE', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  const provider = new FakeProvider(null);

  const result = await runAssetProvisioning({ storage, contentBriefId: crypto.randomUUID(), provider });

  assert.equal(result.outcome, 'STRUCTURAL_FAILURE');

  cleanup(storage, dbPath);
});

test('a content_version not yet PRODUCED returns NOT_YET_PRODUCED', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  const opportunityId = seedOpportunity(storage);
  const contentBriefId = seedBrief(storage, opportunityId);
  const scriptId = crypto.randomUUID();
  storage.run(
    `INSERT INTO scripts (id, content_brief_id, version, body, claim_links, created_at) VALUES (?, ?, 1, 'body', '[]', ?)`,
    [scriptId, contentBriefId, nowISO()]
  );
  storage.run(
    `INSERT INTO content_versions (id, content_brief_id, script_id, state, created_at) VALUES (?, ?, ?, 'PRODUCTION_READY', ?)`,
    [crypto.randomUUID(), contentBriefId, scriptId, nowISO()]
  );
  const provider = new FakeProvider(null);

  const result = await runAssetProvisioning({ storage, contentBriefId, provider });

  assert.equal(result.outcome, 'NOT_YET_PRODUCED');

  cleanup(storage, dbPath);
});
