import { SOURCE_ROLE } from './constants.js';
import { independenceKey } from './evidenceGrading.js';

// A 'contradicting' link records conflicting evidence; it is never support
// (mirrors evidenceGrading.js). Links with no role count as supporting.
const isSupportingLink = (link) => link?.role !== 'contradicting';

/**
 * Pure classification check. A load-bearing claim whose ONLY supporting
 * sources are social_media can never become admissible evidence (social
 * sources never verify or corroborate), so it must not remain load-bearing.
 *
 * Deliberately narrow:
 *  - claims with zero supporting links are NOT touched (nothing proven about them);
 *  - a link to a source that cannot be resolved is treated as non-social (fail-safe: preserve);
 *  - ANY supporting non-social source preserves the classification, even if a
 *    social source is also linked.
 * It does not read or change thresholds, quality tiers, or admissibility rules.
 *
 * @returns {{downgrade: boolean, reason: string, sources: Array}}
 */
export function evaluateSocialOnlyLoadBearing({ claimSourceLinks, sourcesById }) {
  const supporting = (claimSourceLinks || []).filter(isSupportingLink);
  const ids = [...new Set(supporting.map((l) => l.source_id))];
  if (ids.length === 0) return { downgrade: false, reason: 'no_supporting_links', sources: [] };
  const sources = ids.map((id) => {
    const s = sourcesById.get(id);
    return { sourceId: id, role: s?.role ?? null, qualityTier: s?.quality_tier ?? null, domain: s ? independenceKey(s.url) : null };
  });
  const allSocial = sources.every((s) => s.role === SOURCE_ROLE.SOCIAL_MEDIA);
  return allSocial
    ? { downgrade: true, reason: 'only_social_media_sources', sources }
    : { downgrade: false, reason: 'has_non_social_source', sources };
}

/**
 * Applies the downgrade to persisted claims. Injected `setNotLoadBearing` and
 * `logDowngrade` keep this free of storage details so it is unit-testable.
 * Mutates claim.is_load_bearing on the in-memory rows it downgrades.
 * @returns {Array<string>} ids of downgraded claims
 */
export function downgradeSocialOnlyLoadBearing({ claims, getLinks, sourcesById, setNotLoadBearing, logDowngrade }) {
  const downgraded = [];
  for (const claim of claims) {
    if (claim.is_load_bearing !== true && claim.is_load_bearing !== 1) continue;
    const verdict = evaluateSocialOnlyLoadBearing({ claimSourceLinks: getLinks(claim.id), sourcesById });
    if (!verdict.downgrade) continue;
    setNotLoadBearing(claim.id);
    claim.is_load_bearing = false;
    logDowngrade(claim, verdict);
    downgraded.push(claim.id);
  }
  return downgraded;
}
