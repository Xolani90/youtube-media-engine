import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CostTracker, BudgetExceededError } from '../../src/state/CostTracker.js';

/**
 * D-B2 — Cumulative Per-Content Budget.
 *
 * These tests cover only the cumulative-per-content_id ceiling
 * (maxCumulativeCostPerContent) and its interaction with the existing
 * D-B1 per-call ceiling (maxCostPerContent). They do not modify or
 * weaken any existing D-B1/D-D1/D-D2 test.
 *
 * Same mock-storage convention as tests/unit/llm-router-cost.test.js —
 * a plain in-memory stand-in for the two SQL calls CostTracker needs
 * (`get`/`run`), used because this sandbox's better-sqlite3 native
 * binary is Windows-built and cannot load here.
 */
function mockStorage() {
  const rows = [];
  return {
    rows,
    run(sql, params) {
      // INSERT INTO provider_calls (id, run_id, content_id, job_stage, provider, model, request_id, input_tokens, output_tokens, estimated_cost, actual_cost, is_paid, timestamp)
      rows.push({ content_id: params[2], estimated_cost: params[9] });
    },
    get(sql, params) {
      const contentId = params[0];
      const total = rows
        .filter((r) => r.content_id === contentId)
        .reduce((sum, r) => sum + r.estimated_cost, 0);
      return { total };
    }
  };
}

test('D-B2: a call that would exceed the cumulative content ceiling is rejected', () => {
  const storage = mockStorage();
  const costs = new CostTracker(storage, {
    maxDailySpend: 1000, maxMonthlySpend: 1000, maxCostPerContent: 100, maxCumulativeCostPerContent: 5
  });

  costs.record({ runId: 'run-1', contentId: 'content-1', provider: 'fake-paid', estimatedCost: 4, isPaid: true });
  assert.throws(
    () => costs.record({ runId: 'run-1', contentId: 'content-1', provider: 'fake-paid', estimatedCost: 2, isPaid: true }),
    BudgetExceededError
  );
});

test('D-B2: calls that stay under the cumulative content ceiling remain allowed', () => {
  const storage = mockStorage();
  const costs = new CostTracker(storage, {
    maxDailySpend: 1000, maxMonthlySpend: 1000, maxCostPerContent: 100, maxCumulativeCostPerContent: 10
  });

  const id1 = costs.record({ runId: 'run-1', contentId: 'content-2', provider: 'fake-paid', estimatedCost: 3, isPaid: true });
  const id2 = costs.record({ runId: 'run-1', contentId: 'content-2', provider: 'fake-paid', estimatedCost: 3, isPaid: true });
  assert.ok(id1);
  assert.ok(id2);
  assert.equal(costs.contentSpend('content-2'), 6);
});

test('D-B2: cumulative spend landing exactly on the configured limit is accepted (strict ">" boundary)', () => {
  const storage = mockStorage();
  const costs = new CostTracker(storage, {
    maxDailySpend: 1000, maxMonthlySpend: 1000, maxCostPerContent: 100, maxCumulativeCostPerContent: 5
  });

  // First call: nonzero spend, under the limit.
  costs.record({ runId: 'run-1', contentId: 'content-boundary', provider: 'fake-paid', estimatedCost: 3, isPaid: true });
  // Second call brings cumulative spend to EXACTLY the configured limit
  // (3 + 2 === 5). The enforcement rule is "current + new > limit", so
  // landing exactly on the limit must be accepted, not rejected.
  const id2 = costs.record({ runId: 'run-1', contentId: 'content-boundary', provider: 'fake-paid', estimatedCost: 2, isPaid: true });
  assert.ok(id2);

  const rowsForContent = storage.rows.filter((r) => r.content_id === 'content-boundary');
  assert.equal(rowsForContent.length, 2); // both calls, including the boundary-landing one, exist

  assert.equal(costs.contentSpend('content-boundary'), 5); // exactly at the limit
});

