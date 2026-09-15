import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { SqliteStorageDriver } from '../../src/storage/SqliteStorageDriver.js';
import { runQualityGate } from '../../src/quality-gate/pipeline.js';
import { AssetProvenanceRepository } from '../../src/state/AssetProvenance.js';
import { canTransition } from '../../src/state/ContentStateMachine.js';

function freshStorage() {
  const dbPath = path.join(os.tmpdir(), `quality-gate-e2e-${Date.now()}-${Math.random()}.db`);
  return { storage: new SqliteStorageDriver({ dbPath }), dbPath };
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

/** Seeds a Script + content_versions row, driven directly to ORIGINALITY_CHECK
 * (the state Quality Gate transitions from), mirroring the originality
 * suite's `seedThroughFactCheck` precedent. */
function seedThroughOriginalityCheck(storage, { body = 'Default script body text here.' } = {}) {
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
    `INSERT INTO content_versions (id, content_brief_id, script_id, state, created_at) VALUES (?, ?, ?, 'ORIGINALITY_CHECK', ?)`,
    [contentVersionId, contentBriefId, scriptId, nowISO()]
  );
  return { contentBriefId, scriptId, contentVersionId };
}

function seedFactCheck(storage, scriptId, status, version = 1) {
  storage.run(
    `INSERT INTO fact_checks (id, script_id, version, status, findings, created_at)
     VALUES (?, ?, ?, ?, '[]', ?)`,
    [crypto.randomUUID(), scriptId, version, status, nowISO()]
  );
}

function seedOriginalityCheck(storage, { scriptId, contentVersionId }) {
  storage.run(
    `INSERT INTO originality_checks
      (id, content_version_id, script_id, corpus_definition, corpus_size, algorithm, algorithm_version, max_similarity, most_similar_script_id, known_limitations, created_at)
     VALUES (?, ?, ?, 'all_prior_scripts_excluding_current_script_id', 0, 'jaccard_token_set', 'v1', NULL, NULL, 'n/a', ?)`,
    [crypto.randomUUID(), contentVersionId, scriptId, nowISO()]
  );
}

function seedAsset(storage, contentVersionId, verificationStatus) {
  const repo = new AssetProvenanceRepository(storage);
  const assetId = repo.recordAsset({ assetType: 'image', location: '/tmp/x.png', verificationStatus });
  repo.recordUsage({ assetId, contentVersionId });
  return assetId;
}

function getState(storage, contentBriefId) {
  return storage.get('SELECT * FROM content_versions WHERE content_brief_id = ?', [contentBriefId]).state;
}

// 1. All four PASS -------------------------------------------------------

test('all four checks PASS -> PRODUCTION_READY', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  const { contentBriefId, scriptId, contentVersionId } = seedThroughOriginalityCheck(storage);
  seedFactCheck(storage, scriptId, 'PASS');
  seedOriginalityCheck(storage, { scriptId, contentVersionId });

  const result = runQualityGate({ storage, contentBriefId });

  assert.equal(result.aggregate, 'PASS');
  assert.equal(result.targetState, 'PRODUCTION_READY');
  assert.equal(result.transitioned, true);
  assert.equal(getState(storage, contentBriefId), 'PRODUCTION_READY');
  assert.equal(result.checks.assetRights.result, 'PASS');
  assert.equal(result.checks.assetRights.reason, 'no_assets_attached');

  cleanup(storage, dbPath);
});

// 2. Fact-check REVIEW ----------------------------------------------------

test('fact-check REVIEW -> aggregate REVIEW -> NEEDS_REVIEW', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  const { contentBriefId, scriptId, contentVersionId } = seedThroughOriginalityCheck(storage);
  seedFactCheck(storage, scriptId, 'REVIEW');
  seedOriginalityCheck(storage, { scriptId, contentVersionId });

  const result = runQualityGate({ storage, contentBriefId });

  assert.equal(result.aggregate, 'REVIEW');
  assert.equal(getState(storage, contentBriefId), 'NEEDS_REVIEW');

  cleanup(storage, dbPath);
});

// 3. Fact-check REJECT ----------------------------------------------------

test('fact-check REJECT -> aggregate BLOCK -> BLOCKED', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  const { contentBriefId, scriptId, contentVersionId } = seedThroughOriginalityCheck(storage);
  seedFactCheck(storage, scriptId, 'REJECT');
  seedOriginalityCheck(storage, { scriptId, contentVersionId });

  const result = runQualityGate({ storage, contentBriefId });

  assert.equal(result.aggregate, 'BLOCK');
  assert.equal(getState(storage, contentBriefId), 'BLOCKED');

  cleanup(storage, dbPath);
});

// 4. Missing originality measurement --------------------------------------

