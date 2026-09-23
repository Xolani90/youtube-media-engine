import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SqliteStorageDriver } from '../../src/storage/SqliteStorageDriver.js';
import { SystemRunRecorder } from '../../src/state/SystemRun.js';
import { LLMRouter } from '../../src/providers/llm/router.js';
import { runDiscoveryPipeline } from '../../src/discovery/pipeline.js';
import { createDedupWorkloadBudget } from '../../src/discovery/dedup.js';
import discoveryPolicy from '../../config/discovery_policy.json' with { type: 'json' };
import scoringWeights from '../../config/scoring_weights.json' with { type: 'json' };

// ADR-0038: pipeline-level wiring of the dedup workload ceiling -- an
// UNRESOLVED pair must never be fabricated as DUPLICATE/DISTINCT, must
// surface a decision_log occurrence with the correct frozen reason code,
// must be counted in stats.dedupUnresolved and the run's ceilings summary,
// and must never be pushed into `accepted` (so it never reaches scoring or
// persistence, and lands on NOT_SCORED_UNRESOLVED via the existing ledger).

// Serves both dedup Layer-3 prompts ("sameEvent" JSON) and proposition-
// generation prompts (a well-formed proposition), so the resolved
// candidate's normal proposition-generation call is never mistaken for a
// dedup Layer-3 call. Only the former is counted by getDedupCalls().
function countingRouter() {
  let dedupCalls = 0;
  const registry = {
    'counting-stub': () => ({
      id: 'counting-stub', isPaid: false,
      async healthCheck() { return true; },
      async complete({ prompt }) {
        if (prompt.includes('sameEvent')) {
          dedupCalls++;
          return { text: '{"sameEvent": true, "distinctAngle": true}', model: 'counting-stub', requestId: null, inputTokens: 1, outputTokens: 1, estimatedCost: 0, isPaid: false };
        }
        const proposition = JSON.stringify({
          subject: 'Test subject', target_audience: 'Test audience', audience_problem: 'Test problem',
          core_question: 'Test question', gap: 'Test gap', angle: 'Test angle',
          differentiation: 'Test differentiation', commercial_relevance: 'Test relevance',
          core_question_type: 'FACTUAL'
        });
        return { text: proposition, model: 'counting-stub', requestId: null, inputTokens: 1, outputTokens: 1, estimatedCost: 0, isPaid: false };
      }
    })
  };
  const router = new LLMRouter({ priority: ['counting-stub'], allowPaidProviders: false, registry });
  return { router, getDedupCalls: () => dedupCalls };
}

function ambiguousObservations() {
  return [
    {
      title: 'New AI model launched for small business automation workflows',
      description: '', sourceUrl: 'https://example.com/a', sourceId: 'a', sourceType: 'rss',
      discoveredAt: new Date().toISOString(), publishedAt: null, retrievedAt: new Date().toISOString()
    },
    {
      title: 'New AI model launched for enterprise automation workflows',
      description: '', sourceUrl: 'https://example.com/b', sourceId: 'b', sourceType: 'rss',
      discoveredAt: new Date().toISOString(), publishedAt: null, retrievedAt: new Date().toISOString()
    }
  ];
}

function setup() {
  const dbPath = path.join(os.tmpdir(), `adr-0038-pipeline-${Date.now()}-${Math.random()}.db`);
  const storage = new SqliteStorageDriver({ dbPath });
  return { storage, dbPath };
}

async function teardown({ storage, dbPath }) {
  storage.close();
  fs.rmSync(dbPath, { force: true });
  fs.rmSync(`${dbPath}-wal`, { force: true });
  fs.rmSync(`${dbPath}-shm`, { force: true });
}

test('L3 ceiling reached mid-run: the pair is UNRESOLVED, never fabricated, and the second observation never reaches scoring', async () => {
  const ctx = setup();
  await ctx.storage.migrate();
  const runs = new SystemRunRecorder(ctx.storage);
  const { id: runId } = runs.start({ mode: 'SIMULATION' });

  const { router, getDedupCalls } = countingRouter();
  const budget = createDedupWorkloadBudget({ l2Cap: 10, l3Cap: 0 });

  const { stats, selected, scoredCandidates, ceilings } = await runDiscoveryPipeline({
    storage: ctx.storage, runId, observations: ambiguousObservations(), llmRouter: router,
    discoveryPolicy, scoringWeights, alreadyProducedCorpus: [], topK: 5,
    rawFeatures: async () => ({
      novelty: 50, competition: 50, story_potential: 50, evidence_availability: 50,
      production_difficulty: 50, audience_potential: 50, commercial_intent: 50,
      affiliate_potential: 50, lead_generation_potential: 50, product_adjacency: 50,
      sponsorship_potential: 50, policyRisk: 0.1, copyrightRisk: 0.1, repetitionRisk: 0.1
    }),
    dedupWorkloadBudget: budget
  });

  assert.equal(getDedupCalls(), 0, 'L3 ceiling means the semantic call is never made');
  assert.equal(stats.dedupUnresolved, 1, 'exactly the second observation is unresolved');
  assert.equal(stats.scored, 1, 'only the first observation (no comparisons needed) reaches scoring');
  assert.equal(scoredCandidates.length, 1);
  assert.equal(selected.length, 1);
  assert.equal(ceilings.l3SemanticCallCapReached, true);
  assert.equal(ceilings.l2ComparisonCapReached, false, 'L2 budget was never exhausted in this scenario');

  const unresolvedDecision = ctx.storage.get(
    `SELECT * FROM decision_log WHERE run_id = ? AND stage = 'EVENT_DEDUP' AND decision = 'UNRESOLVED'`,
    [runId]
  );
  assert.ok(unresolvedDecision, 'occurrence-level decision_log row recorded');
  assert.equal(unresolvedDecision.reason, 'DISCOVERY_L3_SEMANTIC_CALL_CAP_REACHED');
  assert.equal(unresolvedDecision.resulting_state, 'NOT_SCORED_UNRESOLVED');

  // Never fabricated: the unresolved observation was never persisted as an
  // opportunity at all (accepted only holds resolved candidates).
  const persisted = ctx.storage.all('SELECT * FROM opportunities WHERE run_id = ?', [runId]);
  assert.equal(persisted.length, 1, 'only the resolved (first) observation is persisted');

  await teardown(ctx);
});

