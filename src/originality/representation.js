/**
 * ADR-0019 — Originality Input Representation.
 *
 * Derives the "Originality Text" that the shared tokenizer/similarity
 * machinery (src/discovery/similarity.js) measures, from a persisted
 * `scripts.body` value.
 *
 * This module is Originality-owned. It is deliberately NOT imported from
 * or shared with src/media/** (see ADR-0019 §4.6 / E-16-E-18): B-01's
 * `scriptBodyToNarrationText()` is a Script -> Media narration contract
 * (includes headings, adds sentence punctuation, includes a non-null
 * call_to_action) and is a different representation for a different
 * purpose. No converter is shared between the two.
 *
 * Classification (ADR-0019 §4.4), in order, after trimming only for the
 * purpose of classification:
 *   - empty                          -> no representation
 *   - begins with "{"                -> structured candidate; Structured
 *                                        Form only if it parses as one
 *                                        JSON object satisfying the
 *                                        Structured Script validation
 *                                        requirements below; otherwise
 *                                        no representation (no prose
 *                                        fallback)
 *   - begins with "["                -> no representation, never legacy
 *                                        prose, array parsing never
 *                                        attempted
 *   - anything else                  -> legacy prose (complete persisted
 *                                        body, unchanged)
 */

/**
 * Sentinel returned for a body with no valid Originality representation
 * (empty body, invalid/malformed structured candidate, or array-shaped
 * body). Distinguished from a representation that happens to be the
 * empty string, which cannot occur here since every field required by
 * isValidStructuredForm() must be a non-empty string.
 */
export const NO_REPRESENTATION = Symbol('ORIGINALITY_NO_REPRESENTATION');

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Structured Script validation requirements (ADR-0019 E-05, mirrored from
 * the Script producer contract's own shape — re-implemented here
 * independently rather than imported, per the Originality/Media
 * boundary): hook, narrative, counterpoints, conclusion are required
 * non-empty strings; sections is a required non-empty array of
 * { heading: non-empty string, content: non-empty string, claim_ids: array
 * of strings }. call_to_action is not validated or read by Originality at
 * all — it is excluded from the representation regardless of its
 * persisted value (ADR-0019 §2, E-06), so an absent/null/invalid
 * call_to_action never affects Structured Form validity here.
 */
function isValidStructuredForm(parsed) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
  if (!isNonEmptyString(parsed.hook)) return false;
  if (!isNonEmptyString(parsed.narrative)) return false;
  if (!isNonEmptyString(parsed.counterpoints)) return false;
  if (!isNonEmptyString(parsed.conclusion)) return false;
  if (!Array.isArray(parsed.sections) || parsed.sections.length === 0) return false;
  for (const section of parsed.sections) {
    if (!section || typeof section !== 'object' || Array.isArray(section)) return false;
    if (!isNonEmptyString(section.heading)) return false;
    if (!isNonEmptyString(section.content)) return false;
    if (!Array.isArray(section.claim_ids)) return false;
    for (const id of section.claim_ids) {
      if (typeof id !== 'string' || id.length === 0) return false;
    }
  }
  return true;
}

/**
 * Builds the Originality Text for a valid Structured Form object: hook,
 * narrative, each section's content (in array order), counterpoints,
 * conclusion — joined with whitespace. No labels, connective prose, or
 * synthetic punctuation are added (ADR-0019 §4.1/§4.2). heading,
 * claim_ids, call_to_action, field names, JSON structure, and any
 * unlisted property never contribute.
 */
function buildStructuredOriginalityText(parsed) {
  const parts = [parsed.hook, parsed.narrative];
  for (const section of parsed.sections) {
    parts.push(section.content);
  }
  parts.push(parsed.counterpoints, parsed.conclusion);
  return parts.join(' ');
}

/**
 * Derives the Originality Text for a persisted `scripts.body` value, per
 * ADR-0019 §4.4.
 *
 * @param {string} body
 * @returns {string | typeof NO_REPRESENTATION}
 */
export function deriveOriginalityText(body) {
  if (typeof body !== 'string') return NO_REPRESENTATION;

  const trimmed = body.trim();
  if (trimmed.length === 0) return NO_REPRESENTATION;

  const first = trimmed[0];

  if (first === '[') {
    // Never treated as legacy prose; array parsing never attempted.
    return NO_REPRESENTATION;
  }

  if (first === '{') {
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return NO_REPRESENTATION;
    }
    if (!isValidStructuredForm(parsed)) {
      // No fallback to legacy prose for an invalid structured candidate.
      return NO_REPRESENTATION;
    }
    return buildStructuredOriginalityText(parsed);
  }

  // Legacy prose: the complete persisted body, exactly as written.
  return body;
}

/** True if `deriveOriginalityText(body)` would yield no representation. */
export function hasNoRepresentation(body) {
  return deriveOriginalityText(body) === NO_REPRESENTATION;
}
