import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SqliteStorageDriver } from '../../src/storage/SqliteStorageDriver.js';
import { SystemRunRecorder } from '../../src/state/SystemRun.js';
import { CostTracker } from '../../src/state/CostTracker.js';
import { LLMRouter } from '../../src/providers/llm/router.js';

test('foundation end-to-end: migrate -> run -> route -> cost -> audit -> finish', async () => {
  const dbPath = path.join(os.tmpdir(), `foundation-e2e-${Date.now()}.db`);
  const storage = new SqliteStorageDriver({ dbPath });

  const applied = await storage.migrate();
  assert.ok(applied.includes('0001_init.sql'));

  const runs = new SystemRunRecorder(storage);
  const costs = new CostTracker(storage);

  const { id: runId, mode } = runs.start({ mode: 'SIMULATION' });
  assert.equal(mode, 'SIMULATION');

  const router = new LLMRouter({ priority: ['local-stub'] });
  const { result, providerUsed } = await router.complete({ prompt: 'integration test prompt' });
  assert.equal(providerUsed, 'local-stub');
  assert.equal(result.estimatedCost, 0);

  const callId = costs.record({
    runId,
    jobStage: 'foundation-smoke-test',
    provider: providerUsed,
    model: result.model,
    estimatedCost: result.estimatedCost,
    isPaid: result.isPaid
  });
  assert.ok(callId);

  const decisionId = runs.logDecision(runId, {
    subjectType: 'system',
    subjectId: runId,
    decision: 'foundation_smoke_test_completed',
    reason: 'integration test',
    provider: providerUsed,
    resultingState: 'COMPLETED'
  });
  assert.ok(decisionId);

  runs.finish(runId, { status: 'COMPLETED' });

  const runRow = storage.get('SELECT * FROM system_runs WHERE id = ?', [runId]);
  assert.equal(runRow.status, 'COMPLETED');
  assert.equal(runRow.mode, 'SIMULATION');

  const callRow = storage.get('SELECT * FROM provider_calls WHERE id = ?', [callId]);
  assert.equal(callRow.estimated_cost, 0);
  assert.equal(callRow.is_paid, 0);

  const decisionRow = storage.get('SELECT * FROM decision_log WHERE id = ?', [decisionId]);
  assert.equal(decisionRow.decision, 'foundation_smoke_test_completed');

  storage.close();
  fs.rmSync(dbPath, { force: true });
  fs.rmSync(`${dbPath}-wal`, { force: true });
  fs.rmSync(`${dbPath}-shm`, { force: true });
});

test('LIVE run refused end-to-end when autonomous is disabled', async () => {
  const dbPath = path.join(os.tmpdir(), `foundation-e2e-live-${Date.now()}.db`);
  const storage = new SqliteStorageDriver({ dbPath });
  await storage.migrate();
  const runs = new SystemRunRecorder(storage);

  assert.throws(() => runs.start({ mode: 'LIVE', configSnapshot: { autonomousEnabled: false } }));

  storage.close();
  fs.rmSync(dbPath, { force: true });
  fs.rmSync(`${dbPath}-wal`, { force: true });
  fs.rmSync(`${dbPath}-shm`, { force: true });
});
