import { CLAIM_TYPE, EVIDENCE_STATUS } from '../research/constants.js';
import { hasUnresolvedContradiction } from '../research/contradictions.js';

const ELIGIBLE_CLAIM_TYPES = Object.freeze([CLAIM_TYPE.FACT, CLAIM_TYPE.INFERENCE]);

/**
 * Deterministic eligibility filter for `key_claims` (Brief Specification
 * §9/§10, per D2/D3/D12):
 *   - evidence_status must be VERIFIED (D2) — PARTIALLY_SUPPORTED,
 *     UNSUPPORTED, and CONTESTED are all excluded;
 *   - claim_type must be FACT or INFERENCE (D12) — OPINION is excluded;
 *   - the claim must not currently have an unresolved contradiction (D3) —
 *     this excludes only the specific contested claim, not the whole
 *     Research project.
 */
export function selectEligibleKeyClaims(storage, researchProjectId) {
  const placeholders = ELIGIBLE_CLAIM_TYPES.map(() => '?').join(',');
  const claims = storage.all(
    `SELECT * FROM claims
     WHERE research_project_id = ? AND evidence_status = ? AND claim_type IN (${placeholders})`,
    [researchProjectId, EVIDENCE_STATUS.VERIFIED, ...ELIGIBLE_CLAIM_TYPES]
  );
  return claims.filter((c) => !hasUnresolvedContradiction(storage, c.id));
}

/**
 * Deterministic Validation (not Generation) of a set of claim ids proposed
 * for `key_claims`. Every id must exist, belong to this Research project,
 * and currently be eligible per selectEligibleKeyClaims — the LLM may
 * SELECT among eligible ids but must never cause an ineligible or
 * nonexistent id to be persisted (§9, §13).
 */
export function validateKeyClaimIds(storage, researchProjectId, claimIds) {
  if (!Array.isArray(claimIds) || claimIds.length === 0) {
    return { valid: false, reason: 'EMPTY_KEY_CLAIMS' };
  }

  const eligible = selectEligibleKeyClaims(storage, researchProjectId);
  const eligibleIds = new Set(eligible.map((c) => c.id));

  const seen = new Set();
  for (const id of claimIds) {
    if (typeof id !== 'string' || id.length === 0) {
      return { valid: false, reason: 'INVALID_CLAIM_ID_SHAPE' };
    }
    if (seen.has(id)) {
      return { valid: false, reason: `DUPLICATE_CLAIM_ID_${id}` };
    }
    seen.add(id);
    if (!eligibleIds.has(id)) {
      return { valid: false, reason: `INELIGIBLE_OR_UNKNOWN_CLAIM_ID_${id}` };
    }
  }

  return { valid: true, reason: null };
}