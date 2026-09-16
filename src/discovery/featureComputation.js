import { VALUE_DIMENSIONS } from './scoring.js';

// Production Discovery Feature Computation (M2).
//
// Provides the production-safe rawFeatures(observation) contract consumed
// by src/discovery/pipeline.js (runDiscoveryPipeline), so the autonomous
// entrypoint no longer depends on manually injected deps.discovery.rawFeatures.
//
// This module does NOT change runDiscoveryPipeline()'s public behavior or
// signature: rawFeatures remains a plain fn(observation) => {...} passed
// through unchanged. It only supplies a real implementation of that
// function, in the same spirit as src/discovery/proposition.js supplying
// generateProposition() for the proposition-generation stage.
//
// Owner-mandated hybrid design (M2):
//
//   Deterministic-authoritative (no LLM):
//     policyRisk, copyrightRisk, repetitionRisk
//
//   LLM-assisted (via the existing LLMRouter only):
//     novelty, competition, story_potential, evidence_availability,
//     production_difficulty, audience_potential, commercial_intent,
//     affiliate_potential, lead_generation_potential, product_adjacency,
//     sponsorship_potential
//
// Why competition / evidence_availability / production_difficulty are
// LLM-assisted rather than deterministic: the only data available at this
// call site is { title, description, sourceUrl, sourceId, sourceType,
// feedUrl, publishedAt, discoveredAt, retrievedAt } (see
// src/providers/opportunity/RssSource.js#normalize). There is no existing
// repository signal for how many competing videos/articles exist
// (competition), whether a claim is independently verifiable (evidence
// availability — that determination belongs to the separately-scoped
// Research subsystem, per pipeline.js's own rawFeatures docstring), or how
// hard a topic is to produce. Any keyword-based heuristic for these three
// would be a fabricated, pseudo-objective calculation with no basis in
// existing architecture — which the Owner explicitly disallowed. Routing
// them through the same structured LLM call as the other subjective
// dimensions is the defensible choice given current data.
//
// Why policyRisk / copyrightRisk / repetitionRisk are deterministic and
// fixed at 0 by default: RSS title+description alone provide no positive
// evidence of a policy or copyright violation, and no repository utility
// exists (and none is invented here) to detect one. Absence of a detected
// risk signal is reported honestly as 0 (no risk detected), not fabricated
// as a nonzero "just in case" value — mirroring this codebase's existing
// pattern of treating absence of data as non-disqualifying rather than
// inventing a value (see src/discovery/eligibility.js's isStale(), which
// returns false — "can't assess... not itself a rejection reason" — when
// no timestamp is available). repetitionRisk specifically also reflects
// that Event Dedup (checkDuplicate) and Hard Eligibility's
// already-produced-corpus check already run earlier in
// runDiscoveryPipeline, against the full accepted-candidates set and
// alreadyProducedCorpus, before rawFeatures(observation) is ever invoked.
// rawFeatures is called with a single observation only (pipeline.js is
// unmodified by this milestone), so no comparison corpus is available at
// this call site to compute a further repetition signal against.

// The 3 risk dimensions are handled deterministically; every other
// contract field is a VALUE_DIMENSIONS entry (0-100) and is requested from
// the LLM in a single structured call, mirroring proposition.js's
// single-call, multi-field JSON extraction pattern.
const LLM_VALUE_FIELDS = VALUE_DIMENSIONS;

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Deterministic risk-dimension computation. Pure function of the
 * observation; makes no network/LLM call. See module docstring for the
 * documented rationale behind the fixed 0 baseline.
 */
export function computeDeterministicRiskFeatures(_observation) {
  return {
    policyRisk: 0,
    copyrightRisk: 0,
    repetitionRisk: 0
  };
}

