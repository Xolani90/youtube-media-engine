/**
 * Resolves "the current Script" for a content item for the Originality
 * stage. Deliberately re-implemented independently of
 * `src/fact-check/eligibility.js::resolveCurrentScript()` rather than
 * imported from it, to keep Originality decoupled from Fact-Check (D-G1
 * scope boundary) — the two stages must not depend on one another.
 *
 * Follows the same repository-established rule Fact-Check's precedent
 * documents: "the current Script" is the exact `scripts` row identified by
 * `content_versions.script_id` — never
 * `SELECT ... FROM scripts ORDER BY version DESC LIMIT 1`.
 *
 * @param {import('../storage/StorageDriver.js').StorageDriver} storage
 * @param {string} contentBriefId
 * @returns {{eligible: boolean, reason?: string, contentVersion?: object, script?: object}}
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
  return { eligible: true, contentVersion, script };
}
