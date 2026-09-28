-- 0026_provider_scoped_publication_retry.sql
-- Provider-scoped PUBLICATION retry/quarantine (Owner-authorized fix).
--
-- DEFECT: stage_retry_state / stage_retry_cycle_history key retry identity by
-- (stage, subject_id) only. For PUBLICATION this means a single content
-- version publishing to multiple providers (e.g. youtube_shorts and
-- facebook_reels) shares ONE retry/quarantine counter across ALL providers.
-- Three EXPLICIT_FAILURE results from ONE provider quarantine the item for
-- EVERY provider (workSelection.selectEligiblePublications' unscoped
-- `stage = 'PUBLICATION'` exclusion, and StageRetryPolicy.isQuarantined's
-- unscoped lookup). This is wrong: publication identity is already
-- (content_version_id, provider) per the `publications` table's own UNIQUE
-- index (0010_publication.sql) -- retry/quarantine identity must match it.
--
-- FIX: identity becomes (stage, subject_id, provider) for PUBLICATION.
-- For every OTHER stage (PRODUCTION, BRIEF, SCRIPT, FACT_CHECK, ORIGINALITY,
-- QUALITY_GATE, ASSET_PROVISIONING, MEDIA_PRODUCTION), provider is not a
-- concept that applies to that stage's identity at all -- their behavior and
-- identity semantics from 0017 are preserved EXACTLY. A provider column is
-- added to both tables so a single physical schema can carry both, but for
-- non-PUBLICATION rows it always holds the sentinel empty string '' -- never
-- NULL, never a fabricated provider name -- meaning "not provider-scoped."
-- '' is a normal (non-NULL) value, so UNIQUE (stage, subject_id, provider)
-- still enforces exactly one row per (stage, subject_id) for those stages,
-- identical to 0017's UNIQUE (stage, subject_id). SQLite treats NULL as
-- distinct-from-itself in a UNIQUE index, so NULL could not be used here
-- without silently weakening that existing guarantee -- '' is used instead
-- for exactly that reason.
--
-- OWNER DECISION ON HISTORICAL PUBLICATION RETRY STATE:
-- Every PUBLICATION-stage row written before this migration was recorded
-- under the OLD unscoped identity and carries no provider information --
-- `publications.status = 'FAILED'` rows themselves do carry `provider`, but
-- stage_retry_state / stage_retry_cycle_history never did, and a failure
-- cycle may represent mixed attempts from more than one provider. There is
-- therefore NO safe way to attribute an existing PUBLICATION row to
-- 'youtube', 'facebook', or any other single provider, and this migration
-- does not attempt to. Per Owner instruction:
--   * historical PUBLICATION rows are NOT fabricated a provider and are NOT
--     silently assigned to any specific provider;
--   * they are NOT carried forward as live rows in the rebuilt
--     stage_retry_state / stage_retry_cycle_history tables either, because
--     leaving them active (whether unscoped or under a made-up provider)
--     risks exactly the defect this migration fixes: incorrectly
--     quarantining (or exempting) a specific provider on the strength of
--     old, unattributable data;
--   * instead they are preserved as read-only historical records in two new
--     archive tables (below), verbatim, so no data is lost and the
--     disposition is fully auditable;
--   * PUBLICATION retry/quarantine state starts fresh (empty) after this
--     migration -- every item begins with zero recorded attempts, for every
--     provider, in the new provider-scoped scheme. An item that was
--     legitimately mid-cycle or quarantined pre-migration is not
--     quarantined post-migration for any provider; it earns quarantine
--     again only from new, correctly provider-attributed failures.
-- Non-PUBLICATION rows (PRODUCTION, BRIEF, SCRIPT, etc.) are entirely
-- unaffected by this disposition: they are carried forward 1:1, unchanged, with
-- provider = ''.
--
-- Same copy/drop/rename + FK-toggle pattern as 0012/0013/0017/0018 (see
-- FK_TOGGLE_MIGRATIONS in SqliteStorageDriver.js, which this filename is
-- added to).

