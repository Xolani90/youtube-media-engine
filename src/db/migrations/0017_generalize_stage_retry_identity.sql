-- 0017_generalize_stage_retry_identity.sql
-- Bounded-retry + quarantine governance, A4 Slice 1 (Owner-authorized).
--
-- Generalizes the retry identity established by 0016 from
-- (content_version_id, stage) to (stage, subject_id) so the seven A4 stages
-- can carry their own domain identity WITHOUT fabricating a content_version_id:
--
--   stage               subject_id refers to
--   ------------------  ----------------------------------------------
--   PRODUCTION          content_versions.id        (unchanged, ADR-0023)
--   PUBLICATION         content_versions.id        (unchanged, ADR-0023)
--   BRIEF               research_projects.id       (no content version exists yet)
--   SCRIPT              content_briefs.id          (no script/content version yet)
--   FACT_CHECK          content_versions.id
--   ORIGINALITY         content_versions.id
--   QUALITY_GATE        content_versions.id
--   ASSET_PROVISIONING  content_versions.id
--   MEDIA_PRODUCTION    content_versions.id
--
-- Changes (per table, via copy -> drop -> rename; data is preserved 1:1):
--   * content_version_id is renamed to subject_id.
--   * The REFERENCES content_versions(id) foreign key is DROPPED: Brief and
--     Script identities are not content versions, so a polymorphic subject_id
--     cannot carry that FK. The stage column determines what subject_id names.
--   * The stage CHECK is widened from 2 to 9 values.
--   * Stage isolation is structural: UNIQUE (stage, subject_id) (and
--     UNIQUE (stage, subject_id, cycle_number) for history), so one subject
--     can never share a counter row across stages.
--
-- RESEARCH is intentionally NOT in the stage list (A4/A9 separation).
-- Rights Verification is intentionally NOT in the stage list (out of scope).
--
-- This migration is applied with foreign_keys toggled OFF (see
-- FK_TOGGLE_MIGRATIONS in SqliteStorageDriver), the same lifecycle used by
-- 0012/0013 for table rebuilds.

CREATE TABLE stage_retry_state_new (
  id TEXT PRIMARY KEY,
  subject_id TEXT NOT NULL,
  stage TEXT NOT NULL CHECK (stage IN (
    'PRODUCTION', 'PUBLICATION',
    'BRIEF', 'SCRIPT', 'FACT_CHECK', 'ORIGINALITY', 'QUALITY_GATE',
    'ASSET_PROVISIONING', 'MEDIA_PRODUCTION'
  )),
  cycle_number INTEGER NOT NULL DEFAULT 1 CHECK (cycle_number >= 1),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  quarantined_at TEXT,
  last_failure_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (stage, subject_id)
);

INSERT INTO stage_retry_state_new
  (id, subject_id, stage, cycle_number, attempt_count, quarantined_at, last_failure_reason, created_at, updated_at)
SELECT
  id, content_version_id, stage, cycle_number, attempt_count, quarantined_at, last_failure_reason, created_at, updated_at
FROM stage_retry_state;

DROP TABLE stage_retry_state;
ALTER TABLE stage_retry_state_new RENAME TO stage_retry_state;

CREATE TABLE stage_retry_cycle_history_new (
  id TEXT PRIMARY KEY,
  subject_id TEXT NOT NULL,
  stage TEXT NOT NULL CHECK (stage IN (
    'PRODUCTION', 'PUBLICATION',
    'BRIEF', 'SCRIPT', 'FACT_CHECK', 'ORIGINALITY', 'QUALITY_GATE',
    'ASSET_PROVISIONING', 'MEDIA_PRODUCTION'
  )),
  cycle_number INTEGER NOT NULL,
  attempts_in_cycle INTEGER NOT NULL,
  quarantined_at TEXT NOT NULL,
  reactivated_at TEXT NOT NULL,
  owner_reason TEXT NOT NULL,
  UNIQUE (stage, subject_id, cycle_number)
);

INSERT INTO stage_retry_cycle_history_new
  (id, subject_id, stage, cycle_number, attempts_in_cycle, quarantined_at, reactivated_at, owner_reason)
SELECT
  id, content_version_id, stage, cycle_number, attempts_in_cycle, quarantined_at, reactivated_at, owner_reason
FROM stage_retry_cycle_history;

DROP TABLE stage_retry_cycle_history;
ALTER TABLE stage_retry_cycle_history_new RENAME TO stage_retry_cycle_history;