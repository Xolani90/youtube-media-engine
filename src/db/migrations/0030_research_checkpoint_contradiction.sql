-- 0030_research_checkpoint_contradiction.sql
-- Durable contradiction-completion checkpoint (Pass 40).
--
-- Widens the research_checkpoints.checkpoint CHECK with exactly one new value,
-- 'CONTRADICTION_PERSISTED'. SQLite cannot alter a CHECK in place, so the table
-- is rebuilt with every existing column, the UNIQUE (research_project_id,
-- checkpoint) constraint and the foreign key unchanged, and every existing row
-- is copied 1:1. Nothing references research_checkpoints, so no FK toggle is
-- needed. No other table is touched.

CREATE TABLE research_checkpoints_new (
  id TEXT PRIMARY KEY,
  research_project_id TEXT NOT NULL REFERENCES research_projects(id),
  checkpoint TEXT NOT NULL CHECK (checkpoint IN (
    'SOURCES_PERSISTED', 'EXTRACTION_PERSISTED', 'EXPANSION_PERSISTED',
    'CONTRADICTION_PERSISTED'
  )),
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (research_project_id, checkpoint)
);

INSERT INTO research_checkpoints_new (id, research_project_id, checkpoint, payload, created_at)
SELECT id, research_project_id, checkpoint, payload, created_at FROM research_checkpoints;

DROP TABLE research_checkpoints;
ALTER TABLE research_checkpoints_new RENAME TO research_checkpoints;
