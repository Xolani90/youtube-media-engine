import test from 'node:test';
import assert from 'node:assert/strict';

import {
  computeRawFeatures,
  computeDeterministicRiskFeatures,
  parseAndValidateLlmFeatures
} from '../../src/discovery/featureComputation.js';

const VALID_VALUE_FIELDS = {
  novelty: 90,
  competition: 10,
  story_potential: 90,
  evidence_availability: 90,
  production_difficulty: 10,
  audience_potential: 90,
  commercial_intent: 90,
  affiliate_potential: 90,
  lead_generation_potential: 90,
  product_adjacency: 90,
  sponsorship_potential: 90
};

function stubRouter(responseText) {
  return {
    async complete() {
      return { result: { text: responseText } };
    }
  };
}

test('computeDeterministicRiskFeatures is a pure, deterministic function of the observation', () => {
  const a = computeDeterministicRiskFeatures({ title: 'x' });
  const b = computeDeterministicRiskFeatures({ title: 'x' });

  assert.deepEqual(a, b);
  assert.equal(a.policyRisk, 0);
  assert.equal(a.copyrightRisk, 0);
  assert.equal(a.repetitionRisk, 0);
});

test('parseAndValidateLlmFeatures accepts a complete, valid response', () => {
  const result = parseAndValidateLlmFeatures(
    JSON.stringify(VALID_VALUE_FIELDS)
  );

  for (const [field, value] of Object.entries(VALID_VALUE_FIELDS)) {
    assert.equal(result[field], value);
  }
});

test('parseAndValidateLlmFeatures rejects non-JSON output', () => {
  assert.throws(
    () => parseAndValidateLlmFeatures('not json'),
    /not valid JSON/
  );
});

test('parseAndValidateLlmFeatures rejects missing fields rather than fabricating them', () => {
  assert.throws(
    () => parseAndValidateLlmFeatures(JSON.stringify({ novelty: 50 })),
    /missing or invalid numeric value/
  );
});

test('parseAndValidateLlmFeatures rejects NaN/Infinity values', () => {
  const badPayload = { ...VALID_VALUE_FIELDS, novelty: Infinity };

  assert.throws(
    () => parseAndValidateLlmFeatures(JSON.stringify(badPayload)),
    /missing or invalid numeric value/
  );
});

test('parseAndValidateLlmFeatures clamps finite out-of-range values into [0, 100]', () => {
  const payload = {
    ...VALID_VALUE_FIELDS,
    novelty: 150,
    competition: -20
  };

  const result = parseAndValidateLlmFeatures(JSON.stringify(payload));

  assert.equal(result.novelty, 100);
  assert.equal(result.competition, 0);
});

test('computeRawFeatures returns the full contract, combining deterministic risk dims with LLM-derived value dims, using only the injected llmRouter', async () => {
  const router = stubRouter(JSON.stringify(VALID_VALUE_FIELDS));
  const features = await computeRawFeatures(
    { title: 't', description: 'd' },
    router
  );

  for (const field of Object.keys(VALID_VALUE_FIELDS)) {
    assert.equal(features[field], VALID_VALUE_FIELDS[field]);
  }

  assert.equal(features.policyRisk, 0);
  assert.equal(features.copyrightRisk, 0);
  assert.equal(features.repetitionRisk, 0);
});

test('computeRawFeatures rejects rather than fabricates when the LLM output is malformed', async () => {
  const router = stubRouter(JSON.stringify({ novelty: 90 }));

  await assert.rejects(
    () => computeRawFeatures({ title: 't', description: 'd' }, router),
    /missing or invalid numeric value/
  );
});

test('computeRawFeatures requires an llmRouter to be provided', async () => {
  await assert.rejects(
    () => computeRawFeatures({ title: 't' }, null),
    /requires an llmRouter/
  );
});

// --- ADR-0037: features maxTokens ceiling ---

test('ADR-0037: computeRawFeatures supplies maxTokens=500 to llmRouter.complete', async () => {
  let capturedRequest = null;
  const router = {
    async complete(request) {
      capturedRequest = request;
      return { result: { text: JSON.stringify(VALID_VALUE_FIELDS) } };
    }
  };
  await computeRawFeatures({ title: 't', description: 'd' }, router);
  assert.ok(capturedRequest, 'expected computeRawFeatures to have made an LLM call');
  assert.equal(capturedRequest.maxTokens, 500);
});

test('ADR-0037: a truncated (mid-field, unparseable) features response retains the existing throw behavior, unaffected by the ceiling', async () => {
  // Simulates a response cut off mid-generation, e.g. by a maxTokens ceiling.
  const truncated = '{"novelty": 90, "competition": 10, "story_potential":';
  const router = stubRouter(truncated);
  await assert.rejects(
    () => computeRawFeatures({ title: 't', description: 'd' }, router),
    /not valid JSON/
  );
});
