-- 0009_media_artifacts.sql
-- Real Media Production v1: the smallest local record of an actual
-- rendered, validated .mp4 produced from an existing Production MVP
-- `productions` row.
--
-- Mirrors `productions` (0008_production.sql) exactly in shape and
-- discipline: a dedicated table, entirely separate from `productions`,
-- `assets`/`asset_usages`, and `content_versions`. None of those tables
-- are altered by this migration. Media Production does not duplicate
-- their data — it references `production_id` / `content_version_id` and
-- reads D-G2's assets directly at render time, exactly as Production MVP
-- already does.
--
-- One row per production (UNIQUE below): re-rendering an
-- already-rendered production returns the existing row unchanged,
-- mirroring the `productions` UNIQUE(content_version_id) precedent. A
-- failed render (narration failure, FFmpeg failure, FFprobe validation
-- failure) inserts NO row here — only a successful, inspectable,
-- validated artifact is persisted, matching Production MVP's own
-- "failures are recorded via decision_log alone" convention.
--
-- The render specification (render_spec_json) that produced this
-- artifact is stored verbatim alongside its own checksum, exactly as
-- `productions.manifest_json` stores the production manifest verbatim —
-- so the exact render inputs can be reconstructed/verified without
-- touching the filesystem.
--
-- No existing table is dropped or altered.

CREATE TABLE media_artifacts (
  id TEXT PRIMARY KEY,
  production_id TEXT NOT NULL REFERENCES productions(id),
  content_version_id TEXT NOT NULL REFERENCES content_versions(id),
  render_spec_json TEXT NOT NULL,       -- the exact render_spec content, verbatim
  render_spec_checksum TEXT NOT NULL,   -- sha256 of the canonical render_spec JSON
  narration_path TEXT NOT NULL,         -- local filesystem location of the narration audio
  narration_duration_seconds REAL NOT NULL,
  artifact_path TEXT NOT NULL,          -- local filesystem location of the rendered .mp4
  artifact_checksum TEXT NOT NULL,      -- sha256 of the rendered .mp4 file bytes
  duration_seconds REAL NOT NULL,       -- FFprobe-measured duration of the final artifact
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  video_codec TEXT NOT NULL,            -- FFprobe-reported codec name, e.g. 'h264'
  audio_codec TEXT NOT NULL,            -- FFprobe-reported codec name, e.g. 'aac'
  created_at TEXT NOT NULL
);

CREATE UNIQUE INDEX idx_media_artifacts_content_version_id ON media_artifacts(content_version_id);
CREATE INDEX idx_media_artifacts_production_id ON media_artifacts(production_id);