function buildFeaturePrompt(observation) {
  return [
    'Given the content observation below, estimate the following content',
    'opportunity dimensions as strict JSON with exactly these numeric',
    'fields, each an integer or decimal from 0 to 100 (inclusive):',
    LLM_VALUE_FIELDS.join(', ') + '.',
    'novelty: how new/unique this angle is (0=extremely common, 100=highly novel).',
    'competition: how much existing coverage/competition this topic already has',
    '(0=no existing coverage, 100=heavily saturated).',
    'story_potential: how compelling this is as a narrative (0=dry/flat, 100=highly compelling).',
    'evidence_availability: how likely verifiable evidence/sources exist for this',
    '(0=unlikely to be verifiable, 100=abundant verifiable evidence likely exists).',
    'production_difficulty: how hard this would be to produce as video content',
    '(0=trivial to produce, 100=extremely difficult to produce).',
    'audience_potential: how large an interested audience this could reach',
    '(0=very niche, 100=very broad).',
    'commercial_intent: how much commercial/monetization relevance this topic carries',
    '(0=none, 100=very high).',
    'affiliate_potential: how well this topic supports affiliate-link monetization',
    '(0=none, 100=very high).',
    'lead_generation_potential: how well this topic supports lead generation',
    '(0=none, 100=very high).',
    'product_adjacency: how closely this topic relates to sellable products/services',
    '(0=unrelated, 100=directly adjacent).',
    'sponsorship_potential: how attractive this topic is to sponsors',
    '(0=none, 100=very high).',
    'Return ONLY the JSON object. No prose, no markdown fences, no explanation.',
    `Title: ${observation.title || ''}`,
    `Description: ${observation.description || ''}`
  ].join('\n');
}

/**
 * Parses and validates the LLM's structured response against the required
 * value-dimension contract. Does not clamp missing/non-numeric/NaN/
 * Infinity values into a fabricated default — those are explicit failures.
 * Finite numeric values outside [0, 100] are clamped into range here
 * (the feature-computation boundary owns this, rather than relying solely
 * on src/discovery/scoring.js's downstream normalizeDimension() clamp).
 *
 * @throws Error if the response is not parseable JSON, or any required
 *   field is missing, non-numeric, NaN, or Infinity.
 */
export function parseAndValidateLlmFeatures(rawText) {
  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch (err) {
    throw new Error(
      `computeRawFeatures: LLM response was not valid JSON: ${err.message}`
    );
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new Error('computeRawFeatures: LLM response JSON was not an object');
  }

  const result = {};
  const missingOrInvalid = [];

  for (const field of LLM_VALUE_FIELDS) {
    const value = parsed[field];
    if (!isFiniteNumber(value)) {
      missingOrInvalid.push(field);
      continue;
    }
    result[field] = Math.min(100, Math.max(0, value));
  }

  if (missingOrInvalid.length > 0) {
    throw new Error(
      `computeRawFeatures: LLM response missing or invalid numeric value for: ${missingOrInvalid.join(', ')}`
    );
  }

  return result;
}

/**
 * Production rawFeatures(observation) implementation. Matches the exact
 * contract documented by src/discovery/pipeline.js's runDiscoveryPipeline
 * jsdoc: fn(observation) => { novelty, competition, story_potential,
 * evidence_availability, production_difficulty, audience_potential,
 * commercial_intent, affiliate_potential, lead_generation_potential,
 * product_adjacency, sponsorship_potential, policyRisk, copyrightRisk,
 * repetitionRisk }.
 *
 * All LLM access goes through the provided llmRouter (LLMRouter#complete)
 * — no provider is instantiated directly here, and existing paid-provider
 * gating / provider priority are fully respected because they live in
 * LLMRouter itself, unmodified by this module.
 *
 * Does not silently fabricate a plausible score when the LLM call fails or
 * returns malformed output — this function throws explicitly instead, so
 * that failure is visible rather than producing misleading feature values.
 *
 * @param observation - normalized observation (see RssSource#normalize)
 * @param llmRouter - an LLMRouter instance (src/providers/llm/router.js)
 * @returns {Promise<object>} the full rawFeatures contract object
 * @throws Error if the LLM call fails, or its output is malformed/incomplete
 */
export async function computeRawFeatures(observation, llmRouter) {
  if (!llmRouter) {
    throw new Error('computeRawFeatures requires an llmRouter');
  }

  const riskFeatures = computeDeterministicRiskFeatures(observation);

  const prompt = buildFeaturePrompt(observation);
  const { result } = await llmRouter.complete({ prompt });

  const valueFeatures = parseAndValidateLlmFeatures(result.text);

  return {
    ...valueFeatures,
    ...riskFeatures
  };
}

export default computeRawFeatures;
