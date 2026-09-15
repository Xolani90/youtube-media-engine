-- 0010_publication.sql
-- Publication v1: the smallest durable, provider-neutral record of a
-- publication attempt/result for an already-rendered `media_artifacts`
-- row.
--
-- Provider-neutral by design (see docs/architecture discussion in
-- src/publication/): this is NOT `youtube_publications`. `provider` is
-- a plain string column ('youtube' today; a future provider adds a new
-- value, not a new table). No YouTube-specific column exists here —
-- provider-specific identifiers (provider_item_id, provider_url) are
-- generic enough to hold any provider's confirmed reference.
--
-- One row per (content_version_id, provider) (UNIQUE below): a given
-- content_version has at most one publication record per provider,
-- mirroring the `productions`/`media_artifacts` one-row-per-subject
-- precedent, but scoped by provider so the same content_version can
-- later be published to more than one provider without schema change.
--
-- Unlike `productions`/`media_artifacts` (which only ever persist a
-- successful result), this table persists PENDING/FAILED/AMBIGUOUS rows
-- too — publication is an external side effect where the outcome is not
-- always immediately knowable (§11/§12 of the Publication v1 spec), so
-- the row itself is the durable idempotency/reconciliation record, not
-- just a success log. decision_log continues to record every decision
-- alongside this table, exactly as every prior stage does.
--
-- status:
--   PENDING   - an attempt has been claimed but no provider result is
--               confirmed yet (either "about to call the provider" or,
--               if found already in this state on a later run, "a prior
--               attempt was interrupted and its outcome is unknown" -
--               see src/publication/pipeline.js).
--   PUBLISHED - confirmed provider success. content_versions.state is
--               transitioned to PUBLISHED in the same local transaction
--               that sets this row to PUBLISHED.
--   FAILED    - confirmed, explicit provider failure (e.g. rejected
--               upload). Safe to retry (no external side effect
--               occurred). content_versions.state is left unchanged.
--   AMBIGUOUS - the provider result could not be confirmed one way or
--               the other (network/timeout, or an interrupted PENDING
--               attempt resumed later). Never auto-retried by the
--               pipeline; content_versions.state is left unchanged.
--
-- request_json / result_json store the exact provider-neutral request
-- and normalized provider result verbatim (same "store verbatim
-- alongside checksums" discipline as `productions.manifest_json` /
-- `media_artifacts.render_spec_json`), so an attempt can be inspected
-- or reconciled without re-deriving it from other tables.
--
-- No existing table is dropped or altered.

CREATE TABLE publications (
  id TEXT PRIMARY KEY,
  content_version_id TEXT NOT NULL REFERENCES content_versions(id),
  media_artifact_id TEXT NOT NULL REFERENCES media_artifacts(id),
  provider TEXT NOT NULL,               -- e.g. 'youtube'
  status TEXT NOT NULL CHECK (status IN ('PENDING', 'PUBLISHED', 'FAILED', 'AMBIGUOUS')),
  request_json TEXT NOT NULL,           -- the provider-neutral PublicationRequest, verbatim
  provider_item_id TEXT,                -- e.g. YouTube video id; set only on PUBLISHED
  provider_url TEXT,                    -- e.g. https://youtu.be/<id>; set only on PUBLISHED
  result_json TEXT,                     -- normalized provider result (success, failure, or ambiguous), verbatim
  failure_reason TEXT,                  -- set only on FAILED
  attempt_count INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX idx_publications_content_version_provider ON publications(content_version_id, provider);
CREATE INDEX idx_publications_media_artifact_id ON publications(media_artifact_id);
