-- 0012_remove_legacy_claim_columns.sql
-- RG-03 (Owner-authorized disposition, docs/DECISIONS/RESEARCH-GOVERNANCE-BASELINE.md):
-- REMOVE claims.source_id, claims.confidence, claims.supporting_evidence.
--
-- Unlike 0003_research_subsystem.sql's DROP+CREATE (safe there only because no row
-- had ever been written to claims/sources/research_projects at that time), claims
-- and its dependents (claim_sources, claim_relations) may now hold real rows, so
-- this is a populated-database-safe preserve-and-rebuild: copy the seven columns
-- being kept into a replacement table, drop the old one, rename the replacement
-- into place. This file intentionally issues no PRAGMA foreign_keys statement —
-- PRAGMA foreign_keys has no effect once a transaction is already open (verified),
-- and this migration always runs inside the runner's per-file transaction, so the
-- FK toggle required for the DROP TABLE step below is handled by the runner
-- (SqliteStorageDriver.migrate()), scoped specifically to this filename, not here.

CREATE TABLE claims_new (
  id TEXT PRIMARY KEY,
  research_project_id TEXT NOT NULL REFERENCES research_projects(id),
  claim TEXT NOT NULL,
  claim_type TEXT NOT NULL CHECK (claim_type IN ('FACT', 'INFERENCE', 'OPINION')),
  evidence_status TEXT NOT NULL DEFAULT 'UNSUPPORTED'
    CHECK (evidence_status IN ('VERIFIED', 'PARTIALLY_SUPPORTED', 'UNSUPPORTED', 'CONTESTED')),
  is_load_bearing INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

INSERT INTO claims_new (id, research_project_id, claim, claim_type, evidence_status, is_load_bearing, created_at)
SELECT id, research_project_id, claim, claim_type, evidence_status, is_load_bearing, created_at
FROM claims;

DROP TABLE claims;

ALTER TABLE claims_new RENAME TO claims;