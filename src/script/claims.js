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
