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

  finish(runId, { status = 'COMPLETED', stopReason = null } = {}) {
    this.storage.run(
      `UPDATE system_runs SET finished_at = ?, status = ?, stop_reason = ? WHERE id = ?`,
      [new Date().toISOString(), status, stopReason, runId]
    );
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

// Never persist secrets into audit/config snapshots.
function redact(obj) {
  const clone = JSON.parse(JSON.stringify(obj));
  delete clone.apiKeys;
  return clone;
}

export default SystemRunRecorder;
