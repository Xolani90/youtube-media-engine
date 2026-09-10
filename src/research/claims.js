import { CLAIM_TYPE } from './constants.js';

const CLAIM_TYPES = Object.values(CLAIM_TYPE);

/**
 * Claim extraction (Generation, LLM-assisted) — mirrors proposition.js's
 * generate/validate split: the LLM proposes claim_type and is_load_bearing
 * per claim; it does not adjudicate its own structural validity, and it
 * MUST NOT propose evidence_status (that is deterministic-only, see
 * evidenceGrading.js — an LLM never certifies its own output, v0.6
 * precedent applied to Research).
 *
 * @returns {Promise<{claims: Array<{claim, claim_type, is_load_bearing}>, providerUsed, model, rawOutput, estimatedCost, isPaid}>}
 */
export async function extractClaims({ sourceText, coreQuestion }, llmRouter) {
  const prompt = [
    'Given the source text below, extract the individual factual/inferential/opinion',
    'claims it makes, as a strict JSON array. Each element must have exactly these',
    'fields: "claim" (a non-empty string, one self-contained assertion),',
    '"claim_type" (exactly one of FACT, INFERENCE, OPINION — semantic classification',
    'of the statement itself, independent of how well-supported it is), and',
    '"is_load_bearing" (boolean — true only if this claim is necessary to answer the',
    `core question: "${coreQuestion || ''}").`,
    'Do not include an evidence/confidence field — evidence strength is assessed',
    'separately and deterministically, not by you.',
    `Source text: ${sourceText || ''}`
  ].join('\n');

  const { result, providerUsed } = await llmRouter.complete({ prompt });

  let parsed;
  try {
    parsed = JSON.parse(result.text);
  } catch {
    parsed = [];
  }
  if (!Array.isArray(parsed)) parsed = [];

  const claims = parsed.map((c) => ({
    claim: typeof c?.claim === 'string' ? c.claim : null,
    claim_type: typeof c?.claim_type === 'string' ? c.claim_type : null,
    is_load_bearing: typeof c?.is_load_bearing === 'boolean' ? c.is_load_bearing : null
  }));

  return {
    claims,
    providerUsed,
    model: result.model,
    rawOutput: result.text,
    estimatedCost: result.estimatedCost,
    isPaid: result.isPaid
  };
}

/**
 * Deterministic Validation (not Generation) of one LLM-proposed claim's
 * structure. This is a structural sanity check, not a semantic re-judgment
 * of the LLM's classification call (v0.3 S1).
 */
export function validateExtractedClaim(claim) {
  if (!claim || typeof claim.claim !== 'string' || claim.claim.trim().length === 0) {
    return { valid: false, reason: 'missing or empty claim text' };
  }
  if (!CLAIM_TYPES.includes(claim.claim_type)) {
    return { valid: false, reason: `claim_type must be one of ${CLAIM_TYPES.join(', ')}` };
  }
  if (typeof claim.is_load_bearing !== 'boolean') {
    return { valid: false, reason: 'is_load_bearing must be a boolean' };
  }
  return { valid: true, reason: null };
}