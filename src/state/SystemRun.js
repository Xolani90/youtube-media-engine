import crypto from 'node:crypto';
import { config } from '../config/index.js';

/**
 * SystemRun tracks a single autonomous execution (spec §16, §18, §19).
 * Every run is tagged SIMULATION or LIVE and persists that tag — this
 * distinction must never be inferred after the fact.
 *
 * Owner override (AUTONOMOUS_ENABLED/AUTONOMOUS_DISABLED): if autonomous
 * operation is disabled, starting a run in LIVE mode is refused outright,
 * and the refusal itself is recorded for audit. SIMULATION runs are always
 * permitted regardless of the autonomous switch, since simulation performs
 * no irreversible action.
 */
export class AutonomousDisabledError extends Error {}

/**
 * Single-run protection (ADR-0024). Only ONE autonomous invocation may be
 * active at a time; the guard is the `system_runs` row itself:
 *
 *   an acquired autonomous run  == a system_runs row with status 'RUNNING'
 *   a refused invocation        == NO system_runs row, one decision_log row
 *
 * There is deliberately no second lock/lease/timer: the `RUNNING` row is the
 * sole authority, it is released by `finish()` (COMPLETED / FAILED), and it is
 * NEVER inferred to be stale from its age. A crashed run leaves its RUNNING
 * row behind and every later invocation refuses until the Owner explicitly
 * reclaims it with `reclaimOrphanedRun()` (never called by autonomous code).
 */
export const AUTONOMOUS_RUN_ACTIVE = 'AUTONOMOUS_RUN_ACTIVE';
export const DECISION_INVOCATION_REFUSED = 'INVOCATION_REFUSED';
export const DECISION_OWNER_RECLAIMED = 'OWNER_RECLAIMED';
export const OWNER_RECLAIM_PREFIX = 'OWNER_RECLAIMED:';

export class OwnerReclamationError extends Error {}

export function assertRunAllowed({ mode, autonomousEnabled = config.autonomousEnabled }) {
  if (mode === 'LIVE' && !autonomousEnabled) {
    throw new AutonomousDisabledError(
      'LIVE run refused: AUTONOMOUS_ENABLED is false. Set AUTONOMOUS_ENABLED=true to permit live execution.'
    );
  }
}

export class SystemRunRecorder {
  constructor(storage) {
    this.storage = storage;
  }

  /**
   * Starts and persists a system_runs record. Throws AutonomousDisabledError
   * if mode=LIVE while autonomous operation is disabled — no live run is
   * ever silently created.
   */
  start({ mode = config.runMode, configSnapshot = config } = {}) {
    assertRunAllowed({ mode });
    const id = crypto.randomUUID();
    this.storage.run(
      `INSERT INTO system_runs (id, mode, autonomous_enabled, started_at, status, config_snapshot)
       VALUES (?, ?, ?, ?, 'RUNNING', ?)`,
      [id, mode, config.autonomousEnabled ? 1 : 0, new Date().toISOString(), JSON.stringify(redact(configSnapshot))]
    );
    return { id, mode };
  }

  /**
   * Atomically acquires the single autonomous-run guard.
   *
   * ONE SQL statement decides: `INSERT ... SELECT ... WHERE NOT EXISTS (a
   * RUNNING row)`. A single write statement takes SQLite's write lock before
   * it evaluates the NOT EXISTS subquery, and SQLite serializes writers, so
   * two callers (connections or processes on one host, WAL) cannot both see
   * "no RUNNING row": exactly one inserts, the other inserts zero rows. There
   * is no SELECT-then-INSERT gap. The follow-up read of the blocking rows is
   * in the same transaction as the decisive insert, so it describes the
   * state that caused the refusal.
   *
   * Does NOT call assertRunAllowed (the Owner-override ordering of the
   * entrypoint is unchanged; the runner-facing start() still asserts it).
   * A busy database (SQLITE_BUSY after the driver timeout) is an error, not
   * a refusal: the invocation must not proceed and must not be reported as
   * "another run is active".
   *
   * @returns {{ acquired: true, id: string, mode: string }
   *          | { acquired: false, activeRuns: Array<{id: string, mode: string, started_at: string}> }}
   */
  acquireExclusive({ mode, configSnapshot = config } = {}) {
    const runMode = mode ?? config.runMode;
    const id = crypto.randomUUID();
    return this.storage.transaction(() => {
      const info = this.storage.run(
        `INSERT INTO system_runs (id, mode, autonomous_enabled, started_at, status, config_snapshot)
         SELECT ?, ?, ?, ?, 'RUNNING', ?
          WHERE NOT EXISTS (SELECT 1 FROM system_runs WHERE status = 'RUNNING')`,
        [id, runMode, config.autonomousEnabled ? 1 : 0, new Date().toISOString(), JSON.stringify(redact(configSnapshot))]
      );
      if (info.changes === 1) {
        return { acquired: true, id, mode: runMode };
      }
      const activeRuns = this.storage.all(
        `SELECT id, mode, started_at FROM system_runs WHERE status = 'RUNNING' ORDER BY started_at, id`
      );
      return { acquired: false, activeRuns };
    });
  }

