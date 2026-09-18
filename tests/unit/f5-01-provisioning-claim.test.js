import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { SqliteStorageDriver } from '../../src/storage/SqliteStorageDriver.js';
import { runAssetProvisioning } from '../../src/asset-provisioning/pipeline.js';
import { PROVISIONING_CLAIM } from '../../src/asset-provisioning/constants.js';
import { AssetProvenanceRepository } from '../../src/state/AssetProvenance.js';
import { AssetSourceProvider } from '../../src/providers/asset/AssetSourceProvider.js';

// F5-01 (Owner-authorized Candidate A): schema, domain-invariant, and
// concurrency coverage for 0014_asset_usages_provisioning_claim.sql and
// the pipeline/repository changes that populate it. Mirrors the harness
// conventions in tests/unit/asset-provisioning-pipeline.test.js and the
// migration-inspection style of tests/unit/migration-scope.test.js.

function freshStorage() {
  const dbPath = path.join(os.tmpdir(), `f5-01-${Date.now()}-${Math.random()}.db`);
  return { storage: new SqliteStorageDriver({ dbPath }), dbPath };
}

function tempAssetFile(content = 'fake-image-bytes') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'f5-01-files-'));
  const filePath = path.join(dir, 'asset.jpg');
  fs.writeFileSync(filePath, content);
  return { dir, filePath };
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

// --- Schema -----------------------------------------------------------

test('migration 0014 applies cleanly to an empty database and adds the column + partial unique index', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();

  const applied = storage.all('SELECT id FROM schema_migrations').map((r) => r.id);
  assert.ok(applied.includes('0014_asset_usages_provisioning_claim.sql'));

  const columns = storage.all("PRAGMA table_info(asset_usages)").map((c) => c.name);
  assert.ok(columns.includes('provisioning_claim'));

  const indexes = storage.all("SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name='asset_usages'");
  const claimIndex = indexes.find((i) => i.name === 'idx_asset_usages_provisioning_claim');
  assert.ok(claimIndex, 'expected the partial unique index to exist');
  assert.match(claimIndex.sql, /UNIQUE/i);
  assert.match(claimIndex.sql, /provisioning_claim IS NOT NULL/i);

  cleanup(storage, dbPath);
});

test('migration 0014 applies cleanly on top of legitimate pre-existing asset/usage rows, which retain their values and get NULL provisioning_claim', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  const { contentVersionId } = seedProducedContent(storage);
  const repo = new AssetProvenanceRepository(storage);

  const assetId = repo.recordAsset({ assetType: 'image', location: '/tmp/legacy.png', verificationStatus: 'UNVERIFIED' });
  const usageId = repo.recordUsage({ assetId, contentVersionId, usageContext: 'b-roll' });

  const row = storage.get('SELECT * FROM asset_usages WHERE id = ?', [usageId]);
  assert.equal(row.usage_context, 'b-roll');
  assert.equal(row.provisioning_claim, null);
  assert.equal(row.content_version_id, contentVersionId);

  cleanup(storage, dbPath);
});

// --- Domain invariants --------------------------------------------------

test('a content_version can still have multiple assets and multiple usage contexts', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  const { contentVersionId } = seedProducedContent(storage);
  const repo = new AssetProvenanceRepository(storage);

  const asset1 = repo.recordAsset({ assetType: 'image', location: '/tmp/a1.png' });
  const asset2 = repo.recordAsset({ assetType: 'image', location: '/tmp/a2.png' });
  repo.recordUsage({ assetId: asset1, contentVersionId, usageContext: 'thumbnail' });
  repo.recordUsage({ assetId: asset2, contentVersionId, usageContext: 'b-roll 00:12-00:18' });

  const usages = storage.all('SELECT * FROM asset_usages WHERE content_version_id = ?', [contentVersionId]);
  assert.equal(usages.length, 2);
  assert.ok(usages.some((u) => u.usage_context === 'thumbnail'));
  assert.ok(usages.some((u) => u.usage_context === 'b-roll 00:12-00:18'));
  assert.ok(usages.every((u) => u.provisioning_claim === null));

  cleanup(storage, dbPath);
});

test('a manually/descriptively written usage_context of "b-roll" is not constrained by the automated identity unless it explicitly carries it', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  const { contentVersionId } = seedProducedContent(storage);
  const repo = new AssetProvenanceRepository(storage);

  const asset1 = repo.recordAsset({ assetType: 'image', location: '/tmp/manual-1.png' });
  const asset2 = repo.recordAsset({ assetType: 'image', location: '/tmp/manual-2.png' });

  // Two independent manual 'b-roll' usages against the SAME content_version,
  // neither carrying provisioning_claim -- must NOT collide.
  assert.doesNotThrow(() => {
    repo.recordUsage({ assetId: asset1, contentVersionId, usageContext: 'b-roll' });
    repo.recordUsage({ assetId: asset2, contentVersionId, usageContext: 'b-roll' });
  });

  const count = storage.get(
    "SELECT COUNT(*) as n FROM asset_usages WHERE content_version_id = ? AND usage_context = 'b-roll'",
    [contentVersionId]
  ).n;
  assert.equal(count, 2);

  cleanup(storage, dbPath);
});