test('missing originality evidence -> BLOCKED', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  const { contentBriefId, scriptId } = seedThroughOriginalityCheck(storage);
  seedFactCheck(storage, scriptId, 'PASS');
  // no originality_checks row seeded

  const result = runQualityGate({ storage, contentBriefId });

  assert.equal(result.aggregate, 'BLOCK');
  assert.equal(result.checks.originality.reason, 'ORIGINALITY_EVIDENCE_MISSING');
  assert.equal(getState(storage, contentBriefId), 'BLOCKED');

  cleanup(storage, dbPath);
});

// 5. UNVERIFIED asset -------------------------------------------------------

test('UNVERIFIED asset -> aggregate REVIEW -> NEEDS_REVIEW', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  const { contentBriefId, scriptId, contentVersionId } = seedThroughOriginalityCheck(storage);
  seedFactCheck(storage, scriptId, 'PASS');
  seedOriginalityCheck(storage, { scriptId, contentVersionId });
  seedAsset(storage, contentVersionId, 'UNVERIFIED');

  const result = runQualityGate({ storage, contentBriefId });

  assert.equal(result.checks.assetRights.result, 'REVIEW');
  assert.equal(result.aggregate, 'REVIEW');
  assert.equal(getState(storage, contentBriefId), 'NEEDS_REVIEW');

  cleanup(storage, dbPath);
});

// 6. DISPUTED asset -----------------------------------------------------

test('DISPUTED asset -> aggregate BLOCK -> BLOCKED', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  const { contentBriefId, scriptId, contentVersionId } = seedThroughOriginalityCheck(storage);
  seedFactCheck(storage, scriptId, 'PASS');
  seedOriginalityCheck(storage, { scriptId, contentVersionId });
  seedAsset(storage, contentVersionId, 'DISPUTED');

  const result = runQualityGate({ storage, contentBriefId });

  assert.equal(result.checks.assetRights.result, 'BLOCK');
  assert.equal(result.aggregate, 'BLOCK');
  assert.equal(getState(storage, contentBriefId), 'BLOCKED');

  cleanup(storage, dbPath);
});

// 7. All VERIFIED assets --------------------------------------------------

test('all VERIFIED assets -> asset check PASS -> PRODUCTION_READY', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  const { contentBriefId, scriptId, contentVersionId } = seedThroughOriginalityCheck(storage);
  seedFactCheck(storage, scriptId, 'PASS');
  seedOriginalityCheck(storage, { scriptId, contentVersionId });
  seedAsset(storage, contentVersionId, 'VERIFIED');
  seedAsset(storage, contentVersionId, 'VERIFIED');

  const result = runQualityGate({ storage, contentBriefId });

  assert.equal(result.checks.assetRights.result, 'PASS');
  assert.equal(result.checks.assetRights.reason, 'all_assets_verified');
  assert.equal(result.aggregate, 'PASS');
  assert.equal(getState(storage, contentBriefId), 'PRODUCTION_READY');

  cleanup(storage, dbPath);
});

// 8. Missing structural reference (no content_version at all) -------------

test('missing content_version -> STRUCTURAL_FAILURE, no transition attempted', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();

  const result = runQualityGate({ storage, contentBriefId: 'nonexistent-brief' });

  assert.equal(result.outcome, 'STRUCTURAL_FAILURE');
  assert.equal(result.reason, 'CONTENT_VERSION_NOT_FOUND');
  assert.equal(result.transitioned, false);
  assert.equal(result.checks, null);

  cleanup(storage, dbPath);
});

// 9. Multiple independent failures obey worst-case precedence -------------

test('REVIEW asset + BLOCK fact-check together -> aggregate BLOCK (worst-of, not averaged)', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  const { contentBriefId, scriptId, contentVersionId } = seedThroughOriginalityCheck(storage);
  seedFactCheck(storage, scriptId, 'REJECT'); // BLOCK
  seedOriginalityCheck(storage, { scriptId, contentVersionId });
  seedAsset(storage, contentVersionId, 'UNVERIFIED'); // REVIEW

  const result = runQualityGate({ storage, contentBriefId });

  assert.equal(result.checks.factCheck.result, 'BLOCK');
  assert.equal(result.checks.assetRights.result, 'REVIEW');
  assert.equal(result.aggregate, 'BLOCK', 'BLOCK must win over REVIEW, not be averaged into something milder');
  assert.equal(getState(storage, contentBriefId), 'BLOCKED');

  cleanup(storage, dbPath);
});

// 10. Already-resolved content version is not reprocessed/downgraded -------

