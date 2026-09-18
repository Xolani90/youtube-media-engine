-- 0013_content_versions_state_check.sql
-- F-DB-01 (Owner-authorized disposition: RETAIN OPEN -> schema hardening):
-- content_versions.state has no database-level CHECK constraint, unlike every
-- other controlled-vocabulary lifecycle column in this schema. Application-layer
-- enforcement (ContentStateMachine.js canTransition()/transition()) remains the
-- sole authority for transition *legality*; this migration adds a database-level
-- CHECK for vocabulary *membership* only, as defense-in-depth.
--
-- The 19 permitted values below are ContentStateMachine.STATES (15) union
-- ContentStateMachine.FAILURE_STATES (4), verified by loading the live module
-- at implementation time (exact set match, no additions/omissions/renames).
--
-- Like 0012_remove_legacy_claim_columns.sql, content_versions may hold real
-- rows and is referenced by six dependent tables (risk_assessments,
-- originality_checks, asset_usages, productions, media_artifacts,
-- publications), so this is a populated-database-safe preserve-and-rebuild:
-- copy all existing columns into a replacement table (identical types,
-- NOT NULL, default, and primary/foreign keys, plus the new CHECK), drop the
-- old table, rename the replacement into place. This file intentionally
-- issues no PRAGMA foreign_keys statement — PRAGMA foreign_keys has no effect
-- once a transaction is already open, and this migration always runs inside
-- the runner's per-file transaction, so the FK toggle required for the DROP
-- TABLE step below is handled by the runner (SqliteStorageDriver.migrate()),
-- scoped specifically to this filename (and 0012's), not here.

CREATE TABLE content_versions_new (
  id TEXT PRIMARY KEY,
  content_brief_id TEXT NOT NULL REFERENCES content_briefs(id),
  script_id TEXT REFERENCES scripts(id),
  state TEXT NOT NULL DEFAULT 'DISCOVERED'
    CHECK (state IN (
      'DISCOVERED',
      'SCORED',
      'SELECTED',
      'RESEARCHING',
      'RESEARCH_COMPLETE',
      'BRIEF_CREATED',
      'SCRIPT_DRAFT',
      'FACT_CHECK',
      'ORIGINALITY_CHECK',
      'QUALITY_GATE',
      'PRODUCTION_READY',
      'PRODUCED',
      'PUBLISHED',
      'ANALYZING',
      'LEARNED',
      'REJECTED',
      'BLOCKED',
      'NEEDS_REVIEW',
      'FAILED'
    )),
  created_at TEXT NOT NULL
);

INSERT INTO content_versions_new (id, content_brief_id, script_id, state, created_at)
SELECT id, content_brief_id, script_id, state, created_at
FROM content_versions;

DROP TABLE content_versions;

ALTER TABLE content_versions_new RENAME TO content_versions;
