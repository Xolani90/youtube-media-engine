/**
 * Resolves "the current Script" for a content item for the Quality Gate
 * stage. Deliberately re-implemented independently of
 * `src/fact-check/eligibility.js` / `src/originality/eligibility.js`
 * rather than imported from either, to keep Quality Gate decoupled from
 * both (same scope-boundary convention D-G1 established for Originality
 * relative to Fact-Check).
 *
 * Follows the same repository-established rule: "the current Script" is
 * the exact `scripts` row identified by `content_versions.script_id` —
 * never `SELECT ... FROM scripts ORDER BY version DESC LIMIT 1`.
 *
 * This resolution IS the Gate 1 "structural package completeness" check
 * (content_version -> script -> content_brief all resolve): eligibility
 * failing here is that check's BLOCK condition, reported the same way
 * every other stage reports a structural failure (no gate evaluation
 * attempted, no lifecycle transition).
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
  const contentBrief = storage.get('SELECT * FROM content_briefs WHERE id = ?', [script.content_brief_id]);
  if (!contentBrief) {
    return { eligible: false, reason: 'CONTENT_BRIEF_NOT_FOUND', contentVersion, script };
  }
  return { eligible: true, contentVersion, script };
}