test('the partial unique index rejects a second non-null provisioning_claim for the same content_version_id, at the DB level', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  const { contentVersionId } = seedProducedContent(storage);
  const repo = new AssetProvenanceRepository(storage);

  const asset1 = repo.recordAsset({ assetType: 'image', location: '/tmp/claim-1.png' });
  const asset2 = repo.recordAsset({ assetType: 'image', location: '/tmp/claim-2.png' });

  repo.recordUsage({ assetId: asset1, contentVersionId, usageContext: 'b-roll', provisioningClaim: PROVISIONING_CLAIM });

  assert.throws(() => {
    repo.recordUsage({ assetId: asset2, contentVersionId, usageContext: 'b-roll', provisioningClaim: PROVISIONING_CLAIM });
  }, /UNIQUE constraint failed/);

  const claimCount = storage.get(
    'SELECT COUNT(*) as n FROM asset_usages WHERE content_version_id = ? AND provisioning_claim IS NOT NULL',
    [contentVersionId]
  ).n;
  assert.equal(claimCount, 1);

  cleanup(storage, dbPath);
});

test('the partial unique index does not constrain content_version_id, or usage_context, in general', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  const { contentVersionId: cv1 } = seedProducedContent(storage);
  const { contentVersionId: cv2 } = seedProducedContent(storage);
  const repo = new AssetProvenanceRepository(storage);

  const asset1 = repo.recordAsset({ assetType: 'image', location: '/tmp/cv1.png' });
  const asset2 = repo.recordAsset({ assetType: 'image', location: '/tmp/cv2.png' });

  // Different content_versions may each carry their own automated claim.
  assert.doesNotThrow(() => {
    repo.recordUsage({ assetId: asset1, contentVersionId: cv1, usageContext: 'b-roll', provisioningClaim: PROVISIONING_CLAIM });
    repo.recordUsage({ assetId: asset2, contentVersionId: cv2, usageContext: 'b-roll', provisioningClaim: PROVISIONING_CLAIM });
  });

  cleanup(storage, dbPath);
});

// --- Concurrency ----------------------------------------------------------

test('two concurrent provisioning attempts for the same content_version produce exactly one automated-provisioning claim, and the loser resolves to ALREADY_PROVISIONED', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  const { contentBriefId, contentVersionId } = seedProducedContent(storage);
  const { filePath: file1, dir: dir1 } = tempAssetFile('a');
  const { filePath: file2, dir: dir2 } = tempAssetFile('b');

  // Both invocations pass the pre-call "existing asset?" check before either
  // persists (simulated by delaying provider resolution), exercising exactly
  // the check-then-act window F5-01 identified.
  const provider1 = new FakeProvider(() => new Promise((resolve) => {
    setTimeout(() => resolve({ assetType: 'image', location: file1 }), 30);
  }));
  const provider2 = new FakeProvider(() => new Promise((resolve) => {
    setTimeout(() => resolve({ assetType: 'image', location: file2 }), 10);
  }));

  const [result1, result2] = await Promise.all([
    runAssetProvisioning({ storage, contentBriefId, provider: provider1 }),
    runAssetProvisioning({ storage, contentBriefId, provider: provider2 })
  ]);

  const outcomes = [result1.outcome, result2.outcome].sort();
  assert.deepEqual(outcomes, ['ALREADY_PROVISIONED', 'PROVISIONED']);

  const claimRows = storage.all(
    'SELECT * FROM asset_usages WHERE content_version_id = ? AND provisioning_claim IS NOT NULL',
    [contentVersionId]
  );
  assert.equal(claimRows.length, 1, 'exactly one automated-provisioning claim must be persisted');

  const assetCount = storage.get('SELECT COUNT(*) as n FROM assets').n;
  assert.equal(assetCount, 1, 'the losing invocation must not leave an orphaned asset row');

  // Both results must point at the same, single persisted asset.
  const winner = result1.outcome === 'PROVISIONED' ? result1 : result2;
  const loser = result1.outcome === 'PROVISIONED' ? result2 : result1;
  assert.equal(loser.asset.id, winner.asset.id);

  cleanup(storage, dbPath, [dir1, dir2]);
});

test('non-racing provisioning behavior is unchanged: single invocation still persists a normal claim', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  const { contentBriefId, contentVersionId } = seedProducedContent(storage);
  const { filePath, dir } = tempAssetFile();
  const provider = new FakeProvider({ assetType: 'image', location: filePath, verificationStatus: 'UNVERIFIED' });

  const result = await runAssetProvisioning({ storage, contentBriefId, provider });

  assert.equal(result.outcome, 'PROVISIONED');
  const usage = storage.get('SELECT * FROM asset_usages WHERE asset_id = ?', [result.asset.id]);
  assert.equal(usage.content_version_id, contentVersionId);
  assert.equal(usage.usage_context, 'b-roll');
  assert.equal(usage.provisioning_claim, PROVISIONING_CLAIM);

  cleanup(storage, dbPath, [dir]);
});
