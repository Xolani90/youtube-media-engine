import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkDuplicate, layer1ExactMatch, layer2Similarity, createDedupWorkloadBudget, DEDUP_RESULT } from '../../src/discovery/dedup.js';
import { LLMRouter } from '../../src/providers/llm/router.js';

const thresholds = { candidate_threshold: 0.3, confident_duplicate_threshold: 0.8 };

function countingRouter(responseText = '{"sameEvent": true, "distinctAngle": true}') {
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

const DISTINCT_PAIR = () => ({
  a: { title: 'Cats and dogs playing outside', description: 'pets', sourceUrl: null, sourceId: null },
  b: { title: 'Quarterly earnings report released', description: 'finance', sourceUrl: null, sourceId: null }
});

const AMBIGUOUS_PAIR = () => ({
  a: { title: 'New AI model launched for small business automation workflows', description: '', sourceUrl: null, sourceId: null },
  b: { title: 'New AI model launched for enterprise automation workflows', description: '', sourceUrl: null, sourceId: null }
});

test('sanity: the fixture pair actually lands in the Layer-2 ambiguous band', () => {
  const { a, b } = AMBIGUOUS_PAIR();
  const sim = layer2Similarity(a, b, thresholds);
  assert.equal(sim.result, DEDUP_RESULT.AMBIGUOUS, `expected ambiguous band, got score ${sim.score}`);
});

test('L1 is never gated by the budget, even at zero remaining L2/L3 budget', async () => {
  const budget = createDedupWorkloadBudget({ l2Cap: 0, l3Cap: 0 });
  const a = { title: 'Foo', sourceUrl: null, sourceId: 'dup-1' };
  const b = { title: 'Bar', sourceUrl: null, sourceId: 'dup-1' };
  const { router } = countingRouter();
  const result = await checkDuplicate(a, b, { thresholds, llmRouter: router, budget });
  assert.equal(result.eventMatch, DEDUP_RESULT.DUPLICATE);
  assert.equal(result.ceilingReason, null);
  assert.deepEqual(result.layersUsed, ['layer1']);
});

test('L2 exhaustion: an already-exhausted L2 budget makes the pair UNRESOLVED without computing similarity', async () => {
  const budget = createDedupWorkloadBudget({ l2Cap: 0 });
  const { a, b } = DISTINCT_PAIR();
  const { router, getCalls } = countingRouter();
  const result = await checkDuplicate(a, b, { thresholds, llmRouter: router, budget });
  assert.equal(result.eventMatch, DEDUP_RESULT.UNRESOLVED);
  assert.equal(result.ceilingReason, 'L2');
  assert.equal(getCalls(), 0, 'never fabricated via an LLM call');
  assert.deepEqual(result.layersUsed, ['layer1'], 'layer2 was never entered');
});

test('exact-N-then-refuse: the Nth comparison succeeds, the (N+1)th is UNRESOLVED', async () => {
  const budget = createDedupWorkloadBudget({ l2Cap: 1 });
  const { a, b } = DISTINCT_PAIR();
  const { router } = countingRouter();

  const first = await checkDuplicate(a, b, { thresholds, llmRouter: router, budget });
  assert.equal(first.eventMatch, DEDUP_RESULT.DISTINCT);
  assert.equal(budget.l2Used, 1);

  const second = await checkDuplicate(a, b, { thresholds, llmRouter: router, budget });
  assert.equal(second.eventMatch, DEDUP_RESULT.UNRESOLVED);
  assert.equal(second.ceilingReason, 'L2');
});

test('L3 exhaustion after a REAL Layer-2 AMBIGUOUS: UNRESOLVED, no LLM call made', async () => {
  const budget = createDedupWorkloadBudget({ l2Cap: 10, l3Cap: 0 });
  const { a, b } = AMBIGUOUS_PAIR();
  const { router, getCalls } = countingRouter();

  const result = await checkDuplicate(a, b, { thresholds, llmRouter: router, budget });
  assert.equal(result.eventMatch, DEDUP_RESULT.UNRESOLVED);
  assert.equal(result.ceilingReason, 'L3');
  assert.equal(getCalls(), 0);
  assert.deepEqual(result.layersUsed, ['layer1', 'layer2'], 'layer3 was never entered');
  assert.equal(budget.l2Used, 1, 'the layer-2 comparison itself still counted against the L2 budget');
});

test('L2 exhaustion makes L3 unreachable for that pair, as a natural consequence (not a separate rule)', async () => {
  const budget = createDedupWorkloadBudget({ l2Cap: 0, l3Cap: 100 });
  const { a, b } = AMBIGUOUS_PAIR();
  const { router, getCalls } = countingRouter();

  const result = await checkDuplicate(a, b, { thresholds, llmRouter: router, budget });
  assert.equal(result.eventMatch, DEDUP_RESULT.UNRESOLVED);
  assert.equal(result.ceilingReason, 'L2', 'L2 exhaustion is reported, never misattributed to L3');
  assert.equal(getCalls(), 0);
  assert.equal(budget.l3Used, 0, 'L3 budget was never touched -- the pair never got far enough to need it');
});

test('normal L3 resolution is unaffected when budget is ample: one LLM call, DUPLICATE with distinctAngle', async () => {
  const budget = createDedupWorkloadBudget({ l2Cap: 10, l3Cap: 10 });
  const { a, b } = AMBIGUOUS_PAIR();
  const { router, getCalls } = countingRouter('{"sameEvent": true, "distinctAngle": true}');

  const result = await checkDuplicate(a, b, { thresholds, llmRouter: router, budget });
  assert.equal(result.eventMatch, DEDUP_RESULT.DUPLICATE);
  assert.equal(result.distinctAngle, true);
  assert.equal(result.ceilingReason, null);
  assert.equal(getCalls(), 1);
  assert.equal(budget.l2Used, 1);
  assert.equal(budget.l3Used, 1);
});

test('backward-compatible unbounded default: omitting budget entirely never produces UNRESOLVED', async () => {
  const { a, b } = AMBIGUOUS_PAIR();
  const { router, getCalls } = countingRouter('{"sameEvent": false, "distinctAngle": false}');

  const result = await checkDuplicate(a, b, { thresholds, llmRouter: router });
  assert.notEqual(result.eventMatch, DEDUP_RESULT.UNRESOLVED);
  assert.equal(result.ceilingReason, null);
  assert.equal(getCalls(), 1);
});