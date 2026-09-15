/**
 * Resolves "the current Script" and its content_version/content_brief for
 * Production, following the same repository-established rule every prior
 * stage uses independently: `content_versions.script_id` is the sole
 * authoritative pointer, never `SELECT ... FROM scripts ORDER BY version
 * DESC LIMIT 1`. Deliberately re-implemented rather than imported from
 * fact-check/originality/quality-gate, per the existing per-stage
 * decoupling convention.
 *
 * @param {import('../storage/StorageDriver.js').StorageDriver} storage
 * @param {string} contentBriefId
 * @returns {{eligible: boolean, reason?: string, contentVersion?: object, script?: object, contentBrief?: object}}
 */
export function resolveCurrentScript(storage, contentBriefId) {
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
  return { eligible: true, contentVersion, script, contentBrief };
}