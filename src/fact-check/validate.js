/**
 * Structural shape check for a Script's `claim_links` (spec §11).
 * Shape mirrors Script's own `claim_links` persistence:
 * `[{heading: string, claim_ids: string[]}]`.
 *
 * @param {object} script - a `scripts` row
 * @returns {{valid: boolean, reason?: string, sections?: Array}}
 */
export function parseClaimLinks(script) {
  let parsed;
  try {
    parsed = JSON.parse(script.claim_links ?? 'null');
  } catch {
    return { valid: false, reason: 'CLAIM_LINKS_MALFORMED_JSON' };
  }
  if (!Array.isArray(parsed)) {
    return { valid: false, reason: 'CLAIM_LINKS_NOT_ARRAY' };
  }
  for (const entry of parsed) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      return { valid: false, reason: 'CLAIM_LINKS_ENTRY_NOT_OBJECT' };
    }
    if (typeof entry.heading !== 'undefined' && typeof entry.heading !== 'string') {
      return { valid: false, reason: 'CLAIM_LINKS_INVALID_HEADING_TYPE' };
    }
    if (!Array.isArray(entry.claim_ids)) {
      return { valid: false, reason: 'CLAIM_LINKS_CLAIM_IDS_NOT_ARRAY' };
    }
    for (const claimId of entry.claim_ids) {
      if (typeof claimId !== 'string' || claimId.length === 0) {
        return { valid: false, reason: 'CLAIM_LINKS_INVALID_CLAIM_ID_TYPE' };
      }
    }
  }
  return { valid: true, sections: parsed };
}

/**
 * Resolves the originating Research project for a Script, using exactly
 * the join path required by spec §5:
 * scripts.content_brief_id -> content_briefs.research_project_id.
 * There is no `scripts.research_project_id`; none is introduced here.
 *
 * @param {import('../storage/StorageDriver.js').StorageDriver} storage
 * @param {object} script - a `scripts` row
 * @returns {{resolved: boolean, reason?: string, researchProjectId?: string}}
 */
export function resolveResearchProject(storage, script) {
  const brief = storage.get('SELECT * FROM content_briefs WHERE id = ?', [script.content_brief_id]);
  if (!brief) {
    return { resolved: false, reason: 'CONTENT_BRIEF_NOT_FOUND' };
  }
  if (!brief.research_project_id) {
    return { resolved: false, reason: 'BRIEF_HAS_NO_RESEARCH_PROJECT' };
  }
  return { resolved: true, researchProjectId: brief.research_project_id };
}

/**
 * Resolves every claim referenced in `sections` against the given Research
 * project (spec §5): every claim ID must resolve to an existing claim
 * whose `research_project_id` matches the resolved project. Any claim ID
 * that does not resolve, or resolves to a different project, is a
 * structural failure (no partial/best-effort resolution).
 *
 * @param {import('../storage/StorageDriver.js').StorageDriver} storage
 * @param {string} researchProjectId
 * @param {Array<{heading: string, claim_ids: string[]}>} sections
 * @returns {{valid: boolean, reason?: string, resolved?: Array<{heading: string, claim: object}>}}
 */
export function resolveClaims(storage, researchProjectId, sections) {
  // Spec §11: a claim ID repeated anywhere across the complete claim_links
  // payload (within one section or across sections) is a structural
  // failure, not a legitimate REJECT — the resolution model in §5 requires
  // distinct claims. Checked up front, across the whole payload, before
  // any DB resolution, consistent with the "no partial/best-effort
  // resolution" discipline already used below for missing/wrong-project
  // claim IDs.
  const seen = new Set();
  for (const section of sections) {
    for (const claimId of section.claim_ids) {
      if (seen.has(claimId)) {
        return { valid: false, reason: `CLAIM_LINKS_DUPLICATE_CLAIM_REFERENCE_${claimId}` };
      }
      seen.add(claimId);
    }
  }

  const resolved = [];
  for (const section of sections) {
    for (const claimId of section.claim_ids) {
      const claim = storage.get('SELECT * FROM claims WHERE id = ?', [claimId]);
      if (!claim) {
        return { valid: false, reason: `INVALID_CLAIM_REFERENCE_${claimId}` };
      }
      if (claim.research_project_id !== researchProjectId) {
        return { valid: false, reason: `CLAIM_WRONG_RESEARCH_PROJECT_${claimId}` };
      }
      resolved.push({ heading: section.heading, claim });
    }
  }
  if (resolved.length === 0) {
    return { valid: false, reason: 'CLAIM_LINKS_EMPTY' };
  }
  return { valid: true, resolved };
}

/**
 * Spec §6: whether a resolved claim has an applicable same-project
 * `CONTRADICTS` relation. The relation is undirected (`claim_id` or
 * `related_claim_id`); the other side must belong to the SAME Research
 * project as the claim being evaluated, or the relation is not applicable
 * (prevents cross-project relationship leakage).
 *
 * @param {import('../storage/StorageDriver.js').StorageDriver} storage
 * @param {object} claim - a `claims` row
 * @param {string} researchProjectId - the project resolved for this Script
 * @returns {boolean}
 */
export function hasApplicableContradiction(storage, claim, researchProjectId) {
  const rows = storage.all(
    `SELECT * FROM claim_relations
      WHERE relation_type = 'CONTRADICTS' AND (claim_id = ? OR related_claim_id = ?)`,
    [claim.id, claim.id]
  );
  for (const row of rows) {
    const otherClaimId = row.claim_id === claim.id ? row.related_claim_id : row.claim_id;
    const other = storage.get('SELECT * FROM claims WHERE id = ?', [otherClaimId]);
    if (other && other.research_project_id === researchProjectId) {
      return true;
    }
  }
  return false;
}