import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { SqliteStorageDriver } from '../../src/storage/SqliteStorageDriver.js';
import { SystemRunRecorder } from '../../src/state/SystemRun.js';
import { LLMRouter } from '../../src/providers/llm/router.js';
import { RssSource } from '../../src/providers/opportunity/RssSource.js';
import { runDiscoveryPipeline } from '../../src/discovery/pipeline.js';
import discoveryPolicy from '../../config/discovery_policy.json' with { type: 'json' };
import scoringWeights from '../../config/scoring_weights.json' with { type: 'json' };

const FEED_XML = `<?xml version="1.0"?><rss version="2.0"><channel>
<item><title>AI startup launches automation tool for small business owners</title><link>https://example.com/a</link><description>A new tool helps small business owners automate workflows.</description><pubDate>${new Date().toUTCString()}</pubDate><guid>g-a</guid></item>
<item><title>Coffee shop opens downtown this weekend</title><link>https://example.com/b</link><description>A new local coffee shop is opening.</description><pubDate>${new Date().toUTCString()}</pubDate><guid>g-b</guid></item>
</channel></rss>`;

function proposition(overrides = {}) {
  return JSON.stringify({
    subject: 'Test subject', target_audience: 'Test audience', audience_problem: 'Test problem',
    core_question: 'Test question', gap: 'Test gap', angle: 'Test angle',
    differentiation: 'Test differentiation', commercial_relevance: 'Test relevance',
    core_question_type: 'FACTUAL', ...overrides
  });
}

// A deterministic LLM stub used for both proposition generation and any
// ambiguous-band dedup escalation, so the integration test is fully R0
// (zero network, zero paid provider) and deterministic across runs.
function stubRegistry() {
  return {
    'e2e-stub': () => ({
      id: 'e2e-stub', isPaid: false,
      async healthCheck() { return true; },
      async complete({ prompt }) {
        if (prompt.includes('sameEvent')) {
          return { text: '{"sameEvent": false, "distinctAngle": false}', model: 'e2e-stub', requestId: null, inputTokens: 1, outputTokens: 1, estimatedCost: 0, isPaid: false };
        }
        return { text: proposition(), model: 'e2e-stub', requestId: null, inputTokens: 1, outputTokens: 1, estimatedCost: 0, isPaid: false };
      }
    })
  };
}

function rawFeaturesFactory() {
  // Deterministic synthetic feature computation, injected per v0.6's
  // acknowledgment that real evidence-gathering belongs to Research (out
  // of scope here). Two distinct profiles so ranking/diversity are
  // exercised meaningfully.
  return (observation) => {
    const isAiTopic = /automation|AI/i.test(observation.title || '');
    return {
      novelty: isAiTopic ? 80 : 30,
      competition: isAiTopic ? 40 : 70,
      story_potential: isAiTopic ? 75 : 20,
      evidence_availability: isAiTopic ? 70 : 40,
      production_difficulty: 30,
      audience_potential: isAiTopic ? 70 : 20,
      commercial_intent: isAiTopic ? 65 : 10,
      affiliate_potential: isAiTopic ? 60 : 5,
      lead_generation_potential: isAiTopic ? 55 : 5,
      product_adjacency: isAiTopic ? 60 : 5,
      sponsorship_potential: isAiTopic ? 40 : 10,
      policyRisk: 0.1, copyrightRisk: 0.1, repetitionRisk: 0.1
    };
  };
}

test('full pipeline: RSS -> dedup -> eligibility -> proposition -> scoring -> risk -> diversity -> top-K, persisted with audit trail', async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/rss+xml' });
    res.end(FEED_XML);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  const dbPath = path.join(os.tmpdir(), `discovery-e2e-${Date.now()}.db`);
  const storage = new SqliteStorageDriver({ dbPath });
  await storage.migrate();

  const runs = new SystemRunRecorder(storage);
  const { id: runId } = runs.start({ mode: 'SIMULATION' });

  const source = new RssSource({ feedUrls: [`http://127.0.0.1:${port}/feed`] });
  const { candidates, failures } = await source.fetchCandidates();
  assert.equal(failures.length, 0);
  const observations = candidates.map((c) => source.normalize(c));

  const llmRouter = new LLMRouter({ priority: ['e2e-stub'], allowPaidProviders: false, registry: stubRegistry() });

  const { stats, selected } = await runDiscoveryPipeline({
    storage, runId, observations, llmRouter, discoveryPolicy, scoringWeights,
    alreadyProducedCorpus: [], topK: 1, rawFeatures: rawFeaturesFactory()
  });

  assert.equal(stats.discovered, 2);
  assert.equal(stats.scored, 2, 'both observations should pass eligibility/proposition and reach scoring');
  assert.equal(stats.selected, 1, 'topK=1 must select exactly one');

  // The AI/automation-themed observation should win — verifies ranking is
  // driven by the value score, not discovery order.
  assert.match(selected[0].observation.title, /automation/i);

  // Persistence checks
  const persistedOpps = storage.all('SELECT * FROM opportunities WHERE run_id = ?', [runId]);
  assert.equal(persistedOpps.length, 2, 'both scored candidates persist, selected or not');
  const selectedRow = persistedOpps.find((o) => o.status === 'HANDED_TO_RESEARCH');
  const scoredOnlyRow = persistedOpps.find((o) => o.status === 'SCORED');
  assert.ok(selectedRow);
  assert.ok(scoredOnlyRow);
  assert.ok(JSON.parse(selectedRow.opportunity_proposition).subject);
  assert.ok(selectedRow.underlying_event_id);

  // D-02: core_question_type is persisted as part of the real proposition
  // JSON, consumable by Research without regeneration.
  assert.equal(JSON.parse(selectedRow.opportunity_proposition).core_question_type, 'FACTUAL');

  // The non-selected candidate must retain its own genuinely computed
  // score — not have it altered by diversity selection.
  assert.ok(scoredOnlyRow.overall_score < selectedRow.overall_score);

  // decision_log stage is independently queryable
  const stageValues = storage.all('SELECT DISTINCT stage FROM decision_log WHERE run_id = ?', [runId]).map((r) => r.stage);
  assert.ok(stageValues.includes('PROPOSITION_GENERATION'));
  assert.ok(stageValues.includes('PROPOSITION_VALIDATION'));
  assert.ok(stageValues.includes('VALUE_SCORE'));
  assert.ok(stageValues.includes('RISK_GATE'));
  assert.ok(stageValues.includes('DIVERSITY_SELECTION'));

  const selectionDecision = storage.get(
    `SELECT * FROM decision_log WHERE run_id = ? AND stage = 'DIVERSITY_SELECTION' AND decision = 'SELECTED'`,
    [runId]
  );
  assert.ok(selectionDecision);
  assert.equal(selectionDecision.reason, 'top_k_selected');

  storage.close();
  fs.rmSync(dbPath, { force: true });
  fs.rmSync(`${dbPath}-wal`, { force: true });
  fs.rmSync(`${dbPath}-shm`, { force: true });
  server.close();
});

