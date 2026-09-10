import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SqliteStorageDriver } from '../../src/storage/SqliteStorageDriver.js';
import { CostTracker, BudgetExceededError } from '../../src/state/CostTracker.js';
import { SystemRunRecorder } from '../../src/state/SystemRun.js';

function tempDbPath() {
  return path.join(os.tmpdir(), `cost-tracker-test-${Date.now()}-${Math.random()}.db`);
}

async function freshStorage() {
  const dbPath = tempDbPath();
  const storage = new SqliteStorageDriver({ dbPath });
  await storage.migrate();
  return { storage, dbPath };
}

test('free calls (estimatedCost 0) are recorded without budget checks', async () => {
  const { storage, dbPath } = await freshStorage();
  const runs = new SystemRunRecorder(storage);
  const { id: runId } = runs.start({ mode: 'SIMULATION' });
  const costs = new CostTracker(storage, { maxDailySpend: 0, maxMonthlySpend: 0, maxCostPerContent: 0 });

  const id = costs.record({ runId, provider: 'local-stub', estimatedCost: 0, isPaid: false });
  assert.ok(id);
  storage.close();
  fs.rmSync(dbPath, { force: true });
});

test('a nonzero-cost call against a 0 budget is rejected', async () => {
  const { storage, dbPath } = await freshStorage();
  const runs = new SystemRunRecorder(storage);
  const { id: runId } = runs.start({ mode: 'SIMULATION' });
  const costs = new CostTracker(storage, { maxDailySpend: 0, maxMonthlySpend: 0, maxCostPerContent: 0 });

  assert.throws(
    () => costs.record({ runId, provider: 'fake-paid', estimatedCost: 1.5, isPaid: true }),
    BudgetExceededError
  );
  storage.close();
  fs.rmSync(dbPath, { force: true });
});

test('a call within an explicit nonzero budget is accepted', async () => {
  const { storage, dbPath } = await freshStorage();
  const runs = new SystemRunRecorder(storage);
  const { id: runId } = runs.start({ mode: 'SIMULATION' });
  const costs = new CostTracker(storage, { maxDailySpend: 10, maxMonthlySpend: 100, maxCostPerContent: 5 });

  const id = costs.record({ runId, provider: 'fake-paid', estimatedCost: 1.5, isPaid: true });
  assert.ok(id);
  storage.close();
  fs.rmSync(dbPath, { force: true });
});
