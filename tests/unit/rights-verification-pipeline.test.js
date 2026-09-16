import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import { SqliteStorageDriver } from '../../src/storage/SqliteStorageDriver.js';
import { AssetProvenanceRepository } from '../../src/state/AssetProvenance.js';
import { AssetVerificationRepository } from '../../src/state/AssetVerification.js';
import { runRightsVerification } from '../../src/rights-verification/pipeline.js';
import { OUTCOME } from '../../src/rights-verification/constants.js';
import { POLICY_ID, POLICY_VERSION } from '../../src/rights-verification/policy/pixabay.js';

function freshStorage() {
  const dbPath = path.join(os.tmpdir(), `rights-verification-${Date.now()}-${Math.random()}.db`);
  return { storage: new SqliteStorageDriver({ dbPath }), dbPath };
}

function cleanup(storage, dbPath, ...extraFiles) {
  storage.close();
  fs.rmSync(dbPath, { force: true });
  fs.rmSync(`${dbPath}-wal`, { force: true });
  fs.rmSync(`${dbPath}-shm`, { force: true });
  for (const f of extraFiles) fs.rmSync(f, { force: true });
}

function nowISO() {
  return new Date().toISOString();
}

function seedProducedContent(storage) {
  const opportunityId = crypto.randomUUID();
  storage.run(
    `INSERT INTO opportunities (id, title, source, discovered_at, status) VALUES (?, 'T', 'rss', ?, 'RESEARCH_HANDED_OFF_TEST_FIXTURE')`,
    [opportunityId, nowISO()]
  );
  const contentBriefId = crypto.randomUUID();
  storage.run(
    `INSERT INTO content_briefs (id, opportunity_id, research_project_id, working_title, created_at) VALUES (?, ?, NULL, 'T', ?)`,
    [contentBriefId, opportunityId, nowISO()]
  );
  const scriptId = crypto.randomUUID();
  storage.run(
    `INSERT INTO scripts (id, content_brief_id, version, body, claim_links, created_at) VALUES (?, ?, 1, 'Body.', '[]', ?)`,
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

function attachPixabayAsset(storage, contentVersionId, { license = 'Pixabay Content License', assetFilePath = '/nonexistent/path.jpg' } = {}) {
  const provenanceRepo = new AssetProvenanceRepository(storage);
  const assetId = provenanceRepo.recordAsset({
    assetType: 'image',
    location: assetFilePath,
    checksum: fs.existsSync(assetFilePath) ? sha256OfFile(assetFilePath) : null,
    origin: 'pixabay',
    license,
    provenanceNotes: 'provider=pixabay'
  });
  provenanceRepo.recordUsage({ assetId, contentVersionId, usageContext: 'b-roll' });
  return assetId;
}

function sha256OfFile(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

// ---------------------------------------------------------------------

test('NOT_YET_PRODUCED: no productions row yet -> structural, non-fatal outcome, no assets touched', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();

  const opportunityId = crypto.randomUUID();
  storage.run(`INSERT INTO opportunities (id, title, source, discovered_at, status) VALUES (?, 'T', 'rss', ?, 'X')`, [opportunityId, nowISO()]);
  const contentBriefId = crypto.randomUUID();
  storage.run(`INSERT INTO content_briefs (id, opportunity_id, research_project_id, working_title, created_at) VALUES (?, ?, NULL, 'T', ?)`, [contentBriefId, opportunityId, nowISO()]);
  const scriptId = crypto.randomUUID();
  storage.run(`INSERT INTO scripts (id, content_brief_id, version, body, claim_links, created_at) VALUES (?, ?, 1, 'B', '[]', ?)`, [scriptId, contentBriefId, nowISO()]);
  storage.run(`INSERT INTO content_versions (id, content_brief_id, script_id, state, created_at) VALUES (?, ?, ?, 'PRODUCED', ?)`, [crypto.randomUUID(), contentBriefId, scriptId, nowISO()]);

  const result = runRightsVerification({ storage, contentBriefId });
  assert.equal(result.outcome, OUTCOME.NOT_YET_PRODUCED);
  assert.equal(result.results.length, 0);

  cleanup(storage, dbPath);
});

test('NO_ASSETS_ATTACHED: produced content with zero attached assets', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  const { contentBriefId } = seedProducedContent(storage);

  const result = runRightsVerification({ storage, contentBriefId });
  assert.equal(result.outcome, OUTCOME.NO_ASSETS_ATTACHED);

  cleanup(storage, dbPath);
});

test('UNVERIFIED -> VERIFIED: approved Pixabay license + matching checksum on disk promotes the asset and persists a decision row', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  const { contentBriefId, contentVersionId } = seedProducedContent(storage);

  const assetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rv-asset-'));
  const assetFilePath = path.join(assetDir, 'forest.jpg');
  fs.writeFileSync(assetFilePath, 'real-bytes');
  const assetId = attachPixabayAsset(storage, contentVersionId, { assetFilePath });

  const result = runRightsVerification({ storage, contentBriefId });
  assert.equal(result.outcome, OUTCOME.PROCESSED);
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].decision, 'VERIFIED');

  const assetRow = storage.get('SELECT * FROM assets WHERE id = ?', [assetId]);
  assert.equal(assetRow.verification_status, 'VERIFIED');

  const verificationRepo = new AssetVerificationRepository(storage);
  const decisions = verificationRepo.getDecisionsForAsset(assetId);
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].decision, 'VERIFIED');
  assert.equal(decisions[0].policy_id, POLICY_ID);
  assert.equal(decisions[0].policy_version, POLICY_VERSION);
  assert.equal(decisions[0].verifier_type, 'automated');

  fs.rmSync(assetDir, { recursive: true, force: true });
  cleanup(storage, dbPath);
});

