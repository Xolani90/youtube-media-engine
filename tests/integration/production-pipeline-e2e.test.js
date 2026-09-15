import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { SqliteStorageDriver } from '../../src/storage/SqliteStorageDriver.js';
import { runProduction } from '../../src/production/pipeline.js';
import { AssetProvenanceRepository } from '../../src/state/AssetProvenance.js';

function freshStorage() {
  const dbPath = path.join(os.tmpdir(), `production-e2e-${Date.now()}-${Math.random()}.db`);
  return { storage: new SqliteStorageDriver({ dbPath }), dbPath };
}

function freshArtifactsDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'production-artifacts-'));
}

function cleanup(storage, dbPath, artifactsDir) {
  storage.close();
  fs.rmSync(dbPath, { force: true });
  fs.rmSync(`${dbPath}-wal`, { force: true });
  fs.rmSync(`${dbPath}-shm`, { force: true });
  if (artifactsDir) fs.rmSync(artifactsDir, { recursive: true, force: true });
}

function nowISO() {
  return new Date().toISOString();
}

function seedResearchProject(storage) {
  const opportunityId = crypto.randomUUID();
  storage.run(
    `INSERT INTO opportunities (id, title, source, discovered_at, status) VALUES (?, 'Test opportunity', 'rss', ?, 'DISCOVERED')`,
    [opportunityId, nowISO()]
  );
  return { opportunityId };
}

function seedBrief(storage, opportunityId) {
  const id = crypto.randomUUID();
  storage.run(
    `INSERT INTO content_briefs
      (id, opportunity_id, working_title, core_question, target_audience, viewer_promise,
       hook, angle, narrative_structure, key_claims, counterpoints, original_insights, visual_ideas,
       monetization_opportunities, risk_assessment, created_at)
     VALUES (?, ?, 'T', 'Q', 'A', 'P', 'H', 'Angle', 'Structure', '[]', 'C', 'I', 'V', 'M', 'R', ?)`,
    [id, opportunityId, nowISO()]
  );
  return id;
}

/** Seeds a Script + content_versions row, driven directly to `state` (default PRODUCTION_READY, the state Production transitions from). */
function seedContentVersion(storage, { state = 'PRODUCTION_READY', body = 'Default script body text here.' } = {}) {
  const { opportunityId } = seedResearchProject(storage);
  const contentBriefId = seedBrief(storage, opportunityId);
  const scriptId = crypto.randomUUID();
  storage.run(
    `INSERT INTO scripts (id, content_brief_id, version, body, claim_links, created_at)
     VALUES (?, ?, 1, ?, '[]', ?)`,
    [scriptId, contentBriefId, body, nowISO()]
  );
  const contentVersionId = crypto.randomUUID();
  storage.run(
    `INSERT INTO content_versions (id, content_brief_id, script_id, state, created_at) VALUES (?, ?, ?, ?, ?)`,
    [contentVersionId, contentBriefId, scriptId, state, nowISO()]
  );
  return { contentBriefId, scriptId, contentVersionId };
}

function seedAsset(storage, contentVersionId, verificationStatus = 'VERIFIED') {
  const repo = new AssetProvenanceRepository(storage);
  const assetId = repo.recordAsset({ assetType: 'image', location: '/tmp/x.png', verificationStatus });
  repo.recordUsage({ assetId, contentVersionId, usageContext: 'thumbnail' });
  return assetId;
}

function getState(storage, contentBriefId) {
  return storage.get('SELECT * FROM content_versions WHERE content_brief_id = ?', [contentBriefId]).state;
}

// 1. Valid PRODUCTION_READY content produces an artifact + persists + transitions -----

test('valid PRODUCTION_READY content produces an artifact, persists it, and transitions to PRODUCED', async () => {
  const { storage, dbPath } = freshStorage();
  const artifactsDir = freshArtifactsDir();
  await storage.migrate();
  const { contentBriefId, scriptId, contentVersionId } = seedContentVersion(storage);
  seedAsset(storage, contentVersionId, 'VERIFIED');

  const result = runProduction({ storage, contentBriefId, artifactsDir });

  assert.equal(result.outcome, 'PRODUCED');
  assert.ok(result.production);
  assert.equal(result.production.content_version_id, contentVersionId);
  assert.equal(result.production.script_id, scriptId);
  assert.equal(result.production.artifact_type, 'production_manifest_v1');
  assert.ok(fs.existsSync(result.production.artifact_path));
  assert.equal(getState(storage, contentBriefId), 'PRODUCED');

  cleanup(storage, dbPath, artifactsDir);
});

// 2 & 4. Artifact contains/retains authoritative production inputs & D-G2 provenance -----

