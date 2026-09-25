import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runDiscoveryPipeline } from '../../src/discovery/pipeline.js';
import { LLMRouter } from '../../src/providers/llm/router.js';
import { LLMProvider } from '../../src/providers/llm/LLMProvider.js';
import discoveryPolicy from '../../config/discovery_policy.json' with { type: 'json' };
import scoringWeights from '../../config/scoring_weights.json' with { type: 'json' };

// Regression coverage for the run-killing defect: pipeline.js called
// generateProposition() (which calls LLMRouter#complete()) with no
// try/catch, so an aggregate "all eligible providers failed" error (e.g.
// every provider timing out, the confirmed `gemini-free: This operation
// was aborted` case) propagated uncaught and aborted the ENTIRE Discovery
// run, including candidates that would otherwise have succeeded. This is
// a fast, storage-agnostic unit test (a minimal fake storage.run()
// no-op, no SqliteStorageDriver), matching pipeline-feature-rejection.test.js.

function fakeStorage() {
  return { run() {} };
}

function observation(id, title) {
  return {
    title, description: 'A description of the candidate for this test.',
    sourceUrl: `https://example.com/${id}`, sourceId: id, sourceType: 'rss',
    discoveredAt: new Date().toISOString(), publishedAt: new Date().toISOString(),
    retrievedAt: new Date().toISOString()
  };
}

// A provider whose complete() always throws an AbortError, mirroring the
// confirmed 30s-timeout shape (GeminiProvider/GroqProvider's
// AbortController firing) -- the only source that reaches LLMRouter's
// "all eligible providers failed" aggregate error in this test. Dedup's
// own L2/L3 semantic-judgment LLM calls (see dedup.js) are out of this
// fix's scope (Owner: "Do not change dedup behavior"), so this fake still
// answers those ("sameEvent" prompts) successfully and only times out on
// proposition-generation prompts -- isolating the boundary under test.
class AlwaysTimesOut extends LLMProvider {
  get id() { return 'always-times-out'; }
  get isPaid() { return false; }
  async healthCheck() { return true; }
  async complete({ prompt } = {}) {
    if (prompt?.includes('sameEvent')) {
      return { text: '{"sameEvent": false, "distinctAngle": false}', model: 'always-times-out', requestId: null, inputTokens: 1, outputTokens: 1, estimatedCost: 0, isPaid: false };
    }
    const err = new Error('This operation was aborted');
    err.name = 'AbortError';
    throw err;
  }
}

function timeoutRouter() {
  const provider = new AlwaysTimesOut();
  return new LLMRouter({
    priority: ['always-times-out'],
    allowPaidProviders: false,
    registry: { 'always-times-out': () => provider }
  });
}

function workingStubRouter() {
  const proposition = JSON.stringify({
    subject: 'Test subject', target_audience: 'Test audience', audience_problem: 'Test problem',
    core_question: 'Test question', gap: 'Test gap', angle: 'Test angle',
    differentiation: 'Test differentiation', commercial_relevance: 'Test relevance',
    core_question_type: 'FACTUAL'
  });
  const registry = {
    'stub': () => ({
      id: 'stub', isPaid: false,
      async healthCheck() { return true; },
      async complete({ prompt }) {
        if (prompt.includes('sameEvent')) {
          return { text: '{"sameEvent": false, "distinctAngle": false}', model: 'stub', requestId: null, inputTokens: 1, outputTokens: 1, estimatedCost: 0, isPaid: false };
        }
        return { text: proposition, model: 'stub', requestId: null, inputTokens: 1, outputTokens: 1, estimatedCost: 0, isPaid: false };
      }
    })
  };
  return new LLMRouter({ priority: ['stub'], allowPaidProviders: false, registry });
}

function goodRawFeatures() {
  return {
    novelty: 50, competition: 50, story_potential: 50, evidence_availability: 50,
    production_difficulty: 50, audience_potential: 50, commercial_intent: 50,
    affiliate_potential: 50, lead_generation_potential: 50, product_adjacency: 50,
    sponsorship_potential: 50, policyRisk: 0, copyrightRisk: 0, repetitionRisk: 0
  };
}

