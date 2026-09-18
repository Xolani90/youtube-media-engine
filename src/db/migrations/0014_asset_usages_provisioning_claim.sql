-- 0014_asset_usages_provisioning_claim.sql
-- F5-01 (Owner-authorized disposition: OPTION A -- enforce the narrow
-- invariant; Candidate A -- dedicated identity column, not a reuse of
-- usage_context). Full disposition trail: F5 Failure/Recovery/Idempotency
-- Audit -> F5-01 finding -> F5-01 Owner disposition (Option A) -> F5-01
-- identity audit (usage_context determined SHARED, not exclusive) ->
-- F5-01 Mechanism 2 design -> this Owner-authorized implementation.
--
-- Problem: src/asset-provisioning/pipeline.js's own check-then-act
-- idempotency guard (an application-level read of existing visual assets,
-- followed by an awaited external provider call, followed by a DB insert)
-- has no database-level backstop. Two concurrent runner invocations for
-- the same content_version could each pass the pre-call check and each
-- persist a distinct automated-provisioning asset_usages row.
--
-- Non-solution rejected by the F5-01 identity audit: constraining
-- usage_context = 'b-roll' directly. usage_context is documented,
-- free-text, descriptive metadata (0007_asset_rights_provenance.sql:
-- "free text, e.g. \"thumbnail\", \"b-roll 00:12-00:18\"") with no
-- controlled vocabulary, and multiple existing test fixtures already
-- write the literal 'b-roll' independently of the provisioning stage.
-- Treating it as an exclusive identity would silently narrow a field
-- every other part of this codebase still treats as open text.
--
-- Solution: a new, dedicated, nullable column that ONLY the automated
-- asset-provisioning path ever populates. Every existing row (and every
-- other current or future writer of asset_usages -- manual attachment,
-- test fixtures, thumbnails, future usage roles) leaves this column
-- NULL. usage_context itself is untouched: no rewrite, no new
-- constraint, no vocabulary change.
--
-- This is a purely additive change: ADD COLUMN (nullable, no default
-- needed beyond SQLite's implicit NULL) plus a partial UNIQUE index.
-- Neither operation requires a table rebuild in SQLite (unlike
-- 0012/0013, which added CHECK constraints / removed columns and so
-- needed the preserve-and-rebuild + FK-toggle mechanism in
-- SqliteStorageDriver.js's FK_TOGGLE_MIGRATIONS -- this migration needs
-- neither). No existing table is dropped, no existing row is rewritten,
-- and no existing migration (0001-0013) is modified.
--
-- The partial UNIQUE index enforces: at most one asset_usages row per
-- content_version_id where provisioning_claim IS NOT NULL. It says
-- nothing about content_version_id, usage_context, or any other column
-- in general -- the existing many-to-many asset model (one
-- content_version may use several assets; one asset may be reused
-- across several content_versions) remains fully intact, as does every
-- other legitimate usage_context value (thumbnail, manual b-roll,
-- future roles).

ALTER TABLE asset_usages ADD COLUMN provisioning_claim TEXT;

CREATE UNIQUE INDEX idx_asset_usages_provisioning_claim
  ON asset_usages(content_version_id)
  WHERE provisioning_claim IS NOT NULL;