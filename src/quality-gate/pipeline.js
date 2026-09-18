import crypto from 'node:crypto';
import {
  QUALITY_GATE_STAGE,
  CHECK_RESULT,
  RESULT_RANK,
  CHECK_NAME,
  TARGET_STATE,
  DECISION_LOG_DECISION
} from './constants.js';
import { resolveCurrentScript } from './eligibility.js';
import { checkFactCheck, checkOriginalityEvidence, checkAssetRights } from './checks.js';
import { canTransition, transition, InvalidTransitionError } from '../state/ContentStateMachine.js';

/**
 * Records a decision_log entry. Same shape/discipline as Fact-Check's,
 * Originality's, Script's, and Brief's local logDecision helpers (stage
 * is a first-class column, never encoded into decision/reason) — a
 * small, deliberately duplicated helper per the repository's existing
 * per-module convention, not a shared import.
 */
function logDecision(storage, { runId = null, stage, subjectType, subjectId, decision, reason, resultingState = null }, nowISO = () => new Date().toISOString()) {
  const id = crypto.randomUUID();
  storage.run(
    `INSERT INTO decision_log
      (id, run_id, subject_type, subject_id, decision, reason, provider, config_snapshot, confidence, risk_level, resulting_state, created_at, stage)
     VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?, ?)`,
    [id, runId, subjectType, subjectId, decision, reason, resultingState, nowISO(), stage]
  );
  return id;
}

/**
 * Records the required decision_log entry for a Quality Gate structural
 * failure (no current Script / content_brief resolvable — this IS the
 * structural-completeness check's BLOCK condition) and returns the
 * structured failure the caller receives. No lifecycle transition is
 * attempted — mirrors Fact-Check's and Originality's structuralFailure.
 */
function structuralFailure(storage, { runId, subjectType, subjectId, reason }, nowISO) {
  logDecision(storage, {
    runId,
    stage: QUALITY_GATE_STAGE,
    subjectType,
    subjectId,
    decision: DECISION_LOG_DECISION.STRUCTURAL_FAILURE,
    reason
  }, nowISO);
  return { outcome: 'STRUCTURAL_FAILURE', reason, checks: null, aggregate: null, transitioned: false };
}

/** Deterministic worst-case selector across independent check results. Never a score, weight, or average. */
function aggregate(results) {
  let worst = CHECK_RESULT.PASS;
  for (const r of results) {
    if (RESULT_RANK[r.result] > RESULT_RANK[worst]) worst = r.result;
  }
  return worst;
}

/**
 * Runs Gate 1 (Quality Gate / Production Readiness) for the current
 * Script of a content item (ADR-0006 D-G8, Owner Gate-1 decision).
 *
 * This function may be invoked directly by any caller (mirrors
 * runFactCheck's / runOriginalityCheck's "manual trigger surface, any
 * driver may invoke it" shape), and is also invoked automatically by
 * src/autonomous/runner.js's buildStages() as part of the Owner-authorized
 * runner stage order (ADR-0010) — the same shape as every other stage in
 * that order.
 *
 * @param {object} deps
 * @param {import('../storage/StorageDriver.js').StorageDriver} deps.storage
 * @param {string} deps.contentBriefId
 * @param {string} [deps.runId]
 */
