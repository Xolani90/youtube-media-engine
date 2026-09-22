import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { SqliteStorageDriver } from '../../src/storage/SqliteStorageDriver.js';
import { LLMRouter } from '../../src/providers/llm/router.js';
import { runDiscoveryPipeline } from '../../src/discovery/pipeline.js';
import { deriveIdentity } from '../../src/autonomous/discoveryMemory.js';
import { createDiscoveryEvaluationStore } from '../../src/autonomous/discoveryEvaluationStore.js';
import { createDiscoveryEvaluationSchedule } from '../../src/autonomous/discoveryEvaluationSchedule.js';
import discoveryPolicy from '../../config/discovery_policy.json' with { type: 'json' };
import scoringWeights from '../../config/scoring_weights.json' with { type: 'json' };

// ADR-0034 -- fresh-evaluation scheduling and the per-run budget.
// Real SQLite, real stores, real pipeline. Only the LLM and rawFeatures are stubs.

const FEED = 'https://feed.test/rss';
const T = (iso) => () => new Date(iso);

const PROPOSITION_JSON = JSON.stringify({
  subject: 'Subject', target_audience: 'Practitioners', audience_problem: 'They need reliable information.',
  core_question: 'What does this mean in practice?', gap: 'Coverage lacks a practical view.',
  angle: 'Practical angle.', differentiation: 'Concrete workflows.', commercial_relevance: 'Measurable value.',
  core_question_type: 'FACTUAL'
});

function obs(n) {
  return Array.from({ length: n }, (_, i) => ({
    title: `Story ${i}`, description: `Description body number ${i} with enough distinct text.`,
    sourceUrl: `https://n.test/${i}`, sourceId: `g${i}`, feedUrl: FEED, sourceType: 'rss',
    discoveredAt: '2026-03-01T00:00:00.000Z'
  }));
}

