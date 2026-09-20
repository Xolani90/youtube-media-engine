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
// Attempt 1/2/3 = the 1st/2nd/3rd recorded failure in the current cycle.
// On the 3rd, quarantined_at is set in the SAME transaction as the increment.

export const STAGE_RETRY_CAP = 3;
export const RETRY_STAGE = Object.freeze({ PRODUCTION: 'PRODUCTION', PUBLICATION: 'PUBLICATION' });
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
     VALUES (?, ?, 'content_version', ?, ?, ?, NULL, NULL, NULL, NULL, NULL, ?, ?)`,
    [crypto.randomUUID(), runId, subjectId, decision, reason, nowISO(), stage]
  );
}

/** True iff this (content_version, stage) is currently quarantined. */
export function isQuarantined(storage, contentVersionId, stage) {
  const row = storage.get(
    'SELECT quarantined_at FROM stage_retry_state WHERE content_version_id = ? AND stage = ?',
    [contentVersionId, stage]
  );
  return Boolean(row && row.quarantined_at);
}

/**
 * Records one failed attempt and, on reaching the cap, quarantines — all in
 * one transaction (nested-safe: better-sqlite3 uses a savepoint if the caller
 * already opened one). Any persistence error propagates; nothing is swallowed,
 * so a failure can never silently become unbounded retry.
 */
export function recordFailedAttempt(storage, { contentVersionId, stage, reason, runId = null, nowISO = () => new Date().toISOString() }) {
  return storage.transaction(() => {
    const now = nowISO();
    const existing = storage.get(
      'SELECT * FROM stage_retry_state WHERE content_version_id = ? AND stage = ?',
      [contentVersionId, stage]
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
        `INSERT INTO stage_retry_state (id, content_version_id, stage, cycle_number, attempt_count, last_failure_reason, created_at, updated_at)
         VALUES (?, ?, ?, 1, 1, ?, ?, ?)`,
        [crypto.randomUUID(), contentVersionId, stage, reason, now, now]
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
        'UPDATE stage_retry_state SET quarantined_at = ? WHERE content_version_id = ? AND stage = ?',
        [now, contentVersionId, stage]
      );
      logDecision(storage, {
        runId, subjectId: contentVersionId, stage, nowISO,
        decision: QUARANTINE_DECISION.QUARANTINED,
        reason: `retry_cap_${STAGE_RETRY_CAP}_exhausted_cycle_${cycle}_attempts_${attempt}`
      });
    }
    return { attempt, quarantined, cycle };
  });
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
export function reactivateQuarantined(storage, { contentVersionId, stage, ownerAction, nowISO = () => new Date().toISOString() } = {}) {
  if (!ownerAction || ownerAction.actor !== OWNER_ACTOR) {
    throw new QuarantineReactivationError('reactivation requires an explicit Owner action context (actor: "OWNER")');
  }
  const reason = typeof ownerAction.reason === 'string' ? ownerAction.reason.trim() : '';
  if (!reason) throw new QuarantineReactivationError('reactivation requires a non-empty Owner reason');
  if (!Object.values(RETRY_STAGE).includes(stage)) throw new QuarantineReactivationError(`unknown stage: ${stage}`);

  return storage.transaction(() => {
    const row = storage.get(
      'SELECT * FROM stage_retry_state WHERE content_version_id = ? AND stage = ?',
      [contentVersionId, stage]
    );
    if (!row || !row.quarantined_at) {
      throw new QuarantineReactivationError('item is not currently quarantined');
    }
    const now = nowISO();
    storage.run(
      `INSERT INTO stage_retry_cycle_history
        (id, content_version_id, stage, cycle_number, attempts_in_cycle, quarantined_at, reactivated_at, owner_reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [crypto.randomUUID(), contentVersionId, stage, row.cycle_number, row.attempt_count, row.quarantined_at, now, reason]
    );
    storage.run(
      `UPDATE stage_retry_state
         SET cycle_number = ?, attempt_count = 0, quarantined_at = NULL, updated_at = ?
       WHERE id = ?`,
      [row.cycle_number + 1, now, row.id]
    );
    logDecision(storage, {
      subjectId: contentVersionId, stage, nowISO,
      decision: QUARANTINE_DECISION.QUARANTINE_REACTIVATED,
      reason: `owner_reactivated_stage_${stage}_cycle_${row.cycle_number}_attempts_${row.attempt_count}_quarantined_at_${row.quarantined_at}_reason_${reason}`
    });
    return { cycle: row.cycle_number + 1, previousAttempts: row.attempt_count, previousQuarantinedAt: row.quarantined_at, reactivatedAt: now };
  });
}
