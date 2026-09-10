-- 0003_research_subsystem.sql
-- Research subsystem schema, per the frozen Research Subsystem Specification
-- v0.4 (R1-R7 resolved) and the D-01/D-02 Discovery->Research handoff.
--
-- research_projects, sources, and claims already existed in 0001_init.sql,
-- but in an early/pre-spec shape (claims.claim_type was the old four-value
-- verified_fact/inference/opinion/unresolved CHECK; sources had no role/
-- quality/retrieval_status/content columns; research_projects.status had
-- no CHECK constraint and no stop_reason). SQLite cannot ALTER a column's
-- CHECK constraint or add a CHECK to an existing column in place, so this
-- migration rebuilds those three tables via DROP+CREATE rather than an
-- unsupported in-place ALTER. This is safe: Research was never
-- implemented, so no row has ever been written to any of these three
-- tables in any environment (confirmed by repository inspection).
--
-- Dropped in child-to-parent order, recreated in parent-to-child order.

DROP TABLE IF EXISTS claims;
DROP TABLE IF EXISTS sources;
DROP TABLE IF EXISTS research_projects;

CREATE TABLE research_projects (
  id TEXT PRIMARY KEY,
  opportunity_id TEXT NOT NULL REFERENCES opportunities(id),
  run_id TEXT REFERENCES system_runs(id),
  status TEXT NOT NULL DEFAULT 'RESEARCHING'
    CHECK (status IN ('RESEARCHING', 'RESEARCH_COMPLETE', 'INSUFFICIENT_EVIDENCE', 'FAILED')),
  stop_reason TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT
);

-- Idempotency (v0.2 S14/S18, v0.4): one research project per opportunity,
-- enforced at the database level, not just an application-level check.
CREATE UNIQUE INDEX idx_research_projects_opportunity_id ON research_projects(opportunity_id);

CREATE TABLE sources (
  id TEXT PRIMARY KEY,
  research_project_id TEXT NOT NULL REFERENCES research_projects(id),
  url TEXT,
  source_type TEXT, -- e.g. news, official, academic, video (discovery-time hint)
  role TEXT CHECK (role IN ('primary_authoritative', 'independent_reporting', 'syndicated')),
  quality_tier TEXT CHECK (quality_tier IN ('HIGH', 'MEDIUM', 'LOW', 'UNUSABLE')),
  retrieval_status TEXT CHECK (retrieval_status IN ('SUCCESS', 'FAILED', 'CONTENT_UNPARSEABLE')),
  content TEXT, -- retrieved/extracted evidence snapshot at retrieved_at; not a live representation
  retrieved_at TEXT NOT NULL,
  notes TEXT
);

CREATE TABLE claims (
  id TEXT PRIMARY KEY,
  research_project_id TEXT NOT NULL REFERENCES research_projects(id),
  claim TEXT NOT NULL,
  source_id TEXT REFERENCES sources(id), -- DEPRECATED (v0.2 S5): unused by new Research code, kept for compatibility, never written by new logic
  claim_type TEXT NOT NULL CHECK (claim_type IN ('FACT', 'INFERENCE', 'OPINION')), -- semantic classification (R7/Option B)
  evidence_status TEXT NOT NULL DEFAULT 'UNSUPPORTED'
    CHECK (evidence_status IN ('VERIFIED', 'PARTIALLY_SUPPORTED', 'UNSUPPORTED', 'CONTESTED')), -- evidentiary status (R7/Option B)
  is_load_bearing INTEGER NOT NULL DEFAULT 0, -- current-state field the completeness check reads directly (v0.3 S1)
  confidence REAL,
  supporting_evidence TEXT,
  created_at TEXT NOT NULL
);

-- Evidence relationships (claim <-> source), distinct in purpose from
-- claim_relations (claim <-> claim). Uniqueness prevents a retry from
-- silently duplicating a corroborating relationship (v0.4).
CREATE TABLE claim_sources (
  id TEXT PRIMARY KEY,
  claim_id TEXT NOT NULL REFERENCES claims(id),
  source_id TEXT NOT NULL REFERENCES sources(id),
  role TEXT, -- e.g. 'primary', 'corroborating', 'contradicting'
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_claim_sources_unique ON claim_sources(claim_id, source_id, role);

-- Semantic relationships between claims (claim <-> claim). CONTRADICTS is
-- undirected; canonical ordering (smaller claim_id first, enforced at the
-- application layer) plus this UNIQUE index together prevent a mirrored
-- (A,B) + (B,A) duplicate pair (v0.4).
CREATE TABLE claim_relations (
  id TEXT PRIMARY KEY,
  claim_id TEXT NOT NULL REFERENCES claims(id),
  related_claim_id TEXT NOT NULL REFERENCES claims(id),
  relation_type TEXT NOT NULL CHECK (relation_type IN ('CONTRADICTS')),
  created_at TEXT NOT NULL,
  CHECK (claim_id <> related_claim_id),
  UNIQUE (claim_id, related_claim_id, relation_type)
);

-- decision_log.stage is unconstrained TEXT (0002_opportunity_discovery.sql),
-- allowed values enforced at the application layer only, consistent with
-- Discovery's existing stages. New Research-scoped stage values (additive,
-- no schema change needed): RESEARCH_PROJECT_CREATED, SOURCE_DISCOVERY,
-- SOURCE_ACQUISITION, SOURCE_CLASSIFICATION, CLAIM_EXTRACTION,
-- LOAD_BEARING_CLASSIFICATION, CLAIM_TYPE_RECLASSIFICATION,
-- EVIDENCE_GRADING, CONTRADICTION_CHECK, COMPLETENESS_CHECK.