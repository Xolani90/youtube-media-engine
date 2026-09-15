-- 0006_originality_check_subsystem.sql
-- Additive schema change for the D-G1 v1 Originality measurement stage.
--
-- Dedicated table: `originality_checks` is entirely separate from
-- `fact_checks` (0005_fact_check_subsystem.sql) and from `risk_assessments`
-- (0001_init.sql). Neither of those tables is read or written by this
-- stage, and this stage does not touch them.
--
-- Unlike `fact_checks`, this table is append-only WITHOUT a per-script
-- uniqueness constraint: every explicit Originality evaluation of a given
-- script_id creates a new row (Owner Decision: the corpus is dynamic, so
-- the same script_id can legitimately produce different measurements at
-- different times). There is therefore no UNIQUE(script_id, ...) index —
-- adding one would silently prevent the required duplicate-execution
-- behavior.
--
-- No existing table is dropped or altered.

CREATE TABLE originality_checks (
  id TEXT PRIMARY KEY,
  content_version_id TEXT NOT NULL REFERENCES content_versions(id),
  script_id TEXT NOT NULL REFERENCES scripts(id),
  corpus_definition TEXT NOT NULL,
  corpus_size INTEGER NOT NULL,
  algorithm TEXT NOT NULL,
  algorithm_version TEXT NOT NULL,
  max_similarity REAL,             -- NULL when corpus_size = 0 (not applicable, not 0)
  most_similar_script_id TEXT REFERENCES scripts(id), -- NULL when corpus_size = 0
  known_limitations TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- Non-unique: supports fast lookup of a script's Originality history
-- without constraining how many rows may exist per script_id.
CREATE INDEX idx_originality_checks_script_id ON originality_checks(script_id);
CREATE INDEX idx_originality_checks_content_version_id ON originality_checks(content_version_id);
