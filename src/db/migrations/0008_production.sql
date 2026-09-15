-- 0008_production.sql
-- Production MVP: the smallest local production record required to take a
-- content_version legally at PRODUCTION_READY and turn it into a real,
-- inspectable, deterministic production artifact (Owner Production MVP
-- brief).
--
-- Dedicated table: `productions` is entirely separate from `fact_checks`,
-- `originality_checks`, and `assets`/`asset_usages`. None of those tables
-- are altered by this migration, and Production does not duplicate their
-- data — it references content_version_id/script_id and, for assets,
-- reads D-G2's existing asset_usages/assets tables directly at production
-- time rather than copying them into a parallel representation here.
--
-- One row per content_version (UNIQUE below): PRODUCTION_READY -> PRODUCED
-- is a single forward, non-repeatable transition in ContentStateMachine,
-- so "the production record for this content_version" has exactly one
-- authoritative answer, mirroring the (script_id, version) uniqueness
-- precedent in 0005_fact_check_subsystem.sql. A failed production attempt
-- inserts NO row here (mirrors the fact-check/originality/quality-gate
-- structural-failure convention: only a successful, inspectable result is
-- persisted; failures are recorded via decision_log alone).
--
-- The manifest is stored BOTH on the local filesystem (the real,
-- inspectable artifact — artifact_path) and, as its exact JSON text, in
-- this table (manifest_json) so the persisted DB record alone is enough
-- to verify/reproduce artifact_checksum without touching the filesystem.
--
-- No existing table is dropped or altered.

CREATE TABLE productions (
  id TEXT PRIMARY KEY,
  content_version_id TEXT NOT NULL REFERENCES content_versions(id),
  script_id TEXT NOT NULL REFERENCES scripts(id),
  artifact_type TEXT NOT NULL,       -- e.g. 'production_manifest_v1'
  artifact_path TEXT NOT NULL,       -- local filesystem location of the artifact
  artifact_checksum TEXT NOT NULL,   -- sha256 of the canonical manifest JSON
  manifest_json TEXT NOT NULL,       -- the exact manifest content, verbatim
  created_at TEXT NOT NULL
);

CREATE UNIQUE INDEX idx_productions_content_version_id ON productions(content_version_id);