import crypto from 'node:crypto';

// Bounded-retry + quarantine governance (Owner-authorized workstream).
//
// Authoritative counter: stage_retry_state.attempt_count (current cycle).
// publications.attempt_count is a legacy claim counter and is NOT consulted.
//
// Attempt definitions (a "failed attempt" is recorded exactly once each):
//   PRODUCTION  - one runProduction() invocation for a content brief that
//                 returns ARTIFACT_WRITE_FAILED.
//   PUBLICATION - one provider result of EXPLICIT_FAILURE persisted as
//                 publications.status='FAILED'. AMBIGUOUS results, D-C2
//                 denials, and provider calls that never reach a confirmed
//                 failure do NOT count.
// A4 (Owner-authorized) generalizes the identity from content_version_id to
// (stage, subject_id) - see migration 0017. What subject_id names is decided
// by the stage, and NO identifier is ever fabricated for a stage:
//   BRIEF                  research_projects.id  (no content version exists yet)
//   SCRIPT                 content_briefs.id
//   every other stage      content_versions.id
// A4 attempt definitions (one attempt = one stage invocation that ends in the
// authorized named outcome; excluded outcomes never record an attempt):
//   BRIEF               GENERATION_RETRY_EXHAUSTED (one whole createBrief call)
//   SCRIPT              GENERATION_RETRY_EXHAUSTED (one whole createScript call)
//   FACT_CHECK          STRUCTURAL_FAILURE
//   ORIGINALITY         STRUCTURAL_FAILURE
//   QUALITY_GATE        STRUCTURAL_FAILURE
//   ASSET_PROVISIONING  NO_ASSET_ACQUIRED | INVALID_PROVIDER_RESULT (one budget)
//   MEDIA_PRODUCTION    NARRATION_FAILED | RENDER_FAILED | VALIDATION_FAILED |
//                       ASSET_CHECKSUM_MISMATCH (one budget)
// Attempt 1/2/3 = the 1st/2nd/3rd recorded failure in the current cycle.
// On the 3rd, quarantined_at is set in the SAME transaction as the increment.

export const STAGE_RETRY_CAP = 3;
export const RETRY_STAGE = Object.freeze({
  PRODUCTION: 'PRODUCTION',
  PUBLICATION: 'PUBLICATION',
  BRIEF: 'BRIEF',
  SCRIPT: 'SCRIPT',
  FACT_CHECK: 'FACT_CHECK',
  ORIGINALITY: 'ORIGINALITY',
  QUALITY_GATE: 'QUALITY_GATE',
  ASSET_PROVISIONING: 'ASSET_PROVISIONING',
  MEDIA_PRODUCTION: 'MEDIA_PRODUCTION'
});

// What a stage's subject_id names, used for decision_log.subject_type.
const SUBJECT_TYPE = Object.freeze({
  [RETRY_STAGE.BRIEF]: 'research_project',
  [RETRY_STAGE.SCRIPT]: 'content_brief'
});
export const subjectTypeForStage = (stage) => SUBJECT_TYPE[stage] ?? 'content_version';

// Stages whose subject is NOT a content version: the legacy `contentVersionId`
// parameter alias is refused for them so a content version id can never be
// supplied as their identity.
const NOT_CONTENT_VERSION_STAGES = new Set(Object.keys(SUBJECT_TYPE));

function assertKnownStage(stage, ErrorClass = Error) {
  if (!Object.values(RETRY_STAGE).includes(stage)) throw new ErrorClass(`unknown stage: ${stage}`);
}

/** Resolves (subjectId | legacy contentVersionId alias) for a stage; throws on any ambiguity. */
function resolveSubjectId({ subjectId, contentVersionId, stage }, ErrorClass = Error) {
  assertKnownStage(stage, ErrorClass);
  if (contentVersionId !== undefined && NOT_CONTENT_VERSION_STAGES.has(stage)) {
    throw new ErrorClass(`stage ${stage} is not identified by a content_version_id (its subject is a ${subjectTypeForStage(stage)}); pass subjectId`);
  }
  if (subjectId !== undefined && contentVersionId !== undefined && subjectId !== contentVersionId) {
    throw new ErrorClass('subjectId and contentVersionId disagree');
  }
  const resolved = subjectId ?? contentVersionId;
  if (!resolved) throw new ErrorClass('a retry attempt requires a subjectId');
  return resolved;
}
// ---------------------------------------------------------------------------
// A4 retry ELIGIBILITY (Owner resolution, Slice 2 clarification).
//
// A named A4 outcome identifies a CLASS of outcome that MAY enter bounded
// retry. It is NOT automatically retryable: the actual failure must be
// established as transient / item-specific by the stage's own evidence, and a
// failure that is deterministic, or that is a configuration/infrastructure
// problem rather than an item problem, never consumes item retry budget.
//
//   evidence = { nature, basis }   supplied by the failure site; basis is a
//                                  short machine-readable justification.
//   TRANSIENT (+ non-empty basis)  eligible: may record an attempt.
//   DETERMINISTIC                  not eligible.
//   INFRASTRUCTURE                 not eligible (config/provider-wide; the
//                                  final disposition is deferred to the
//                                  formal A2 classification in Slice 3).
//   no evidence                    STRUCTURAL_FAILURE and
//                                  ASSET_CHECKSUM_MISMATCH default to
//                                  DETERMINISTIC (approved policy); every other
//                                  outcome is UNESTABLISHED. Not eligible either
//                                  way: no evidence of a transient cause, no
//                                  budget. No transient classification is
//                                  inferred here; that is Slice 3.
// A non-eligible failure is still logged and returned exactly as before
// (existing stage contract), it just records no attempt and never quarantines.
// ---------------------------------------------------------------------------
export const FAILURE_NATURE = Object.freeze({
  TRANSIENT: 'TRANSIENT',
  DETERMINISTIC: 'DETERMINISTIC',
  INFRASTRUCTURE: 'INFRASTRUCTURE',
  UNESTABLISHED: 'UNESTABLISHED'
});
const DETERMINISTIC_BY_DEFAULT = new Set(['STRUCTURAL_FAILURE', 'ASSET_CHECKSUM_MISMATCH']);

