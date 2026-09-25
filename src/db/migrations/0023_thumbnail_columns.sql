-- 0023_thumbnail_columns.sql
-- Phase 2B: thumbnail generation + YouTube thumbnail upload.
--
-- Purely additive: four nullable/defaulted columns across two existing
-- tables, no rebuild, no DROP, no data migration. No existing row is
-- affected and every existing query (SELECT * included) keeps working
-- unchanged, since no column is renamed, retyped or removed.
--
-- media_artifacts (0009_media_artifacts.sql) is already the existing
-- artifact/provenance boundary for a content_version's rendered .mp4 —
-- thumbnail_path/thumbnail_checksum extend it with the same
-- "local filesystem path + sha256 of the actual bytes" discipline
-- already used for artifact_path/artifact_checksum, rather than
-- introducing a parallel artifact table. NULL means "no thumbnail
-- generated yet" (e.g. rows rendered before this migration, or a
-- content_version whose thumbnail generation failed and was skipped as
-- best-effort — see src/publication/pipeline.js).
ALTER TABLE media_artifacts ADD COLUMN thumbnail_path TEXT;
ALTER TABLE media_artifacts ADD COLUMN thumbnail_checksum TEXT;

-- publications (0010_publication.sql) is already the durable
-- attempt/result record for a (content_version, provider) publish
-- action. Video-upload success/failure/ambiguity is tracked by the
-- existing `status`/`result_json`/`failure_reason` columns; the four
-- columns below track the THUMBNAIL upload as a second, independently
-- observable external step against the SAME row, deliberately never a
-- second `publications` row and never a reinterpretation of `status`
-- (video and thumbnail are separate provider calls with separate
-- outcomes — see runPublication's attemptThumbnailUpload). This is what
-- lets a thumbnail retry find "video already PUBLISHED, thumbnail not
-- yet SUCCESS" without ever re-claiming or re-uploading the video.
--
-- thumbnail_status mirrors PUBLICATION_STATUS's vocabulary at the
-- thumbnail level (NULL = never attempted, PENDING = claimed but no
-- confirmed provider result yet, SUCCESS = confirmed, FAILED = confirmed
-- explicit rejection (safe to retry), AMBIGUOUS = unconfirmed (never
-- auto-retried, mirrors the video AMBIGUOUS precedent)). Enforced at the
-- application layer only, consistent with how every other
-- controlled-value column added by an ALTER TABLE in this schema is
-- handled (e.g. decision_log.stage, 0002_opportunity_discovery.sql) —
-- SQLite cannot add a CHECK constraint to an existing table via ALTER.
ALTER TABLE publications ADD COLUMN thumbnail_status TEXT;
ALTER TABLE publications ADD COLUMN thumbnail_result_json TEXT;
ALTER TABLE publications ADD COLUMN thumbnail_attempt_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE publications ADD COLUMN thumbnail_updated_at TEXT;