function makeEnv() {
  const calls = { proposition: 0, features: 0 };
  const llmRouter = new LLMRouter({
    priority: ['stub'], allowPaidProviders: false,
    registry: {
      stub: () => ({
        id: 'stub', isPaid: false,
        async healthCheck() { return true; },
        async complete({ prompt }) {
          if (prompt.includes('sameEvent')) return { text: '{"sameEvent": false, "distinctAngle": false}', model: 'stub-model', estimatedCost: 0, isPaid: false };
          calls.proposition++;
          return { text: PROPOSITION_JSON, model: 'stub-model', estimatedCost: 0, isPaid: false };
        }
      })
    }
  });
  const rawFeatures = async (observation) => {
    calls.features++;
    return {
      novelty: 50, competition: 10, story_potential: 90, evidence_availability: 90,
      production_difficulty: 10, audience_potential: 90, commercial_intent: 90, affiliate_potential: 90,
      lead_generation_potential: 90, product_adjacency: 90, sponsorship_potential: 90,
      policyRisk: 0, copyrightRisk: 0, repetitionRisk: 0
    };
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dev-schedule-'));
  const storage = new SqliteStorageDriver({ dbPath: path.join(dir, 't.db') });
  return { calls, llmRouter, rawFeatures, storage, dir, cleanup: () => { storage.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

async function withEnv(fn) {
  const env = makeEnv();
  try {
    await env.storage.migrate();
    await fn(env);
  } finally {
    env.cleanup();
  }
}

const evalStoreFor = (env, opts = {}) => createDiscoveryEvaluationStore({
  storage: env.storage, sourceScope: 'static-feed', now: T('2026-03-01T00:00:00.000Z'), ...opts
});
const scheduleFor = (env) => createDiscoveryEvaluationSchedule({ storage: env.storage, sourceScope: 'static-feed' });

function runPipeline(env, { observations, evaluationStore, evaluationSchedule, freshEvaluationBudget = Infinity, topK = 100 } = {}) {
  return runDiscoveryPipeline({
    storage: env.storage, runId: null, observations, llmRouter: env.llmRouter,
    discoveryPolicy, scoringWeights, alreadyProducedCorpus: [], topK,
    rawFeatures: env.rawFeatures, evaluationStore, evaluationSchedule, freshEvaluationBudget
  });
}

const scheduleRows = (env) => env.storage.all('SELECT * FROM discovery_evaluation_schedule ORDER BY identity_key');
const identityKeyFor = (o) => deriveIdentity(o, { sourceScope: 'static-feed' }).key;

test('migration 0021 creates discovery_evaluation_schedule keyed by identity_key alone', async () => {
  await withEnv(async (env) => {
    const cols = env.storage.all("PRAGMA table_info(discovery_evaluation_schedule)").map((c) => c.name);
    assert.deepEqual(cols.sort(), ['identity_key', 'last_fresh_evaluation_at'].sort());
  });
});

test('A. budget enforcement: only the first N candidates needing fresh evaluation are evaluated; the rest are skipped, not reused, not persisted', async () => {
  await withEnv(async (env) => {
    const store = evalStoreFor(env);
    const schedule = scheduleFor(env);
    const result = await runPipeline(env, { observations: obs(5), evaluationStore: store, evaluationSchedule: schedule, freshEvaluationBudget: 2 });

    assert.equal(result.stats.freshEvaluated, 2);
    assert.equal(result.stats.budgetSkipped, 3);
    assert.equal(result.stats.reused, 0);
    assert.equal(env.calls.proposition, 2, 'skipped candidates never call the proposition LLM');
    assert.equal(env.calls.features, 2, 'skipped candidates never call feature computation');
    assert.equal(scheduleRows(env).length, 2, 'only the successfully fresh-evaluated candidates get a schedule row');
    assert.equal(result.scoredCandidates.length, 2, 'skipped candidates are not scored or persisted this run');
  });
});

test('B. scheduling order: never-evaluated candidates go first, then oldest last_fresh_evaluation_at, identity_key as tie-break', async () => {
  await withEnv(async (env) => {
    const observations = obs(4);
    const store = evalStoreFor(env);

    // Pre-seed schedule rows directly: g0 evaluated most recently, g1 least
    // recently, g2/g3 left with no row (never evaluated -> highest priority).
    env.storage.run(
      'INSERT INTO discovery_evaluation_schedule (identity_key, last_fresh_evaluation_at) VALUES (?, ?)',
      [identityKeyFor(observations[0]), '2026-03-05T00:00:00.000Z']
    );
    env.storage.run(
      'INSERT INTO discovery_evaluation_schedule (identity_key, last_fresh_evaluation_at) VALUES (?, ?)',
      [identityKeyFor(observations[1]), '2026-03-01T00:00:00.000Z']
    );
    const schedule = scheduleFor(env);

    const result = await runPipeline(env, { observations, evaluationStore: store, evaluationSchedule: schedule, freshEvaluationBudget: 2 });

    const evaluatedIds = result.scoredCandidates.map((c) => c.observation.sourceId).sort();
    // g2 and g3 (never evaluated) take priority over g1 (oldest timestamp)
    // and g0 (newest timestamp); between g2/g3, identity_key ASC decides.
    assert.deepEqual(evaluatedIds, ['g2', 'g3']);
  });
});

test('C. reuse consumes zero budget and never touches the schedule', async () => {
  await withEnv(async (env) => {
    const observations = obs(3);
    const store = evalStoreFor(env);
    const schedule = scheduleFor(env);

    const first = await runPipeline(env, { observations, evaluationStore: store, evaluationSchedule: schedule, freshEvaluationBudget: 3 });
    assert.equal(first.stats.freshEvaluated, 3);
    const scheduleAfterFirst = scheduleRows(env);
    assert.equal(scheduleAfterFirst.length, 3);

    const before = { ...env.calls };
    // budget of 1 would matter if any candidate needed fresh evaluation, but
    // all three are durably reusable, so budget is never even consulted.
    const second = await runPipeline(env, { observations, evaluationStore: store, evaluationSchedule: schedule, freshEvaluationBudget: 1 });
    assert.equal(second.stats.reused, 3);
    assert.equal(second.stats.freshEvaluated, 0);
    assert.equal(second.stats.budgetSkipped, 0);
    assert.deepEqual(env.calls, before, 'no new LLM/feature calls on reuse');
    assert.deepEqual(scheduleRows(env), scheduleAfterFirst, 'schedule rows unchanged by reuse');
  });
});

test('D. atomicity: schedule timestamp and durable evaluation are written together, in lockstep', async () => {
  await withEnv(async (env) => {
    const observations = obs(2);
    const store = evalStoreFor(env);
    const schedule = scheduleFor(env);

    await runPipeline(env, { observations, evaluationStore: store, evaluationSchedule: schedule, freshEvaluationBudget: 10 });

    const evalKeys = env.storage.all('SELECT identity_key FROM discovery_evaluations ORDER BY identity_key').map((r) => r.identity_key);
    const scheduleKeys = scheduleRows(env).map((r) => r.identity_key);
    assert.deepEqual(evalKeys, scheduleKeys, 'every committed evaluation has exactly one matching schedule row');
  });
});

test('E. no evaluationSchedule supplied: unbudgeted behavior is unchanged (back-compat)', async () => {
  await withEnv(async (env) => {
    const observations = obs(3);
    const store = evalStoreFor(env);

    const result = await runPipeline(env, { observations, evaluationStore: store, evaluationSchedule: null, freshEvaluationBudget: 1 });
    assert.equal(result.stats.freshEvaluated, 3, 'without a schedule, budget is never enforced');
    assert.equal(result.stats.budgetSkipped, 0);
    const cols = env.storage.all("SELECT name FROM sqlite_master WHERE type='table' AND name='discovery_evaluation_schedule'");
    assert.equal(cols.length, 1, 'table exists (from migration) but nothing is written without a schedule instance');
    assert.equal(scheduleRows(env).length, 0);
  });
});
