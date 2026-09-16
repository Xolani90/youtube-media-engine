/**
 * Resolves the inputs Asset Provisioning needs: the current Script/
 * content_brief (same repository-established rule every prior stage uses
 * independently -- `content_versions.script_id` is the sole authoritative
 * pointer), plus the already-shipped Production record for that
 * content_version. Deliberately re-implemented rather than imported from
 * production/eligibility.js or media/eligibility.js, per the existing
 * per-stage decoupling convention.
 *
 * Asset Provisioning's structural precondition mirrors Media Production's:
 * it requires an existing `productions` row (Production must have already
 * run and succeeded) and content_version.state === 'PRODUCED'. Both are
 * structural facts about upstream state, not something this stage
 * evaluates itself.
 *
 * @param {import('../storage/StorageDriver.js').StorageDriver} storage
 * @param {string} contentBriefId
 * @returns {{eligible: boolean, reason?: string, contentVersion?: object, script?: object, contentBrief?: object, production?: object}}
 */
export function resolveProducedContentForProvisioning(storage, contentBriefId) {
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
  const production = storage.get(
    'SELECT * FROM productions WHERE content_version_id = ?',
    [contentVersion.id]
  );
  if (!production) {
    return { eligible: false, reason: 'NO_PRODUCTION_RECORD', contentVersion, script, contentBrief };
  }
  return { eligible: true, contentVersion, script, contentBrief, production };
}

export default resolveProducedContentForProvisioning;
