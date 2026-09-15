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
 * content_version.state === 'PRODUCED' itself here — that is checked
 * separately by the pipeline, because a content_version already in
 * PUBLISHED state (a prior successful publish) is a structurally valid
 * input too and must be reported as ALREADY_PUBLISHED rather than a
 * structural failure.
 *
 * @param {import('../storage/StorageDriver.js').StorageDriver} storage
 * @param {string} contentBriefId
 * @returns {{eligible: boolean, reason?: string, contentVersion?: object, script?: object, contentBrief?: object, mediaArtifact?: object}}
 */
export function resolveMediaForPublication(storage, contentBriefId) {
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
  return { eligible: true, contentVersion, script, contentBrief, mediaArtifact };
}
