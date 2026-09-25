import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { SqliteStorageDriver } from '../../src/storage/SqliteStorageDriver.js';
import { LLMRouter } from '../../src/providers/llm/router.js';
import { OpportunitySource } from '../../src/providers/opportunity/OpportunitySource.js';
import { ResearchSourceProvider } from '../../src/research/ResearchSourceProvider.js';
import { runAutonomousEntrypoint } from '../../src/index.js';

class SingleCandidateSource extends OpportunitySource {
  get id() {
    return 'single-candidate-stub';
  }

  async healthCheck() {
    return true;
  }

  async fetchCandidates() {
    return {
      candidates: [{ raw: true }],
      failures: []
    };
  }

  normalize() {
    return {
      title: 'Deterministic Entry Point Opportunity',
      description: 'A deterministic opportunity for autonomous entrypoint testing.',
      source: 'entrypoint-test',
      sourceUrl: 'https://example.test/opportunity',
      discoveredAt: new Date().toISOString()
    };
  }
}

function rawFeaturesStub() {
  return {
    novelty: 90,
    competition: 10,
    story_potential: 90,
    evidence_availability: 90,
    production_difficulty: 10,
    audience_potential: 90,
    commercial_intent: 90,
    affiliate_potential: 90,
    lead_generation_potential: 90,
    product_adjacency: 90,
    sponsorship_potential: 90,
    policyRisk: 0,
    copyrightRisk: 0,
    repetitionRisk: 0
  };
}

class NoCandidatesSourceProvider extends ResearchSourceProvider {
  get id() {
    return 'no-candidates-stub';
  }

  async healthCheck() {
    return true;
  }

  async discoverCandidates() {
    return {
      candidates: [],
      failures: []
    };
  }
}

function featureComputationResponse() {
  return JSON.stringify({
    novelty: 90,
    competition: 10,
    story_potential: 90,
    evidence_availability: 90,
    production_difficulty: 10,
    audience_potential: 90,
    commercial_intent: 90,
    affiliate_potential: 90,
    lead_generation_potential: 90,
    product_adjacency: 90,
    sponsorship_potential: 90
  });
}

function stubRegistry({ featureResponseText = featureComputationResponse() } = {}) {
  return {
    'e2e-stub': () => ({
      id: 'e2e-stub',
      isPaid: false,

      async healthCheck() {
        return true;
      },

      async complete(request) {
        if (request.prompt.includes('same event')) {
          return {
            text: JSON.stringify({
              sameEvent: false,
              confidence: 0.99,
              reason: 'Deterministic test response.'
            })
          };
        }

        // M2: production featureComputation.js's prompt is the only one
        // that requests 'sponsorship_potential' — distinguishes it from
        // the proposition-generation prompt below.
        if (request.prompt.includes('sponsorship_potential')) {
          return { text: featureResponseText };
        }

        return {
          text: JSON.stringify({
            subject: 'Deterministic Entry Point Opportunity',
            target_audience: 'Small business owners',
            audience_problem: 'They need reliable workflow automation information.',
            core_question: 'What does this automation opportunity mean for small businesses?',
            gap: 'Existing coverage lacks a focused practical explanation.',
            angle: 'Explain the opportunity through practical small-business use cases.',
            differentiation: 'Focus on concrete workflows rather than generic AI commentary.',
            commercial_relevance: 'Automation tools can create measurable business value.',
            core_question_type: 'FACTUAL'
          })
        };
      }
    })
  };
}

function tempDbPath() {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'media-engine-entrypoint-')
  );
  return {
    dir,
    dbPath: path.join(dir, 'test.db')
  };
}

