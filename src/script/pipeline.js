import crypto from 'node:crypto';
import { SCRIPT_STAGE } from './constants.js';
import { checkBriefEligibility } from './eligibility.js';
import { generateScriptFields, validateGeneratedScript } from './generate.js';
import { validateScriptClaimReferences, buildClaimLinks } from './claims.js';
import { canTransition, transition, InvalidTransitionError } from '../state/ContentStateMachine.js';
import { isQuarantined, recordFailedAttemptIfRetryable, retryFields, FAILURE_NATURE, RETRY_STAGE } from '../state/StageRetryPolicy.js';

/**
 * Records a decision_log entry, same shape/discipline as Brief's and
 * Research's local logDecision helpers (stage is a first-class column,
 * never encoded into decision/reason).
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

function currentScript(storage, contentBriefId) {
  return storage.get(
    'SELECT * FROM scripts WHERE content_brief_id = ? ORDER BY version DESC LIMIT 1',
    [contentBriefId]
  );
}

/**
 * Creates (or, with `regenerate: true`, appends a new version of) the
 * Script for a Brief (Script Specification, §3/§6).
 *
 * Unlike Brief (which overwrites in place), Script is append-only: each
 * regeneration produces a new `scripts` row with an incremented `version`,
 * preserving prior versions. `content_versions.script_id` always points at
 * the current (most recently persisted) version.
 *
 * This is the manual trigger surface for v1, in the same "run once, any
 * driver may invoke it" style as `createBrief` — no CLI/scheduler wrapper
 * is introduced here.
 *
 * @param {object} deps
 * @param {import('../storage/StorageDriver.js').StorageDriver} deps.storage
 * @param {string} deps.contentBriefId
 * @param {object} deps.llmRouter
 * @param {object} deps.policy - script_policy.json
 * @param {boolean} [deps.regenerate] - explicit regeneration flag. Without it, an existing Script is returned unchanged, with no LLM call.
 * @param {string} [deps.runId]
 */
