import { deriveIdentity } from './discoveryMemory.js';

/**
 * Fresh-evaluation scheduling state (ADR-0034).
 *
 * Tracks, per canonical Discovery identity_key, when that identity's most
 * recent SUCCESSFUL fresh evaluation was durably completed. Read-only
 * lookups feed the per-run fresh-evaluation budget's ordering (oldest /
 * never-evaluated first); the write is made only by the pipeline, atomically
 * with the corresponding ADR-0033 discovery_evaluations commit.
 *
 * Deliberately orthogonal to createDiscoveryEvaluationStore(): this store
 * never decides reuse and is never consulted for it. `sourceScope` is
 * accepted here only because deriveIdentity() requires the same scope the
 * caller uses for ADR-0033 reuse, so the two stores agree on identity for
 * the same observation -- it does not otherwise participate in scheduling.
 */
export function createDiscoveryEvaluationSchedule({ storage, sourceScope = null }) {
  if (!storage) throw new Error('createDiscoveryEvaluationSchedule requires storage');

  return {
    /** The canonical identity_key for an observation, or null (unschedulable: no deterministic identity). */
    identityKey(observation) {
      const identity = deriveIdentity(observation, { sourceScope });
      return identity ? identity.key : null;
    },

    /**
     * The ISO timestamp of the identity's last successful fresh evaluation,
     * or null if it has none (never fresh-evaluated, or no deterministic
     * identity -- both cases receive the highest scheduling priority).
     * Read-only.
     */
    lastFreshEvaluatedAt(observation) {
      const identity = deriveIdentity(observation, { sourceScope });
      if (!identity) return null;

      const row = storage.get(
        'SELECT last_fresh_evaluation_at FROM discovery_evaluation_schedule WHERE identity_key = ?',
        [identity.key]
      );
      return row ? row.last_fresh_evaluation_at : null;
    },

    /**
     * Durably records that a fresh evaluation for this observation's
     * identity completed successfully NOW. Call only from inside the same
     * database transaction as the corresponding discovery_evaluations
     * commit (see src/discovery/pipeline.js) -- this method itself performs
     * a single statement and is not the source of the atomicity guarantee.
     * No-op for identity-less observations.
     */
    recordFreshEvaluation(observation, { now = () => new Date() } = {}) {
      const identity = deriveIdentity(observation, { sourceScope });
      if (!identity) return { recorded: false };

      const at = now();
      const iso = (at instanceof Date ? at : new Date(at)).toISOString();

      storage.run(
        `INSERT INTO discovery_evaluation_schedule (identity_key, last_fresh_evaluation_at)
         VALUES (?, ?)
         ON CONFLICT(identity_key) DO UPDATE SET
           last_fresh_evaluation_at = excluded.last_fresh_evaluation_at`,
        [identity.key, iso]
      );
      return { recorded: true };
    }
  };
}

export default createDiscoveryEvaluationSchedule;