/** Pure. Decides whether a failure of `outcome` with `evidence` may consume A4 retry budget. */
export function assessRetryEligibility({ outcome, evidence } = {}) {
  const nature = evidence?.nature;
  const basis = typeof evidence?.basis === 'string' ? evidence.basis.trim() : '';
  if (nature === FAILURE_NATURE.TRANSIENT) {
    return basis
      ? { eligible: true, nature, basis }
      : { eligible: false, nature: FAILURE_NATURE.UNESTABLISHED, basis: 'transient_claim_without_basis' };
  }
  if (nature === FAILURE_NATURE.DETERMINISTIC || nature === FAILURE_NATURE.INFRASTRUCTURE) {
    return { eligible: false, nature, basis: basis || 'stage_evidence' };
  }
  if (DETERMINISTIC_BY_DEFAULT.has(outcome)) {
    return { eligible: false, nature: FAILURE_NATURE.DETERMINISTIC, basis: 'deterministic_by_default' };
  }
  return { eligible: false, nature: FAILURE_NATURE.UNESTABLISHED, basis: 'no_transient_evidence' };
}

export const OWNER_ACTOR = 'OWNER';
export const QUARANTINE_DECISION = Object.freeze({
  QUARANTINED: 'QUARANTINED',
  QUARANTINE_REACTIVATED: 'QUARANTINE_REACTIVATED'
});

export class QuarantineReactivationError extends Error {}

function logDecision(storage, { runId = null, subjectId, decision, reason, stage, nowISO }) {
  storage.run(
    `INSERT INTO decision_log
      (id, run_id, subject_type, subject_id, decision, reason, provider, config_snapshot, confidence, risk_level, resulting_state, created_at, stage)
     VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, ?, ?)`,
    [crypto.randomUUID(), runId, subjectTypeForStage(stage), subjectId, decision, reason, nowISO(), stage]
  );
}

/** True iff this (stage, subject) is currently quarantined. subjectId is the stage's own identity (see header). */
export function isQuarantined(storage, subjectId, stage) {
  const row = storage.get(
    'SELECT quarantined_at FROM stage_retry_state WHERE subject_id = ? AND stage = ?',
    [subjectId, stage]
  );
  return Boolean(row && row.quarantined_at);
}

/**
 * Records one failed attempt and, on reaching the cap, quarantines — all in
 * one transaction (nested-safe: better-sqlite3 uses a savepoint if the caller
 * already opened one). Any persistence error propagates; nothing is swallowed,
 * so a failure can never silently become unbounded retry.
 */
