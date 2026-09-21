import crypto from 'node:crypto';
import { FINAL_COMPLIANCE_STAGE, OUTCOME, DECISION_LOG_DECISION, RESULT } from './constants.js';
import { loadGate2Policy, Gate2PolicyLoadError } from './policy.js';
import { evaluateGate2 } from './evaluator.js';
import { verifyGate2Pass } from './verify.js';
import { Gate2ComplianceRepository } from './repository.js';
import { canTransition, transition } from '../state/ContentStateMachine.js';

/** Same shape/discipline as every other stage's local logDecision helper. */
function logDecision(storage, { runId = null, subjectType, subjectId, decision, reason, resultingState = null }, nowISO = () => new Date().toISOString()) {
  const id = crypto.randomUUID();
  storage.run(
    `INSERT INTO decision_log
      (id, run_id, subject_type, subject_id, decision, reason, provider, config_snapshot, confidence, risk_level, resulting_state, created_at, stage)
     VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?, ?)`,
    [id, runId, subjectType, subjectId, decision, reason, resultingState, nowISO(), FINAL_COMPLIANCE_STAGE]
  );
  return id;
}

// ADR-0032 s11: result -> destination state, per current state.
//   PRODUCED:         PASS -> FINAL_COMPLIANCE, REVIEW -> NEEDS_REVIEW, BLOCK -> BLOCKED
//   FINAL_COMPLIANCE: PASS -> (append PASS, NO transition), REVIEW -> NEEDS_REVIEW, BLOCK -> BLOCKED
const TARGET_STATE = Object.freeze({
  [RESULT.PASS]: 'FINAL_COMPLIANCE',
  [RESULT.REVIEW]: 'NEEDS_REVIEW',
  [RESULT.BLOCK]: 'BLOCKED'
});

/**
 * Gate 2 / FINAL_COMPLIANCE runner stage (ADR-0032 section 14).
 *
 * Handles exactly two kinds of item:
 *   (A) PRODUCED items that have a media artifact: evaluated; a PASS moves
 *       them to FINAL_COMPLIANCE, REVIEW to NEEDS_REVIEW, BLOCK to BLOCKED.
 *   (B) FINAL_COMPLIANCE items: first checked for a currently valid PASS
 *       (fresh policy read, actual file checksum, current bindings/evidence).
 *       If one exists nothing happens (ALREADY_VALID). Otherwise Gate 2 is
 *       evaluated again: PASS appends a fresh PASS and the item stays in
 *       FINAL_COMPLIANCE WITHOUT a same-state transition; REVIEW / BLOCK move
 *       it to NEEDS_REVIEW / BLOCKED (both terminal: exit workflows are out
 *       of scope). There is no FINAL_COMPLIANCE -> PRODUCED transition.
 *
 * The selectors that feed this stage are efficiency filters only; this stage
 * alone decides whether a PASS is currently valid.
 *
 * This stage NEVER publishes: it imports nothing from src/publication/, calls
 * no provider, and consults no authorization.
 *
 * If the policy pack is missing/malformed/wrong, no PASS is established, no
 * existing PASS is accepted, no state transition occurs, no REVIEW/BLOCK is
 * fabricated, and POLICY_LOAD_FAILURE is reported.
 *
 * @param {object} deps
 * @param {import('../storage/StorageDriver.js').StorageDriver} deps.storage
 * @param {string} deps.contentBriefId
 * @param {string} [deps.runId]
 */