-- ---------------------------------------------------------------------
-- 1. Archive historical PUBLICATION rows verbatim, read-only, before they
--    are excluded from the rebuilt live tables. Never queried by
--    application code; kept solely as an auditable historical record.
-- ---------------------------------------------------------------------
CREATE TABLE stage_retry_state_legacy_publication_unscoped (
  id TEXT PRIMARY KEY,
  subject_id TEXT NOT NULL,
  stage TEXT NOT NULL,
  cycle_number INTEGER NOT NULL,
  attempt_count INTEGER NOT NULL,
  quarantined_at TEXT,
  last_failure_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT NOT NULL,
  archive_disposition TEXT NOT NULL DEFAULT
    'pre_provider_scoping_unattributable_not_carried_forward'
);

INSERT INTO stage_retry_state_legacy_publication_unscoped
  (id, subject_id, stage, cycle_number, attempt_count, quarantined_at, last_failure_reason, created_at, updated_at, archived_at)
SELECT
  id, subject_id, stage, cycle_number, attempt_count, quarantined_at, last_failure_reason, created_at, updated_at, CURRENT_TIMESTAMP
FROM stage_retry_state
WHERE stage = 'PUBLICATION';

CREATE TABLE stage_retry_cycle_history_legacy_publication_unscoped (
  id TEXT PRIMARY KEY,
  subject_id TEXT NOT NULL,
  stage TEXT NOT NULL,
  cycle_number INTEGER NOT NULL,
  attempts_in_cycle INTEGER NOT NULL,
  quarantined_at TEXT NOT NULL,
  reactivated_at TEXT NOT NULL,
  owner_reason TEXT NOT NULL,
  archived_at TEXT NOT NULL,
  archive_disposition TEXT NOT NULL DEFAULT
    'pre_provider_scoping_unattributable_not_carried_forward'
);

INSERT INTO stage_retry_cycle_history_legacy_publication_unscoped
  (id, subject_id, stage, cycle_number, attempts_in_cycle, quarantined_at, reactivated_at, owner_reason, archived_at)
SELECT
  id, subject_id, stage, cycle_number, attempts_in_cycle, quarantined_at, reactivated_at, owner_reason, CURRENT_TIMESTAMP
FROM stage_retry_cycle_history
WHERE stage = 'PUBLICATION';

-- ---------------------------------------------------------------------
-- 2. Rebuild stage_retry_state with the new provider column. Only
--    non-PUBLICATION rows (provider = '') are carried forward.
-- ---------------------------------------------------------------------
CREATE TABLE stage_retry_state_new (
  id TEXT PRIMARY KEY,
  subject_id TEXT NOT NULL,
  stage TEXT NOT NULL CHECK (stage IN (
    'PRODUCTION', 'PUBLICATION',
    'BRIEF', 'SCRIPT', 'FACT_CHECK', 'ORIGINALITY', 'QUALITY_GATE',
    'ASSET_PROVISIONING', 'MEDIA_PRODUCTION'
  )),
  -- '' for every stage except PUBLICATION, where it holds the real
  -- provider id (e.g. 'youtube_shorts', 'facebook_reels'). Never NULL:
  -- see header for why NULL cannot be used here.
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
  id, subject_id, stage, '', cycle_number, attempt_count, quarantined_at, last_failure_reason, created_at, updated_at
FROM stage_retry_state
WHERE stage != 'PUBLICATION';

DROP TABLE stage_retry_state;
ALTER TABLE stage_retry_state_new RENAME TO stage_retry_state;

-- ---------------------------------------------------------------------
-- 3. Rebuild stage_retry_cycle_history the same way.
-- ---------------------------------------------------------------------
CREATE TABLE stage_retry_cycle_history_new (
  id TEXT PRIMARY KEY,
  subject_id TEXT NOT NULL,
  stage TEXT NOT NULL CHECK (stage IN (
    'PRODUCTION', 'PUBLICATION',
    'BRIEF', 'SCRIPT', 'FACT_CHECK', 'ORIGINALITY', 'QUALITY_GATE',
    'ASSET_PROVISIONING', 'MEDIA_PRODUCTION'
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
  id, subject_id, stage, '', cycle_number, attempts_in_cycle, quarantined_at, reactivated_at, owner_reason
FROM stage_retry_cycle_history
WHERE stage != 'PUBLICATION';

DROP TABLE stage_retry_cycle_history;
ALTER TABLE stage_retry_cycle_history_new RENAME TO stage_retry_cycle_history;
