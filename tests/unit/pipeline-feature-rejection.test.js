import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runDiscoveryPipeline } from '../../src/discovery/pipeline.js';
import { LLMRouter } from '../../src/providers/llm/router.js';
import discoveryPolicy from '../../config/discovery_policy.json' with { type: 'json' };
import scoringWeights from '../../config/scoring_weights.json' with { type: 'json' };

// Feature computation (computeRawFeatures) intentionally throws on
// malformed/truncated LLM output rather than fabricating a value -- see
// src/discovery/featureComputation.js's own contract. Prior to this fix,
// runDiscoveryPipeline let that throw propagate uncaught, which aborted
// the ENTIRE Discovery run (including candidates that had already cleared
// proposition validation) over a single malformed response. This is a
// fast, storage-agnostic unit test (a minimal fake storage.run() no-op,
// no SqliteStorageDriver) exercising just the pipeline-boundary handling.

// A minimal fake storage: pipeline.js only calls storage.run(...) for
// logDecision/insertOpportunity in this test's path (no evaluationStore/
// evaluationSchedule is supplied, so storage.transaction is never called).
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

function stubRouter() {
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

test('a rawFeatures() throw rejects only that candidate: run completes, other candidates still reach scoring', async () => {
  const observations = [
    observation('a', 'The first candidate for the unique topic Alpha'),
    observation('b', 'The second candidate for the unique topic Beta')
  ];

  // Candidate 'a' simulates the observed truncated-JSON failure
  // (computeRawFeatures throws); candidate 'b' succeeds normally.
  const rawFeatures = (obs) => {
    if (obs.sourceId === 'a') {
      throw new Error('computeRawFeatures: LLM response was not valid JSON: Unterminated string in JSON at position 148');
    }
    return goodRawFeatures();
  };

  const { stats, selected } = await runDiscoveryPipeline({
    storage: fakeStorage(), runId: 'run-1', observations, llmRouter: stubRouter(),
    discoveryPolicy, scoringWeights, alreadyProducedCorpus: [], topK: 5, rawFeatures
  });

  // The run must complete (no uncaught throw) and report the failure via
  // stats rather than aborting -- this is the core regression this test
  // guards against.
  assert.equal(stats.discovered, 2);
  assert.equal(stats.featureRejected, 1, 'the malformed-feature candidate must be counted as rejected, not crash the run');
  assert.equal(stats.propositionRejected, 0);

  // The other candidate, unaffected by the throw, must still reach
  // scoring/selection -- proving the pipeline continues past the failure.
  assert.equal(stats.scored, 1);
  assert.equal(selected.length, 1);
  assert.equal(selected[0].observation.sourceId, 'b');
});
