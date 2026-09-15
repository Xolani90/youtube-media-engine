import crypto from 'node:crypto';
import { PRODUCTION_STAGE, OUTCOME, DECISION_LOG_DECISION } from './constants.js';
import { resolveCurrentScript } from './eligibility.js';
import { buildManifest, canonicalStringify, sha256 } from './manifest.js';
import { writeManifestArtifact } from './artifactStore.js';
import { AssetProvenanceRepository } from '../state/AssetProvenance.js';
import { canTransition, transition, InvalidTransitionError } from '../state/ContentStateMachine.js';
import { config } from '../config/index.js';

/**
 * Records a decision_log entry. Same shape/discipline as every other
 * stage's local logDecision helper (stage is a first-class column) — a
 * small, deliberately duplicated helper per the repository's existing
 * per-module convention, not a shared import.
 */
function logDecision(storage, { runId = null, subjectType, subjectId, decision, reason, resultingState = null }, nowISO = () => new Date().toISOString()) {
  const id = crypto.randomUUID();
  storage.run(
    `INSERT INTO decision_log
      (id, run_id, subject_type, subject_id, decision, reason, provider, config_snapshot, confidence, risk_level, resulting_state, created_at, stage)
     VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?, ?)`,
    [id, runId, subjectType, subjectId, decision, reason, resultingState, nowISO(), PRODUCTION_STAGE]
  );
  return id;
}

/** D-G2 assets currently attached to this content_version, with their usage_context merged in. Read-only — never mutates asset or usage rows. */
function fetchAssetsWithUsageContext(storage, contentVersionId) {
  const repo = new AssetProvenanceRepository(storage);
  const assets = repo.getAssetsForContent(contentVersionId);
  const usageRows = storage.all(
    'SELECT asset_id, usage_context FROM asset_usages WHERE content_version_id = ?',
    [contentVersionId]
  );
  const usageByAssetId = new Map(usageRows.map((u) => [u.asset_id, u.usage_context]));
  return assets.map((a) => ({ ...a, usage_context: usageByAssetId.get(a.id) ?? null }));
}

/**
 * Runs Production for the current Script of a content item (Owner
 * Production MVP brief). Standalone, explicitly-invoked stage — no
 * orchestrator calls this automatically, mirroring every prior stage's
 * "manual trigger surface" convention.
 *
 * @param {object} deps
 * @param {import('../storage/StorageDriver.js').StorageDriver} deps.storage
 * @param {string} deps.contentBriefId
 * @param {string} [deps.artifactsDir] - defaults to config.productionArtifactsDir
 * @param {string} [deps.runId]
 */
