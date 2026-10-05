/**
 * Deterministic Validation (not Generation) of the claim ids a proposed
 * Script attaches to its sections via `claim_links`. Every referenced id
 * must belong to the Brief's own `key_claims` set — never a broader pool,
 * never invented by the model, never pulled from another Brief.
 *
 * This is referential validation only: it checks that an id is a member
 * of allowedClaimIds. It does NOT re-query the live `claims` table's
 * current evidence_status — Script deliberately treats the Brief as the
 * sole authoritative input and does not re-run Research/Brief logic
 * (Script Specification §6).
 *
 * A claim id may appear only once across the whole claim_links payload
 * (within a section or across sections). This mirrors the Fact-Check
 * structural rule (CLAIM_LINKS_DUPLICATE_CLAIM_REFERENCE_*) so a Script
 * Fact-Check would reject is rejected here, where the bounded generation
 * retry can still repair it.
 */
export function validateScriptClaimReferences(sections, allowedClaimIds) {
  const allowed = new Set(allowedClaimIds);
  const seen = new Set();

  for (const section of sections) {
    if (!Array.isArray(section.claim_ids)) {
      return { valid: false, reason: 'INVALID_SECTION_CLAIM_IDS_SHAPE' };
    }
    for (const id of section.claim_ids) {
      if (typeof id !== 'string' || id.length === 0) {
        return { valid: false, reason: 'INVALID_SECTION_CLAIM_IDS_SHAPE' };
      }
      if (!allowed.has(id)) {
        return { valid: false, reason: `INVALID_CLAIM_REFERENCE_${id}` };
      }
      if (seen.has(id)) {
        return { valid: false, reason: `DUPLICATE_CLAIM_REFERENCE_${id}` };
      }
      seen.add(id);
    }
  }

  return { valid: true, reason: null };
}

/**
 * Builds the `claim_links` audit-trail structure persisted alongside the
 * Script body: [{ heading, claim_ids }], one entry per section, in the
 * order the sections were generated.
 */
export function buildClaimLinks(sections) {
  return sections.map((section) => ({
    heading: section.heading,
    claim_ids: Array.isArray(section.claim_ids) ? section.claim_ids : []
  }));
}

// Figures worth checking: money, percentages, decimals, thousands-separated
// numbers and 4-digit years. Plain small integers ("3 steps") are ignored so
// ordinary prose is not rejected.
const FIGURE_PATTERN = /\$\s?\d[\d,]*(?:\.\d+)?|\d[\d,]*(?:\.\d+)?\s?%|\b\d+\.\d+\b|\b\d{1,3}(?:,\d{3})+\b|\b(?:19|20)\d{2}\b/g;

export function extractFigures(text) {
  return new Set((String(text ?? '').match(FIGURE_PATTERN) ?? []).map((f) => f.replace(/[\s,]/g, '')));
}

/**
 * Deterministic grounding guard: every figure in a section's content must
 * appear in the text of that section's referenced claims or in the Brief
 * fields. Skipped (valid) when any referenced claim text is unavailable, so
 * a missing lookup can never cause a rejection. Not semantic judgment.
 */
export function validateSectionFigures(sections, claimTextById, briefText = '') {
  const briefFigures = extractFigures(briefText);
  for (const section of sections) {
    const texts = section.claim_ids.map((id) => claimTextById.get(id));
    if (texts.some((t) => typeof t !== 'string')) continue;
    const allowed = extractFigures(texts.join(' '));
    for (const f of extractFigures(`${section.heading} ${section.content}`)) {
      if (!allowed.has(f) && !briefFigures.has(f)) {
        return { valid: false, reason: `UNGROUNDED_FIGURE_${f}` };
      }
    }
  }
  return { valid: true, reason: null };
}