  /**
   * Records that an invocation was refused because the guard was held. It
   * writes decision_log rows only (one per blocking run, attached to that
   * run) and NEVER a system_runs row, so a refused invocation is never
   * mistaken for an autonomous run that started, completed or failed.
   * Returns true if the evidence was persisted.
   */
  recordRefusal({ activeRuns }) {
    try {
      const blockers = activeRuns.length > 0 ? activeRuns : [null];
      for (const blocker of blockers) {
        this.logDecision(blocker?.id ?? null, {
          subjectType: 'system_run',
          subjectId: blocker?.id ?? 'unknown',
          decision: DECISION_INVOCATION_REFUSED,
          reason: blocker
            ? `${AUTONOMOUS_RUN_ACTIVE}: run ${blocker.id} (${blocker.mode}, started ${blocker.started_at}) holds the single-run guard`
            : `${AUTONOMOUS_RUN_ACTIVE}: the guard was held when acquisition was attempted`
        });
      }
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Releases a run. An Owner-reclaimed row is never overwritten: if a run the
   * Owner reclaimed later tries to finish, its reclaim evidence is preserved.
   * Returns the number of rows updated.
   *
   * ADR-0038: `ceilingSummary`, when explicitly passed (any value including
   * null), is persisted as JSON into system_runs.ceiling_summary. When the
   * option is omitted entirely, that column is left untouched -- existing
   * callers that never pass it see byte-for-byte the pre-ADR-0038 behavior.
   */
  finish(runId, { status = 'COMPLETED', stopReason = null, ...rest } = {}) {
    if (Object.prototype.hasOwnProperty.call(rest, 'ceilingSummary')) {
      const info = this.storage.run(
        `UPDATE system_runs SET finished_at = ?, status = ?, stop_reason = ?, ceiling_summary = ?
          WHERE id = ? AND (stop_reason IS NULL OR substr(stop_reason, 1, ${OWNER_RECLAIM_PREFIX.length}) <> '${OWNER_RECLAIM_PREFIX}')`,
        [new Date().toISOString(), status, stopReason, rest.ceilingSummary == null ? null : JSON.stringify(rest.ceilingSummary), runId]
      );
      return info.changes;
    }
    const info = this.storage.run(
      `UPDATE system_runs SET finished_at = ?, status = ?, stop_reason = ?
        WHERE id = ? AND (stop_reason IS NULL OR substr(stop_reason, 1, ${OWNER_RECLAIM_PREFIX.length}) <> '${OWNER_RECLAIM_PREFIX}')`,
      [new Date().toISOString(), status, stopReason, runId]
    );
    return info.changes;
  }

  logDecision(runId, { subjectType, subjectId, decision, reason, provider = null, confidence = null, riskLevel = null, resultingState = null }) {
    const id = crypto.randomUUID();
    this.storage.run(
      `INSERT INTO decision_log
        (id, run_id, subject_type, subject_id, decision, reason, provider, config_snapshot, confidence, risk_level, resulting_state, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, runId, subjectType, subjectId, decision, reason, provider, JSON.stringify(redact(config)), confidence, riskLevel, resultingState, new Date().toISOString()]
    );
    return id;
  }
}

/**
 * Explicit Owner-only reclamation of an orphaned RUNNING autonomous run
 * (crash / kill). NEVER called by src/index.js, the runner, or any
 * autonomous path; it is reachable only from the Owner CLI
 * (scripts/reclaim-autonomous-run.js) or a direct call.
 *
 * `actor === 'OWNER'` is a governance-context ASSERTION, not authentication:
 * anyone with filesystem access to the database can call this. It exists so
 * reclamation is always an explicit, recorded, reasoned act.
 *
 * Evidence is preserved, never erased: the old row is kept (status ->
 * 'STOPPED', started_at/mode/config_snapshot untouched, stop_reason prefixed
 * with OWNER_RECLAIMED:) and a decision_log row records who/why and the
 * row's previous state. Only a row that is currently RUNNING can be
 * reclaimed, decided atomically by the UPDATE's own WHERE clause.
 */
export function reclaimOrphanedRun(storage, { runId, actor, reason, now = () => new Date() } = {}) {
  if (actor !== 'OWNER') {
    throw new OwnerReclamationError("reclamation requires explicit Owner context (actor must be 'OWNER')");
  }
  if (typeof runId !== 'string' || runId.length === 0) {
    throw new OwnerReclamationError('reclamation requires the runId of the RUNNING run to reclaim');
  }
  if (typeof reason !== 'string' || reason.trim().length === 0) {
    throw new OwnerReclamationError('reclamation requires a non-empty reason');
  }
  const at = now().toISOString();
  return storage.transaction(() => {
    const before = storage.get('SELECT id, mode, status, started_at FROM system_runs WHERE id = ?', [runId]);
    if (!before) {
      throw new OwnerReclamationError(`no system_runs row with id ${runId}`);
    }
    const info = storage.run(
      `UPDATE system_runs SET finished_at = ?, status = 'STOPPED', stop_reason = ?
        WHERE id = ? AND status = 'RUNNING'`,
      [at, `${OWNER_RECLAIM_PREFIX} ${reason.trim()}`, runId]
    );
    if (info.changes !== 1) {
      throw new OwnerReclamationError(`run ${runId} is not RUNNING (status ${before.status}); nothing reclaimed`);
    }
    storage.run(
      `INSERT INTO decision_log
         (id, run_id, subject_type, subject_id, decision, reason, provider, config_snapshot, confidence, risk_level, resulting_state, created_at)
       VALUES (?, ?, 'system_run', ?, ?, ?, NULL, NULL, NULL, NULL, 'STOPPED', ?)`,
      [
        crypto.randomUUID(), runId, runId, DECISION_OWNER_RECLAIMED,
        `actor=OWNER (asserted, not authenticated); reason=${reason.trim()}; previous={"status":"${before.status}","mode":"${before.mode}","started_at":"${before.started_at}"}`,
        at
      ]
    );
    return { runId, previousStatus: before.status, previousStartedAt: before.started_at, reclaimedAt: at };
  });
}

// Never persist secrets into audit/config snapshots.
function redact(obj) {
  const clone = JSON.parse(JSON.stringify(obj));
  delete clone.apiKeys;
  return clone;
}

export default SystemRunRecorder;
