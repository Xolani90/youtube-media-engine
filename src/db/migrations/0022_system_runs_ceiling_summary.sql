-- 0022_system_runs_ceiling_summary.sql
-- Structured run-level ceiling summary metadata (ADR-0038).
--
-- Nullable, additive-only column. Populated only when a run's caller
-- explicitly passes a ceilingSummary to SystemRunRecorder.finish() (see
-- src/state/SystemRun.js); omitted on every other call, so existing
-- finish() callers are byte-for-byte unaffected. Stores a JSON object
-- combining the run's RSS admission ceilings (per-feed/global) and Discovery
-- dedup workload ceilings (L2 comparison / L3 semantic-call), letting
-- downstream autonomous orchestration distinguish exhaustive Discovery
-- completion from workload-bounded Discovery completion.
--
-- This column is NOT the primary machine-readable representation of a
-- ceiling event -- occurrence-level events are recorded independently in
-- decision_log (existing schema, unchanged by this migration). This is only
-- the run-level structured summary ADR-0038 requires alongside it.

ALTER TABLE system_runs ADD COLUMN ceiling_summary TEXT;