test('A/D: all LLM providers unavailable for one candidate is recorded as a skip, run continues, later candidate still reaches scoring', async () => {
  const observations = [
    observation('a', 'The first candidate for the unique topic Alpha'),
    observation('b', 'The second candidate for the unique topic Beta')
  ];

  // Both candidates hit the same always-times-out router: this proves the
  // per-candidate catch fires for each of them independently (the run
  // still completes with two SKIPPED decisions rather than aborting on
  // the first). The separate "later candidate still processed" claim
  // (mixed pass/fail within one run) is proven by the next test.
  const { stats, selected } = await runDiscoveryPipeline({
    storage: fakeStorage(), runId: 'run-1', observations, llmRouter: timeoutRouter(),
    discoveryPolicy, scoringWeights, alreadyProducedCorpus: [], topK: 5, rawFeatures: () => goodRawFeatures()
  });

  // The run must complete (no uncaught throw) -- this is the core
  // regression this test guards against.
  assert.equal(stats.discovered, 2);
  assert.equal(stats.providerUnavailable, 2, 'both candidates fail proposition generation because the sole provider always times out');

  // B: neither failed candidate increments freshEvaluated.
  assert.equal(stats.freshEvaluated, 0);
  // C: neither failed candidate is counted as budget-exhausted.
  assert.equal(stats.budgetSkipped, 0);
  // Not a content-level rejection either -- distinct bucket.
  assert.equal(stats.propositionRejected, 0);

  assert.equal(stats.scored, 0);
  assert.equal(selected.length, 0);
});

test('D: a candidate unaffected by provider failure (working router) still reaches scoring, proving the pipeline continues past a per-candidate provider failure', async () => {
  const observations = [
    observation('a', 'The first candidate for the unique topic Alpha'),
    observation('b', 'The second candidate for the unique topic Beta')
  ];

  // Candidate 'a' fails proposition generation (provider unavailable);
  // candidate 'b' succeeds via a working stub router. A single llmRouter
  // is shared by the whole run, so this uses a router whose provider
  // fails only for the prompt built from candidate 'a''s observation,
  // succeeding otherwise -- proving per-candidate, not per-run, failure.
  const registry = {
    'flaky': () => ({
      id: 'flaky', isPaid: false,
      async healthCheck() { return true; },
      async complete({ prompt }) {
        if (prompt.includes('sameEvent')) {
          return { text: '{"sameEvent": false, "distinctAngle": false}', model: 'flaky', requestId: null, inputTokens: 1, outputTokens: 1, estimatedCost: 0, isPaid: false };
        }
        if (prompt.includes('Alpha')) {
          const err = new Error('This operation was aborted');
          err.name = 'AbortError';
          throw err;
        }
        const proposition = JSON.stringify({
          subject: 'Test subject', target_audience: 'Test audience', audience_problem: 'Test problem',
          core_question: 'Test question', gap: 'Test gap', angle: 'Test angle',
          differentiation: 'Test differentiation', commercial_relevance: 'Test relevance',
          core_question_type: 'FACTUAL'
        });
        return { text: proposition, model: 'flaky', requestId: null, inputTokens: 1, outputTokens: 1, estimatedCost: 0, isPaid: false };
      }
    })
  };
  const flakyRouter = new LLMRouter({ priority: ['flaky'], allowPaidProviders: false, registry });

  const { stats, selected } = await runDiscoveryPipeline({
    storage: fakeStorage(), runId: 'run-1', observations, llmRouter: flakyRouter,
    discoveryPolicy, scoringWeights, alreadyProducedCorpus: [], topK: 5, rawFeatures: () => goodRawFeatures()
  });

  assert.equal(stats.discovered, 2);
  assert.equal(stats.providerUnavailable, 1);
  assert.equal(stats.scored, 1);
  assert.equal(selected.length, 1);
  assert.equal(selected[0].observation.sourceId, 'b');
});

test('E: a genuine non-provider exception from proposition generation is NOT swallowed and still propagates', async () => {
  const observations = [observation('a', 'The first candidate for the unique topic Alpha')];

  // A router whose complete() throws a plain bug-shaped error (no
  // providerFailures metadata attached -- i.e. not what LLMRouter#complete
  // produces when every eligible provider fails) must still abort the run,
  // proving the pipeline does not broadly classify every exception as
  // provider unavailability.
  const buggyRouter = {
    async complete() {
      throw new TypeError('candidate.observation is not iterable');
    }
  };

  await assert.rejects(
    () => runDiscoveryPipeline({
      storage: fakeStorage(), runId: 'run-1', observations, llmRouter: buggyRouter,
      discoveryPolicy, scoringWeights, alreadyProducedCorpus: [], topK: 5, rawFeatures: () => goodRawFeatures()
    }),
    /candidate\.observation is not iterable/
  );
});

test('F: router aggregate error exposes providerFailures used by the pipeline to classify provider unavailability', async () => {
  const router = timeoutRouter();
  await assert.rejects(
    () => router.complete({ prompt: 'hi' }),
    (err) => {
      assert.ok(Array.isArray(err.providerFailures));
      assert.equal(err.providerFailures.length, 1);
      assert.equal(err.providerFailures[0].id, 'always-times-out');
      assert.equal(err.providerFailures[0].transient, true);
      assert.equal(err.llmProviderUnavailable, true);
      return true;
    }
  );
});