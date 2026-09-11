import crypto from 'node:crypto';
import { FACT_CHECK_STAGE, DECISION_LOG_DECISION, FACT_CHECK_STATUS } from './constants.js';
import { resolveCurrentScript } from './eligibility.js';
import { parseClaimLinks, resolveResearchProject, resolveClaims, hasApplicableContradiction } from './validate.js';
import { evaluateDecision } from './decision.js';
import { canTransition, transition, InvalidTransitionError } from '../state/ContentStateMachine.js';

/**
 * Records a decision_log entry, same shape/discipline as Script's and
 * Brief's local logDecision helpers (stage is a first-class column, never
 * encoded into decision/reason).
 */
function logDecision(storage, { runId = null, stage, subjectType, subjectId, decision, reason, provider = null, resultingState = null, configSnapshot = null }, nowISO = () => new Date().toISOString()) {
  const id = crypto.randomUUID();
  storage.run(
    `INSERT INTO decision_log
      (id, run_id, subject_type, subject_id, decision, reason, provider, config_snapshot, confidence, risk_level, resulting_state, created_at, stage)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?)`,
    [id, runId, subjectType, subjectId, decision, reason, provider, configSnapshot ? JSON.stringify(configSnapshot) : null, resultingState, nowISO(), stage]
  );
  return id;
}

function latestFactCheck(storage, scriptId) {
  return storage.get(
    'SELECT * FROM fact_checks WHERE script_id = ? ORDER BY version DESC LIMIT 1',
    [scriptId]
  );
}

/**
 * Records the required decision_log entry for a Fact-Check structural
 * failure (spec §11 / D10), and returns the structured failure the caller
 * is required to receive.
 */
function structuralFailure(storage, { runId, subjectType, subjectId, reason }, nowISO) {
  logDecision(storage, {
    runId,
    stage: FACT_CHECK_STAGE,
    subjectType,
    subjectId,
    decision: DECISION_LOG_DECISION.STRUCTURAL_FAILURE,
    reason,
    resultingState: 'SCRIPT_DRAFT'
  }, nowISO);
  return { outcome: 'STRUCTURAL_FAILURE', reason, factCheck: null };
}

/**
 * Runs (or returns the existing result of) Fact-Check for the current
 * Script of a content item (spec, all sections).
 *
 * This is the manual trigger surface for Fact-Check, in the same
 * "run once, any driver may invoke it" style as `createScript`.
 *
 * @param {object} deps
 * @param {import('../storage/StorageDriver.js').StorageDriver} deps.storage
 * @param {string} deps.contentBriefId
 * @param {boolean} [deps.force] - forced rerun: always creates a new version. Without it, an existing Fact-Check result for the current Script is returned unchanged (spec §10).
 * @param {string} [deps.runId]
 */
