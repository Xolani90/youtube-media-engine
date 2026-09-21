-- 0018_content_versions_final_compliance_state.sql
-- ADR-0032 (Gate 2 / FINAL_COMPLIANCE): widens the content_versions.state
-- CHECK constraint added by 0013 so it also admits 'FINAL_COMPLIANCE', the new
-- lifecycle state between PRODUCED and PUBLISHED.
--
-- This is a vocabulary-membership change only. Transition *legality* remains
-- the sole responsibility of ContentStateMachine.js canTransition()/transition().
-- The 20 permitted values below are ContentStateMachine.STATES (16) union
-- ContentStateMachine.FAILURE_STATES (4), i.e. exactly the 19 values from 0013
-- plus 'FINAL_COMPLIANCE' -- no other addition, omission or rename.
--
-- Same populated-database-safe preserve-and-rebuild convention as 0013:
-- content_versions is referenced by dependent tables (risk_assessments,
-- originality_checks, asset_usages, productions, media_artifacts, publications),
-- so all existing rows and columns are copied 1:1 into a replacement table
-- (identical types, NOT NULL, default, primary/foreign keys, plus the widened
-- CHECK), the old table is dropped, and the replacement is renamed into place.
-- This file intentionally issues no PRAGMA foreign_keys statement: PRAGMA
-- foreign_keys has no effect once a transaction is open and this migration
-- always runs inside the runner's per-file transaction, so the FK toggle
-- required for the DROP TABLE step is handled by the runner
-- (SqliteStorageDriver.migrate()), scoped to this filename (and 0012's/0013's/
-- 0017's), not here.
--
-- Existing rows are unaffected: no row is moved into FINAL_COMPLIANCE by this
-- migration. Existing PRODUCED rows stay PRODUCED and must obtain a Gate 2 PASS
-- through the final-compliance stage (ADR-0032 section 12: no grandfathering).

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
      'FINAL_COMPLIANCE',
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
