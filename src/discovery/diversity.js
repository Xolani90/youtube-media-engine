import { localSimilarity } from './similarity.js';

/**
 * Given risk-cleared candidates already ranked by raw value score
 * (descending), selects up to topK while avoiding near-duplicate
 * portfolio composition. Crucially: this NEVER modifies a candidate's
 * `overallScore` — it only decides which candidates are selected vs.
 * excluded, and returns the exclusion reasons separately for audit
 * (v0.6 §12: "Diversity constrains selection, never alters score").
 *
 * @param rankedCandidates - array of { id, overallScore, observation, underlyingEventId }
 *   already sorted by overallScore descending
 * @param topK - number of slots to fill
 * @param similarityThreshold - candidates more similar than this to an
 *   already-selected candidate are excluded for this run (not rejected
 *   outright — they simply weren't selected in THIS run's portfolio)
 * @returns { selected: [...], excluded: [{ candidate, reason }] }
 */
export function selectDiversePortfolio(rankedCandidates, topK, similarityThreshold = 0.6) {
  const selected = [];
  const excluded = [];

  for (const candidate of rankedCandidates) {
    if (selected.length >= topK) {
      excluded.push({ candidate, reason: 'TOP_K_REACHED' });
      continue;
    }

    const tooSimilar = selected.find((s) => {
      if (s.underlyingEventId && candidate.underlyingEventId && s.underlyingEventId === candidate.underlyingEventId) {
        return true; // same underlying event already represented in this portfolio
      }
      return localSimilarity(s.observation, candidate.observation) >= similarityThreshold;
    });

    if (tooSimilar) {
      excluded.push({ candidate, reason: `TOO_SIMILAR_TO_SELECTED:${tooSimilar.id}` });
      continue;
    }

    selected.push(candidate);
  }

  return { selected, excluded };
}
