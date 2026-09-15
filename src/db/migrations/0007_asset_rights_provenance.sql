-- 0007_asset_rights_provenance.sql
-- D-G2: asset-level rights/provenance foundation (ADR-0008 §5 — D-G2 is
-- eligible for its own separate implementation authorization once D-C2
-- is ratified; this migration is that separately authorized D-G2 work,
-- not part of D-C2 itself).
--
-- Two new tables, kept deliberately separate per the required boundary:
--
--   assets        — an individual media asset's identity plus the
--                    provenance/rights information that belongs to THAT
--                    ASSET (not to any particular piece of content it may
--                    later be used in).
--   asset_usages  — the explicit, separate relationship recording that a
--                    given asset is used by a given content_version.
--                    Many-to-many: one asset may be reused across several
--                    content_versions, and one content_version may use
--                    several assets. This relationship is NOT encoded by
--                    putting content information inside `assets` rows.
--
-- This is unrelated to `sources` (0001_init.sql), which records research
-- provenance (source -> research/content) and is not touched or extended
-- by this migration.
--
-- No existing table is dropped or altered.

CREATE TABLE assets (
  id TEXT PRIMARY KEY,
  asset_type TEXT NOT NULL,   -- e.g. image, video_clip, audio, music, voice, generated
  location TEXT NOT NULL,     -- where the asset actually lives (path/URI/storage key)
  checksum TEXT,               -- content hash, where computable
  origin TEXT,                 -- where/how the asset was obtained (provider, stock library, generated, etc.)
  license TEXT,                 -- rights/license descriptor (e.g. CC-BY-4.0, proprietary, generated-no-license)
  attribution_required INTEGER NOT NULL DEFAULT 0,
  attribution_text TEXT,
  usage_restrictions TEXT,      -- free text / JSON describing constraints on use
  provenance_notes TEXT,
  verification_status TEXT NOT NULL DEFAULT 'UNVERIFIED'
    CHECK (verification_status IN ('UNVERIFIED', 'VERIFIED', 'DISPUTED')),
  imported_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE asset_usages (
  id TEXT PRIMARY KEY,
  asset_id TEXT NOT NULL REFERENCES assets(id),
  content_version_id TEXT NOT NULL REFERENCES content_versions(id),
  usage_context TEXT,   -- free text, e.g. "thumbnail", "b-roll 00:12-00:18"
  created_at TEXT NOT NULL
);

CREATE INDEX idx_asset_usages_asset_id ON asset_usages(asset_id);
CREATE INDEX idx_asset_usages_content_version_id ON asset_usages(content_version_id);
