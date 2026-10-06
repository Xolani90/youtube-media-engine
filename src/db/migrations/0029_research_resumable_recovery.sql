-- 0029_research_resumable_recovery.sql
-- ADR-0039 (B4): resumable Research recovery.
--
-- 1. Widens the stage CHECK of stage_retry_state and stage_retry_cycle_history
--    with 'RESEARCH' (subject_id = research_projects.id; not provider-scoped,
--    so provider is always ''). Every existing row is copied 1:1; no counter,
--    quarantine or history value changes. Same preserve-and-rebuild convention
--    as 0017/0026 (the runner toggles foreign_keys for this filename).
-- 2. Creates research_checkpoints: one row per (project, checkpoint). A row is
--    written in the SAME transaction as the evidence it describes, so a
--    checkpoint can never exist without that evidence and evidence can never be
--    committed without its checkpoint. No historical evidence row is touched.

CREATE TABLE stage_retry_state_new (
  id TEXT PRIMARY KEY,
  subject_id TEXT NOT NULL,
  stage TEXT NOT NULL CHECK (stage IN (
    'PRODUCTION', 'PUBLICATION',
    'BRIEF', 'SCRIPT', 'FACT_CHECK', 'ORIGINALITY', 'QUALITY_GATE',
    'ASSET_PROVISIONING', 'MEDIA_PRODUCTION', 'RESEARCH'
  )),
  provider TEXT NOT NULL DEFAULT '',
  cycle_number INTEGER NOT NULL DEFAULT 1 CHECK (cycle_number >= 1),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  quarantined_at TEXT,
  last_failure_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (stage, subject_id, provider)
);

INSERT INTO stage_retry_state_new
  (id, subject_id, stage, provider, cycle_number, attempt_count, quarantined_at, last_failure_reason, created_at, updated_at)
SELECT
  id, subject_id, stage, provider, cycle_number, attempt_count, quarantined_at, last_failure_reason, created_at, updated_at
FROM stage_retry_state;

DROP TABLE stage_retry_state;
ALTER TABLE stage_retry_state_new RENAME TO stage_retry_state;

CREATE TABLE stage_retry_cycle_history_new (
  id TEXT PRIMARY KEY,
  subject_id TEXT NOT NULL,
  stage TEXT NOT NULL CHECK (stage IN (
    'PRODUCTION', 'PUBLICATION',
    'BRIEF', 'SCRIPT', 'FACT_CHECK', 'ORIGINALITY', 'QUALITY_GATE',
    'ASSET_PROVISIONING', 'MEDIA_PRODUCTION', 'RESEARCH'
  )),
  provider TEXT NOT NULL DEFAULT '',
  cycle_number INTEGER NOT NULL,
  attempts_in_cycle INTEGER NOT NULL,
  quarantined_at TEXT NOT NULL,
  reactivated_at TEXT NOT NULL,
  owner_reason TEXT NOT NULL,
  UNIQUE (stage, subject_id, provider, cycle_number)
);

INSERT INTO stage_retry_cycle_history_new
  (id, subject_id, stage, provider, cycle_number, attempts_in_cycle, quarantined_at, reactivated_at, owner_reason)
SELECT
  id, subject_id, stage, provider, cycle_number, attempts_in_cycle, quarantined_at, reactivated_at, owner_reason
FROM stage_retry_cycle_history;

DROP TABLE stage_retry_cycle_history;
ALTER TABLE stage_retry_cycle_history_new RENAME TO stage_retry_cycle_history;

CREATE TABLE research_checkpoints (
  id TEXT PRIMARY KEY,
  research_project_id TEXT NOT NULL REFERENCES research_projects(id),
  checkpoint TEXT NOT NULL CHECK (checkpoint IN (
    'SOURCES_PERSISTED', 'EXTRACTION_PERSISTED', 'EXPANSION_PERSISTED'
  )),
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (research_project_id, checkpoint)
);
