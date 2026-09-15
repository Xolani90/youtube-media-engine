import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LLMRouter } from '../../src/providers/llm/router.js';
import { LLMProvider } from '../../src/providers/llm/LLMProvider.js';
import { CostTracker, BudgetExceededError } from '../../src/state/CostTracker.js';

/**
 * D-B1 (ADR-0002) — LLMRouter-level cost enforcement.
 *
 * These tests exercise the real CostTracker against a plain in-memory
 * mock of the storage interface it needs (`get`/`run`), rather than the
 * real SqliteStorageDriver — this repo's known better-sqlite3 "invalid
 * ELF header" sandbox limitation (Windows native binary vs. this Linux
 * environment) is a pre-existing, unrelated issue and is not worked
 * around here by weakening these tests; a mock storage object is a
 * legitimate, deterministic substitute for CostTracker's two SQL calls.
 */
function mockStorage() {
  const rows = [];
  return {
    rows,
    run(sql, params) {
      // INSERT INTO provider_calls (... , estimated_cost, ...)
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

class PaidCallCounter extends LLMProvider {
  constructor(id = 'paid-provider') {
    super();
    this._id = id;
    this.callCount = 0;
  }
  get id() { return this._id; }
  get isPaid() { return true; }
  async healthCheck() { return true; }
  async complete() {
    this.callCount += 1;
    return { text: 'paid-ok', model: 'paid-model', requestId: null, inputTokens: 1, outputTokens: 1, estimatedCost: 1, isPaid: true };
  }
}

class FreeCallCounter extends LLMProvider {
  constructor(id = 'free-provider') {
    super();
    this._id = id;
    this.callCount = 0;
  }
  get id() { return this._id; }
  get isPaid() { return false; }
  async healthCheck() { return true; }
  async complete() {
    this.callCount += 1;
    return { text: 'free-ok', model: 'free-model', requestId: null, inputTokens: 1, outputTokens: 1, estimatedCost: 0, isPaid: false };
  }
}

test('Test A — a billable call within the configured per-call ceiling is allowed and the provider IS invoked', async () => {
  const storage = mockStorage();
  const costTracker = new CostTracker(storage, { maxDailySpend: 10, maxMonthlySpend: 100, maxCostPerContent: 5 });
  const paid = new PaidCallCounter();
  const router = new LLMRouter({
    priority: ['paid'],
    allowPaidProviders: true,
    registry: { paid: () => paid },
    costTracker
  });

  const { providerUsed, result } = await router.complete({ prompt: 'hi', estimatedCost: 2 }, { runId: 'run-1', jobStage: 'test' });

  assert.equal(providerUsed, 'paid-provider');
  assert.equal(paid.callCount, 1);
  assert.equal(result.text, 'paid-ok');
  assert.equal(storage.rows.length, 1);
});

test('Test B — a billable call exceeding the configured ceiling is rejected BEFORE the provider is invoked', async () => {
  const storage = mockStorage();
  const costTracker = new CostTracker(storage, { maxDailySpend: 10, maxMonthlySpend: 100, maxCostPerContent: 1 });
  const paid = new PaidCallCounter();
  const router = new LLMRouter({
    priority: ['paid'],
    allowPaidProviders: true,
    registry: { paid: () => paid },
    costTracker
  });

  await assert.rejects(
    () => router.complete({ prompt: 'hi', estimatedCost: 5 }, { runId: 'run-1' }),
    BudgetExceededError
  );
  // The provider must never have been invoked — this is the core D-B1 requirement.
  assert.equal(paid.callCount, 0);
  // And nothing was recorded as spent, since the throw happens before insert.
  assert.equal(storage.rows.length, 0);
});

test('Test C — a local/free provider remains usable and is not blocked by paid-provider cost enforcement', async () => {
  const storage = mockStorage();
  // A zero budget: would reject ANY nonzero-cost paid call, but must never
  // block a free (isPaid=false, estimatedCost=0) call.
  const costTracker = new CostTracker(storage, { maxDailySpend: 0, maxMonthlySpend: 0, maxCostPerContent: 0 });
  const free = new FreeCallCounter();
  const router = new LLMRouter({
    priority: ['free'],
    allowPaidProviders: false,
    registry: { free: () => free },
    costTracker
  });

  const { providerUsed } = await router.complete({ prompt: 'hi' }, { runId: 'run-1' });
  assert.equal(providerUsed, 'free-provider');
  assert.equal(free.callCount, 1);
});

test('Test D — a rejected paid call does not silently fall through to another paid provider', async () => {
  const storage = mockStorage();
  const costTracker = new CostTracker(storage, { maxDailySpend: 10, maxMonthlySpend: 100, maxCostPerContent: 1 });
  const primaryPaid = new PaidCallCounter('primary-paid');
  const secondaryPaid = new PaidCallCounter('secondary-paid');
  const router = new LLMRouter({
    priority: ['primary-paid', 'secondary-paid'],
    allowPaidProviders: true,
    registry: { 'primary-paid': () => primaryPaid, 'secondary-paid': () => secondaryPaid },
    costTracker
  });

  await assert.rejects(
    () => router.complete({ prompt: 'hi', estimatedCost: 5 }),
    BudgetExceededError
  );
  assert.equal(primaryPaid.callCount, 0);
  assert.equal(secondaryPaid.callCount, 0);
});

test('a router constructed WITHOUT a costTracker enforces nothing (existing behavior preserved)', async () => {
  const paid = new PaidCallCounter();
  const router = new LLMRouter({
    priority: ['paid'],
    allowPaidProviders: true,
    registry: { paid: () => paid }
  });
  const { providerUsed } = await router.complete({ prompt: 'hi', estimatedCost: 999999 });
  assert.equal(providerUsed, 'paid-provider');
  assert.equal(paid.callCount, 1);
});
