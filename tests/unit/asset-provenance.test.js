import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { SqliteStorageDriver } from '../../src/storage/SqliteStorageDriver.js';
import { AssetProvenanceRepository } from '../../src/state/AssetProvenance.js';

function tempDbPath() {
  return path.join(os.tmpdir(), `asset-provenance-test-${Date.now()}-${Math.random()}.db`);
}

async function freshStorage() {
  const dbPath = tempDbPath();
  const storage = new SqliteStorageDriver({ dbPath });
  await storage.migrate();
  return { storage, dbPath };
}

function cleanup(storage, dbPath) {
  storage.close();
  fs.rmSync(dbPath, { force: true });
  fs.rmSync(`${dbPath}-wal`, { force: true });
  fs.rmSync(`${dbPath}-shm`, { force: true });
}

function nowISO() {
  return new Date().toISOString();
}

// Seeds a minimal content_version row (through opportunity -> content_brief)
// so asset_usages has something real to reference, following the same
// seeding style as tests/integration/originality-check-pipeline-e2e.test.js.
function seedContentVersion(storage) {
  const opportunityId = crypto.randomUUID();
  storage.run(
    `INSERT INTO opportunities (id, title, source, discovered_at, status) VALUES (?, 'Test opportunity', 'rss', ?, 'DISCOVERED')`,
    [opportunityId, nowISO()]
  );
  const briefId = crypto.randomUUID();
  storage.run(
    `INSERT INTO content_briefs
      (id, opportunity_id, working_title, core_question, target_audience, viewer_promise,
       hook, angle, narrative_structure, key_claims, counterpoints, original_insights, visual_ideas,
       monetization_opportunities, risk_assessment, created_at)
     VALUES (?, ?, 'T', 'Q', 'A', 'P', 'H', 'Angle', 'Structure', '[]', 'C', 'I', 'V', 'M', 'R', ?)`,
    [briefId, opportunityId, nowISO()]
  );
  const contentVersionId = crypto.randomUUID();
  storage.run(
    `INSERT INTO content_versions (id, content_brief_id, state, created_at) VALUES (?, ?, 'DISCOVERED', ?)`,
    [contentVersionId, briefId, nowISO()]
  );
  return contentVersionId;
}

// 1. An asset can be represented independently of research sources.
test('an asset can be recorded with no research_project/source in existence at all', async () => {
  const { storage, dbPath } = await freshStorage();
  const assets = new AssetProvenanceRepository(storage);

  const sourceCountBefore = storage.get('SELECT COUNT(*) as n FROM sources').n;
  assert.equal(sourceCountBefore, 0);

  const assetId = assets.recordAsset({ assetType: 'image', location: 's3://bucket/thumb.png' });
  assert.ok(assetId);
  assert.ok(assets.getAsset(assetId));

  // Recording the asset did not touch sources at all.
  const sourceCountAfter = storage.get('SELECT COUNT(*) as n FROM sources').n;
  assert.equal(sourceCountAfter, 0);

  cleanup(storage, dbPath);
});

// 2. Asset provenance/rights information can be represented.
test('asset provenance/rights fields round-trip', async () => {
  const { storage, dbPath } = await freshStorage();
  const assets = new AssetProvenanceRepository(storage);

  const assetId = assets.recordAsset({
    assetType: 'video_clip',
    location: '/data/assets/clip-001.mp4',
    checksum: 'sha256:deadbeef',
    origin: 'stock-library:pexels',
    license: 'CC0',
    attributionRequired: false,
    usageRestrictions: 'no-resale',
    provenanceNotes: 'downloaded 2026-09-01',
    verificationStatus: 'VERIFIED'
  });

  const row = assets.getAsset(assetId);
  assert.equal(row.asset_type, 'video_clip');
  assert.equal(row.location, '/data/assets/clip-001.mp4');
  assert.equal(row.checksum, 'sha256:deadbeef');
  assert.equal(row.origin, 'stock-library:pexels');
  assert.equal(row.license, 'CC0');
  assert.equal(row.attribution_required, 0);
  assert.equal(row.usage_restrictions, 'no-resale');
  assert.equal(row.provenance_notes, 'downloaded 2026-09-01');
  assert.equal(row.verification_status, 'VERIFIED');

  cleanup(storage, dbPath);
});