export function runProduction({ storage, contentBriefId, artifactsDir = config.productionArtifactsDir, runId = null }) {
  const nowISO = () => new Date().toISOString();

  const eligibility = resolveCurrentScript(storage, contentBriefId);
  if (!eligibility.eligible) {
    logDecision(storage, {
      runId, subjectType: 'content_brief', subjectId: contentBriefId,
      decision: DECISION_LOG_DECISION.STRUCTURAL_FAILURE, reason: eligibility.reason
    }, nowISO);
    return { outcome: OUTCOME.STRUCTURAL_FAILURE, reason: eligibility.reason, production: null };
  }
  const { contentVersion, script, contentBrief } = eligibility;

  // Idempotency: PRODUCTION_READY -> PRODUCED is a single forward,
  // non-repeatable transition. If this content_version has already been
  // produced, return the existing authoritative record unchanged — never
  // re-derive, re-write, or re-transition (mirrors Fact-Check's
  // non-forced-rerun precedent, applied here at the state level since
  // there is exactly one production per content_version).
  if (contentVersion.state === 'PRODUCED') {
    const existing = storage.get('SELECT * FROM productions WHERE content_version_id = ?', [contentVersion.id]);
    return { outcome: OUTCOME.ALREADY_PRODUCED, production: existing ?? null };
  }

  // The only legal entry point is PRODUCTION_READY. Any other state
  // (ORIGINALITY_CHECK, QUALITY_GATE, NEEDS_REVIEW, BLOCKED, SCRIPT_DRAFT,
  // etc.) is rejected cleanly — no attempt, no transition.
  if (contentVersion.state !== 'PRODUCTION_READY') {
    logDecision(storage, {
      runId, subjectType: 'content_version', subjectId: contentVersion.id,
      decision: DECISION_LOG_DECISION.INELIGIBLE_STATE, reason: `not_eligible_from_state_${contentVersion.state}`
    }, nowISO);
    return { outcome: OUTCOME.INELIGIBLE_STATE, reason: contentVersion.state, production: null };
  }

  // Re-check D-G2 asset rights at production time (not just Gate 1's
  // earlier snapshot — assets may have been attached, or their
  // verification_status changed, since Gate 1 ran). Any DISPUTED or
  // UNVERIFIED asset is a certain condition Production must not silently
  // proceed past (Owner brief §9/§7); mirrors Gate 1's own vocabulary,
  // not a new policy. usage_restrictions free text is never parsed.
  const assets = fetchAssetsWithUsageContext(storage, contentVersion.id);
  const unsafeAsset = assets.find((a) => a.verification_status === 'DISPUTED' || a.verification_status === 'UNVERIFIED');
  if (unsafeAsset) {
    const outcome = storage.transaction(() => {
      const cv = storage.get('SELECT * FROM content_versions WHERE content_brief_id = ?', [contentBriefId]);
      if (!cv || cv.script_id !== script.id) {
        throw new Error(`content_versions no longer points at script ${script.id} for content_brief ${contentBriefId}; refusing to block production.`);
      }
      if (!canTransition(cv.state, 'BLOCKED')) {
        throw new InvalidTransitionError(`${cv.state} -> BLOCKED is not a valid transition`);
      }
      const newState = transition(cv.state, 'BLOCKED');
      storage.run('UPDATE content_versions SET state = ? WHERE id = ?', [newState, cv.id]);
      logDecision(storage, {
        runId, subjectType: 'content_version', subjectId: cv.id,
        decision: DECISION_LOG_DECISION.ASSET_RIGHTS_BLOCKED,
        reason: `asset_${unsafeAsset.id}_verification_status_${unsafeAsset.verification_status}`,
        resultingState: newState
      }, nowISO);
      return { transitioned: true };
    });
    return { outcome: OUTCOME.ASSET_RIGHTS_BLOCKED, reason: unsafeAsset.verification_status, transitioned: outcome.transitioned, production: null };
  }

  // Build the deterministic manifest and write it to local storage BEFORE
  // touching the database — if the write fails, nothing is persisted and
  // the state is left exactly as PRODUCTION_READY (never falsely PRODUCED).
  const manifest = buildManifest({ contentVersion, script, contentBrief, assets });
  const manifestJson = canonicalStringify(manifest);
  const checksum = sha256(manifestJson);

  let artifactPath;
  try {
    artifactPath = writeManifestArtifact(artifactsDir, contentVersion.id, manifestJson);
  } catch (err) {
    logDecision(storage, {
      runId, subjectType: 'content_version', subjectId: contentVersion.id,
      decision: DECISION_LOG_DECISION.ARTIFACT_WRITE_FAILED, reason: `artifact_write_failed_${err.message}`
    }, nowISO);
    return { outcome: OUTCOME.ARTIFACT_WRITE_FAILED, reason: err.message, production: null };
  }

  const outcome = storage.transaction(() => {
    // Re-read content_versions inside the transaction: it must still be
    // pointed at this exact script and still be PRODUCTION_READY
    // (mirrors every prior stage's staleness guard).
    const cv = storage.get('SELECT * FROM content_versions WHERE content_brief_id = ?', [contentBriefId]);
    if (!cv || cv.script_id !== script.id) {
      throw new Error(`content_versions no longer points at script ${script.id} for content_brief ${contentBriefId}; refusing to persist Production result.`);
    }
    if (cv.state !== 'PRODUCTION_READY') {
      // Lost the race (e.g. a concurrent run already produced or blocked
      // it) — the artifact file was written but is simply an
      // inconsequential duplicate of what a concurrent successful run
      // would also have produced (same deterministic inputs -> same
      // bytes); no DB row is inserted here.
      return { raced: true };
    }
    if (!canTransition(cv.state, 'PRODUCED')) {
      throw new InvalidTransitionError(`${cv.state} -> PRODUCED is not a valid transition`);
    }

    const productionId = crypto.randomUUID();
    storage.run(
      `INSERT INTO productions (id, content_version_id, script_id, artifact_type, artifact_path, artifact_checksum, manifest_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [productionId, cv.id, script.id, manifest.artifact_type, artifactPath, checksum, manifestJson, nowISO()]
    );

    const newState = transition(cv.state, 'PRODUCED');
    storage.run('UPDATE content_versions SET state = ? WHERE id = ?', [newState, cv.id]);
    logDecision(storage, {
      runId, subjectType: 'content_version', subjectId: cv.id,
      decision: DECISION_LOG_DECISION.PRODUCED, reason: `production_persisted_${productionId}`, resultingState: newState
    }, nowISO);

    return { productionId };
  });

  if (outcome.raced) {
    const existing = storage.get('SELECT * FROM productions WHERE content_version_id = ?', [contentVersion.id]);
    return { outcome: OUTCOME.ALREADY_PRODUCED, production: existing ?? null };
  }

  const production = storage.get('SELECT * FROM productions WHERE id = ?', [outcome.productionId]);
  return { outcome: OUTCOME.PRODUCED, production };
}