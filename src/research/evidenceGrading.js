import { EVIDENCE_STATUS, SOURCE_ROLE, RETRIEVAL_STATUS } from './constants.js';

const QUALITY_ORDER = ['UNUSABLE', 'LOW', 'MEDIUM', 'HIGH'];

function meetsMinimumQuality(tier, minimumTier) {
  return QUALITY_ORDER.indexOf(tier) >= QUALITY_ORDER.indexOf(minimumTier);
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

  const eligibleSources = (claimSourceLinks || [])
    .map((link) => sourcesById.get(link.source_id))
    .filter(Boolean)
    .filter((s) => isSourceEligible(s, policy, nowMs));

  const hasSufficientPrimary = eligibleSources.some(
    (s) => s.role === SOURCE_ROLE.PRIMARY_AUTHORITATIVE && policy.evidence.source_roles.primary_authoritative.sufficient_alone
  );
  if (hasSufficientPrimary) return EVIDENCE_STATUS.VERIFIED;

  const independentCount = eligibleSources.filter(
    (s) => s.role === SOURCE_ROLE.INDEPENDENT_REPORTING && policy.evidence.source_roles.independent_reporting.counts_toward_corroboration
  ).length;

  if (independentCount >= policy.evidence.independent_reporting_minimum) {
    return EVIDENCE_STATUS.VERIFIED;
  }
  if (eligibleSources.length > 0) {
    return EVIDENCE_STATUS.PARTIALLY_SUPPORTED;
  }
  return EVIDENCE_STATUS.UNSUPPORTED;
}