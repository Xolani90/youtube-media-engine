import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { SqliteStorageDriver } from '../../src/storage/SqliteStorageDriver.js';
import { runAssetProvisioning } from '../../src/asset-provisioning/pipeline.js';
import { AssetSourceProvider } from '../../src/providers/asset/AssetSourceProvider.js';

function freshStorage() {
  const dbPath = path.join(os.tmpdir(), `asset-provisioning-e2e-${Date.now()}-${Math.random()}.db`);
  return { storage: new SqliteStorageDriver({ dbPath }), dbPath };
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

function seedProducedContent(storage) {
  const opportunityId = crypto.randomUUID();
  storage.run(
    `INSERT INTO opportunities (id, title, source, discovered_at, status) VALUES (?, 'Test opportunity', 'rss', ?, 'DISCOVERED')`,
    [opportunityId, nowISO()]
  );
  const contentBriefId = crypto.randomUUID();
  storage.run(
    `INSERT INTO content_briefs
      (id, opportunity_id, working_title, core_question, target_audience, viewer_promise,
       hook, angle, narrative_structure, key_claims, counterpoints, original_insights, visual_ideas,
       monetization_opportunities, risk_assessment, created_at)
     VALUES (?, ?, 'T', 'Q', 'A', 'P', 'H', 'Angle', 'Structure', '[]', 'C', 'I', 'A quiet forest path', 'M', 'R', ?)`,
    [contentBriefId, opportunityId, nowISO()]
  );
  const scriptId = crypto.randomUUID();
  storage.run(
    `INSERT INTO scripts (id, content_brief_id, version, body, claim_links, created_at)
     VALUES (?, ?, 1, 'Script body.', '[]', ?)`,
    [scriptId, contentBriefId, nowISO()]
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
  return { contentBriefId, contentVersionId };
}

class FakeProvider extends AssetSourceProvider {
  constructor(location) {
    super();
    this._location = location;
  }
  get id() { return 'fake'; }
  async healthCheck() { return true; }
  async acquireVisualAsset() {
    return {
      assetType: 'image',
      location: this._location,
      origin: 'fake-stub-provider',
      license: 'Test License',
      verificationStatus: 'UNVERIFIED'
    };
  }
}

// End-to-end proof: produced content fixture -> Asset Provisioning ->
// real AssetProvenanceRepository -> assets row exists -> asset_usages row
// exists -> correct content_version_id -> local visual file exists.
// Uses an injected fake AssetSourceProvider for deterministic, offline
// testing -- this does NOT prove live Pixabay acquisition (Milestone C's
// scripts/acquire-real-pixabay-asset.js remains the live provider proof).
test('produced content flows through Asset Provisioning into a real persisted asset + usage', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();

  const assetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'asset-provisioning-e2e-file-'));
  const assetPath = path.join(assetDir, 'forest.jpg');
  fs.writeFileSync(assetPath, 'real-local-visual-file-bytes');

  const { contentBriefId, contentVersionId } = seedProducedContent(storage);
  const provider = new FakeProvider(assetPath);

  const result = await runAssetProvisioning({ storage, contentBriefId, provider });

  assert.equal(result.outcome, 'PROVISIONED');
  assert.ok(result.asset);

  const assetRow = storage.get('SELECT * FROM assets WHERE id = ?', [result.asset.id]);
  assert.ok(assetRow, 'assets row must exist');
  assert.equal(assetRow.verification_status, 'UNVERIFIED');

  const usageRow = storage.get('SELECT * FROM asset_usages WHERE asset_id = ?', [result.asset.id]);
  assert.ok(usageRow, 'asset_usages row must exist');
  assert.equal(usageRow.content_version_id, contentVersionId);

  assert.ok(fs.existsSync(assetRow.location), 'local visual file must exist on disk');

  // Idempotency, in the same real-repository path: running it again must
  // not create a second asset or a second usage row.
  const secondResult = await runAssetProvisioning({ storage, contentBriefId, provider });
  assert.equal(secondResult.outcome, 'ALREADY_PROVISIONED');
  assert.equal(storage.get('SELECT COUNT(*) as n FROM assets').n, 1);
  assert.equal(storage.get('SELECT COUNT(*) as n FROM asset_usages').n, 1);

  cleanup(storage, dbPath, [assetDir]);
});