export function runFactCheck({ storage, contentBriefId, force = false, runId = null }) {
  const nowISO = () => new Date().toISOString();

  // --- §4a/§4b: resolve the current Script via content_versions.script_id
  // only. No independent "ORDER BY version DESC" definition of current. ---
  const eligibility = resolveCurrentScript(storage, contentBriefId);
  if (!eligibility.eligible) {
    // No current Script id exists yet to attribute the failure to; log
    // against the content_brief being evaluated instead.
    return structuralFailure(storage, {
      runId, subjectType: 'content_brief', subjectId: contentBriefId, reason: eligibility.reason
    }, nowISO);
  }
  const { script } = eligibility;

  // --- §10: ordinary (non-forced) rerun returns the latest existing
  // result for this exact script_id without re-validating or re-deciding. ---
  if (!force) {
    const existing = latestFactCheck(storage, script.id);
    if (existing) {
      return { outcome: 'EXISTING_RESULT_RETURNED', factCheck: existing };
    }
  }

  // --- §11: structural validation of claim_links shape. ---
  const shape = parseClaimLinks(script);
  if (!shape.valid) {
    return structuralFailure(storage, {
      runId, subjectType: 'script', subjectId: script.id, reason: shape.reason
    }, nowISO);
  }

  // --- §5: resolve the originating Research project via
  // scripts.content_brief_id -> content_briefs.research_project_id. ---
  const project = resolveResearchProject(storage, script);
  if (!project.resolved) {
    return structuralFailure(storage, {
      runId, subjectType: 'script', subjectId: script.id, reason: project.reason
    }, nowISO);
  }

  // --- §5: resolve every claim_ids entry against that project only. ---
  const claims = resolveClaims(storage, project.researchProjectId, shape.sections);
  if (!claims.valid) {
    return structuralFailure(storage, {
      runId, subjectType: 'script', subjectId: script.id, reason: claims.reason
    }, nowISO);
  }

  // --- §6: read live evidence_status + applicable CONTRADICTS relations. ---
  const items = claims.resolved.map(({ heading, claim }) => ({
    heading,
    claim,
    hasApplicableContradiction: hasApplicableContradiction(storage, claim, project.researchProjectId)
  }));

  // --- §7/§8: deterministic decision, independent of RiskPolicy. ---
  const { status, findings } = evaluateDecision(items);
  const findingsJson = JSON.stringify(findings);

  // --- §9/§13: atomic persist (+ lifecycle transition on PASS/REVIEW only). ---
  const outcome = storage.transaction(() => {
    const priorLatest = latestFactCheck(storage, script.id);
    const nextVersion = priorLatest ? priorLatest.version + 1 : 1;

    const factCheckId = crypto.randomUUID();
    storage.run(
      `INSERT INTO fact_checks (id, script_id, version, status, findings, notes, created_at)
       VALUES (?, ?, ?, ?, ?, NULL, ?)`,
      [factCheckId, script.id, nextVersion, status, findingsJson, nowISO()]
    );
    logDecision(storage, {
      runId, stage: FACT_CHECK_STAGE, subjectType: 'script', subjectId: script.id,
      decision: status, reason: `fact_check_evaluated_version_${nextVersion}`
    }, nowISO);

    if (status === FACT_CHECK_STATUS.PASS || status === FACT_CHECK_STATUS.REVIEW) {
      // Re-read content_versions inside the transaction: it must still be
      // pointed at this exact script.
      const contentVersion = storage.get(
        'SELECT * FROM content_versions WHERE content_brief_id = ?',
        [contentBriefId]
      );
      if (!contentVersion || contentVersion.script_id !== script.id) {
        throw new Error(`content_versions no longer points at script ${script.id} for content_brief ${contentBriefId}; refusing to transition.`);
      }
      // The spec's lifecycle table (§12) defines exactly one transition:
      // SCRIPT_DRAFT -> FACT_CHECK. A rerun (forced or otherwise) of a
      // Script that is already at FACT_CHECK (e.g. re-evaluating a Script
      // whose prior result was also PASS/REVIEW) has nothing to
      // transition — the state machine has no FACT_CHECK -> FACT_CHECK
      // self-transition, and forcing one is not part of the spec. Only
      // attempt the state-machine transition from the exact state the
      // spec defines it for; otherwise the new result is persisted with
      // no lifecycle side effect.
      if (contentVersion.state === 'SCRIPT_DRAFT') {
        if (!canTransition(contentVersion.state, 'FACT_CHECK')) {
          throw new InvalidTransitionError(`${contentVersion.state} -> FACT_CHECK is not a valid transition`);
        }
        const newState = transition(contentVersion.state, 'FACT_CHECK');
        storage.run(
          'UPDATE content_versions SET state = ? WHERE id = ?',
          [newState, contentVersion.id]
        );
        logDecision(storage, {
          runId, stage: FACT_CHECK_STAGE, subjectType: 'content_version', subjectId: contentVersion.id,
          decision: 'FACT_CHECK', reason: 'fact_check_persisted', resultingState: newState
        }, nowISO);
      }
    } else if (status === FACT_CHECK_STATUS.REJECT) {
      // P1 (owner-decided destination: FACT_CHECK -> REJECTED). Applies
      // only when the current Script's content_versions row is already at
      // FACT_CHECK (i.e. this REJECT is a *later* authoritative result
      // following an earlier PASS/REVIEW) — a first-time REJECT while the
      // Script is still at SCRIPT_DRAFT must keep leaving state at
      // SCRIPT_DRAFT, unchanged from existing behavior.
      const contentVersion = storage.get(
        'SELECT * FROM content_versions WHERE content_brief_id = ?',
        [contentBriefId]
      );
      if (!contentVersion || contentVersion.script_id !== script.id) {
        throw new Error(`content_versions no longer points at script ${script.id} for content_brief ${contentBriefId}; refusing to transition.`);
      }
      if (contentVersion.state === 'FACT_CHECK') {
        if (!canTransition(contentVersion.state, 'REJECTED')) {
          throw new InvalidTransitionError(`${contentVersion.state} -> REJECTED is not a valid transition`);
        }
        const newState = transition(contentVersion.state, 'REJECTED');
        storage.run(
          'UPDATE content_versions SET state = ? WHERE id = ?',
          [newState, contentVersion.id]
        );
        logDecision(storage, {
          runId, stage: FACT_CHECK_STAGE, subjectType: 'content_version', subjectId: contentVersion.id,
          decision: 'REJECTED', reason: 'fact_check_rejected_after_fact_check', resultingState: newState
        }, nowISO);
      }
      // else: state is not FACT_CHECK (e.g. still SCRIPT_DRAFT on a
      // first-time REJECT) — row persisted above, no lifecycle
      // transition, state remains unchanged. Nothing further to do.
    }

    return { factCheckId };
  });

  const factCheck = storage.get('SELECT * FROM fact_checks WHERE id = ?', [outcome.factCheckId]);
  return { outcome: status, factCheck };
}