-- 0032_publisher_feed_items.sql
-- Phase 1 publisher RSS metadata isolation (Owner-approved 2026-10-31).
-- Additive only: one new table and one index. No existing table is read,
-- altered, rebuilt or referenced (deliberately NO foreign keys), so no
-- FK_TOGGLE_MIGRATIONS entry is needed and `sources`, `claims` and
-- `claim_sources` are untouched.
--
-- Every row is NON-EVIDENTIARY publisher metadata that annotates one blocked
-- (FAILED) source row for audit reporting. It is never evidence: the CHECK
-- constraints below make a row that claims otherwise unrepresentable.
-- IF NOT EXISTS keeps this idempotent so the annotate script's explicit
-- --apply-migration path and the normal runner can both execute it safely.
CREATE TABLE IF NOT EXISTS publisher_feed_items (
  id TEXT PRIMARY KEY,
  feed_url TEXT NOT NULL,
  item_key TEXT NOT NULL,                -- stable dedup key: feed guid, else normalized item link
  item_guid TEXT,
  item_link TEXT NOT NULL,
  item_url_normalized TEXT NOT NULL,
  title TEXT,
  summary_text TEXT,
  summary_sha256 TEXT,
  published_at_feed TEXT,                -- exactly as the feed reported it
  feed_fetched_at TEXT NOT NULL,
  annotated_at TEXT NOT NULL,
  blocked_source_id TEXT NOT NULL,       -- plain id, no FK
  blocked_source_url TEXT NOT NULL,      -- original publisher URL, unmodified
  research_project_id TEXT,
  blocked_retrieval_status TEXT NOT NULL,
  blocked_retrieval_method TEXT,
  blocked_error_text TEXT,               -- original retrieval error text, unmodified
  blocked_http_status INTEGER,
  failure_class TEXT NOT NULL CHECK (failure_class IN (
    'host_access_denied', 'host_rate_limited', 'host_http_error', 'internal_retrieval_failure')),
  origin TEXT NOT NULL DEFAULT 'rss_feed_metadata' CHECK (origin = 'rss_feed_metadata'),
  evidentiary INTEGER NOT NULL DEFAULT 0 CHECK (evidentiary = 0),
  UNIQUE (feed_url, item_key, blocked_source_id)
);
CREATE INDEX IF NOT EXISTS idx_publisher_feed_items_blocked_source ON publisher_feed_items(blocked_source_id);
