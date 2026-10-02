import { getDomain } from 'tldts';
import { EVIDENCE_STATUS, SOURCE_ROLE, RETRIEVAL_STATUS } from './constants.js';

const QUALITY_ORDER = ['UNUSABLE', 'LOW', 'MEDIUM', 'HIGH'];

function meetsMinimumQuality(tier, minimumTier) {
  return QUALITY_ORDER.indexOf(tier) >= QUALITY_ORDER.indexOf(minimumTier);
}

/**
 * Deterministic publisher-independence key for corroboration counting.
 *
 * Returns the registrable domain (public-suffix aware, via the Public
 * Suffix List: news.example.com, www.example.com and example.com all map to
 * example.com; www.bbc.co.uk -> bbc.co.uk). Two URLs sharing a key are ONE
 * publisher for corroboration purposes.
 *
 * Fails closed: a missing/unparseable URL, an IP address, or a host with no
 * registrable domain (e.g. localhost) returns null, and a source with a null
 * key can never count as independent corroboration.
 *
 * Only ICANN-section suffixes are used (tldts default), so hosts under
 * shared private suffixes (e.g. *.blogspot.com) are conservatively treated
 * as one publisher rather than many.
 *
 * @param {string} url
 * @returns {string|null}
 */
export function independenceKey(url) {
  if (typeof url !== 'string' || url.trim() === '') return null;
  let hostname;
  try {
    hostname = new URL(url).hostname;
  } catch {
    return null;
  }
  return getDomain(hostname) || null;
}

/**
 * A source counts as usable evidence only if it was actually retrieved,
 * is fresh per policy staleness, and meets the configured minimum quality
 * tier for corroboration purposes (v0.3 S6, v0.4 source-independence
 * clarification).
 */
export function isSourceFresh(source, policy, nowMs = Date.now()) {
  if (!source.retrieved_at) return false;
  const ageHours = (nowMs - new Date(source.retrieved_at).getTime()) / (1000 * 60 * 60);
  return ageHours <= policy.staleness.maximum_source_age_hours;
}

function isSourceEligible(source, policy, nowMs) {
  return (
    source.retrieval_status === RETRIEVAL_STATUS.SUCCESS &&
    isSourceFresh(source, policy, nowMs) &&
    meetsMinimumQuality(source.quality_tier, policy.evidence.source_quality.minimum_quality_tier_for_corroboration)
  );
}

/** Pure evidence-grade diagnostic using exactly the production eligibility rules. */
export function explainEvidenceSources({ claimSourceLinks, sourcesById, policy, nowMs = Date.now() }) {
  const uniqueSourceIds = [...new Set((claimSourceLinks || []).map((link) => link.source_id))];
  const sources = uniqueSourceIds.map((sourceId) => {
    const source = sourcesById.get(sourceId);
    if (!source) return { sourceId, domain: null, role: null, qualityTier: null, retrievalStatus: null, fresh: false, qualityOk: false, eligible: false };
    const fresh = isSourceFresh(source, policy, nowMs);
    const qualityOk = meetsMinimumQuality(source.quality_tier, policy.evidence.source_quality.minimum_quality_tier_for_corroboration);
    return {
      sourceId, domain: independenceKey(source.url), role: source.role,
      qualityTier: source.quality_tier, retrievalStatus: source.retrieval_status,
      fresh, qualityOk, eligible: isSourceEligible(source, policy, nowMs)
    };
  });
  const eligible = sources.filter((source) => source.eligible);
  const independentDomains = [...new Set(eligible
    .filter((source) => source.role === SOURCE_ROLE.INDEPENDENT_REPORTING && policy.evidence.source_roles.independent_reporting.counts_toward_corroboration)
    .map((source) => source.domain).filter(Boolean))];
  const hasPrimaryAuthoritative = eligible.some((source) => source.role === SOURCE_ROLE.PRIMARY_AUTHORITATIVE && policy.evidence.source_roles.primary_authoritative.sufficient_alone);
  return { sources, independentDomains, independentCount: independentDomains.length,
    required: policy.evidence.independent_reporting_minimum, hasPrimaryAuthoritative };
}

/**
 * Deterministic evidence_status computation (Validation, never Generation
 * — the LLM never self-certifies evidence_status, v0.4 R7).
 *
 * Domain diversity is NOT treated as proof of independence: only sources
 * classified `independent_reporting` count toward the corroboration
 * minimum; `syndicated` sources never count, regardless of how many
 * distinct domains they span (v0.4 source-independence clarification).
 * A `primary_authoritative` source is sufficient alone when policy says so.
 *
 * Integrity rules for the independent_reporting count:
 *  - Each distinct `source_id` counts at most once, no matter how many
 *    claim_sources rows (e.g. `primary` + `corroborating`) reference it.
 *  - Sources are counted by distinct independenceKey (registrable domain),
 *    not by URL: two pages from the same publisher are one source of
 *    corroboration. Sources with no derivable key never count.
 *
 * @param {object} params
 * @param {Array<{claim_id, source_id}>} params.claimSourceLinks - claim_sources rows for this claim
 * @param {Map<string, object>} params.sourcesById
 * @param {object} params.policy
 * @param {boolean} [params.hasUnresolvedContradiction] - a CONTRADICTS relation touches this claim
 * @param {number} [params.nowMs]
 * @returns {'VERIFIED'|'PARTIALLY_SUPPORTED'|'UNSUPPORTED'|'CONTESTED'}
 */
export function computeEvidenceStatus({ claimSourceLinks, sourcesById, policy, hasUnresolvedContradiction = false, nowMs = Date.now() }) {
  if (hasUnresolvedContradiction) {
    // Contradiction affects evidence_status only, never claim_type (v0.4).
    // Both contradictory claims may honestly remain CONTESTED rather than
    // the system manufacturing a winner.
    return EVIDENCE_STATUS.CONTESTED;
  }

  // A source is one piece of evidence regardless of how many claim_sources
  // rows (roles) link it to this claim.
  const uniqueSourceIds = [...new Set((claimSourceLinks || []).map((link) => link.source_id))];
  const eligibleSources = uniqueSourceIds
    .map((sourceId) => sourcesById.get(sourceId))
    .filter(Boolean)
    .filter((s) => isSourceEligible(s, policy, nowMs));

  const hasSufficientPrimary = eligibleSources.some(
    (s) => s.role === SOURCE_ROLE.PRIMARY_AUTHORITATIVE && policy.evidence.source_roles.primary_authoritative.sufficient_alone
  );
  if (hasSufficientPrimary) return EVIDENCE_STATUS.VERIFIED;

  const independentKeys = new Set(
    eligibleSources
      .filter((s) => s.role === SOURCE_ROLE.INDEPENDENT_REPORTING && policy.evidence.source_roles.independent_reporting.counts_toward_corroboration)
      .map((s) => independenceKey(s.url))
      .filter((key) => key !== null)
  );
  const independentCount = independentKeys.size;

  if (independentCount >= policy.evidence.independent_reporting_minimum) {
    return EVIDENCE_STATUS.VERIFIED;
  }
  if (eligibleSources.length > 0) {
    return EVIDENCE_STATUS.PARTIALLY_SUPPORTED;
  }
  return EVIDENCE_STATUS.UNSUPPORTED;
}