test('re-running Quality Gate on an already-resolved content_version does not re-transition or downgrade', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  const { contentBriefId, scriptId, contentVersionId } = seedThroughOriginalityCheck(storage);
  seedFactCheck(storage, scriptId, 'PASS');
  seedOriginalityCheck(storage, { scriptId, contentVersionId });

  const first = runQualityGate({ storage, contentBriefId });
  assert.equal(first.transitioned, true);
  assert.equal(getState(storage, contentBriefId), 'PRODUCTION_READY');

  // A second run recomputes checks (still PASS) but must not re-transition
  // an already-resolved content_version, and must never downgrade it even
  // if evidence changes.
  seedFactCheck(storage, scriptId, 'REJECT', 2); // if re-evaluated, this would now BLOCK
  const second = runQualityGate({ storage, contentBriefId });

  assert.equal(second.transitioned, false);
  assert.equal(getState(storage, contentBriefId), 'PRODUCTION_READY', 'must not be downgraded to BLOCKED on rerun');

  cleanup(storage, dbPath);
});

// 11. Existing lifecycle rules remain intact / no illegal transition introduced -

test('state machine still forbids skipping ORIGINALITY_CHECK -> PRODUCED directly', () => {
  assert.equal(canTransition('ORIGINALITY_CHECK', 'PRODUCED'), false);
  assert.equal(canTransition('ORIGINALITY_CHECK', 'QUALITY_GATE'), true);
  assert.equal(canTransition('QUALITY_GATE', 'PRODUCTION_READY'), true);
  assert.equal(canTransition('QUALITY_GATE', 'NEEDS_REVIEW'), true);
  assert.equal(canTransition('QUALITY_GATE', 'BLOCKED'), true);
  assert.equal(canTransition('QUALITY_GATE', 'PRODUCED'), false, 'must not skip PRODUCTION_READY');
});

// 12. Gate 1 never touches risk_assessments ---------------------------------

test('Quality Gate never reads or writes risk_assessments', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  const { contentBriefId, scriptId, contentVersionId } = seedThroughOriginalityCheck(storage);
  seedFactCheck(storage, scriptId, 'PASS');
  seedOriginalityCheck(storage, { scriptId, contentVersionId });
  seedAsset(storage, contentVersionId, 'DISPUTED');

  runQualityGate({ storage, contentBriefId });

  const riskRows = storage.all('SELECT * FROM risk_assessments', []);
  assert.equal(riskRows.length, 0, 'Quality Gate must not write to risk_assessments (ADR-0006: remains Risk-stage-only)');

  cleanup(storage, dbPath);
});

// 13. No composite score is ever produced -----------------------------------

test('Quality Gate result carries only PASS/REVIEW/BLOCK outcomes, never a numeric score', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  const { contentBriefId, scriptId, contentVersionId } = seedThroughOriginalityCheck(storage);
  seedFactCheck(storage, scriptId, 'PASS');
  seedOriginalityCheck(storage, { scriptId, contentVersionId });

  const result = runQualityGate({ storage, contentBriefId });

  assert.ok(['PASS', 'REVIEW', 'BLOCK'].includes(result.aggregate));
  assert.equal(typeof result.aggregate, 'string');
  for (const check of Object.values(result.checks)) {
    assert.ok(['PASS', 'REVIEW', 'BLOCK'].includes(check.result));
  }
  assert.equal(Object.prototype.hasOwnProperty.call(result, 'score'), false);

  cleanup(storage, dbPath);
});

// 14. Decision log reconstructs the outcome ----------------------------------

test('decision_log records enough to reconstruct why the content reached its final state', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  const { contentBriefId, scriptId, contentVersionId } = seedThroughOriginalityCheck(storage);
  seedFactCheck(storage, scriptId, 'PASS');
  seedOriginalityCheck(storage, { scriptId, contentVersionId });
  seedAsset(storage, contentVersionId, 'UNVERIFIED');

  const result = runQualityGate({ storage, contentBriefId });
  assert.equal(result.aggregate, 'REVIEW');

  const rows = storage.all(`SELECT * FROM decision_log WHERE stage = 'QUALITY_GATE' ORDER BY created_at ASC`, []);
  const decisions = rows.map((r) => r.decision);
  assert.ok(decisions.includes('QUALITY_GATE'), 'must log stage entry');
  assert.ok(decisions.some((d) => d.startsWith('FACT_CHECK_CHECK_')));
  assert.ok(decisions.some((d) => d.startsWith('ORIGINALITY_EVIDENCE_CHECK_')));
  assert.ok(decisions.some((d) => d.startsWith('ASSET_RIGHTS_CHECK_')));
  assert.ok(decisions.some((d) => d.startsWith('STRUCTURAL_COMPLETENESS_CHECK_')));
  assert.ok(decisions.includes('REVIEW'), 'must log final aggregate outcome');

  cleanup(storage, dbPath);
});
