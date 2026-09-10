-- 0001_init.sql
-- Foundational schema for M0. Tables beyond the M0-active pipeline
-- (production_jobs, publication_jobs, performance_metrics, learning_events)
-- are created now so the schema does not need breaking changes later,
-- but application logic for them is NOT implemented in M0.

CREATE TABLE IF NOT EXISTS system_runs (
  id TEXT PRIMARY KEY,
  mode TEXT NOT NULL CHECK (mode IN ('SIMULATION', 'LIVE')),
  autonomous_enabled INTEGER NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL DEFAULT 'RUNNING', -- RUNNING | COMPLETED | FAILED | STOPPED
  stop_reason TEXT,
  config_snapshot TEXT NOT NULL -- JSON snapshot of relevant config at run time (auditability)
);

CREATE TABLE IF NOT EXISTS opportunities (
  id TEXT PRIMARY KEY,
  run_id TEXT REFERENCES system_runs(id),
  title TEXT NOT NULL,
  description TEXT,
  source TEXT NOT NULL,
  source_url TEXT,
  discovered_at TEXT NOT NULL,
  category TEXT,
  keywords TEXT, -- JSON array
  audience TEXT,
  commercial_intent TEXT,
  novelty REAL,
  competition REAL,
  story_potential REAL,
  evidence_availability REAL,
  production_difficulty REAL,
  monetization_potential REAL,
  policy_risk REAL,
  copyright_risk REAL,
  repetition_risk REAL,
  overall_score REAL,
  score_breakdown TEXT, -- JSON, see scoring model
  status TEXT NOT NULL DEFAULT 'DISCOVERED'
);

CREATE TABLE IF NOT EXISTS research_projects (
  id TEXT PRIMARY KEY,
  opportunity_id TEXT NOT NULL REFERENCES opportunities(id),
  run_id TEXT REFERENCES system_runs(id),
  status TEXT NOT NULL DEFAULT 'RESEARCHING',
  created_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS sources (
  id TEXT PRIMARY KEY,
  research_project_id TEXT NOT NULL REFERENCES research_projects(id),
  url TEXT,
  source_type TEXT, -- e.g. news, official, academic, video
  retrieved_at TEXT NOT NULL,
  notes TEXT
);

CREATE TABLE IF NOT EXISTS claims (
  id TEXT PRIMARY KEY,
  research_project_id TEXT NOT NULL REFERENCES research_projects(id),
  claim TEXT NOT NULL,
  source_id TEXT REFERENCES sources(id),
  claim_type TEXT NOT NULL CHECK (claim_type IN ('verified_fact', 'inference', 'opinion', 'unresolved')),
  confidence REAL,
  supporting_evidence TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS content_briefs (
  id TEXT PRIMARY KEY,
  opportunity_id TEXT NOT NULL REFERENCES opportunities(id),
  research_project_id TEXT REFERENCES research_projects(id),
  working_title TEXT,
  core_question TEXT,
  target_audience TEXT,
  viewer_promise TEXT,
  hook TEXT,
  angle TEXT,
  narrative_structure TEXT,
  key_claims TEXT, -- JSON array of claim ids
  counterpoints TEXT,
  original_insights TEXT,
  visual_ideas TEXT,
  monetization_opportunities TEXT,
  risk_assessment TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS scripts (
  id TEXT PRIMARY KEY,
  content_brief_id TEXT NOT NULL REFERENCES content_briefs(id),
  version INTEGER NOT NULL DEFAULT 1,
  body TEXT NOT NULL,
  claim_links TEXT, -- JSON: paragraph -> claim id mapping (audit trail)
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS content_versions (
  id TEXT PRIMARY KEY,
  content_brief_id TEXT NOT NULL REFERENCES content_briefs(id),
  script_id TEXT REFERENCES scripts(id),
  state TEXT NOT NULL DEFAULT 'DISCOVERED',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS risk_assessments (
  id TEXT PRIMARY KEY,
  content_version_id TEXT NOT NULL REFERENCES content_versions(id),
  flags TEXT, -- JSON array, e.g. FACTUAL_UNCERTAINTY, COPYRIGHT_RISK
  status TEXT NOT NULL CHECK (status IN ('PASS', 'REVIEW', 'REJECT')),
  notes TEXT,
  created_at TEXT NOT NULL
);

-- production_jobs, publication_jobs, performance_metrics, and learning_events
-- were intentionally removed (Phase 1.5 correction) — they belong to the
-- Autonomous Media Production phase, which is out of scope for M0. They
-- will be introduced in a later migration once that phase is specified.

-- Cost tracking: identical accounting whether cost is 0 (free tier) or paid.
CREATE TABLE IF NOT EXISTS provider_calls (
  id TEXT PRIMARY KEY,
  run_id TEXT REFERENCES system_runs(id),
  content_id TEXT,
  job_stage TEXT,
  provider TEXT NOT NULL,
  model TEXT,
  request_id TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  estimated_cost REAL NOT NULL DEFAULT 0,
  actual_cost REAL,
  is_paid INTEGER NOT NULL DEFAULT 0,
  timestamp TEXT NOT NULL
);

-- Auditability: what the system saw, decided, and why.
CREATE TABLE IF NOT EXISTS decision_log (
  id TEXT PRIMARY KEY,
  run_id TEXT REFERENCES system_runs(id),
  subject_type TEXT NOT NULL, -- e.g. opportunity, content_version
  subject_id TEXT NOT NULL,
  decision TEXT NOT NULL,
  reason TEXT NOT NULL,
  provider TEXT,
  config_snapshot TEXT,
  confidence REAL,
  risk_level TEXT,
  resulting_state TEXT,
  created_at TEXT NOT NULL
);
