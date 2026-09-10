/**
 * Generation (LLM-assisted) of a Script's body fields, from an eligible
 * Brief. Mirrors Brief's generate.js proposes/validates split (Brief
 * Specification §12, carried over to Script Specification §3/§6): the LLM
 * proposes hook/narrative/sections/counterpoints/conclusion/call_to_action,
 * deterministic code validates shape and claim-id membership. The LLM
 * never proposes anything outside this JSON contract and is instructed
 * never to invent a claim id.
 *
 * @returns {Promise<{parsed: object|null, providerUsed: string, model: string, rawOutput: string, estimatedCost: number, isPaid: boolean}>}
 */
export async function generateScriptFields({ brief, eligibleClaimIds, allowCallToAction }, llmRouter) {
  const ctaInstruction = allowCallToAction
    ? '"call_to_action" must be a non-empty string.'
    : '"call_to_action" must be null — a call to action is not permitted for this Script.';

  const prompt = [
    'You are drafting a video Script from an already-approved Content Brief.',
    'Do not rewrite, paraphrase, or contradict the Brief\'s working_title,',
    'core_question, angle, or risk_assessment — treat them as fixed context.',
    'You are given the Brief fields and a list of ELIGIBLE claim ids (the',
    'only ids from the Brief\'s own key_claims that you may reference).',
    'Produce a strict JSON object with exactly these fields:',
    '"hook" (non-empty string), "narrative" (non-empty string),',
    '"sections" (a non-empty JSON array of objects, each with a non-empty',
    'string "heading", a non-empty string "content", and a "claim_ids"',
    'array of zero or more claim id strings chosen ONLY from the eligible',
    'claims list below — never invent an id, never include an id not',
    'present in that list), "counterpoints" (non-empty string),',
    '"conclusion" (non-empty string), and "call_to_action".',
    ctaInstruction,
    'Ground every section only in the given claims: do not invent facts,',
    'do not imply evidence that does not exist.',
    `Working title: ${brief?.working_title || ''}`,
    `Core question: ${brief?.core_question || ''}`,
    `Hook (from Brief): ${brief?.hook || ''}`,
    `Angle: ${brief?.angle || ''}`,
    `Narrative structure: ${brief?.narrative_structure || ''}`,
    `Eligible claim ids: ${JSON.stringify(eligibleClaimIds)}`
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

export const SCRIPT_STRING_FIELDS = Object.freeze(['hook', 'narrative', 'counterpoints', 'conclusion']);

/**
 * Deterministic structural Validation (not Generation, not semantic
 * judgment) of one LLM-proposed Script content object. Checks shape only:
 * required string fields are present/non-empty, `sections` is a non-empty
 * array of well-formed section objects, and `call_to_action` respects the
 * caller's CTA policy. This does NOT verify semantic grounding — the same
 * explicitly acknowledged limitation as Brief D11.
 *
 * @param {object} parsed
 * @param {{allowCallToAction: boolean}} policyFlags
 */
export function validateGeneratedScript(parsed, { allowCallToAction }) {
  if (!parsed || typeof parsed !== 'object') {
    return { valid: false, reason: 'MALFORMED_LLM_OUTPUT' };
  }

  for (const field of SCRIPT_STRING_FIELDS) {
    if (typeof parsed[field] !== 'string' || parsed[field].trim().length === 0) {
      return { valid: false, reason: `MISSING_OR_EMPTY_FIELD_${field}` };
    }
  }

  if (!Array.isArray(parsed.sections) || parsed.sections.length === 0) {
    return { valid: false, reason: 'MISSING_OR_EMPTY_SECTIONS' };
  }

  for (const section of parsed.sections) {
    if (!section || typeof section !== 'object' || Array.isArray(section)) {
      return { valid: false, reason: 'INVALID_SECTION_SHAPE' };
    }
    if (typeof section.heading !== 'string' || section.heading.trim().length === 0) {
      return { valid: false, reason: 'MISSING_OR_EMPTY_SECTION_HEADING' };
    }
    if (typeof section.content !== 'string' || section.content.trim().length === 0) {
      return { valid: false, reason: 'MISSING_OR_EMPTY_SECTION_CONTENT' };
    }
    if (!Array.isArray(section.claim_ids)) {
      return { valid: false, reason: 'INVALID_SECTION_CLAIM_IDS_SHAPE' };
    }
    if (!section.claim_ids.every((id) => typeof id === 'string' && id.length > 0)) {
      return { valid: false, reason: 'INVALID_SECTION_CLAIM_IDS_SHAPE' };
    }
  }

  if (allowCallToAction) {
    if (typeof parsed.call_to_action !== 'string' || parsed.call_to_action.trim().length === 0) {
      return { valid: false, reason: 'MISSING_OR_EMPTY_FIELD_call_to_action' };
    }
  } else if (parsed.call_to_action !== null && parsed.call_to_action !== undefined) {
    return { valid: false, reason: 'CALL_TO_ACTION_NOT_PERMITTED' };
  }

  return { valid: true, reason: null };
}