export function runFinalCompliance({ storage, contentBriefId, runId = null }) {
  const nowISO = () => new Date().toISOString();

  // --- 1. Fresh policy read (never cached). ---
  let policy;
  try {
    policy = loadGate2Policy();
  } catch (err) {
    if (!(err instanceof Gate2PolicyLoadError)) throw err;
    logDecision(storage, {
      runId, subjectType: 'content_brief', subjectId: contentBriefId,
      decision: DECISION_LOG_DECISION.POLICY_LOAD_FAILURE, reason: `${err.code}: ${err.message}`
    }, nowISO);
    return { outcome: OUTCOME.POLICY_LOAD_FAILURE, reason: err.code, message: err.message };
  }

  // --- 2. Structural eligibility. ---
  const contentVersion = storage.get('SELECT * FROM content_versions WHERE content_brief_id = ?', [contentBriefId]);
  if (!contentVersion) {
    logDecision(storage, {
      runId, subjectType: 'content_brief', subjectId: contentBriefId,
      decision: DECISION_LOG_DECISION.STRUCTURAL_FAILURE, reason: 'CONTENT_VERSION_NOT_FOUND'
    }, nowISO);
    return { outcome: OUTCOME.STRUCTURAL_FAILURE, reason: 'CONTENT_VERSION_NOT_FOUND' };
  }
  if (contentVersion.state !== 'PRODUCED' && contentVersion.state !== 'FINAL_COMPLIANCE') {
    logDecision(storage, {
      runId, subjectType: 'content_version', subjectId: contentVersion.id,
      decision: DECISION_LOG_DECISION.INELIGIBLE_STATE, reason: `not_eligible_from_state_${contentVersion.state}`
    }, nowISO);
    return { outcome: OUTCOME.INELIGIBLE_STATE, reason: contentVersion.state };
  }
  const mediaArtifact = storage.get('SELECT id FROM media_artifacts WHERE content_version_id = ?', [contentVersion.id]);
  if (!mediaArtifact) {
    logDecision(storage, {
      runId, subjectType: 'content_version', subjectId: contentVersion.id,
      decision: DECISION_LOG_DECISION.NOT_YET_RENDERED, reason: 'no_media_artifact'
    }, nowISO);
    return { outcome: OUTCOME.NOT_YET_RENDERED, reason: 'no_media_artifact' };
  }

  // --- 3. FINAL_COMPLIANCE items: skip if a PASS is currently valid. ---
  if (contentVersion.state === 'FINAL_COMPLIANCE') {
    let verification;
    try {
      verification = verifyGate2Pass(storage, contentVersion.id);
    } catch (err) {
      // The pack became unusable between the read above and this check. Same
      // rule as above: surface the failure, change nothing.
      if (!(err instanceof Gate2PolicyLoadError)) throw err;
      logDecision(storage, {
        runId, subjectType: 'content_version', subjectId: contentVersion.id,
        decision: DECISION_LOG_DECISION.POLICY_LOAD_FAILURE, reason: `${err.code}: ${err.message}`
      }, nowISO);
      return { outcome: OUTCOME.POLICY_LOAD_FAILURE, reason: err.code, message: err.message };
    }
    if (verification.authorizing) {
      return { outcome: OUTCOME.ALREADY_VALID, transitioned: false, resultingState: 'FINAL_COMPLIANCE', record: verification.record };
    }
  }

  // --- 4. Evaluate (read-only), then persist + transition atomically. ---
  const evaluation = evaluateGate2(storage, contentVersion.id);
  const evaluatedFromState = contentVersion.state;
  const repo = new Gate2ComplianceRepository(storage);

  const persisted = storage.transaction(() => {
    // Guard against the state having moved since it was read above; if it
    // did, nothing is written for this attempt.
    const current = storage.get('SELECT state FROM content_versions WHERE id = ?', [contentVersion.id]);
    if (!current || current.state !== evaluatedFromState) return { changed: true, state: current?.state ?? null };

    const record = repo.append({
      contentVersionId: contentVersion.id,
      decision: evaluation.overall,
      policyVersion: policy.version,
      ruleIds: policy.ruleIds,
      ruleResults: evaluation.ruleResults,
      binding: evaluation.binding,
      evidence: evaluation.evidence
    });

    const target = TARGET_STATE[evaluation.overall];
    let resultingState = evaluatedFromState;
    // No same-state transition: a fresh PASS on an item already in
    // FINAL_COMPLIANCE only appends the record.
    if (target !== evaluatedFromState) {
      if (!canTransition(evaluatedFromState, target)) {
        throw new Error(`Gate 2: illegal transition ${evaluatedFromState} -> ${target}`); // rolls the record back too
      }
      resultingState = transition(evaluatedFromState, target);
      storage.run('UPDATE content_versions SET state = ? WHERE id = ?', [resultingState, contentVersion.id]);
    }

    logDecision(storage, {
      runId, subjectType: 'content_version', subjectId: contentVersion.id,
      decision: DECISION_LOG_DECISION[evaluation.overall],
      reason: `gate2_${evaluation.overall}_record_${record.id}_policy_${policy.version}`,
      resultingState
    }, nowISO);
    return { changed: false, record, resultingState };
  });

  if (persisted.changed) {
    return { outcome: OUTCOME.CONCURRENT_STATE_CHANGE, reason: `state_now_${persisted.state}` };
  }

  return {
    outcome: OUTCOME[evaluation.overall],
    decision: evaluation.overall,
    transitioned: persisted.resultingState !== evaluatedFromState,
    resultingState: persisted.resultingState,
    ruleResults: evaluation.ruleResults,
    record: persisted.record
  };
}

export default runFinalCompliance;
