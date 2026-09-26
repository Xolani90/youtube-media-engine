-- 0025_short_form_media_artifacts.sql
-- Short-form derivative production: the smallest local record of a
-- vertical (1080x1920) derivative render produced FROM an existing,
-- already-rendered `media_artifacts` (long-form, 1280x720) row.
--
-- Deliberately a SEPARATE table, not a second row shoehorned into
-- `media_artifacts` -- that table's UNIQUE(content_version_id) index
-- (0009_media_artifacts.sql) is a load-bearing invariant several
-- existing queries rely on ("one media_artifacts row per
-- content_version_id"); widening it would touch every existing
-- long-form call site for no benefit. Instead this mirrors
-- `media_artifacts` exactly in shape and discipline (own tmp+rename
-- artifact convention, own sha256 checksum, own render_spec_json
-- verbatim + checksum) and stores one extra fact long-form doesn't
-- need: which bounded sub-segment of the source narration this
-- derivative covers.
--
-- media_artifact_id is the source long-form artifact this was derived
-- from (provenance) -- never re-derives narration/visual timing itself,
-- only reads the source's already-computed render_spec_json.
--
-- One row per content_version (UNIQUE below), matching the
-- `media_artifacts`/`productions` one-row-per-subject precedent: a
-- content_version has at most one short-form derivative in this first
-- implementation. Re-deriving would return the existing row unchanged
-- (see src/media/pipeline.js#runShortFormProduction), exactly like
-- long-form's own idempotency discipline.
--
-- No existing table is dropped, altered, or has its UNIQUE index
-- touched by this migration.

CREATE TABLE short_form_media_artifacts (
  id TEXT PRIMARY KEY,
  media_artifact_id TEXT NOT NULL REFERENCES media_artifacts(id),
  content_version_id TEXT NOT NULL REFERENCES content_versions(id),
  segment_start_seconds REAL NOT NULL,  -- offset into the source narration this derivative starts at (v1: always 0)
  segment_end_seconds REAL NOT NULL,    -- offset into the source narration this derivative ends at
  render_spec_json TEXT NOT NULL,       -- the exact short-form render_spec content, verbatim (1080x1920)
  render_spec_checksum TEXT NOT NULL,   -- sha256 of the canonical render_spec JSON
  artifact_path TEXT NOT NULL,          -- local filesystem location of the rendered short-form .mp4
  artifact_checksum TEXT NOT NULL,      -- sha256 of the rendered .mp4 file bytes
  duration_seconds REAL NOT NULL,       -- FFprobe-measured duration of the final artifact
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  video_codec TEXT NOT NULL,
  audio_codec TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE UNIQUE INDEX idx_short_form_media_artifacts_content_version_id ON short_form_media_artifacts(content_version_id);
CREATE INDEX idx_short_form_media_artifacts_media_artifact_id ON short_form_media_artifacts(media_artifact_id);