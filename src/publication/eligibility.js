/**
 * Resolves the inputs Publication needs: the current Script/content
 * brief (same repository-established rule every prior stage uses
 * independently — `content_versions.script_id` is the sole
 * authoritative pointer), plus the already-shipped Media Production
 * artifact for that content_version. Deliberately re-implemented rather
 * than imported from media/eligibility.js or production/eligibility.js,
 * per the existing per-stage decoupling convention.
 *
 * Publication's structural precondition is stricter than Media
 * Production's: it requires an existing `media_artifacts` row (Media
 * Production must have already rendered and validated a real .mp4) in
 * addition to a resolvable Script/content_brief. It does NOT require
 * content_version.state === 'FINAL_COMPLIANCE' itself here (ADR-0032) — that is checked
 * separately by the pipeline, because a content_version already in
 * PUBLISHED state (a prior successful publish) is a structurally valid
 * input too and must be reported as ALREADY_PUBLISHED rather than a
 * structural failure.
 *
 * Short-form derivative production adds a second possible target
 * (`opts.target`): when `'SHORT_FORM'`, this also requires an existing
 * `short_form_media_artifacts` row for the content_version (see
 * ../media/pipeline.js#runShortFormProduction) and returns a
 * mediaArtifact-shaped object built from the LONG-FORM row (so its
 * `id`/`thumbnail_path` are unchanged — Publication's existing
 * thumbnail-reuse and media_artifact_id FK conventions keep working
 * unmodified) with `artifact_path`/`artifact_checksum`/`duration_seconds`/
 * `width`/`height`/`video_codec`/`audio_codec` overridden from the
 * short-form row — the exact fields buildPublicationRequest() and the
 * provider adapter read to decide WHAT file gets uploaded. No schema
 * change to `publications` or `media_artifacts` was needed for this.
 *
 * @param {import('../storage/StorageDriver.js').StorageDriver} storage
 * @param {string} contentBriefId
 * @param {object} [opts]
 * @param {'LONGFORM'|'SHORT_FORM'} [opts.target] - defaults to 'LONGFORM'
 * @returns {{eligible: boolean, reason?: string, contentVersion?: object, script?: object, contentBrief?: object, mediaArtifact?: object}}
 */
export function resolveMediaForPublication(storage, contentBriefId, { target = 'LONGFORM' } = {}) {
  const contentVersion = storage.get(
    'SELECT * FROM content_versions WHERE content_brief_id = ?',
    [contentBriefId]
  );
  if (!contentVersion) {
    return { eligible: false, reason: 'CONTENT_VERSION_NOT_FOUND' };
  }
  if (!contentVersion.script_id) {
    return { eligible: false, reason: 'NO_CURRENT_SCRIPT', contentVersion };
  }
  const script = storage.get('SELECT * FROM scripts WHERE id = ?', [contentVersion.script_id]);
  if (!script) {
    return { eligible: false, reason: 'CURRENT_SCRIPT_NOT_FOUND', contentVersion };
  }
  const contentBrief = storage.get('SELECT * FROM content_briefs WHERE id = ?', [script.content_brief_id]);
  if (!contentBrief) {
    return { eligible: false, reason: 'CONTENT_BRIEF_NOT_FOUND', contentVersion, script };
  }
  const mediaArtifact = storage.get(
    'SELECT * FROM media_artifacts WHERE content_version_id = ?',
    [contentVersion.id]
  );
  if (!mediaArtifact) {
    return { eligible: false, reason: 'NOT_YET_RENDERED', contentVersion, script, contentBrief };
  }

  if (target !== 'SHORT_FORM') {
    return { eligible: true, contentVersion, script, contentBrief, mediaArtifact };
  }

  const shortFormArtifact = storage.get(
    'SELECT * FROM short_form_media_artifacts WHERE content_version_id = ?',
    [contentVersion.id]
  );
  if (!shortFormArtifact) {
    // Same NOT_YET_RENDERED vocabulary as the long-form case above --
    // runPublication() maps this reason to OUTCOME.NOT_YET_RENDERED
    // either way, so a caller cannot tell "no long-form artifact" from
    // "no short-form derivative yet" purely from the outcome, only from
    // this reason string plus which target it requested.
    return { eligible: false, reason: 'NOT_YET_RENDERED', contentVersion, script, contentBrief };
  }

  const shortFormMediaArtifact = {
    ...mediaArtifact,
    artifact_path: shortFormArtifact.artifact_path,
    artifact_checksum: shortFormArtifact.artifact_checksum,
    duration_seconds: shortFormArtifact.duration_seconds,
    width: shortFormArtifact.width,
    height: shortFormArtifact.height,
    video_codec: shortFormArtifact.video_codec,
    audio_codec: shortFormArtifact.audio_codec
  };
  return { eligible: true, contentVersion, script, contentBrief, mediaArtifact: shortFormMediaArtifact };
}