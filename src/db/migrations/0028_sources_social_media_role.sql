-- 0028_sources_social_media_role.sql
-- Pass 46.2: widens sources.role CHECK with 'social_media'. Vocabulary change
-- only; rows are copied 1:1. Same preserve-and-rebuild convention as 0018:
-- no PRAGMA here, the runner toggles foreign_keys for this filename.
CREATE TABLE sources_new (
  id TEXT PRIMARY KEY,
  research_project_id TEXT NOT NULL REFERENCES research_projects(id),
  url TEXT,
  source_type TEXT,
  role TEXT CHECK (role IN ('primary_authoritative', 'independent_reporting', 'syndicated', 'social_media')),
  quality_tier TEXT CHECK (quality_tier IN ('HIGH', 'MEDIUM', 'LOW', 'UNUSABLE')),
  retrieval_status TEXT CHECK (retrieval_status IN ('SUCCESS', 'FAILED', 'CONTENT_UNPARSEABLE')),
  content TEXT,
  retrieved_at TEXT NOT NULL,
  notes TEXT
);
INSERT INTO sources_new (id, research_project_id, url, source_type, role, quality_tier, retrieval_status, content, retrieved_at, notes)
SELECT id, research_project_id, url, source_type, role, quality_tier, retrieval_status, content, retrieved_at, notes FROM sources;
DROP TABLE sources;
ALTER TABLE sources_new RENAME TO sources;
