-- 0021_discovery_evaluation_schedule.sql
-- Fresh-evaluation scheduling state (ADR-0034).
--
-- Tracks, per canonical Discovery identity_key (the same identity derived by
-- deriveIdentity() in src/autonomous/discoveryMemory.js, used by ADR-0033),
-- when that identity's most recent SUCCESSFUL fresh evaluation was durably
-- completed. This is the only input to the per-run fresh-evaluation budget's
-- ordering: among candidates that require a fresh evaluation this run,
-- never-evaluated candidates (no row here) go first, then the oldest
-- last_fresh_evaluation_at, with identity_key as a deterministic tie-break.
--
-- Orthogonal to discovery_evaluations (ADR-0033):
--   * this table is never read to decide reuse;
--   * a durable reuse never writes to this table;
--   * content-fingerprint or contract-version invalidation of an ADR-0033
--     record does NOT reset or otherwise touch this table -- an identity
--     that loses its reuse eligibility is simply fresh-evaluated again in
--     its normal scheduling order, and only a SUCCESSFUL fresh evaluation
--     updates last_fresh_evaluation_at.
--
-- A row is written only when a fresh evaluation's discovery_evaluations
-- commit and this table's write have both been persisted in the SAME
-- database transaction (see src/autonomous/discoveryEvaluationSchedule.js
-- and its call site in src/discovery/pipeline.js). No foreign key to
-- discovery_evaluations or discovery_observations: keyed by identity_key
-- alone, exactly like discovery_evaluations. No age expiry and no
-- retention/cleanup (out of scope, mirrors ADR-0033).

CREATE TABLE IF NOT EXISTS discovery_evaluation_schedule (
  identity_key TEXT PRIMARY KEY,
  last_fresh_evaluation_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_discovery_evaluation_schedule_last_fresh
  ON discovery_evaluation_schedule (last_fresh_evaluation_at);
