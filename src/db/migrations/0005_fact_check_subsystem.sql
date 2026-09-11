-- 0005_fact_check_subsystem.sql
-- Additive schema change required by the Fact-Check Specification (§9).
--
-- Dedicated table: `fact_checks` is entirely separate from
-- `risk_assessments` (0001_init.sql), which remains exclusively owned by
-- the Risk stage and is neither read nor written by Fact-Check.
--
-- Fact-Check results are append-only per `script_id` (unlike a
-- would-be per-Script overwrite): each run inserts a new row with an
-- explicit integer `version`, never mutating a prior result. The unique
-- index below is the DB-enforced half of that guarantee — the same
-- pattern already established by 0004_script_subsystem.sql for
-- (content_brief_id, version): a version-allocation race (two concurrent
-- writers computing the same "next" version for the same script_id) fails
-- loudly at the database layer instead of silently persisting a
-- duplicate. The application layer (src/fact-check/pipeline.js)
-- additionally computes the next version from inside the same
-- storage.transaction() that performs the insert.
--
-- No existing table is dropped or altered.

CREATE TABLE fact_checks (
  id TEXT PRIMARY KEY,
  script_id TEXT NOT NULL REFERENCES scripts(id),
  version INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('PASS', 'REVIEW', 'REJECT')),
  findings TEXT NOT NULL, -- JSON array of {claim_id, section_heading, finding}
  notes TEXT,
  created_at TEXT NOT NULL
);

CREATE UNIQUE INDEX idx_fact_checks_script_id_version ON fact_checks(script_id, version);