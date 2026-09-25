-- 0024_analytics_snapshots.sql
-- Phase 3: durable YouTube Analytics collection.
--
-- Purely additive: one new table, no ALTER on any existing table, no
-- DROP, no data migration. No existing row is affected.
--
-- `publications` (0010_publication.sql) is already the durable record
-- of a confirmed external publication and already carries the
-- provider-confirmed identity (`provider`, `provider_item_id`) that
-- analytics must attach to. This table extends that identity with
-- observational, timestamped performance snapshots rather than
-- creating a parallel content/video identity system -- exactly the
-- same "extend, don't duplicate" discipline 0023 used for
-- media_artifacts. It is provider-neutral in shape (a plain `provider`
-- column, like `publications` itself), even though Phase 3 only
-- populates it from YouTube: a second provider later adds rows, not a
-- new table.
--
-- One publication can have MANY analytics_snapshots rows over time
-- (one per collected period) -- collection never overwrites or deletes
-- a prior period's snapshot, so historical performance trends remain
-- observable. Idempotency is scoped to a single (publication_id,
-- period_start, period_end) triple: re-collecting the EXACT same
-- period upserts that one row (see src/analytics/collector.js) rather
-- than accumulating duplicate rows for the same period, while
-- collecting a different period (e.g. the next day's "lifetime to
-- date" snapshot) always creates a new row. This is a deliberate
-- period-keyed-upsert model, not snapshot-per-collection-call.
--
-- period_start/period_end/collected_at are UTC ISO-8601 strings
-- (period_start/period_end are date-only, matching the YouTube
-- Analytics API's startDate/endDate query parameters; collected_at is
-- a full timestamp), mirroring every other table's existing TEXT
-- timestamp convention in this schema.
--
-- Every metric column is NULLABLE and stores NULL, never 0, when
-- YouTube did not return that metric for the queried period/video --
-- see src/analytics/youtube/YouTubeAnalyticsAdapter.js's normalization,
-- which only ever copies a value YouTube actually returned. NULL means
-- "not reported"; 0 means "reported as zero". This distinction is
-- load-bearing (Phase 3 spec §7/§8) and is never collapsed by this
-- schema or by the collector.
--
-- `status` records the OUTCOME of the collection attempt for this row
-- (mirrors the existing outcome-vs-persisted-state split used
-- elsewhere in this schema), independently of whether any metric
-- values are present -- e.g. a row can be `SUCCESS` with some metrics
-- NULL (YouTube simply didn't report them) without that meaning the
-- collection attempt itself failed. `result_json` stores the adapter's
-- full normalized result verbatim (same "store verbatim" discipline as
-- publications.result_json), so a collection attempt can be inspected
-- or reconciled without re-deriving it.
--
-- This migration never touches `publications`, D-C2, state machine, or
-- any existing table -- analytics collection is read-only against
-- YouTube and purely additive against this database (Phase 3 spec
-- §13/§23).
CREATE TABLE analytics_snapshots (
  id TEXT PRIMARY KEY,
  publication_id TEXT NOT NULL REFERENCES publications(id),
  provider TEXT NOT NULL,              -- e.g. 'youtube', mirrors publications.provider
  provider_item_id TEXT NOT NULL,      -- e.g. YouTube video id, copied verbatim from the publications row at collection time
  period_start TEXT NOT NULL,          -- UTC date (YYYY-MM-DD), inclusive
  period_end TEXT NOT NULL,            -- UTC date (YYYY-MM-DD), inclusive
  collected_at TEXT NOT NULL,          -- UTC ISO-8601 timestamp of this collection attempt

  -- Core performance metrics (Phase 3 spec §7). NULL = not reported by
  -- YouTube for this period/video; a genuine zero is stored as 0, never
  -- conflated with NULL.
  views INTEGER,
  likes INTEGER,
  comments INTEGER,
  shares INTEGER,
  estimated_watch_time_minutes REAL,
  average_view_duration_seconds REAL,
  average_view_percentage REAL,
  impressions INTEGER,
  impressions_ctr REAL,

  -- Collection outcome (Phase 3 spec §12). Enforced at the application
  -- layer only, consistent with every other controlled-value column
  -- added by an ALTER/CREATE in this schema (SQLite CHECK constraints
  -- are only meaningfully enforced at table-creation time here, and
  -- this repository's convention -- see 0023's own note -- is to still
  -- document rather than rely on CHECK for evolving vocabularies).
  status TEXT NOT NULL CHECK (status IN ('SUCCESS', 'UNAVAILABLE', 'AUTH_FAILURE', 'RATE_LIMITED', 'TRANSIENT_FAILURE', 'PERMANENT_FAILURE')),
  failure_reason TEXT,                 -- set only when status != 'SUCCESS'
  result_json TEXT NOT NULL,           -- normalized adapter result, verbatim

  created_at TEXT NOT NULL
);

-- Idempotency key (Phase 3 spec §16): at most one row per
-- (publication, exact period). A repeated collection of the identical
-- period upserts this row; a different period always inserts a new
-- one, preserving history.
CREATE UNIQUE INDEX idx_analytics_snapshots_publication_period ON analytics_snapshots(publication_id, period_start, period_end);
CREATE INDEX idx_analytics_snapshots_publication_id ON analytics_snapshots(publication_id);