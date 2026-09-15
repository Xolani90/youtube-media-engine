/**
 * Resolves the inputs Media Production needs: the current Script (same
 * repository-established rule every prior stage uses independently —
 * `content_versions.script_id` is the sole authoritative pointer), plus
 * the already-shipped Production MVP record for that content_version.
 * Deliberately re-implemented rather than imported from
 * production/eligibility.js, per the existing per-stage decoupling
 * convention.
 *
 * Media Production's structural precondition is stricter than every
 * upstream stage's: it requires not just a resolvable Script, but an
 * existing `productions` row (Production MVP must have already run and
 * succeeded) and content_version.state === 'PRODUCED' (Production MVP's
 * one legal successful outcome). Both are structural facts about
 * upstream state, not something Media Production evaluates itself.
 *
 * @param {import('../storage/StorageDriver.js').StorageDriver} storage
 * @param {string} contentBriefId
 * @returns {{eligible: boolean, reason?: string, contentVersion?: object, script?: object, contentBrief?: object, production?: object}}
 */
export function resolveProductionForMedia(storage, contentBriefId) {
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