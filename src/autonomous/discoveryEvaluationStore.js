import crypto from 'node:crypto';
import { deriveIdentity } from './discoveryMemory.js';
import { VALUE_DIMENSIONS } from '../discovery/scoring.js';

/**
 * Durable per-observation Discovery evaluation state (ADR-0033).
 *
 * `EVALUATION COMPLETE != SELECTION COMPLETE`. This store records that an
 * observation's evaluation (a valid Opportunity Proposition plus the raw
 * feature values) is complete, keyed by the stable Discovery `identity_key`
 * (src/autonomous/discoveryMemory.js). It never records a selection outcome,
 * never touches `discovery_observations`, and is not `decision_log`.
 *
 * Only LLM-derived artifacts are persisted. Score and risk are NOT stored:
 * the pipeline recomputes them from the CURRENT configuration when a record
 * is reused.
 *
 * A record is reusable ONLY when ALL of the following hold:
 *   1. the identity_key matches (it is the record's key);
 *   2. the title/description fingerprint matches exactly;
 *   3. the evaluation contract version equals the current one;
 *   4. cycle-scoped: the record was completed AFTER the identity's ledger
 *      `last_evaluated_at` (or the ledger has none). recordDiscoveryOutcomes
 *      sets last_evaluated_at for every admitted identity after selection, so
 *      outcome recording closes the cycle -- the 24h reconsideration and
 *      SELECTED re-admission therefore still mean a fresh evaluation.
 *
 * Deliberately NOT invalidators: URL, source, provider, model (audit only),
 * elapsed time (no age expiry), and any "materially updated" heuristic.
 *
 * Observations without a deterministic identity are never persisted and never
 * reused (they are evaluated every run, exactly as before).
 */

/**
 * Evaluation contract version. MUST be bumped whenever any of these change,
 * because previously stored proposition/feature values would no longer mean
 * what the current code asks for:
 *   - the proposition prompt or the proposition field contract
 *     (src/discovery/proposition.js);
 *   - the feature prompt (src/discovery/featureComputation.js);
 *   - the set of value dimensions (VALUE_DIMENSIONS in src/discovery/scoring.js).
 * Scoring weights, normalization and risk thresholds are NOT part of the
 * contract: they are read from the current configuration on every reuse.
 */
export const DISCOVERY_EVALUATION_CONTRACT_VERSION = '1';

const RISK_FIELDS = Object.freeze(['policyRisk', 'copyrightRisk', 'repetitionRisk']);

/**
 * Content fingerprint derived from exactly title and description -- the only
 * inputs any evaluation stage consumes. `|| ''` mirrors how the prompts read
 * these fields, so null and '' are the same evaluation input.
 */
export function contentFingerprint(observation) {
  const title = observation?.title || '';
  const description = observation?.description || '';
  return crypto.createHash('sha256').update(JSON.stringify([title, description])).digest('hex');
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

// A stored raw-feature object is usable only if it can feed the existing
// scoring/risk functions unchanged. Anything else is treated as "no record"
// (one re-evaluation), never repaired or defaulted.
function isCompleteRawFeatures(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  return [...VALUE_DIMENSIONS, ...RISK_FIELDS].every((field) => isFiniteNumber(raw[field]));
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * @param storage - storage driver (run/get)
 * @param sourceScope - the OpportunitySource id, exactly as passed to
 *   prepareDiscoveryMemory, so the identity is derived identically
 * @param now - clock (same injection point as the ledger)
 * @param contractVersion - overridable for tests; defaults to the constant
 * @returns {{ lookup(observation): object|null, commit(observation, evaluation): {stored: boolean} }}
 */
export function createDiscoveryEvaluationStore({
  storage,
  sourceScope = null,
  now = () => new Date(),
  contractVersion = DISCOVERY_EVALUATION_CONTRACT_VERSION
}) {
  if (!storage) throw new Error('createDiscoveryEvaluationStore requires storage');

  return {
    /**
     * Returns { proposition, raw, completedAt, auditMetadata } for a VALID
     * durable evaluation, otherwise null. Read-only.
     */
    lookup(observation) {
      const identity = deriveIdentity(observation, { sourceScope });
      if (!identity) return null;

      const record = storage.get(
        'SELECT * FROM discovery_evaluations WHERE identity_key = ?',
        [identity.key]
      );
      if (!record) return null;
      if (record.contract_version !== contractVersion) return null;
      if (record.content_fingerprint !== contentFingerprint(observation)) return null;

      const completedMs = Date.parse(record.completed_at);
      if (!Number.isFinite(completedMs)) return null;

      // Cycle scope: read-only use of the ledger's existing boundary.
      const ledger = storage.get(
        'SELECT last_evaluated_at FROM discovery_observations WHERE identity_key = ?',
        [identity.key]
      );
      if (ledger && ledger.last_evaluated_at !== null && ledger.last_evaluated_at !== undefined) {
        const evaluatedMs = Date.parse(ledger.last_evaluated_at);
        // Unreadable boundary: cannot prove the record is in the current
        // cycle, so do not reuse (cost of being wrong is one re-evaluation).
        if (!Number.isFinite(evaluatedMs)) return null;
        if (!(completedMs > evaluatedMs)) return null;
      }

      const proposition = parseJson(record.proposition);
      const raw = parseJson(record.raw_features);
      if (!proposition || typeof proposition !== 'object' || !isCompleteRawFeatures(raw)) return null;

      return {
        proposition,
        raw,
        completedAt: record.completed_at,
        contractVersion: record.contract_version,
        auditMetadata: record.audit_metadata ? parseJson(record.audit_metadata) ?? null : null
      };
    },

    /**
     * Durably records a COMPLETED evaluation in one statement (atomic). Call
     * only after proposition validation and feature extraction succeeded.
     * Replaces any earlier record for the identity (different content,
     * contract version or cycle). No-op for identity-less observations.
     */
    commit(observation, { proposition, raw, audit = null }) {
      const identity = deriveIdentity(observation, { sourceScope });
      if (!identity) return { stored: false };

      const completedAt = now();
      const completedIso = (completedAt instanceof Date ? completedAt : new Date(completedAt)).toISOString();

      storage.run(
        `INSERT INTO discovery_evaluations
           (identity_key, content_fingerprint, contract_version, proposition, raw_features, completed_at, audit_metadata)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(identity_key) DO UPDATE SET
           content_fingerprint = excluded.content_fingerprint,
           contract_version = excluded.contract_version,
           proposition = excluded.proposition,
           raw_features = excluded.raw_features,
           completed_at = excluded.completed_at,
           audit_metadata = excluded.audit_metadata`,
        [
          identity.key,
          contentFingerprint(observation),
          contractVersion,
          JSON.stringify(proposition),
          JSON.stringify(raw),
          completedIso,
          audit ? JSON.stringify(audit) : null
        ]
      );
      return { stored: true };
    }
  };
}

export default createDiscoveryEvaluationStore;