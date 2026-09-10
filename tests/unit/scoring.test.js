import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeValueScore, normalizeDimension, VALUE_DIMENSIONS } from '../../src/discovery/scoring.js';
import discoveryPolicy from '../../config/discovery_policy.json' with { type: 'json' };
import scoringWeights from '../../config/scoring_weights.json' with { type: 'json' };

const normalizationConfig = discoveryPolicy.normalization;

test('competition is inverted: high raw competition -> low normalized value', () => {
  const { normalized, inverted } = normalizeDimension('competition', 90, normalizationConfig);
  assert.equal(inverted, true);
  assert.ok(normalized < 0.2, `expected low normalized value for high competition, got ${normalized}`);
});

test('production_difficulty is inverted: high raw difficulty -> low normalized value', () => {
  const { normalized, inverted } = normalizeDimension('production_difficulty', 90, normalizationConfig);
  assert.equal(inverted, true);
  assert.ok(normalized < 0.2);
});

test('novelty is NOT inverted: high raw novelty -> high normalized value', () => {
  const { normalized, inverted } = normalizeDimension('novelty', 90, normalizationConfig);
  assert.equal(inverted, false);
  assert.ok(normalized > 0.8);
});

test('out-of-range raw values are clamped', () => {
  const { normalized } = normalizeDimension('novelty', 999, normalizationConfig);
  assert.equal(normalized, 1);
  const { normalized: low } = normalizeDimension('novelty', -50, normalizationConfig);
  assert.equal(low, 0);
});

function allDimensions(overrides = {}) {
  const base = {};
  for (const d of VALUE_DIMENSIONS) base[d] = 50;
  return { ...base, ...overrides };
}

test('equal weighting produces sane relative rankings only after inversion', () => {
  // A candidate with LOW competition (good) and LOW production_difficulty (good)
  // should score higher than one with HIGH competition and HIGH difficulty,
  // all else equal — this only holds true if inversion is actually applied.
  const good = computeValueScore(allDimensions({ competition: 10, production_difficulty: 10 }), { weightsConfig: scoringWeights, normalizationConfig, discoveryPolicyVersion: discoveryPolicy.version });
  const bad = computeValueScore(allDimensions({ competition: 90, production_difficulty: 90 }), { weightsConfig: scoringWeights, normalizationConfig, discoveryPolicyVersion: discoveryPolicy.version });
  assert.ok(good.overallScore > bad.overallScore, `expected low-competition/low-difficulty to score higher: good=${good.overallScore} bad=${bad.overallScore}`);
});

test('score_breakdown preserves every dimension individually, not just the final number', () => {
  const { breakdown } = computeValueScore(allDimensions(), { weightsConfig: scoringWeights, normalizationConfig, discoveryPolicyVersion: discoveryPolicy.version });
  for (const dim of ['audience_potential', 'commercial_intent', 'affiliate_potential', 'lead_generation_potential', 'product_adjacency', 'sponsorship_potential']) {
    assert.ok(dim in breakdown.components, `expected ${dim} to be individually visible in score_breakdown`);
  }
  assert.ok('overall_score' in breakdown.final);
});

test('score_breakdown embeds weight and normalization configuration versions', () => {
  const { breakdown } = computeValueScore(allDimensions(), { weightsConfig: scoringWeights, normalizationConfig, discoveryPolicyVersion: discoveryPolicy.version });
  assert.equal(breakdown.version, scoringWeights.version);
  assert.equal(breakdown.normalization_version, discoveryPolicy.version);
});

test('GOVERNANCE FINDING (not a pass/fail assertion of the anti-gaming property): under equal weighting across all 11 value-score dimensions (5 non-monetization + 6 monetization), a candidate with extreme high monetization and extreme low audience/editorial value can numerically outscore the reverse case, purely because monetization occupies 6 of the 11 equally-weighted slots. This is reported to the Owner/Architect as a conflict between two frozen decisions (§9 anti-gaming constraint vs. §9/§10 equal weighting across 11 dimensions) rather than silently resolved — see implementation report §H.', () => {
  const highAudienceLowMonetization = computeValueScore(
    allDimensions({
      novelty: 90, story_potential: 90, evidence_availability: 90,
      audience_potential: 10, commercial_intent: 10, affiliate_potential: 10,
      lead_generation_potential: 10, product_adjacency: 10, sponsorship_potential: 10
    }),
    { weightsConfig: scoringWeights, normalizationConfig, discoveryPolicyVersion: discoveryPolicy.version }
  );
  const lowAudienceHighMonetization = computeValueScore(
    allDimensions({
      novelty: 10, story_potential: 10, evidence_availability: 10,
      audience_potential: 90, commercial_intent: 90, affiliate_potential: 90,
      lead_generation_potential: 90, product_adjacency: 90, sponsorship_potential: 90
    }),
    { weightsConfig: scoringWeights, normalizationConfig, discoveryPolicyVersion: discoveryPolicy.version }
  );
  // This assertion documents MEASURED behavior (it currently PASSES because
  // the low-audience/high-monetization case DOES numerically outscore the
  // high-audience/low-monetization case) — it is deliberately asserting the
  // observed outcome, not the desired one, so this test fails loudly if a
  // future change silently "fixes" this without a recorded governance
  // decision. See the implementation report for the required next step.
  assert.ok(
    lowAudienceHighMonetization.overallScore > highAudienceLowMonetization.overallScore,
    'This assertion documents the current measured (undesired) behavior — see report §H.'
  );
});

test('missing raw dimension throws rather than silently scoring incompletely', () => {
  const incomplete = allDimensions();
  delete incomplete.novelty;
  assert.throws(() => computeValueScore(incomplete, { weightsConfig: scoringWeights, normalizationConfig, discoveryPolicyVersion: discoveryPolicy.version }));
});