test('recordAsset requires assetType and location', async () => {
  const { storage, dbPath } = await freshStorage();
  const assets = new AssetProvenanceRepository(storage);

  assert.throws(() => assets.recordAsset({ location: '/x' }), /assetType/);
  assert.throws(() => assets.recordAsset({ assetType: 'image' }), /location/);

  cleanup(storage, dbPath);
});

// 3. An asset can be associated with content through an explicit usage relationship.
test('an asset is associated with content only via asset_usages, not via its own row', async () => {
  const { storage, dbPath } = await freshStorage();
  const assets = new AssetProvenanceRepository(storage);
  const contentVersionId = seedContentVersion(storage);

  const assetId = assets.recordAsset({ assetType: 'image', location: '/x/thumb.png' });
  assert.deepEqual(assets.getAssetsForContent(contentVersionId), []); // not used yet

  assets.recordUsage({ assetId, contentVersionId, usageContext: 'thumbnail' });

  const used = assets.getAssetsForContent(contentVersionId);
  assert.equal(used.length, 1);
  assert.equal(used[0].id, assetId);

  const usages = assets.getUsagesForAsset(assetId);
  assert.equal(usages.length, 1);
  assert.equal(usages[0].content_version_id, contentVersionId);
  assert.equal(usages[0].usage_context, 'thumbnail');

  cleanup(storage, dbPath);
});

test('recordUsage requires assetId and contentVersionId', async () => {
  const { storage, dbPath } = await freshStorage();
  const assets = new AssetProvenanceRepository(storage);
  const contentVersionId = seedContentVersion(storage);
  const assetId = assets.recordAsset({ assetType: 'image', location: '/x' });

  assert.throws(() => assets.recordUsage({ contentVersionId }), /assetId/);
  assert.throws(() => assets.recordUsage({ assetId }), /contentVersionId/);

  cleanup(storage, dbPath);
});

// 4. Multiple assets can be associated with content where the schema permits it.
test('multiple assets can be used by the same content, and one asset can be reused across content', async () => {
  const { storage, dbPath } = await freshStorage();
  const assets = new AssetProvenanceRepository(storage);
  const contentA = seedContentVersion(storage);
  const contentB = seedContentVersion(storage);

  const asset1 = assets.recordAsset({ assetType: 'image', location: '/x/1.png' });
  const asset2 = assets.recordAsset({ assetType: 'audio', location: '/x/2.mp3' });

  // Content A uses both assets.
  assets.recordUsage({ assetId: asset1, contentVersionId: contentA });
  assets.recordUsage({ assetId: asset2, contentVersionId: contentA });
  assert.equal(assets.getAssetsForContent(contentA).length, 2);

  // Asset 1 is reused by Content B too.
  assets.recordUsage({ assetId: asset1, contentVersionId: contentB });
  assert.equal(assets.getAssetsForContent(contentB).length, 1);
  assert.equal(assets.getUsagesForAsset(asset1).length, 2);

  cleanup(storage, dbPath);
});