test('D-B2: free/local zero-cost calls do not consume the cumulative budget', () => {
  const storage = mockStorage();
  const costs = new CostTracker(storage, {
    maxDailySpend: 1000, maxMonthlySpend: 1000, maxCostPerContent: 100, maxCumulativeCostPerContent: 5
  });

  costs.record({ runId: 'run-1', contentId: 'content-3', provider: 'local-stub', estimatedCost: 0, isPaid: false });
  costs.record({ runId: 'run-1', contentId: 'content-3', provider: 'local-stub', estimatedCost: 0, isPaid: false });
  assert.equal(costs.contentSpend('content-3'), 0);
  // A subsequent paid call still has the full cumulative ceiling available.
  const id = costs.record({ runId: 'run-1', contentId: 'content-3', provider: 'fake-paid', estimatedCost: 5, isPaid: true });
  assert.ok(id);
});

test('D-B2: a rejected cumulative-budget call does not create a provider_calls row', () => {
  const storage = mockStorage();
  const costs = new CostTracker(storage, {
    maxDailySpend: 1000, maxMonthlySpend: 1000, maxCostPerContent: 100, maxCumulativeCostPerContent: 5
  });

  costs.record({ runId: 'run-1', contentId: 'content-4', provider: 'fake-paid', estimatedCost: 5, isPaid: true });
  assert.throws(
    () => costs.record({ runId: 'run-1', contentId: 'content-4', provider: 'fake-paid', estimatedCost: 0.01, isPaid: true }),
    BudgetExceededError
  );
  const rowsForContent = storage.rows.filter((r) => r.content_id === 'content-4');
  assert.equal(rowsForContent.length, 1); // only the first, accepted call was recorded
});

test('D-B2: successful paid calls accumulate against the same content_id', () => {
  const storage = mockStorage();
  const costs = new CostTracker(storage, {
    maxDailySpend: 1000, maxMonthlySpend: 1000, maxCostPerContent: 100, maxCumulativeCostPerContent: 100
  });

  costs.record({ runId: 'run-1', contentId: 'content-5', provider: 'fake-paid', estimatedCost: 1, isPaid: true });
  costs.record({ runId: 'run-1', contentId: 'content-5', provider: 'fake-paid', estimatedCost: 2, isPaid: true });
  costs.record({ runId: 'run-1', contentId: 'content-5', provider: 'fake-paid', estimatedCost: 3, isPaid: true });
  assert.equal(costs.contentSpend('content-5'), 6);
});

test('D-B2: calls from multiple pipeline stages accumulate against the same content_id', () => {
  const storage = mockStorage();
  const costs = new CostTracker(storage, {
    maxDailySpend: 1000, maxMonthlySpend: 1000, maxCostPerContent: 100, maxCumulativeCostPerContent: 100
  });

  costs.record({ runId: 'run-1', contentId: 'content-6', jobStage: 'research', provider: 'fake-paid', estimatedCost: 1, isPaid: true });
  costs.record({ runId: 'run-1', contentId: 'content-6', jobStage: 'brief', provider: 'fake-paid', estimatedCost: 1, isPaid: true });
  costs.record({ runId: 'run-1', contentId: 'content-6', jobStage: 'script', provider: 'fake-paid', estimatedCost: 1, isPaid: true });
  assert.equal(costs.contentSpend('content-6'), 3);
});

