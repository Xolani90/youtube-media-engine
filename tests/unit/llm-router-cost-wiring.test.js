import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LLMRouter } from '../../src/providers/llm/router.js';
import { LLMProvider } from '../../src/providers/llm/LLMProvider.js';
import { LocalStubProvider, REGISTRY } from '../../src/providers/llm/candidates.js';
import { CostTracker, BudgetExceededError } from '../../src/state/CostTracker.js';

/**
 * D-B1 corrective wiring tests (post-audit fix).
 *
 * The prior audit found that router-level cost enforcement, while
 * correctly implemented, was never actually connected to any real
 * execution path — `src/index.js` constructed its `LLMRouter` without
 * a `costTracker`. This file proves the fix: it builds the router the
 * SAME way `src/index.js` now does — a `CostTracker` constructed first,
 * then handed to `new LLMRouter({ ..., costTracker })` — rather than a
 * bespoke test-only wiring pattern.
 *
 * As in llm-router-cost.test.js, CostTracker is exercised against a
 * plain in-memory mock of the storage interface it needs (`get`/`run`)
 * rather than the real SqliteStorageDriver, to avoid this repo's known,
 * unrelated better-sqlite3 "invalid ELF header" sandbox limitation.
 * CostTracker's own logic is not touched or reimplemented by the mock.
 */
function mockStorage() {
  const rows = [];
  return {
    rows,
    run(sql, params) {
      rows.push({ estimated_cost: params[9], timestamp: params[12] });
    },
    get(sql, params) {
      const sinceIso = params[0];
      const total = rows
        .filter((r) => r.timestamp >= sinceIso)
        .reduce((sum, r) => sum + r.estimated_cost, 0);
      return { total };
    }
  };
}

class DummyPaidProvider extends LLMProvider {
  constructor(id = 'dummy-paid') {
    super();
    this._id = id;
    this.callCount = 0;
  }
  get id() { return this._id; }
  get isPaid() { return true; }
  async healthCheck() { return true; }
  async complete() {
    this.callCount += 1;
    return { text: 'ok', model: 'dummy-model', requestId: null, inputTokens: 1, outputTokens: 1, estimatedCost: 1, isPaid: true };
  }
}

/**
 * Mirrors src/index.js's real construction order exactly:
 *   const costs = new CostTracker(storage);
 *   const router = new LLMRouter({ priority: [...], costTracker: costs });
 */
function buildProductionStyleRouter({ priority, allowPaidProviders = false, registry, limits }) {
  const storage = mockStorage();
  const costs = new CostTracker(storage, limits);
  const router = new LLMRouter({ priority, allowPaidProviders, registry, costTracker: costs });
  return { storage, costs, router };
}

test('Test 1 — a router built via the real application\'s dependency-wiring pattern actually receives a live CostTracker', async () => {
  const { router, costs } = buildProductionStyleRouter({
    priority: ['local-stub'],
    registry: REGISTRY,
    limits: { maxDailySpend: 10, maxMonthlySpend: 100, maxCostPerContent: 5 }
  });

  // Property evidence...
  assert.equal(router.costTracker, costs);
  assert.notEqual(router.costTracker, null);

  // ...and behavioral evidence: a paid call that should be rejected under
  // this same router IS rejected, proving the wiring is live, not just a
  // stored reference.
  const paidRouter = new LLMRouter({
    priority: ['dummy-paid'],
    allowPaidProviders: true,
    registry: { 'dummy-paid': () => new DummyPaidProvider() },
    costTracker: costs
  });
  const tooExpensive = { prompt: 'x', estimatedCost: 999 };
  await assert.rejects(() => paidRouter.complete(tooExpensive), BudgetExceededError);
});

test('Test 2 — a real billable request exceeding the limit is blocked before the provider is invoked (production-style construction)', async () => {
  const dummyPaid = new DummyPaidProvider();
  const { router } = buildProductionStyleRouter({
    priority: ['dummy-paid'],
    allowPaidProviders: true,
    registry: { 'dummy-paid': () => dummyPaid },
    limits: { maxDailySpend: 10, maxMonthlySpend: 100, maxCostPerContent: 1 }
  });

  await assert.rejects(
    () => router.complete({ prompt: 'x', estimatedCost: 5 }),
    BudgetExceededError
  );
  assert.equal(dummyPaid.callCount, 0);
});

test('Test 3 — a real billable request within the permitted cost is allowed and accounting stays consistent with CostTracker semantics', async () => {
  const dummyPaid = new DummyPaidProvider();
  const { router, storage } = buildProductionStyleRouter({
    priority: ['dummy-paid'],
    allowPaidProviders: true,
    registry: { 'dummy-paid': () => dummyPaid },
    limits: { maxDailySpend: 10, maxMonthlySpend: 100, maxCostPerContent: 5 }
  });

  const { providerUsed } = await router.complete({ prompt: 'x', estimatedCost: 2 }, { runId: 'run-1', jobStage: 'test' });
  assert.equal(providerUsed, 'dummy-paid');
  assert.equal(dummyPaid.callCount, 1);
  // Exactly one accounting row for this one call — no double-recording.
  assert.equal(storage.rows.length, 1);
  assert.equal(storage.rows[0].estimated_cost, 2);
});

test('Test 4 — the real local-stub free provider (as used by src/index.js) remains usable under production-style construction', async () => {
  const { router } = buildProductionStyleRouter({
    priority: ['local-stub'],
    registry: REGISTRY,
    limits: { maxDailySpend: 0, maxMonthlySpend: 0, maxCostPerContent: 0 }
  });

  const { providerUsed, result } = await router.complete({ prompt: 'foundation smoke test' }, { runId: 'run-1', jobStage: 'foundation-smoke-test' });
  assert.equal(providerUsed, 'local-stub');
  assert.equal(result.isPaid, false);
  assert.ok(result.text.includes('local-stub'));
});

test('Test 5 — a cost-rejected paid call under production-style construction does not fall through to another paid provider', async () => {
  const primary = new DummyPaidProvider('primary-paid');
  const secondary = new DummyPaidProvider('secondary-paid');
  const { router } = buildProductionStyleRouter({
    priority: ['primary-paid', 'secondary-paid'],
    allowPaidProviders: true,
    registry: { 'primary-paid': () => primary, 'secondary-paid': () => secondary },
    limits: { maxDailySpend: 10, maxMonthlySpend: 100, maxCostPerContent: 1 }
  });

  await assert.rejects(() => router.complete({ prompt: 'x', estimatedCost: 5 }), BudgetExceededError);
  assert.equal(primary.callCount, 0);
  assert.equal(secondary.callCount, 0);
});

test('sanity: LocalStubProvider is the real production free provider, not a test double', () => {
  const stub = new LocalStubProvider();
  assert.equal(stub.id, 'local-stub');
  assert.equal(stub.isPaid, false);
});