test('production artifact retains the authoritative production inputs and D-G2 asset provenance', async () => {
  const { storage, dbPath } = freshStorage();
  const artifactsDir = freshArtifactsDir();
  await storage.migrate();
  const { contentBriefId, scriptId, contentVersionId } = seedContentVersion(storage, { body: 'Exact script body.' });
  seedAsset(storage, contentVersionId, 'VERIFIED');

  const result = runProduction({ storage, contentBriefId, artifactsDir });

  const manifest = JSON.parse(result.production.manifest_json);
  assert.equal(manifest.content_version_id, contentVersionId);
  assert.equal(manifest.script.id, scriptId);
  assert.equal(manifest.script.body, 'Exact script body.');
  assert.equal(manifest.assets.length, 1);
  assert.equal(manifest.assets[0].verification_status, 'VERIFIED');
  assert.equal(manifest.assets[0].usage_context, 'thumbnail');

  const onDisk = fs.readFileSync(result.production.artifact_path, 'utf8');
  assert.equal(onDisk, result.production.manifest_json);

  cleanup(storage, dbPath, artifactsDir);
});

// 6. VERIFIED-only assets work (no block) -----

test('all VERIFIED assets -> production succeeds', async () => {
  const { storage, dbPath } = freshStorage();
  const artifactsDir = freshArtifactsDir();
  await storage.migrate();
  const { contentBriefId, contentVersionId } = seedContentVersion(storage);
  seedAsset(storage, contentVersionId, 'VERIFIED');
  seedAsset(storage, contentVersionId, 'VERIFIED');

  const result = runProduction({ storage, contentBriefId, artifactsDir });

  assert.equal(result.outcome, 'PRODUCED');

  cleanup(storage, dbPath, artifactsDir);
});

// 7. UNVERIFIED / DISPUTED assets cannot silently produce -----

test('DISPUTED asset -> ASSET_RIGHTS_BLOCKED, transitions to BLOCKED, no artifact persisted', async () => {
  const { storage, dbPath } = freshStorage();
  const artifactsDir = freshArtifactsDir();
  await storage.migrate();
  const { contentBriefId, contentVersionId } = seedContentVersion(storage);
  seedAsset(storage, contentVersionId, 'DISPUTED');

  const result = runProduction({ storage, contentBriefId, artifactsDir });

  assert.equal(result.outcome, 'ASSET_RIGHTS_BLOCKED');
  assert.equal(result.production, null);
  assert.equal(getState(storage, contentBriefId), 'BLOCKED');
  assert.equal(storage.get('SELECT * FROM productions WHERE content_version_id = ?', [contentVersionId]), undefined);

  cleanup(storage, dbPath, artifactsDir);
});

test('UNVERIFIED asset -> ASSET_RIGHTS_BLOCKED, transitions to BLOCKED, no artifact persisted', async () => {
  const { storage, dbPath } = freshStorage();
  const artifactsDir = freshArtifactsDir();
  await storage.migrate();
  const { contentBriefId, contentVersionId } = seedContentVersion(storage);
  seedAsset(storage, contentVersionId, 'UNVERIFIED');

  const result = runProduction({ storage, contentBriefId, artifactsDir });

  assert.equal(result.outcome, 'ASSET_RIGHTS_BLOCKED');
  assert.equal(getState(storage, contentBriefId), 'BLOCKED');

  cleanup(storage, dbPath, artifactsDir);
});

// 8. Non-PRODUCTION_READY content is rejected -----

for (const state of ['ORIGINALITY_CHECK', 'QUALITY_GATE', 'NEEDS_REVIEW', 'BLOCKED', 'SCRIPT_DRAFT']) {
  test(`content in ${state} is rejected -> INELIGIBLE_STATE, no transition, no artifact`, async () => {
    const { storage, dbPath } = freshStorage();
    const artifactsDir = freshArtifactsDir();
    await storage.migrate();
    const { contentBriefId, contentVersionId } = seedContentVersion(storage, { state });

    const result = runProduction({ storage, contentBriefId, artifactsDir });

    assert.equal(result.outcome, 'INELIGIBLE_STATE');
    assert.equal(result.production, null);
    assert.equal(getState(storage, contentBriefId), state);
    assert.equal(storage.get('SELECT * FROM productions WHERE content_version_id = ?', [contentVersionId]), undefined);

    cleanup(storage, dbPath, artifactsDir);
  });
}

// 3, 10. Artifact associated with correct content_version; exact PRODUCTION_READY -> PRODUCED transition -----

