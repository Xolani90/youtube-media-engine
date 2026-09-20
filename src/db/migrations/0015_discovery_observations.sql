-- Discovery Observation Memory Ledger (Owner-authorized workstream).
--
-- One row per deterministic observation identity (see
-- src/autonomous/discoveryMemory.js). The ledger records FACTS about
-- Discovery observations and their evaluation history. It deliberately
-- holds NO permanent "suppressed" flag and NO copy of downstream state
-- (research / production / publication): suppression is derived at read
-- time from evaluation_outcome + last_evaluated_at + the configured
-- cooldown (config/discovery_policy.json -> reconsideration.cooldownHours).
--
-- evaluation_outcome:
--   NOT_EVALUATED         written BEFORE Discovery runs; stays if Discovery
--                         throws / never completes. Never suppressing.
--   SELECTED              Discovery selected it (handed to research).
--   SCORED_NOT_SELECTED   scored by Discovery but not selected. The only
--                         outcome the cooldown suppresses.
--   NOT_SCORED_UNRESOLVED absent from Discovery's scored results after a
--                         successful return; the reason is not exposed by
--                         Discovery and is NOT inferred. Never suppressing.
--
-- Sequential-invocation assumption: no locking or concurrency control is
-- provided by this table (out of scope).

CREATE TABLE IF NOT EXISTS discovery_observations (
  id TEXT PRIMARY KEY,
  -- sha256 of JSON.stringify([identity_kind, identity_scope, identity_value])
  identity_key TEXT NOT NULL,
  identity_kind TEXT NOT NULL
    CHECK (identity_kind IN ('SOURCE_ID', 'CANONICAL_URL', 'TITLE')),
  identity_scope TEXT, -- feed/source scope for SOURCE_ID; NULL for the other kinds
  identity_value TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  times_seen INTEGER NOT NULL DEFAULT 1 CHECK (times_seen >= 1),
  last_evaluated_at TEXT,
  evaluation_outcome TEXT NOT NULL
    CHECK (evaluation_outcome IN ('NOT_EVALUATED', 'SELECTED', 'SCORED_NOT_SELECTED', 'NOT_SCORED_UNRESOLVED')),
  opportunity_id TEXT REFERENCES opportunities(id),
  -- An outcome other than NOT_EVALUATED can only be recorded by a completed
  -- Discovery pass, so it must carry that pass's time.
  CHECK (evaluation_outcome = 'NOT_EVALUATED' OR last_evaluated_at IS NOT NULL)
);

-- Deterministic uniqueness of the identity representation.
CREATE UNIQUE INDEX IF NOT EXISTS idx_discovery_observations_identity_key
  ON discovery_observations(identity_key);