import { jaccardSimilarity, tokenize } from './similarity.js';

export const ELIGIBILITY_REASON = Object.freeze({
  INELIGIBLE_LANGUAGE: 'INELIGIBLE_LANGUAGE',
  INELIGIBLE_EMPTY_CONTENT: 'INELIGIBLE_EMPTY_CONTENT',
  INELIGIBLE_ALREADY_PRODUCED: 'INELIGIBLE_ALREADY_PRODUCED',
  INELIGIBLE_MALFORMED: 'INELIGIBLE_MALFORMED',
  DUPLICATE: 'DUPLICATE',
  EXPIRED: 'EXPIRED'
});

/**
 * Very small deterministic language check: does the text contain a
 * meaningful share of common English function words? This is a coarse,
 * cheap, R0 heuristic — not a language-ID model. Sufficient for M0's
 * stated target audience (English-speaking).
 */
const COMMON_ENGLISH_WORDS = new Set(['the', 'and', 'is', 'to', 'of', 'a', 'in', 'for', 'on', 'with']);
function looksLikeSupportedLanguage(text) {
  const tokens = (text || '').toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return false;
  const hits = tokens.filter((t) => COMMON_ENGLISH_WORDS.has(t)).length;
  // Short titles may legitimately contain zero function words (e.g. "Apple Unveils M5 Chip") —
  // only reject when there is enough text to expect function words and none appear.
  if (tokens.length < 6) return true;
  return hits > 0;
}

function isStale(observation, freshnessConfig, now = Date.now()) {
  if (!observation.publishedAt) return false; // can't assess staleness without a timestamp — not itself a rejection reason
  const ageHours = (now - new Date(observation.publishedAt).getTime()) / 3_600_000;
  // M0 default: treat "evergreen" ceiling as the outer bound for eligibility
  // (freshness *categorization* — breaking/trending/evergreen — is a
  // downstream scoring concern; eligibility only rejects candidates past
  // the absolute outer age bound).
  return ageHours > freshnessConfig.evergreen_hours;
}

/**
 * Hard Eligibility check (v0.6 §4). Fully deterministic. Does NOT assess
 * whether the opportunity is strong — only whether it can technically
 * enter evaluation. Does not perform duplicate detection itself — it
 * consumes a dedup result already computed by src/discovery/dedup.js.
 *
 * @param observation - normalized observation
 * @param options.alreadyProducedCorpus - array of { title, description } from
 *   previously produced content (scripts/content_versions), for the
 *   already-produced check
 * @param options.dedupResolvedDuplicate - boolean, true if Event Dedup (§6)
 *   already resolved this observation as a duplicate of an existing candidate
 * @param options.thresholds - discovery_policy.json thresholds
 * @returns { eligible: boolean, reason: string|null }
 */
export function checkHardEligibility(observation, { alreadyProducedCorpus = [], dedupResolvedDuplicate = false, thresholds }) {
  if (!observation || (!observation.title && !observation.description)) {
    return { eligible: false, reason: ELIGIBILITY_REASON.INELIGIBLE_EMPTY_CONTENT };
  }

  const combinedText = `${observation.title || ''} ${observation.description || ''}`.trim();
  if (combinedText.length < 3) {
    return { eligible: false, reason: ELIGIBILITY_REASON.INELIGIBLE_MALFORMED };
  }

  if (!looksLikeSupportedLanguage(combinedText)) {
    return { eligible: false, reason: ELIGIBILITY_REASON.INELIGIBLE_LANGUAGE };
  }

  if (dedupResolvedDuplicate) {
    return { eligible: false, reason: ELIGIBILITY_REASON.DUPLICATE };
  }

  if (isStale(observation, thresholds.freshness.maximum_age_by_category)) {
    return { eligible: false, reason: ELIGIBILITY_REASON.EXPIRED };
  }

  const candidateTokens = tokenize(combinedText);
  for (const produced of alreadyProducedCorpus) {
    const producedTokens = tokenize(`${produced.title || ''} ${produced.description || ''}`);
    const sim = jaccardSimilarity(candidateTokens, producedTokens);
    if (sim >= thresholds.eligibility.already_produced_similarity_threshold) {
      return { eligible: false, reason: ELIGIBILITY_REASON.INELIGIBLE_ALREADY_PRODUCED };
    }
  }

  // NOTE: no minimum-source-count check exists here, per v0.6 §4 — one
  // usable, retrievable source is sufficient. Evidence sufficiency is a
  // Value Score concern (evidence_availability), not an eligibility gate.
  return { eligible: true, reason: null };
}
