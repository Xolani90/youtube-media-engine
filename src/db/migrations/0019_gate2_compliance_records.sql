-- 0019_gate2_compliance_records.sql
-- ADR-0032 (Gate 2 / FINAL_COMPLIANCE): the append-only Gate 2 compliance
-- record. One row per Gate 2 evaluation that produced a PASS/REVIEW/BLOCK
-- result. (A policy-pack load failure produces NO row: ADR-0032 section 13
-- forbids fabricating a REVIEW/BLOCK for it.)
--
-- Ordering: "newest record for a content_version_id" is defined by `seq`, an
-- INTEGER PRIMARY KEY AUTOINCREMENT, which IS this table's SQLite rowid.
-- UUIDs (`id`) and timestamps (`created_at`) are deliberately NOT used to
-- decide recency: UUIDs are random and timestamps can collide. AUTOINCREMENT
-- (rather than a bare rowid) guarantees `seq` is strictly monotonic and never
-- reused. A newer REVIEW/BLOCK therefore always supersedes an older PASS, and
-- an older PASS can never override a newer non-PASS.
--
-- Append-only: rows are never updated or deleted. The two triggers below make
-- that a database-enforced property rather than only an application
-- convention. No update/delete semantics exist anywhere in the application.
--
-- PASS binding (ADR-0032 section 9): the bound_* columns hold the exact values
-- a PASS is bound to. A PASS row must carry every binding (CHECK below); a
-- REVIEW/BLOCK row records whichever of them could be resolved. Policy binding
-- is policy_version + rule_ids_json (the exact evaluated rule-ID set). Evidence
-- references (asset_verifications ids, decision_log ids, media artifact and
-- checksum) are stored, by reference, in evidence_json.

CREATE TABLE gate2_compliance_records (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  content_version_id TEXT NOT NULL REFERENCES content_versions(id),
  decision TEXT NOT NULL CHECK (decision IN ('PASS', 'REVIEW', 'BLOCK')),
  policy_version TEXT NOT NULL,
  rule_ids_json TEXT NOT NULL,            -- JSON array: exact evaluated rule IDs, sorted
  rule_results_json TEXT NOT NULL,        -- JSON array: per-rule { rule_id, result, reason }
  bound_content_script_id TEXT,           -- content_versions.script_id
  bound_script_id TEXT,                   -- scripts.id
  bound_script_version INTEGER,           -- scripts.version
  bound_production_script_id TEXT,        -- productions.script_id
  bound_media_artifact_id TEXT,           -- media_artifacts.id
  bound_artifact_checksum TEXT,           -- media_artifacts.artifact_checksum
  bound_working_title TEXT,               -- exact current content_briefs.working_title
  bound_viewer_promise TEXT,              -- exact current content_briefs.viewer_promise
  bound_metadata_json TEXT,               -- deterministic representation of the two metadata fields
  evidence_json TEXT NOT NULL,            -- JSON: references only (see ADR-0032 section 9)
  created_at TEXT NOT NULL,
  CHECK (
    decision <> 'PASS' OR (
      bound_content_script_id IS NOT NULL AND
      bound_script_id IS NOT NULL AND
      bound_script_version IS NOT NULL AND
      bound_production_script_id IS NOT NULL AND
      bound_media_artifact_id IS NOT NULL AND
      bound_artifact_checksum IS NOT NULL AND
      bound_working_title IS NOT NULL AND
      bound_viewer_promise IS NOT NULL AND
      bound_metadata_json IS NOT NULL
    )
  )
);

CREATE INDEX idx_gate2_compliance_records_content_version
  ON gate2_compliance_records(content_version_id, seq);

CREATE TRIGGER gate2_compliance_records_no_update
BEFORE UPDATE ON gate2_compliance_records
BEGIN
  SELECT RAISE(ABORT, 'gate2_compliance_records is append-only: UPDATE is not permitted');
END;

CREATE TRIGGER gate2_compliance_records_no_delete
BEFORE DELETE ON gate2_compliance_records
BEGIN
  SELECT RAISE(ABORT, 'gate2_compliance_records is append-only: DELETE is not permitted');
END;