test('UNVERIFIED -> UNVERIFIED (cache) on a NOT_VERIFIED decision: the assets.verification_status CHECK constraint has no NOT_VERIFIED value, so the cache column must remain UNVERIFIED while the full decision is still persisted', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  const { contentBriefId, contentVersionId } = seedProducedContent(storage);
  // Unapproved license -> NOT_VERIFIED, and no checksum/file -> would be
  // NOT_VERIFIED regardless; either way this must never throw a CHECK
  // constraint violation against the assets table.
  const assetId = attachPixabayAsset(storage, contentVersionId, { license: 'Some Other License' });

  const result = runRightsVerification({ storage, contentBriefId });
  assert.equal(result.outcome, OUTCOME.PROCESSED);
  assert.equal(result.results[0].decision, 'NOT_VERIFIED');

  const assetRow = storage.get('SELECT * FROM assets WHERE id = ?', [assetId]);
  assert.equal(assetRow.verification_status, 'UNVERIFIED');

  const verificationRepo = new AssetVerificationRepository(storage);
  const decisions = verificationRepo.getDecisionsForAsset(assetId);
  assert.equal(decisions[0].decision, 'NOT_VERIFIED');
  assert.equal(decisions[0].reason, 'license_not_approved');

  cleanup(storage, dbPath);
});

test('checksum mismatch -> DISPUTED, not merely NOT_VERIFIED, and the original acquisition checksum is never overwritten', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  const { contentBriefId, contentVersionId } = seedProducedContent(storage);

  const assetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rv-asset-'));
  const assetFilePath = path.join(assetDir, 'forest.jpg');
  fs.writeFileSync(assetFilePath, 'original-bytes-at-acquisition-time');
  const assetId = attachPixabayAsset(storage, contentVersionId, { assetFilePath });
  const acquisitionChecksum = storage.get('SELECT checksum FROM assets WHERE id = ?', [assetId]).checksum;

  // File on disk now differs from the checksum recorded at acquisition.
  fs.writeFileSync(assetFilePath, 'tampered-bytes');

  const result = runRightsVerification({ storage, contentBriefId });
  assert.equal(result.results[0].decision, 'DISPUTED');
  assert.equal(result.results[0].reason, 'checksum_mismatch');

  const assetRow = storage.get('SELECT * FROM assets WHERE id = ?', [assetId]);
  assert.equal(assetRow.verification_status, 'DISPUTED');
  assert.equal(assetRow.checksum, acquisitionChecksum, 'the original acquisition checksum must never be overwritten by a later mismatch');

  fs.rmSync(assetDir, { recursive: true, force: true });
  cleanup(storage, dbPath);
});

test('DISPUTED assets are excluded from automated eligibility entirely, never auto-resolved', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  const { contentBriefId, contentVersionId } = seedProducedContent(storage);
  const assetId = attachPixabayAsset(storage, contentVersionId);
  storage.run(`UPDATE assets SET verification_status = 'DISPUTED' WHERE id = ?`, [assetId]);

  const result = runRightsVerification({ storage, contentBriefId });
  assert.equal(result.outcome, OUTCOME.NO_ELIGIBLE_ASSETS);

  const assetRow = storage.get('SELECT * FROM assets WHERE id = ?', [assetId]);
  assert.equal(assetRow.verification_status, 'DISPUTED', 'automated stage must never resolve a dispute');

  const verificationRepo = new AssetVerificationRepository(storage);
  assert.equal(verificationRepo.getDecisionsForAsset(assetId).length, 0);

  cleanup(storage, dbPath);
});

test('lazy re-verification: an asset already decided under this exact policy id/version is not re-evaluated (idempotent, no duplicate decision rows)', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  const { contentBriefId, contentVersionId } = seedProducedContent(storage);

  const assetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rv-asset-'));
  const assetFilePath = path.join(assetDir, 'forest.jpg');
  fs.writeFileSync(assetFilePath, 'real-bytes');
  const assetId = attachPixabayAsset(storage, contentVersionId, { assetFilePath });

  const first = runRightsVerification({ storage, contentBriefId });
  assert.equal(first.outcome, OUTCOME.PROCESSED);

  const second = runRightsVerification({ storage, contentBriefId });
  assert.equal(second.outcome, OUTCOME.NO_ELIGIBLE_ASSETS, 're-running under the same policy version must not re-evaluate an already-decided asset');

  const verificationRepo = new AssetVerificationRepository(storage);
  assert.equal(verificationRepo.getDecisionsForAsset(assetId).length, 1, 'no duplicate decision row');

  // A later policy version makes the asset eligible again (F2 §15).
  const laterDecision = verificationRepo.getLatestDecisionForPolicyVersion(assetId, POLICY_ID, 'v2-does-not-exist-yet');
  assert.equal(laterDecision, null);

  fs.rmSync(assetDir, { recursive: true, force: true });
  cleanup(storage, dbPath);
});

test('content_versions.state is never transitioned by this stage', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  const { contentBriefId, contentVersionId } = seedProducedContent(storage);
  attachPixabayAsset(storage, contentVersionId);

  runRightsVerification({ storage, contentBriefId });

  const cv = storage.get('SELECT * FROM content_versions WHERE id = ?', [contentVersionId]);
  assert.equal(cv.state, 'PRODUCED');

  cleanup(storage, dbPath);
});