// 5. Asset provenance does not accidentally become content-level provenance.
test('asset provenance stays on the assets table and is not written into content_versions/content_briefs', async () => {
  const { storage, dbPath } = await freshStorage();
  const assets = new AssetProvenanceRepository(storage);
  const contentVersionId = seedContentVersion(storage);

  const assetId = assets.recordAsset({
    assetType: 'image',
    location: '/x/1.png',
    license: 'CC-BY-4.0',
    provenanceNotes: 'this belongs to the asset, not the content'
  });
  assets.recordUsage({ assetId, contentVersionId });

  const contentVersionColumns = storage
    .all("PRAGMA table_info(content_versions)")
    .map((c) => c.name);
  const briefColumns = storage.all('PRAGMA table_info(content_briefs)').map((c) => c.name);

  for (const provenanceColumn of ['license', 'checksum', 'provenance_notes', 'usage_restrictions', 'asset_type']) {
    assert.ok(!contentVersionColumns.includes(provenanceColumn), `content_versions must not gain "${provenanceColumn}"`);
    assert.ok(!briefColumns.includes(provenanceColumn), `content_briefs must not gain "${provenanceColumn}"`);
  }

  // And the content_versions row itself carries none of the asset's rights info.
  const contentRow = storage.get('SELECT * FROM content_versions WHERE id = ?', [contentVersionId]);
  assert.ok(!('license' in contentRow));
  assert.ok(!('provenance_notes' in contentRow));

  cleanup(storage, dbPath);
});

// 6. Existing source/research functionality remains unaffected.
// Prior to RG-03 (docs/DECISIONS/RESEARCH-GOVERNANCE-BASELINE.md), this test
// also inserted and read back claims.source_id — the sole dependency on that
// now-removed legacy column (see RG-03 in the governance baseline). The
// active claim-to-source relationship is claim_sources, unaffected by RG-03
// and not exercised here since this test's purpose is claims/sources/
// research_projects basics, not claim_sources itself.
test('sources/research_projects/claims still work exactly as before D-G2', async () => {
  const { storage, dbPath } = await freshStorage();

  const opportunityId = crypto.randomUUID();
  storage.run(
    `INSERT INTO opportunities (id, title, source, discovered_at, status) VALUES (?, 'O', 'rss', ?, 'DISCOVERED')`,
    [opportunityId, nowISO()]
  );
  const researchProjectId = crypto.randomUUID();
  storage.run(
    `INSERT INTO research_projects (id, opportunity_id, status, created_at) VALUES (?, ?, 'RESEARCHING', ?)`,
    [researchProjectId, opportunityId, nowISO()]
  );
  const sourceId = crypto.randomUUID();
  storage.run(
    `INSERT INTO sources (id, research_project_id, url, source_type, retrieved_at) VALUES (?, ?, 'https://example.com', 'news', ?)`,
    [sourceId, researchProjectId, nowISO()]
  );
  const claimId = crypto.randomUUID();
  storage.run(
    `INSERT INTO claims (id, research_project_id, claim, claim_type, created_at)
     VALUES (?, ?, 'X happened', 'FACT', ?)`,
    [claimId, researchProjectId, nowISO()]
  );

  const claim = storage.get('SELECT * FROM claims WHERE id = ?', [claimId]);
  assert.equal(claim.claim, 'X happened');
  assert.equal(claim.claim_type, 'FACT');

  cleanup(storage, dbPath);
});

// 7. Existing lifecycle behavior remains unaffected.
test('ContentStateMachine transitions are unaffected by D-G2', async () => {
  const { canTransition } = await import('../../src/state/ContentStateMachine.js');
  assert.equal(canTransition('DISCOVERED', 'SCORED'), true);
  assert.equal(canTransition('DISCOVERED', 'PRODUCTION_READY'), false);
  assert.equal(canTransition('PRODUCTION_READY', 'REJECTED'), true);
});

test('the migration applies cleanly alongside all existing migrations', async () => {
  const { storage, dbPath } = await freshStorage();
  const tableNames = storage
    .all("SELECT name FROM sqlite_master WHERE type='table'")
    .map((r) => r.name);
  assert.ok(tableNames.includes('assets'));
  assert.ok(tableNames.includes('asset_usages'));
  // Pre-existing tables are still there too.
  assert.ok(tableNames.includes('content_versions'));
  assert.ok(tableNames.includes('sources'));
  cleanup(storage, dbPath);
});