test('D-B2: rerunning/reprocessing the same content_id does not reset cumulative spend', () => {
  const storage = mockStorage();
  const costs = new CostTracker(storage, {
    maxDailySpend: 1000, maxMonthlySpend: 1000, maxCostPerContent: 100, maxCumulativeCostPerContent: 5
  });

  // Original attempt at some stage.
  costs.record({ runId: 'run-1', contentId: 'content-7', jobStage: 'script', provider: 'fake-paid', estimatedCost: 3, isPaid: true });
  // A rerun/regeneration of that same content later, potentially in a
  // different run, still draws from the same content-scoped total.
  costs.record({ runId: 'run-2', contentId: 'content-7', jobStage: 'script', provider: 'fake-paid', estimatedCost: 1.5, isPaid: true });
  assert.equal(costs.contentSpend('content-7'), 4.5);
  // The next rerun attempt that would push the lifetime total over the
  // ceiling is rejected — the budget was never reset by the rerun.
  assert.throws(
    () => costs.record({ runId: 'run-2', contentId: 'content-7', jobStage: 'script', provider: 'fake-paid', estimatedCost: 1, isPaid: true }),
    BudgetExceededError
  );
});

test('D-B2: a new content_id starts an independent cumulative budget', () => {
  const storage = mockStorage();
  const costs = new CostTracker(storage, {
    maxDailySpend: 1000, maxMonthlySpend: 1000, maxCostPerContent: 100, maxCumulativeCostPerContent: 5
  });

  costs.record({ runId: 'run-1', contentId: 'content-8a', provider: 'fake-paid', estimatedCost: 5, isPaid: true });
  // content-8a's budget is now exhausted, but a different content_id is unaffected.
  const id = costs.record({ runId: 'run-1', contentId: 'content-8b', provider: 'fake-paid', estimatedCost: 5, isPaid: true });
  assert.ok(id);
  assert.equal(costs.contentSpend('content-8a'), 5);
  assert.equal(costs.contentSpend('content-8b'), 5);
});

test('D-B2: a paid call that is accounted for and then fails during provider invocation still consumes its reserved cost (no refund)', async () => {
  const storage = mockStorage();
  const costs = new CostTracker(storage, {
    maxDailySpend: 1000, maxMonthlySpend: 1000, maxCostPerContent: 100, maxCumulativeCostPerContent: 5
  });

  // Minimal test-only stand-in for LLMRouter.complete()'s actual
  // production sequence (see src/providers/llm/router.js: it calls
  // costTracker.record(...) and, ONLY if that succeeds, then calls
  // provider.complete(request) on the next line). CostTracker itself has
  // no knowledge of provider outcomes — it cannot observe or react to
  // what happens after record() returns. This helper reproduces that
  // exact ordering without touching any production code, so the test
  // exercises the real architectural consequence of pre-call accounting
  // rather than merely asserting the absence of a refund method.
  async function completeLikeRouter({ costTracker, context, request, provider }) {
    costTracker.record({
      runId: context.runId,
      contentId: context.contentId,
      jobStage: context.jobStage,
      provider: provider.id,
      estimatedCost: request.estimatedCost ?? 0,
      isPaid: provider.isPaid
    });
    // Only reached because record() did not throw — mirrors router.js's
    // "await provider.complete(request)" on the line after record().
    return provider.complete(request);
  }

  const failingProvider = {
    id: 'fake-paid-failing',
    isPaid: true,
    async complete() {
      throw new Error('simulated provider failure after accounting');
    }
  };

  await assert.rejects(
    () => completeLikeRouter({
      costTracker: costs,
      context: { runId: 'run-1', contentId: 'content-9', jobStage: 'script' },
      request: { estimatedCost: 4 },
      provider: failingProvider
    }),
    /simulated provider failure after accounting/
  );

  // The provider_calls row from the pre-call accounting step remains,
  // and its estimated_cost remains included in cumulative spend.
  const rowsForContent = storage.rows.filter((r) => r.content_id === 'content-9');
  assert.equal(rowsForContent.length, 1);
  assert.equal(costs.contentSpend('content-9'), 4);

  // A subsequent call for the same content_id demonstrates the failed
  // attempt genuinely consumed budget — only 1 of the remaining 1
  // (5 - 4) is available, so a further 2 is rejected.
  assert.throws(
    () => costs.record({ runId: 'run-1', contentId: 'content-9', provider: 'fake-paid', estimatedCost: 2, isPaid: true }),
    BudgetExceededError
  );
  // ...while a call within the 1 remaining is accepted, confirming the
  // 4 from the failed attempt was neither refunded nor rolled back.
  const id = costs.record({ runId: 'run-1', contentId: 'content-9', provider: 'fake-paid', estimatedCost: 1, isPaid: true });
  assert.ok(id);

  // No refund/rollback API exists on CostTracker.
  assert.equal(typeof costs.refund, 'undefined');
});

