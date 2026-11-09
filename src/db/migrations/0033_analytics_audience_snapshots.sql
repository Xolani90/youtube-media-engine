-- 0033_analytics_audience_snapshots.sql
-- Audience-retention curves and traffic-source breakdowns per publication and
-- EXACT period. Purely additive: one new table, no ALTER on any existing table.
--
-- Kept beside analytics_snapshots (0024), not inside it: those rows hold one
-- scalar-metrics report per (publication, period); a retention curve and a
-- traffic breakdown are different report shapes with their own failure modes
-- (e.g. retention is withheld for low-volume videos), so each (publication,
-- kind, period) gets its own row and outcome.
--
-- `status` carries the same six-way outcome vocabulary as analytics_snapshots.
-- UNAVAILABLE means YouTube returned no usable data -- it is NOT zero
-- performance and `summary_json` is NULL for every non-SUCCESS row. Nothing
-- here is ever filled with a default; absent values stay absent/null inside
-- summary_json and result_json.
--
-- summary_json: the small comparable summary recommendations read.
--   RETENTION:       { at10, at25, at50, at75, steepestDrop, pointCount }
--   TRAFFIC_SOURCES: { totalViews, totalViewsComplete, zeroViews, shares: { SOURCE: fraction|null } }
-- result_json: the adapter's normalized result verbatim (curve points / source rows).
CREATE TABLE analytics_audience_snapshots (
  id TEXT PRIMARY KEY,
  publication_id TEXT NOT NULL REFERENCES publications(id),
  provider TEXT NOT NULL,
  provider_item_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('RETENTION', 'TRAFFIC_SOURCES')),
  period_start TEXT NOT NULL,          -- UTC date (YYYY-MM-DD), inclusive
  period_end TEXT NOT NULL,            -- UTC date (YYYY-MM-DD), inclusive
  collected_at TEXT NOT NULL,          -- UTC ISO-8601 timestamp of this collection attempt
  status TEXT NOT NULL CHECK (status IN ('SUCCESS', 'UNAVAILABLE', 'AUTH_FAILURE', 'RATE_LIMITED', 'TRANSIENT_FAILURE', 'PERMANENT_FAILURE')),
  failure_reason TEXT,                 -- set only when status != 'SUCCESS'
  summary_json TEXT,                   -- NULL unless status = 'SUCCESS'
  result_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- At most one row per (publication, kind, exact period); re-collection upserts it.
CREATE UNIQUE INDEX idx_analytics_audience_snapshots_key ON analytics_audience_snapshots(publication_id, kind, period_start, period_end);
CREATE INDEX idx_analytics_audience_snapshots_publication_id ON analytics_audience_snapshots(publication_id);
