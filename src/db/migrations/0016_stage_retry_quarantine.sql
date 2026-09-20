-- 0016_stage_retry_quarantine.sql
-- Bounded-retry + quarantine governance (Owner-authorized workstream).
--
-- Side-table design: neither `content_versions.state` nor
-- `publications.status` is altered (no CHECK change, no table rebuild).
-- QUARANTINED is a disposition recorded HERE, separate from and never a
-- reinterpretation of REJECTED / BLOCKED / NEEDS_REVIEW / AMBIGUOUS / FAILED.
--
-- stage_retry_state: ONE row per (content_version_id, stage) holding the
-- CURRENT retry cycle. This is the single authoritative counter for the
-- 3-attempt governance cap (publications.attempt_count is a legacy claim
-- counter and is never consulted for the cap).
--   stage          'PRODUCTION' | 'PUBLICATION'
--   cycle_number   1 for the first cycle; incremented by Owner reactivation
--   attempt_count  failed attempts recorded in the CURRENT cycle
--   quarantined_at non-NULL <=> currently quarantined (cap exhausted)
--
-- stage_retry_cycle_history: append-only evidence. One row is written per
-- reactivation, preserving the closed cycle's attempt count, quarantine
-- timestamp, reactivation timestamp and Owner reason. Nothing here is ever
-- updated or deleted.
--
-- No existing table is dropped or altered.

CREATE TABLE stage_retry_state (
  id TEXT PRIMARY KEY,
  content_version_id TEXT NOT NULL REFERENCES content_versions(id),
  stage TEXT NOT NULL CHECK (stage IN ('PRODUCTION', 'PUBLICATION')),
  cycle_number INTEGER NOT NULL DEFAULT 1 CHECK (cycle_number >= 1),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  quarantined_at TEXT,
  last_failure_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (content_version_id, stage)
);

CREATE TABLE stage_retry_cycle_history (
  id TEXT PRIMARY KEY,
  content_version_id TEXT NOT NULL REFERENCES content_versions(id),
  stage TEXT NOT NULL CHECK (stage IN ('PRODUCTION', 'PUBLICATION')),
  cycle_number INTEGER NOT NULL,
  attempts_in_cycle INTEGER NOT NULL,
  quarantined_at TEXT NOT NULL,
  reactivated_at TEXT NOT NULL,
  owner_reason TEXT NOT NULL,
  UNIQUE (content_version_id, stage, cycle_number)
);
