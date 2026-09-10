/**
 * Deterministic eligibility gate for Script creation (Script Specification
 * §6). The Brief is the sole authoritative input for this stage — Script
 * does not re-query Research or re-run any Brief/Research validation. A
 * persisted `content_briefs` row could only exist because `createBrief`
 * already enforced RESEARCH_COMPLETE (Brief D1), so Script trusts that
 * gate rather than duplicating it.
 */

// Every field a Brief must have populated before a Script can be drafted
// from it (mirrors BRIEF_STRING_FIELDS in src/brief/generate.js, plus
// core_question which Brief copies in deterministically).
const REQUIRED_BRIEF_FIELDS = Object.freeze([
  'working_title', 'core_question', 'target_audience', 'viewer_promise',
  'hook', 'angle', 'narrative_structure', 'counterpoints',
  'original_insights', 'visual_ideas', 'monetization_opportunities',
  'risk_assessment'
]);

function parseKeyClaims(brief) {
  try {
    const parsed = JSON.parse(brief.key_claims);
    if (!Array.isArray(parsed)) return null;
    if (parsed.length === 0) return null;
    if (!parsed.every((id) => typeof id === 'string' && id.length > 0)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * @param {object|undefined} brief - row from content_briefs, or undefined if not found
 * @returns {{eligible: boolean, reason: string|null, keyClaimIds: string[]|null}}
 */
export function checkBriefEligibility(brief) {
  if (!brief) {
    return { eligible: false, reason: 'BRIEF_NOT_FOUND', keyClaimIds: null };
  }

  for (const field of REQUIRED_BRIEF_FIELDS) {
    if (typeof brief[field] !== 'string' || brief[field].trim().length === 0) {
      return { eligible: false, reason: `INELIGIBLE_BRIEF_MISSING_FIELD_${field}`, keyClaimIds: null };
    }
  }

  const keyClaimIds = parseKeyClaims(brief);
  if (!keyClaimIds) {
    return { eligible: false, reason: 'INELIGIBLE_BRIEF_INVALID_KEY_CLAIMS', keyClaimIds: null };
  }

  return { eligible: true, reason: null, keyClaimIds };
}