test('autonomous entrypoint runs Discovery once and hands off to runner', async () => {
  const { dir, dbPath } = tempDbPath();

  const storage = new SqliteStorageDriver({ dbPath });
  const llmRouter = new LLMRouter({
    priority: ['e2e-stub'],
    allowPaidProviders: false,
    registry: stubRegistry()
  });

  const opportunitySource = new SingleCandidateSource();
  const sourceProvider = new NoCandidatesSourceProvider();

  try {
    const result = await runAutonomousEntrypoint({
      storage,
      llmRouter,
      discovery: {
        opportunitySource,
        rawFeatures: rawFeaturesStub,
        topK: 1
      },
      research: {
        sourceProvider
      }
    });

    assert.equal(result.discovery.stats.discovered, 1);
    assert.equal(result.discovery.stats.selected, 1);

    const opportunity = storage.db
      .prepare(
        `SELECT id, status
           FROM opportunities
          ORDER BY id DESC
          LIMIT 1`
      )
      .get();

    assert.equal(opportunity.status, 'HANDED_TO_RESEARCH');

    assert.ok(result.runner.runId);
    assert.equal(result.runner.stopReason, 'no_work');

    const run = storage.db
      .prepare(
        `SELECT id, status, ceiling_summary
           FROM system_runs
          WHERE id = ?`
      )
      .get(result.runner.runId);

    assert.equal(run.status, 'COMPLETED');

    // Instrumentation: the existing Discovery admission-funnel stats object
    // (runDiscoveryPipeline()'s unmodified `stats`, already returned as
    // result.discovery.stats) must be persisted, unmodified, on the run's
    // system_runs row via the existing ceiling_summary JSON column -- so a
    // real scheduled run's funnel counts are inspectable afterwards without
    // re-running anything.
    assert.ok(run.ceiling_summary, 'system_runs.ceiling_summary must be persisted');
    const persistedCeilingSummary = JSON.parse(run.ceiling_summary);
    assert.deepEqual(
      persistedCeilingSummary.discoveryStats,
      result.discovery.stats,
      'persisted discoveryStats must match the Discovery pipeline\'s own stats object'
    );
    assert.equal(persistedCeilingSummary.discoveryStats.selected, 1);

    const researchProject = storage.db
      .prepare(
        `SELECT opportunity_id
           FROM research_projects
          WHERE opportunity_id = ?
          LIMIT 1`
      )
      .get(opportunity.id);

    assert.equal(researchProject.opportunity_id, opportunity.id);

    const processedResearch = result.runner.processed.find(
      (item) => item.stage === 'research'
    );

    assert.ok(processedResearch);
    assert.equal(processedResearch.count, 1);
  } finally {
    storage.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('autonomous entrypoint persists Discovery admission-funnel stats even when Discovery selects zero candidates (COMPLETED / no_work)', async () => {
  const { dir, dbPath } = tempDbPath();

  const storage = new SqliteStorageDriver({ dbPath });
  const llmRouter = new LLMRouter({
    priority: ['e2e-stub'],
    allowPaidProviders: false,
    registry: stubRegistry()
  });

  const opportunitySource = new SingleCandidateSource();
  const sourceProvider = new NoCandidatesSourceProvider();

  try {
    // topK: 0 -- Discovery scores the candidate but selects none of it, the
    // same "completed but selected zero" shape observed in real no_work
    // runs. This does not change Discovery selection behavior; it only
    // exercises the existing selectDiversePortfolio(riskCleared, topK)
    // path with its existing topK parameter.
    const result = await runAutonomousEntrypoint({
      storage,
      llmRouter,
      discovery: {
        opportunitySource,
        rawFeatures: rawFeaturesStub,
        topK: 0
      },
      research: {
        sourceProvider
      }
    });

    assert.equal(result.discovery.stats.discovered, 1);
    assert.equal(result.discovery.stats.selected, 0);
    assert.equal(result.runner.stopReason, 'no_work');

    const run = storage.db
      .prepare(
        `SELECT id, status, ceiling_summary
           FROM system_runs
          WHERE id = ?`
      )
      .get(result.runner.runId);

    assert.equal(run.status, 'COMPLETED');
    assert.ok(run.ceiling_summary, 'system_runs.ceiling_summary must be persisted for a zero-selected Discovery pass');

    const persistedCeilingSummary = JSON.parse(run.ceiling_summary);
    assert.ok(persistedCeilingSummary.discoveryStats, 'discoveryStats must be present even when nothing was selected');
    assert.equal(persistedCeilingSummary.discoveryStats.selected, 0);
    assert.deepEqual(persistedCeilingSummary.discoveryStats, result.discovery.stats);
  } finally {
    storage.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('autonomous entrypoint computes rawFeatures via production feature computation when not injected (M2)', async () => {
  const { dir, dbPath } = tempDbPath();

  const storage = new SqliteStorageDriver({ dbPath });
  const llmRouter = new LLMRouter({
    priority: ['e2e-stub'],
    allowPaidProviders: false,
    registry: stubRegistry()
  });

  const opportunitySource = new SingleCandidateSource();
  const sourceProvider = new NoCandidatesSourceProvider();

  try {
    const result = await runAutonomousEntrypoint({
      storage,
      llmRouter,
      discovery: {
        opportunitySource,
        // No rawFeatures supplied: must fall back to
        // src/discovery/featureComputation.js's computeRawFeatures,
        // routed entirely through the injected llmRouter — no network
        // access, no real credentials.
        topK: 1
      },
      research: {
        sourceProvider
      }
    });

    assert.equal(result.discovery.stats.discovered, 1);
    assert.equal(result.discovery.stats.selected, 1);

    const opportunity = storage.db
      .prepare(
        `SELECT id, status
           FROM opportunities
          ORDER BY id DESC
          LIMIT 1`
      )
      .get();

    assert.equal(opportunity.status, 'HANDED_TO_RESEARCH');
  } finally {
    storage.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('autonomous entrypoint propagates an explicit failure when production feature computation returns malformed LLM output (M2)', async () => {
  const { dir, dbPath } = tempDbPath();

  const storage = new SqliteStorageDriver({ dbPath });
  const llmRouter = new LLMRouter({
    priority: ['e2e-stub'],
    allowPaidProviders: false,
    // Feature-computation prompt resolves to a response missing required
    // numeric fields — must reject explicitly, not fabricate a score.
    registry: stubRegistry({ featureResponseText: JSON.stringify({ novelty: 90 }) })
  });

  try {
    await assert.rejects(
      () =>
        runAutonomousEntrypoint({
          storage,
          llmRouter,
          discovery: {
            opportunitySource: new SingleCandidateSource(),
            topK: 1
          }
        }),
      /missing or invalid numeric value/
    );
  } finally {
    storage.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