test('a candidate rejected at Hard Eligibility incurs zero proposition-generation and zero scoring LLM calls', async () => {
  const dbPath = path.join(os.tmpdir(), `discovery-e2e-elig-${Date.now()}.db`);
  const storage = new SqliteStorageDriver({ dbPath });
  await storage.migrate();
  const runs = new SystemRunRecorder(storage);
  const { id: runId } = runs.start({ mode: 'SIMULATION' });

  let callCount = 0;
  const registry = {
    'counting-stub': () => ({
      id: 'counting-stub', isPaid: false,
      async healthCheck() { return true; },
      async complete() {
        callCount++;
        return { text: proposition(), model: 'counting-stub', requestId: null, inputTokens: 1, outputTokens: 1, estimatedCost: 0, isPaid: false };
      }
    })
  };
  const llmRouter = new LLMRouter({ priority: ['counting-stub'], allowPaidProviders: false, registry });

  // Empty title/description -> INELIGIBLE_EMPTY_CONTENT, must short-circuit
  // before any proposition/scoring LLM call.
  const observations = [{ title: '', description: '', sourceUrl: 'https://example.com/empty', sourceId: 'empty-1', sourceType: 'rss', discoveredAt: new Date().toISOString() }];

  const { stats } = await runDiscoveryPipeline({
    storage, runId, observations, llmRouter, discoveryPolicy, scoringWeights,
    alreadyProducedCorpus: [], topK: 1, rawFeatures: rawFeaturesFactory()
  });

  assert.equal(stats.eligibilityRejected, 1);
  assert.equal(stats.scored, 0);
  assert.equal(callCount, 0, 'zero LLM calls must occur for a Hard-Eligibility-rejected candidate');

  const decision = storage.get(`SELECT * FROM decision_log WHERE run_id = ? AND stage = 'HARD_ELIGIBILITY'`, [runId]);
  assert.equal(decision.reason, 'INELIGIBLE_EMPTY_CONTENT');

  storage.close();
  fs.rmSync(dbPath, { force: true });
  fs.rmSync(`${dbPath}-wal`, { force: true });
  fs.rmSync(`${dbPath}-shm`, { force: true });
});

test('R0: default configuration operates with zero paid-provider invocation throughout the pipeline', async () => {
  const dbPath = path.join(os.tmpdir(), `discovery-e2e-r0-${Date.now()}.db`);
  const storage = new SqliteStorageDriver({ dbPath });
  await storage.migrate();
  const runs = new SystemRunRecorder(storage);
  const { id: runId } = runs.start({ mode: 'SIMULATION' });

  const llmRouter = new LLMRouter({ priority: ['e2e-stub'], allowPaidProviders: false, registry: stubRegistry() });
  const observations = [{
    title: 'AI automation tool launch for small businesses', description: 'A new tool.',
    sourceUrl: 'https://example.com/r0', sourceId: 'r0-1', sourceType: 'rss', discoveredAt: new Date().toISOString()
  }];

  await runDiscoveryPipeline({
    storage, runId, observations, llmRouter, discoveryPolicy, scoringWeights,
    alreadyProducedCorpus: [], topK: 1, rawFeatures: rawFeaturesFactory()
  });

  const paidCalls = storage.all(`SELECT * FROM decision_log WHERE run_id = ? AND config_snapshot LIKE '%"isPaid":true%'`, [runId]);
  assert.equal(paidCalls.length, 0);

  storage.close();
  fs.rmSync(dbPath, { force: true });
  fs.rmSync(`${dbPath}-wal`, { force: true });
  fs.rmSync(`${dbPath}-shm`, { force: true });
});