test('L2 ceiling reached mid-run: UNRESOLVED with the correct reason code, no similarity fabricated', async () => {
  const ctx = setup();
  await ctx.storage.migrate();
  const runs = new SystemRunRecorder(ctx.storage);
  const { id: runId } = runs.start({ mode: 'SIMULATION' });

  const { router, getDedupCalls } = countingRouter();
  const budget = createDedupWorkloadBudget({ l2Cap: 0, l3Cap: 100 });

  const { stats, ceilings } = await runDiscoveryPipeline({
    storage: ctx.storage, runId, observations: ambiguousObservations(), llmRouter: router,
    discoveryPolicy, scoringWeights, alreadyProducedCorpus: [], topK: 5,
    rawFeatures: async () => ({
      novelty: 50, competition: 50, story_potential: 50, evidence_availability: 50,
      production_difficulty: 50, audience_potential: 50, commercial_intent: 50,
      affiliate_potential: 50, lead_generation_potential: 50, product_adjacency: 50,
      sponsorship_potential: 50, policyRisk: 0.1, copyrightRisk: 0.1, repetitionRisk: 0.1
    }),
    dedupWorkloadBudget: budget
  });

  assert.equal(getDedupCalls(), 0);
  assert.equal(stats.dedupUnresolved, 1);
  assert.equal(ceilings.l2ComparisonCapReached, true);
  assert.equal(ceilings.l3SemanticCallCapReached, false, 'L3 budget was never touched');

  const unresolvedDecision = ctx.storage.get(
    `SELECT * FROM decision_log WHERE run_id = ? AND stage = 'EVENT_DEDUP' AND decision = 'UNRESOLVED'`,
    [runId]
  );
  assert.equal(unresolvedDecision.reason, 'DISCOVERY_L2_COMPARISON_CAP_REACHED');

  await teardown(ctx);
});

test('default production budget (omitted override) never introduces UNRESOLVED at small scale -- backward compatible', async () => {
  const ctx = setup();
  await ctx.storage.migrate();
  const runs = new SystemRunRecorder(ctx.storage);
  const { id: runId } = runs.start({ mode: 'SIMULATION' });

  const { router } = countingRouter();

  const { stats, ceilings } = await runDiscoveryPipeline({
    storage: ctx.storage, runId, observations: ambiguousObservations(), llmRouter: router,
    discoveryPolicy, scoringWeights, alreadyProducedCorpus: [], topK: 5,
    rawFeatures: async () => ({
      novelty: 50, competition: 50, story_potential: 50, evidence_availability: 50,
      production_difficulty: 50, audience_potential: 50, commercial_intent: 50,
      affiliate_potential: 50, lead_generation_potential: 50, product_adjacency: 50,
      sponsorship_potential: 50, policyRisk: 0.1, copyrightRisk: 0.1, repetitionRisk: 0.1
    })
    // dedupWorkloadBudget intentionally omitted -- defaults to the frozen
    // 1,225/1,225 production ceilings, far above what two observations need.
  });

  assert.equal(stats.dedupUnresolved, 0);
  assert.equal(ceilings.l2ComparisonCapReached, false);
  assert.equal(ceilings.l3SemanticCallCapReached, false);

  await teardown(ctx);
});

test('no PARTIAL status: a bounded pipeline run\'s status is decided by the runner, not by the ceiling', async () => {
  // Governance requirement 17 -- runDiscoveryPipeline itself has no notion
  // of run status at all (that belongs to SystemRunRecorder/runner.js), so
  // this asserts the pipeline's return value carries no such field.
  const ctx = setup();
  await ctx.storage.migrate();
  const runs = new SystemRunRecorder(ctx.storage);
  const { id: runId } = runs.start({ mode: 'SIMULATION' });
  const { router } = countingRouter();
  const budget = createDedupWorkloadBudget({ l2Cap: 0, l3Cap: 0 });

  const result = await runDiscoveryPipeline({
    storage: ctx.storage, runId, observations: ambiguousObservations(), llmRouter: router,
    discoveryPolicy, scoringWeights, alreadyProducedCorpus: [], topK: 5,
    rawFeatures: async () => ({
      novelty: 50, competition: 50, story_potential: 50, evidence_availability: 50,
      production_difficulty: 50, audience_potential: 50, commercial_intent: 50,
      affiliate_potential: 50, lead_generation_potential: 50, product_adjacency: 50,
      sponsorship_potential: 50, policyRisk: 0.1, copyrightRisk: 0.1, repetitionRisk: 0.1
    }),
    dedupWorkloadBudget: budget
  });

  assert.equal('status' in result, false);
  assert.equal('PARTIAL' in Object.values(result), false);

  await teardown(ctx);
});