test('D-B2: a retry is a separate attempt and consumes its own reserved cost', () => {
  const storage = mockStorage();
  const costs = new CostTracker(storage, {
    maxDailySpend: 1000, maxMonthlySpend: 1000, maxCostPerContent: 100, maxCumulativeCostPerContent: 100
  });

  // Failed attempt #1.
  costs.record({ runId: 'run-1', contentId: 'content-10', provider: 'fake-paid', estimatedCost: 1, isPaid: true });
  // Retry attempt #2 — counted separately, not merged with attempt #1.
  costs.record({ runId: 'run-1', contentId: 'content-10', provider: 'fake-paid', estimatedCost: 1, isPaid: true });
  // Retry attempt #3, which succeeds.
  costs.record({ runId: 'run-1', contentId: 'content-10', provider: 'fake-paid', estimatedCost: 1, isPaid: true });
  assert.equal(costs.contentSpend('content-10'), 3);
  const rowsForContent = storage.rows.filter((r) => r.content_id === 'content-10');
  assert.equal(rowsForContent.length, 3);
});

test('D-B2: D-B1 per-call enforcement is unchanged and both limits are enforced independently', () => {
  // A call that satisfies D-B2 (cumulative) but violates D-B1 (per-call) is
  // still rejected.
  const storageA = mockStorage();
  const costsA = new CostTracker(storageA, {
    maxDailySpend: 1000, maxMonthlySpend: 1000, maxCostPerContent: 2, maxCumulativeCostPerContent: 100
  });
  assert.throws(
    () => costsA.record({ runId: 'run-1', contentId: 'content-11a', provider: 'fake-paid', estimatedCost: 3, isPaid: true }),
    BudgetExceededError
  );

  // A call that satisfies D-B1 (per-call) but violates D-B2 (cumulative) is
  // still rejected.
  const storageB = mockStorage();
  const costsB = new CostTracker(storageB, {
    maxDailySpend: 1000, maxMonthlySpend: 1000, maxCostPerContent: 100, maxCumulativeCostPerContent: 2
  });
  costsB.record({ runId: 'run-1', contentId: 'content-11b', provider: 'fake-paid', estimatedCost: 2, isPaid: true });
  assert.throws(
    () => costsB.record({ runId: 'run-1', contentId: 'content-11b', provider: 'fake-paid', estimatedCost: 1, isPaid: true }),
    BudgetExceededError
  );

  // A call satisfying both limits succeeds.
  const storageC = mockStorage();
  const costsC = new CostTracker(storageC, {
    maxDailySpend: 1000, maxMonthlySpend: 1000, maxCostPerContent: 100, maxCumulativeCostPerContent: 100
  });
  const id = costsC.record({ runId: 'run-1', contentId: 'content-11c', provider: 'fake-paid', estimatedCost: 1, isPaid: true });
  assert.ok(id);
});

test('D-B2: a call with no content_id is unaffected by the cumulative ceiling', () => {
  const storage = mockStorage();
  const costs = new CostTracker(storage, {
    maxDailySpend: 1000, maxMonthlySpend: 1000, maxCostPerContent: 100, maxCumulativeCostPerContent: 1
  });

  // No contentId supplied — there is no cumulative scope to check against,
  // so only the existing D-B1 checks apply (and pass here).
  const id = costs.record({ runId: 'run-1', provider: 'fake-paid', estimatedCost: 50, isPaid: true });
  assert.ok(id);
});