export function recordFailedAttempt(storage, { subjectId: givenSubjectId, contentVersionId: legacyContentVersionId, stage, reason, runId = null, nowISO = () => new Date().toISOString() }) {
  const subjectId = resolveSubjectId({ subjectId: givenSubjectId, contentVersionId: legacyContentVersionId, stage });
  return storage.transaction(() => {
    const now = nowISO();
    const existing = storage.get(
      'SELECT * FROM stage_retry_state WHERE subject_id = ? AND stage = ?',
      [subjectId, stage]
    );
    if (existing?.quarantined_at) {
      // Defensive: a quarantined item must never accrue further attempts.
      return { attempt: existing.attempt_count, quarantined: true, alreadyQuarantined: true, cycle: existing.cycle_number };
    }
    let attempt;
    let cycle;
    if (!existing) {
      attempt = 1;
      cycle = 1;
      storage.run(
        `INSERT INTO stage_retry_state (id, subject_id, stage, cycle_number, attempt_count, last_failure_reason, created_at, updated_at)
         VALUES (?, ?, ?, 1, 1, ?, ?, ?)`,
        [crypto.randomUUID(), subjectId, stage, reason, now, now]
      );
    } else {
      attempt = existing.attempt_count + 1;
      cycle = existing.cycle_number;
      storage.run(
        'UPDATE stage_retry_state SET attempt_count = ?, last_failure_reason = ?, updated_at = ? WHERE id = ?',
        [attempt, reason, now, existing.id]
      );
    }
    const quarantined = attempt >= STAGE_RETRY_CAP;
    if (quarantined) {
      storage.run(
        'UPDATE stage_retry_state SET quarantined_at = ? WHERE subject_id = ? AND stage = ?',
        [now, subjectId, stage]
      );
      logDecision(storage, {
        runId, subjectId, stage, nowISO,
        decision: QUARANTINE_DECISION.QUARANTINED,
        reason: `retry_cap_${STAGE_RETRY_CAP}_exhausted_cycle_${cycle}_attempts_${attempt}`
      });
    }
    return { attempt, quarantined, cycle };
  });
}

/**
 * Records a failed attempt ONLY if assessRetryEligibility() says the failure
 * may consume A4 budget; otherwise records nothing. Call it in the same
 * transaction as the stage's decision_log entry. Spread retryFields() of the
 * result into the stage result.
 */
export function recordFailedAttemptIfRetryable(storage, { outcome, evidence, ...attempt }) {
  const assessment = assessRetryEligibility({ outcome, evidence });
  if (!assessment.eligible) return { retryEligible: false, nature: assessment.nature, basis: assessment.basis };
  const recorded = recordFailedAttempt(storage, attempt);
  return { retryEligible: true, nature: assessment.nature, basis: assessment.basis, ...recorded };
}

/** Result fields for a stage failure: the disposition always; attempt/quarantined only when an attempt was recorded. */
export function retryFields(r) {
  return {
    retryDisposition: { eligible: r.retryEligible, nature: r.nature, basis: r.basis },
    ...(r.retryEligible ? { attempt: r.attempt, quarantined: r.quarantined } : {})
  };
}

/**
 * Owner-only reactivation. NEVER called by any pipeline, runner or selector.
 * Requires an explicit ownerAction context ({ actor: 'OWNER', reason }); anything
 * else is refused. Closes the current cycle into stage_retry_cycle_history
 * (evidence preserved), starts cycle N+1 at attempt_count 0, clears
 * quarantined_at, and writes a QUARANTINE_REACTIVATED decision_log row — all in
 * one transaction. Does not change content_versions.state, publications rows,
 * or any authorization; the item re-enters normal stage gates (incl. D-C2).
 */
export function reactivateQuarantined(storage, { subjectId: givenSubjectId, contentVersionId: legacyContentVersionId, stage, ownerAction, nowISO = () => new Date().toISOString() } = {}) {
  if (!ownerAction || ownerAction.actor !== OWNER_ACTOR) {
    throw new QuarantineReactivationError('reactivation requires an explicit Owner action context (actor: "OWNER")');
  }
  const reason = typeof ownerAction.reason === 'string' ? ownerAction.reason.trim() : '';
  if (!reason) throw new QuarantineReactivationError('reactivation requires a non-empty Owner reason');
  const subjectId = resolveSubjectId({ subjectId: givenSubjectId, contentVersionId: legacyContentVersionId, stage }, QuarantineReactivationError);

  return storage.transaction(() => {
    const row = storage.get(
      'SELECT * FROM stage_retry_state WHERE subject_id = ? AND stage = ?',
      [subjectId, stage]
    );
    if (!row || !row.quarantined_at) {
      throw new QuarantineReactivationError('item is not currently quarantined');
    }
    const now = nowISO();
    storage.run(
      `INSERT INTO stage_retry_cycle_history
        (id, subject_id, stage, cycle_number, attempts_in_cycle, quarantined_at, reactivated_at, owner_reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [crypto.randomUUID(), subjectId, stage, row.cycle_number, row.attempt_count, row.quarantined_at, now, reason]
    );
    storage.run(
      `UPDATE stage_retry_state
         SET cycle_number = ?, attempt_count = 0, quarantined_at = NULL, updated_at = ?
       WHERE id = ?`,
      [row.cycle_number + 1, now, row.id]
    );
    logDecision(storage, {
      subjectId, stage, nowISO,
      decision: QUARANTINE_DECISION.QUARANTINE_REACTIVATED,
      reason: `owner_reactivated_stage_${stage}_cycle_${row.cycle_number}_attempts_${row.attempt_count}_quarantined_at_${row.quarantined_at}_reason_${reason}`
    });
    return { cycle: row.cycle_number + 1, previousAttempts: row.attempt_count, previousQuarantinedAt: row.quarantined_at, reactivatedAt: now };
  });
}