export function runQualityGate({ storage, contentBriefId, runId = null }) {
  const nowISO = () => new Date().toISOString();

  // Structural-completeness check (content_version -> script ->
  // content_brief all resolve). Failing here IS the BLOCK condition for
  // that check — no partial gate evaluation is attempted.
  const eligibility = resolveCurrentScript(storage, contentBriefId);
  if (!eligibility.eligible) {
    return structuralFailure(storage, {
      runId, subjectType: 'content_brief', subjectId: contentBriefId, reason: eligibility.reason
    }, nowISO);
  }
  const { script, contentVersion } = eligibility;

  // The remaining three checks are pure reads, computed outside the
  // transaction (mirrors Originality's jaccard computation) since none
  // of them performs a write.
  const factCheckResult = checkFactCheck(storage, script.id);
  const originalityResult = checkOriginalityEvidence(storage, script.id);
  const assetRightsResult = checkAssetRights(storage, contentVersion.id);
  const structuralResult = { name: CHECK_NAME.STRUCTURAL, result: CHECK_RESULT.PASS, reason: 'structural_references_resolved' };

  const checks = {
    factCheck: factCheckResult,
    originality: originalityResult,
    assetRights: assetRightsResult,
    structural: structuralResult
  };
  const aggregateResult = aggregate([factCheckResult, originalityResult, assetRightsResult, structuralResult]);
  const targetState = TARGET_STATE[aggregateResult];

  const outcome = storage.transaction(() => {
    // Re-read content_versions inside the transaction: it must still be
    // pointed at this exact script (mirrors Fact-Check's/Originality's
    // staleness guard).
    const cv = storage.get('SELECT * FROM content_versions WHERE content_brief_id = ?', [contentBriefId]);
    if (!cv || cv.script_id !== script.id) {
      throw new Error(`content_versions no longer points at script ${script.id} for content_brief ${contentBriefId}; refusing to persist Quality Gate result.`);
    }

    // Only transition from the exact state Gate 1 is defined for
    // (ORIGINALITY_CHECK -> QUALITY_GATE -> target). A content_version
    // that has already been resolved by a prior Gate 1 run (i.e. already
    // sitting at QUALITY_GATE, PRODUCTION_READY, NEEDS_REVIEW, or
    // BLOCKED) is NOT re-transitioned — this guarantees an
    // already-resolved result can never be silently downgraded or
    // reprocessed. The checks above are still computed and logged for
    // audit purposes, but no state-machine write occurs.
    let transitioned = false;
    if (cv.state === 'ORIGINALITY_CHECK') {
      if (!canTransition(cv.state, 'QUALITY_GATE')) {
        throw new InvalidTransitionError(`${cv.state} -> QUALITY_GATE is not a valid transition`);
      }
      let newState = transition(cv.state, 'QUALITY_GATE');
      storage.run('UPDATE content_versions SET state = ? WHERE id = ?', [newState, cv.id]);
      logDecision(storage, {
        runId, stage: QUALITY_GATE_STAGE, subjectType: 'content_version', subjectId: cv.id,
        decision: DECISION_LOG_DECISION.QUALITY_GATE_ENTERED, reason: 'quality_gate_entered', resultingState: newState
      }, nowISO);

      if (!canTransition(newState, targetState)) {
        throw new InvalidTransitionError(`${newState} -> ${targetState} is not a valid transition`);
      }
      newState = transition(newState, targetState);
      storage.run('UPDATE content_versions SET state = ? WHERE id = ?', [newState, cv.id]);
      transitioned = true;
    }

    // Per-check decision_log entries — sufficient to reconstruct exactly
    // why the content became PRODUCTION_READY / NEEDS_REVIEW / BLOCKED,
    // without a new audit table or logging architecture.
    for (const check of [factCheckResult, originalityResult, assetRightsResult, structuralResult]) {
      logDecision(storage, {
        runId, stage: QUALITY_GATE_STAGE, subjectType: 'script', subjectId: script.id,
        decision: `${check.name}_${check.result}`, reason: check.reason
      }, nowISO);
    }
    logDecision(storage, {
      runId, stage: QUALITY_GATE_STAGE, subjectType: 'content_version', subjectId: cv.id,
      decision: aggregateResult, reason: `quality_gate_evaluated_aggregate_${aggregateResult}`,
      resultingState: transitioned ? targetState : null
    }, nowISO);

    return { transitioned };
  });

  return {
    outcome: aggregateResult,
    checks,
    aggregate: aggregateResult,
    targetState,
    transitioned: outcome.transitioned
  };
}