test('successful production transitions exactly PRODUCTION_READY -> PRODUCED and associates the artifact with the right content_version', async () => {
  const { storage, dbPath } = freshStorage();
  const artifactsDir = freshArtifactsDir();
  await storage.migrate();
  const a = seedContentVersion(storage);
  const b = seedContentVersion(storage);

  const resultA = runProduction({ storage, contentBriefId: a.contentBriefId, artifactsDir });

  assert.equal(resultA.production.content_version_id, a.contentVersionId);
  assert.equal(getState(storage, a.contentBriefId), 'PRODUCED');
  // Untouched sibling content_version stays exactly where it was.
  assert.equal(getState(storage, b.contentBriefId), 'PRODUCTION_READY');
  assert.equal(storage.get('SELECT * FROM productions WHERE content_version_id = ?', [b.contentVersionId]), undefined);

  cleanup(storage, dbPath, artifactsDir);
});

// 9. Artifact creation failure does not produce PRODUCED -----

test('artifact write failure -> ARTIFACT_WRITE_FAILED, state remains PRODUCTION_READY, no productions row', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  const { contentBriefId, contentVersionId } = seedContentVersion(storage);

  // A regular file in place of the artifacts base dir makes mkdirSync fail.
  const artifactsDir = path.join(os.tmpdir(), `not-a-dir-${Date.now()}-${Math.random()}`);
  fs.writeFileSync(artifactsDir, 'not a directory');

  const result = runProduction({ storage, contentBriefId, artifactsDir });

  assert.equal(result.outcome, 'ARTIFACT_WRITE_FAILED');
  assert.equal(result.production, null);
  assert.equal(getState(storage, contentBriefId), 'PRODUCTION_READY');
  assert.equal(storage.get('SELECT * FROM productions WHERE content_version_id = ?', [contentVersionId]), undefined);

  storage.close();
  fs.rmSync(dbPath, { force: true });
  fs.rmSync(`${dbPath}-wal`, { force: true });
  fs.rmSync(`${dbPath}-shm`, { force: true });
  fs.rmSync(artifactsDir, { force: true });
});

// 11. Repeated production does not create uncontrolled duplicates -----

test('repeated production for an already-PRODUCED content_version returns the same existing record, no duplicate row', async () => {
  const { storage, dbPath } = freshStorage();
  const artifactsDir = freshArtifactsDir();
  await storage.migrate();
  const { contentBriefId, contentVersionId } = seedContentVersion(storage);
  seedAsset(storage, contentVersionId, 'VERIFIED');

  const first = runProduction({ storage, contentBriefId, artifactsDir });
  const second = runProduction({ storage, contentBriefId, artifactsDir });

  assert.equal(first.outcome, 'PRODUCED');
  assert.equal(second.outcome, 'ALREADY_PRODUCED');
  assert.equal(second.production.id, first.production.id);
  const rows = storage.all('SELECT * FROM productions WHERE content_version_id = ?', [contentVersionId]);
  assert.equal(rows.length, 1);
  assert.equal(getState(storage, contentBriefId), 'PRODUCED');

  cleanup(storage, dbPath, artifactsDir);
});

// 12. Production does not invoke external services -----

test('production performs no network/external side effects (purely local artifact + DB writes)', async () => {
  const { storage, dbPath } = freshStorage();
  const artifactsDir = freshArtifactsDir();
  await storage.migrate();
  const { contentBriefId } = seedContentVersion(storage);

  // No provider/network config or credentials are supplied at all, and
  // runProduction accepts no provider/credential dependency — the only
  // side effects available to it are the local filesystem write and the
  // local storage transaction exercised above.
  const result = runProduction({ storage, contentBriefId, artifactsDir });

  assert.equal(result.outcome, 'PRODUCED');
  assert.equal(storage.all('SELECT * FROM provider_calls').length, 0);

  cleanup(storage, dbPath, artifactsDir);
});

// 13/14. Existing lifecycle and D-C2/D-G1/D-G2 surfaces remain untouched -----

test('structural failure (no current script) is rejected cleanly, mirroring other stages', async () => {
  const { storage, dbPath } = freshStorage();
  const artifactsDir = freshArtifactsDir();
  await storage.migrate();
  const { opportunityId } = seedResearchProject(storage);
  const contentBriefId = seedBrief(storage, opportunityId);
  // No content_versions row at all for this content_brief.

  const result = runProduction({ storage, contentBriefId, artifactsDir });

  assert.equal(result.outcome, 'STRUCTURAL_FAILURE');
  assert.equal(result.reason, 'CONTENT_VERSION_NOT_FOUND');
  assert.equal(result.production, null);

  cleanup(storage, dbPath, artifactsDir);
});
