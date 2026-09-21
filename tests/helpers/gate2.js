// Test helper (NOT a test: lives outside tests/unit and tests/integration, so
// it is not matched by the `npm test` globs). ADR-0032 (Gate 2 / FINAL_COMPLIANCE).
//
// Makes an existing PRODUCED fixture Gate-2-passable using ONLY the real
// repository relationships and the REAL final-compliance stage -- it never
// inserts a compliance record by hand, so tests that need a "Gate 2 already
// passed" item exercise the genuine evaluator/persistence/transition path.

import crypto from 'node:crypto';
import fs from 'node:fs';
import { runFinalCompliance } from '../../src/compliance/pipeline.js';
import { sha256File } from '../../src/media/artifactStore.js';
import { AssetVerificationRepository } from '../../src/state/AssetVerification.js';

const nowISO = () => new Date().toISOString();

/**
 * Adds the existing-provenance evidence GC-005 reads (script-generation and
 * brief-generation ACCEPTED decision_log rows, plus a research_projects row
 * for the brief) and re-points media_artifacts.artifact_checksum at the real
 * bytes of the artifact file, when that file exists. Idempotent.
 */
export function prepareGate2Evidence(storage, contentVersionId) {
  const cv = storage.get('SELECT * FROM content_versions WHERE id = ?', [contentVersionId]);
  const script = storage.get('SELECT * FROM scripts WHERE id = ?', [cv.script_id]);
  const brief = storage.get('SELECT * FROM content_briefs WHERE id = ?', [script.content_brief_id]);

  let researchProjectId = brief.research_project_id;
  if (!researchProjectId) {
    researchProjectId = crypto.randomUUID();
    storage.run(
      `INSERT INTO research_projects (id, opportunity_id, status, created_at) VALUES (?, ?, 'RESEARCH_COMPLETE', ?)`,
      [researchProjectId, brief.opportunity_id, nowISO()]
    );
    storage.run('UPDATE content_briefs SET research_project_id = ? WHERE id = ?', [researchProjectId, brief.id]);
  }

  const ensureAccepted = (subjectType, subjectId, stage) => {
    const existing = storage.get(
      `SELECT id FROM decision_log WHERE subject_type = ? AND subject_id = ? AND stage = ? AND decision = 'ACCEPTED'`,
      [subjectType, subjectId, stage]
    );
    if (existing) return;
    storage.run(
      `INSERT INTO decision_log (id, run_id, subject_type, subject_id, decision, reason, created_at, stage)
       VALUES (?, NULL, ?, ?, 'ACCEPTED', 'accepted_on_attempt_1', ?, ?)`,
      [crypto.randomUUID(), subjectType, subjectId, nowISO(), stage]
    );
  };
  ensureAccepted('content_brief', brief.id, 'SCRIPT_GENERATION');
  ensureAccepted('research_project', researchProjectId, 'BRIEF_GENERATION');

  const media = storage.get('SELECT * FROM media_artifacts WHERE content_version_id = ?', [contentVersionId]);
  if (media && fs.existsSync(media.artifact_path)) {
    storage.run('UPDATE media_artifacts SET artifact_checksum = ? WHERE id = ?', [sha256File(media.artifact_path), media.id]);
  }
}

/**
 * Records an append-only asset_verifications row for an asset, mirroring
 * what rights verification persists (the history Gate 2 GC-002 reads).
 */
export function recordVerification(storage, assetId, decision, { reason = 'test' } = {}) {
  return new AssetVerificationRepository(storage).recordDecision({
    assetId, decision, policyId: 'test-policy', policyVersion: '1', evidenceFieldsExamined: {}, reason, verifierType: 'automated'
  });
}

/**
 * Runs the real final-compliance stage for the content_version's brief and
 * returns its result. From PRODUCED, a PASS moves it to FINAL_COMPLIANCE.
 */
export function runGate2(storage, contentVersionId, { runId = null } = {}) {
  const cv = storage.get('SELECT content_brief_id FROM content_versions WHERE id = ?', [contentVersionId]);
  return runFinalCompliance({ storage, contentBriefId: cv.content_brief_id, runId });
}

/** prepareGate2Evidence + runGate2, asserting the item reached a Gate 2 PASS. */
export function passGate2(storage, contentVersionId) {
  prepareGate2Evidence(storage, contentVersionId);
  const result = runGate2(storage, contentVersionId);
  if (result.decision !== 'PASS') {
    throw new Error(`test helper expected a Gate 2 PASS, got ${result.outcome}: ${JSON.stringify(result.ruleResults ?? result)}`);
  }
  return result;
}