export async function createScript({ storage, contentBriefId, llmRouter, policy, regenerate = false, runId = null }) {
  const brief = storage.get('SELECT * FROM content_briefs WHERE id = ?', [contentBriefId]);

  // --- Idempotency fast path: an existing Script without an explicit
  // regeneration request is returned as-is, with no LLM call and no
  // re-validation. ---
  const existingBeforeGeneration = currentScript(storage, contentBriefId);
  if (existingBeforeGeneration && !regenerate) {
    return { script: existingBeforeGeneration, created: false, regenerated: false, rejected: false };
  }

  // --- A4 bounded-retry governance: a quarantined brief is refused on direct
  // invocation too. Identity is (SCRIPT, content_brief_id) - NOT the content
  // version id. Owner-only reactivation is the sole way out.
  if (isQuarantined(storage, contentBriefId, RETRY_STAGE.SCRIPT)) {
    logDecision(storage, {
      runId, stage: SCRIPT_STAGE.ELIGIBILITY_CHECK, subjectType: 'content_brief',
      subjectId: contentBriefId, decision: 'QUARANTINE_REFUSED', reason: 'script_quarantined_owner_reactivation_required'
    });
    return { outcome: 'QUARANTINED', rejected: true, reason: 'SCRIPT_QUARANTINED', created: false, regenerated: false };
  }

  // --- Eligibility gate: Brief must be structurally complete. Script
  // treats the Brief as the sole authoritative input and does not
  // re-query Research. ---
  const eligibility = checkBriefEligibility(brief);
  if (!eligibility.eligible) {
    logDecision(storage, {
      runId, stage: SCRIPT_STAGE.ELIGIBILITY_CHECK, subjectType: 'content_brief',
      subjectId: contentBriefId, decision: 'REJECTED', reason: eligibility.reason
    });
    return { rejected: true, reason: eligibility.reason, created: false, regenerated: false };
  }
  logDecision(storage, {
    runId, stage: SCRIPT_STAGE.ELIGIBILITY_CHECK, subjectType: 'content_brief',
    subjectId: contentBriefId, decision: 'ELIGIBLE', reason: 'BRIEF_STRUCTURALLY_COMPLETE'
  });

  const allowCallToAction = policy?.allow_call_to_action === true;
  const maxAttempts = policy?.generation?.max_attempts ?? 3;

  // --- Generation + deterministic Validation, bounded retry ---
  let accepted = null;
  let attemptsUsed = 0;
  let lastFailureReason = null;

  while (attemptsUsed < maxAttempts && !accepted) {
    attemptsUsed++;
    const generation = await generateScriptFields(
      { brief, eligibleClaimIds: eligibility.keyClaimIds, allowCallToAction },
      llmRouter
    );

    const structural = validateGeneratedScript(generation.parsed, { allowCallToAction });
    if (!structural.valid) {
      lastFailureReason = structural.reason;
      logDecision(storage, {
        runId, stage: SCRIPT_STAGE.VALIDATION, subjectType: 'content_brief', subjectId: contentBriefId,
        decision: 'REJECTED', reason: structural.reason, provider: generation.providerUsed,
        configSnapshot: { model: generation.model, estimatedCost: generation.estimatedCost, isPaid: generation.isPaid, attempt: attemptsUsed }
      });
      continue;
    }

    const claimCheck = validateScriptClaimReferences(generation.parsed.sections, eligibility.keyClaimIds);
    if (!claimCheck.valid) {
      lastFailureReason = claimCheck.reason;
      logDecision(storage, {
        runId, stage: SCRIPT_STAGE.VALIDATION, subjectType: 'content_brief', subjectId: contentBriefId,
        decision: 'REJECTED', reason: claimCheck.reason, provider: generation.providerUsed,
        configSnapshot: { model: generation.model, estimatedCost: generation.estimatedCost, isPaid: generation.isPaid, attempt: attemptsUsed }
      });
      continue;
    }

    accepted = generation;
  }

  if (!accepted) {
    // A4: this whole createScript() call ending in GENERATION_RETRY_EXHAUSTED is
    // ONE A4 attempt under (SCRIPT, content_brief_id). A4 is a SEPARATE, autonomous-
    // invocation-level mechanism: the in-call generation loop above (its own
    // cap, policy.generation.max_attempts) is UNCHANGED and is neither counted
    // toward nor reset by A4. Worst case = 3 A4 attempts x the internal cap
    // (9 provider generations at the default cap of 3): Owner-accepted policy.
    // Evidence: every internal generation produced output that failed
    // validation; a later invocation draws fresh generations for this same
    // item, so the failure is item-specific and recoverable, not deterministic.
    // Log entry + counter + quarantine commit in ONE transaction.
    const retry = storage.transaction(() => {
      logDecision(storage, {
        runId, stage: SCRIPT_STAGE.GENERATION, subjectType: 'content_brief', subjectId: contentBriefId,
        decision: 'FAILED', reason: `RETRY_EXHAUSTED_${lastFailureReason}`
      });
      return recordFailedAttemptIfRetryable(storage, {
        outcome: 'GENERATION_RETRY_EXHAUSTED',
        evidence: { nature: FAILURE_NATURE.TRANSIENT, basis: 'generation_exhausted_output_failed_validation' },
        subjectId: contentBriefId, stage: RETRY_STAGE.SCRIPT,
        reason: `GENERATION_RETRY_EXHAUSTED_${lastFailureReason}`, runId
      });
    });
    // No partial Script, no lifecycle transition, prior Script (if any) untouched.
    return {
      rejected: true, reason: `GENERATION_RETRY_EXHAUSTED_${lastFailureReason}`, created: false, regenerated: false,
      attemptsUsed, ...retryFields(retry)
    };
  }

  logDecision(storage, {
    runId, stage: SCRIPT_STAGE.GENERATION, subjectType: 'content_brief', subjectId: contentBriefId,
    decision: 'ACCEPTED', reason: `accepted_on_attempt_${attemptsUsed}`, provider: accepted.providerUsed,
    configSnapshot: { model: accepted.model, estimatedCost: accepted.estimatedCost, isPaid: accepted.isPaid }
  });

  const body = JSON.stringify({
    hook: accepted.parsed.hook,
    narrative: accepted.parsed.narrative,
    sections: accepted.parsed.sections,
    counterpoints: accepted.parsed.counterpoints,
    conclusion: accepted.parsed.conclusion,
    call_to_action: allowCallToAction ? (accepted.parsed.call_to_action ?? null) : null
  });
  const claimLinksJson = JSON.stringify(buildClaimLinks(accepted.parsed.sections));
  const nowISO = new Date().toISOString();

  // --- Atomic persist (+ lifecycle transition on first version only) ---
  //
  // F1 fix: `existing` and the resulting `nextVersion` are (re-)computed
  // INSIDE this transaction closure, immediately before the INSERT — not
  // from the `existingBeforeGeneration` read taken earlier, which happened
  // before the `await` calls above and is therefore stale with respect to
  // any concurrent writer. better-sqlite3 transactions run synchronously
  // to completion against a single connection, so once this closure
  // starts, no other transaction on this storage instance can interleave
  // between the read here and the write below — read-then-increment is
  // atomic. The UNIQUE(content_brief_id, version) index added in this
  // migration is a second, DB-enforced line of defense: even a future
  // caller using a different connection/process against the same
  // database file would have any duplicate-version insert rejected by
  // SQLite itself rather than silently succeeding.
  const outcome = storage.transaction(() => {
    const existing = currentScript(storage, contentBriefId);
    const nextVersion = existing ? existing.version + 1 : 1;

    const scriptId = crypto.randomUUID();
    storage.run(
      `INSERT INTO scripts (id, content_brief_id, version, body, claim_links, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [scriptId, contentBriefId, nextVersion, body, claimLinksJson, nowISO]
    );
    logDecision(storage, {
      runId, stage: SCRIPT_STAGE.PERSISTED, subjectType: 'script', subjectId: scriptId,
      decision: existing ? 'REGENERATED' : 'CREATED', reason: existing ? 'explicit_regeneration' : 'script_generation_accepted'
    }, () => nowISO);

    if (!existing) {
      // BRIEF_CREATED -> SCRIPT_DRAFT, only after successful persistence,
      // and only on first version creation (regeneration does not move
      // the lifecycle state — it is already at SCRIPT_DRAFT).
      const contentVersion = storage.get(
        'SELECT * FROM content_versions WHERE content_brief_id = ?',
        [contentBriefId]
      );
      if (!contentVersion) {
        throw new Error(`No content_versions row found for content_brief_id ${contentBriefId}; Brief must be persisted before Script.`);
      }
      if (!canTransition(contentVersion.state, 'SCRIPT_DRAFT')) {
        throw new InvalidTransitionError(`${contentVersion.state} -> SCRIPT_DRAFT is not a valid transition`);
      }
      const newState = transition(contentVersion.state, 'SCRIPT_DRAFT');
      storage.run(
        'UPDATE content_versions SET script_id = ?, state = ? WHERE id = ?',
        [scriptId, newState, contentVersion.id]
      );
      logDecision(storage, {
        runId, stage: SCRIPT_STAGE.LIFECYCLE_TRANSITION, subjectType: 'content_version', subjectId: contentVersion.id,
        decision: 'SCRIPT_DRAFT', reason: 'script_persisted', resultingState: newState
      }, () => nowISO);
    } else {
      // Regeneration: keep the lifecycle state as-is, just repoint the
      // current-version pointer at the newest script row.
      storage.run(
        'UPDATE content_versions SET script_id = ? WHERE content_brief_id = ?',
        [scriptId, contentBriefId]
      );
    }

    return { scriptId, created: !existing, regenerated: Boolean(existing) };
  });

  const script = storage.get('SELECT * FROM scripts WHERE id = ?', [outcome.scriptId]);
  return {
    script,
    created: outcome.created,
    regenerated: outcome.regenerated,
    rejected: false,
    attemptsUsed
  };
}
