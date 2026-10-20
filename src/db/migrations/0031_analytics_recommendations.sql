-- 0031_analytics_recommendations.sql
-- Pending, human-reviewed analytics findings. Purely additive: one new table,
-- no ALTER on any existing table. Rows are generated from analytics_snapshots
-- (read-only) by src/analytics/recommendations.js and stay PENDING until an
-- operator explicitly approves or rejects them. Nothing in the engine reads
-- this table to drive discovery, briefs, scripts, production or publication;
-- approval changes only this row.
CREATE TABLE analytics_recommendations (
  id TEXT PRIMARY KEY,
  fingerprint TEXT NOT NULL,            -- sha256 of (provider, provider_item_id, window_kind, metric, direction); makes generation idempotent
  publication_id TEXT NOT NULL REFERENCES publications(id),
  provider TEXT NOT NULL,
  provider_item_id TEXT NOT NULL,
  window_kind TEXT NOT NULL CHECK (window_kind IN ('24H', '7D')),
  metric TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('ABOVE_BASELINE', 'BELOW_BASELINE')),
  subject_value REAL NOT NULL,
  baseline_median REAL NOT NULL,
  baseline_count INTEGER NOT NULL,
  relative_difference REAL NOT NULL,
  summary TEXT NOT NULL,
  evidence_json TEXT NOT NULL,          -- snapshot ids/periods used, verbatim, for audit
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED')),
  decided_at TEXT,
  decision_note TEXT,
  created_at TEXT NOT NULL
);

CREATE UNIQUE INDEX idx_analytics_recommendations_fingerprint ON analytics_recommendations(fingerprint);
CREATE INDEX idx_analytics_recommendations_status ON analytics_recommendations(status);
