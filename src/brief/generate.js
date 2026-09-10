/**
 * Generation (LLM-assisted) of Brief's creative/interpretive fields, plus
 * the LLM's proposed `key_claims` selection — a subset of the eligible
 * claim ids computed deterministically by claims.js. Mirrors Research's
 * claims.js generate/validate split (§12): the LLM proposes, deterministic
 * code validates. The LLM never proposes evidence_status, never proposes
 * `core_question` (that is copied deterministically, outside this call —
 * see coreQuestion.js, D14), and is instructed not to invent claim ids.
 *
 * @returns {Promise<{parsed: object|null, providerUsed: string, model: string, rawOutput: string, estimatedCost: number, isPaid: boolean}>}
 */
export async function generateBriefFields({ coreQuestion, opportunity, eligibleClaims }, llmRouter) {
  const claimsForPrompt = eligibleClaims.map((c) => ({ id: c.id, claim: c.claim, claim_type: c.claim_type }));

  const prompt = [
    'You are drafting a Content Brief.',
    `The authoritative core question is: "${coreQuestion}". Do not rewrite,`,
    'paraphrase, or otherwise alter it anywhere in your output — it is',
    'supplied to you for context only and is copied into the Brief',
    'separately, deterministically, outside of your response.',
    'You are given the opportunity context and a list of ELIGIBLE Research',
    'claims (each already VERIFIED and non-contested), each with an "id".',
    'Produce a strict JSON object with exactly these fields:',
    '"working_title", "target_audience", "viewer_promise", "hook", "angle",',
    '"narrative_structure", "counterpoints", "original_insights",',
    '"visual_ideas", "monetization_opportunities", "risk_assessment"',
    '(all non-empty strings), and "key_claims" (a JSON array of one or more',
    'claim id strings, chosen ONLY from the eligible claims list below —',
    'never invent an id, never include an id not present in that list).',
    'Ground "counterpoints" and "original_insights" only in the given',
    'claims: do not invent facts, do not imply evidence that does not',
    'exist, and do not resolve or conceal a contradiction. A direct',
    'quotation must be reproduced exactly from the claim text; a paraphrase',
    'must never be presented as a direct quote.',
    `Opportunity title: ${opportunity?.title || ''}`,
    `Opportunity description: ${opportunity?.description || ''}`,
    `Eligible claims: ${JSON.stringify(claimsForPrompt)}`
  ].join('\n');

  const { result, providerUsed } = await llmRouter.complete({ prompt });

  let parsed;
  try {
    parsed = JSON.parse(result.text);
  } catch {
    parsed = null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    parsed = null;
  }

  return {
    parsed,
    providerUsed,
    model: result.model,
    rawOutput: result.text,
    estimatedCost: result.estimatedCost,
    isPaid: result.isPaid
  };
}

export const BRIEF_STRING_FIELDS = Object.freeze([
  'working_title', 'target_audience', 'viewer_promise', 'hook', 'angle',
  'narrative_structure', 'counterpoints', 'original_insights',
  'visual_ideas', 'monetization_opportunities', 'risk_assessment'
]);

/**
 * Deterministic structural Validation (not Generation, not semantic
 * judgment) of one LLM-proposed Brief content object. This checks shape
 * only — every required string field is present/non-empty and
 * `key_claims` is a non-empty array of strings. It does NOT (and per D11
 * cannot) verify that free-text content is semantically grounded; that is
 * an explicitly acknowledged v1 limitation (§11).
 */
export function validateGeneratedBrief(parsed) {
  if (!parsed || typeof parsed !== 'object') {
    return { valid: false, reason: 'MALFORMED_LLM_OUTPUT' };
  }
  for (const field of BRIEF_STRING_FIELDS) {
    if (typeof parsed[field] !== 'string' || parsed[field].trim().length === 0) {
      return { valid: false, reason: `MISSING_OR_EMPTY_FIELD_${field}` };
    }
  }
  if (!Array.isArray(parsed.key_claims) || parsed.key_claims.length === 0) {
    return { valid: false, reason: 'MISSING_OR_EMPTY_KEY_CLAIMS' };
  }
  if (!parsed.key_claims.every((id) => typeof id === 'string' && id.length > 0)) {
    return { valid: false, reason: 'INVALID_KEY_CLAIMS_SHAPE' };
  }
  return { valid: true, reason: null };
}