import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkDuplicate, layer1ExactMatch, layer2Similarity, DEDUP_RESULT } from '../../src/discovery/dedup.js';
import { LLMRouter } from '../../src/providers/llm/router.js';

const thresholds = { candidate_threshold: 0.3, confident_duplicate_threshold: 0.8 };

// A router whose only provider records how many times complete() was called,
// so tests can assert exactly-zero or exactly-one LLM invocations.
function countingRouter(responseText = '{"sameEvent": true, "distinctAngle": false}') {
  let calls = 0;
  const registry = {
    'counting-stub': () => ({
      id: 'counting-stub',
      isPaid: false,
      async healthCheck() { return true; },
      async complete() {
        calls++;
        return { text: responseText, model: 'counting-stub', requestId: null, inputTokens: 1, outputTokens: 1, estimatedCost: 0, isPaid: false };
      }
    })
  };
  const router = new LLMRouter({ priority: ['counting-stub'], allowPaidProviders: false, registry });
  return { router, getCalls: () => calls };
}

test('Layer 1 exact URL match -> DUPLICATE, zero LLM calls', async () => {
  const a = { title: 'Foo', sourceUrl: 'https://example.com/x', sourceId: null };
  const b = { title: 'Bar', sourceUrl: 'https://example.com/x?utm_source=twitter', sourceId: null };
  const { router, getCalls } = countingRouter();
  const result = await checkDuplicate(a, b, { thresholds, llmRouter: router });
  assert.equal(result.eventMatch, DEDUP_RESULT.DUPLICATE);
  assert.equal(result.llmCallMade, false);
  assert.equal(getCalls(), 0);
  assert.deepEqual(result.layersUsed, ['layer1']);
});

test('Layer 1 exact sourceId match -> DUPLICATE', () => {
  const a = { title: 'Foo', sourceUrl: null, sourceId: 'guid-1' };
  const b = { title: 'Bar', sourceUrl: null, sourceId: 'guid-1' };
  assert.equal(layer1ExactMatch(a, b), DEDUP_RESULT.DUPLICATE);
});

test('Layer 2 clearly distinct -> DISTINCT, zero LLM calls', async () => {
  const a = { title: 'Cats and dogs playing outside', description: 'pets' };
  const b = { title: 'Quarterly earnings report released', description: 'finance' };
  const { router, getCalls } = countingRouter();
  const result = await checkDuplicate(a, b, { thresholds, llmRouter: router });
  assert.equal(result.eventMatch, DEDUP_RESULT.DISTINCT);
  assert.equal(result.llmCallMade, false);
  assert.equal(getCalls(), 0);
  assert.deepEqual(result.layersUsed, ['layer1', 'layer2']);
});

test('Layer 2 clearly duplicate (high similarity) -> DUPLICATE, zero LLM calls', async () => {
  const a = { title: 'OpenAI releases new GPT model for businesses today', description: 'launch announcement' };
  const b = { title: 'OpenAI releases new GPT model for businesses today', description: 'launch announcement details' };
  const { router, getCalls } = countingRouter();
  const result = await checkDuplicate(a, b, { thresholds, llmRouter: router });
  assert.equal(result.eventMatch, DEDUP_RESULT.DUPLICATE);
  assert.equal(getCalls(), 0);
});

test('Ambiguous similarity band escalates to Layer 3, exactly one LLM call', async () => {
  // Constructed to land in the [0.3, 0.8) ambiguous band.
  const a = { title: 'New AI model launched for small business automation workflows', description: '' };
  const b = { title: 'New AI model launched for enterprise automation workflows', description: '' };
  const sim = layer2Similarity(a, b, thresholds);
  assert.equal(sim.result, DEDUP_RESULT.AMBIGUOUS, `test fixture must land in ambiguous band, got score ${sim.score}`);

  const { router, getCalls } = countingRouter('{"sameEvent": true, "distinctAngle": true}');
  const result = await checkDuplicate(a, b, { thresholds, llmRouter: router });
  assert.equal(result.llmCallMade, true);
  assert.equal(getCalls(), 1);
  assert.deepEqual(result.layersUsed, ['layer1', 'layer2', 'layer3']);
});

test('Layer 3 same event + distinct angle -> DUPLICATE eventMatch with distinctAngle=true (survives as separate opportunity)', async () => {
  const a = { title: 'New AI model launched for small business automation workflows', description: '' };
  const b = { title: 'New AI model launched for enterprise automation workflows', description: '' };
  const { router } = countingRouter('{"sameEvent": true, "distinctAngle": true}');
  const result = await checkDuplicate(a, b, { thresholds, llmRouter: router });
  assert.equal(result.eventMatch, DEDUP_RESULT.DUPLICATE);
  assert.equal(result.distinctAngle, true);
});

test('malformed LLM output falls back to conservative same-event/no-distinct-angle', async () => {
  const a = { title: 'New AI model launched for small business automation workflows', description: '' };
  const b = { title: 'New AI model launched for enterprise automation workflows', description: '' };
  const { router } = countingRouter('not valid json');
  const result = await checkDuplicate(a, b, { thresholds, llmRouter: router });
  assert.equal(result.eventMatch, DEDUP_RESULT.DUPLICATE);
  assert.equal(result.distinctAngle, false);
});
