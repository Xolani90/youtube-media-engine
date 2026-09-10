export const VALUE_DIMENSIONS = Object.freeze([
  'novelty', 'competition', 'story_potential', 'evidence_availability', 'production_difficulty',
  'audience_potential', 'commercial_intent', 'affiliate_potential',
  'lead_generation_potential', 'product_adjacency', 'sponsorship_potential'
]);

/**
 * Normalizes a single raw dimension value onto [0, 1] using the configured
 * bounds, then inverts it if the dimension's raw semantics run opposite
 * to "higher is better" (v0.6 §8). Clamps out-of-range inputs.
 */
export function normalizeDimension(dimension, rawValue, normalizationConfig) {
  const bounds = normalizationConfig.scale_bounds_by_dimension[dimension];
  if (!bounds) {
    throw new Error(`No normalization bounds configured for dimension "${dimension}"`);
  }
  const clamped = Math.min(bounds.max, Math.max(bounds.min, rawValue));
  const range = bounds.max - bounds.min;
  let normalized = range === 0 ? 0 : (clamped - bounds.min) / range;

  const inverted = Boolean(normalizationConfig.inversion_map[dimension]);
  if (inverted) {
    normalized = 1 - normalized;
  }
  return { normalized, inverted };
}

/**
 * Computes the full value score for a set of raw dimension inputs.
 * Returns { overallScore, breakdown } where breakdown records, per
 * dimension: raw value, normalized (post-inversion) value, weight, and
 * contribution — sufficient to reconstruct the score (v0.6 §16 M0
 * acceptance: score_breakdown must never store only the final number).
 */
export function computeValueScore(rawDimensions, { weightsConfig, normalizationConfig, discoveryPolicyVersion }) {
  const components = {};
  let weightedSum = 0;
  let weightTotal = 0;

  for (const dim of VALUE_DIMENSIONS) {
    const raw = rawDimensions[dim];
    if (typeof raw !== 'number') {
      throw new Error(`Missing raw value for scoring dimension "${dim}"`);
    }
    const { normalized, inverted } = normalizeDimension(dim, raw, normalizationConfig);
    const weight = weightsConfig.weights[dim];
    if (typeof weight !== 'number') {
      throw new Error(`Missing weight for scoring dimension "${dim}"`);
    }
    const contribution = normalized * weight;
    components[dim] = { raw, normalized, inverted, weight, contribution };
    weightedSum += contribution;
    weightTotal += weight;
  }

  const overallScore = weightTotal === 0 ? 0 : (weightedSum / weightTotal) * 100; // 0-100 scale, matches opportunities.overall_score convention

  const breakdown = {
    version: weightsConfig.version,
    normalization_version: discoveryPolicyVersion || null,
    components,
    final: { overall_score: overallScore }
  };

  return { overallScore, breakdown };
}
