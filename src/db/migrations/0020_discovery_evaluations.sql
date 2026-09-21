-- 0020_discovery_evaluations.sql
-- Durable per-observation Discovery evaluation state (ADR-0033).
--
-- One row per deterministic observation identity (the same identity_key used
-- by discovery_observations, see src/autonomous/discoveryMemory.js). A row
-- records that an observation's EVALUATION (valid proposition + raw feature
-- values) is complete. It is NOT a selection outcome and NOT a ledger state:
-- discovery_observations.evaluation_outcome keeps its existing meaning and is
-- untouched. decision_log remains audit-only and is never read to resume.
--
-- Only LLM-derived artifacts are stored (proposition, raw features). Score and
-- risk are recomputed from the CURRENT configuration when a record is reused.
--
-- Reuse validity (enforced in src/autonomous/discoveryEvaluationStore.js, not
-- by constraints here):
--   * identity_key matches;
--   * content_fingerprint matches exactly (title + description only);
--   * contract_version equals the current evaluation contract version;
--   * cycle-scoped: completed_at is after the identity's ledger
--     last_evaluated_at (or the ledger has none). Outcome recording closes the
--     cycle.
--
-- No foreign key to discovery_observations: the store is keyed by identity_key
-- alone and must not constrain or be constrained by ledger writes. No age
-- expiry and no retention/cleanup (deferred by ADR-0033).

CREATE TABLE IF NOT EXISTS discovery_evaluations (
  identity_key TEXT PRIMARY KEY,
  content_fingerprint TEXT NOT NULL,
  contract_version TEXT NOT NULL,
  proposition TEXT NOT NULL,   -- JSON: the parsed, validated Opportunity Proposition
  raw_features TEXT NOT NULL,  -- JSON: the complete rawFeatures(observation) result
  completed_at TEXT NOT NULL,
  audit_metadata TEXT          -- JSON: provider/model of the proposition call (audit only, never an invalidator)
);