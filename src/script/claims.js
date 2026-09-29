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
 */
export function validateScriptClaimReferences(sections, allowedClaimIds) {
  const allowed = new Set(allowedClaimIds);
  // Fact-Check (spec §11) treats a claim id repeated anywhere across the
  // claim_links payload as a STRUCTURAL_FAILURE, which is deterministic and
  // never retried. A Script that repeats an id can therefore never pass, so
  // it must be rejected here, inside the bounded generation retry loop,
  // rather than persisted and left to fail Fact-Check on every sweep.
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
