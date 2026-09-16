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

function stubRegistry() {
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
        `SELECT id, status
           FROM system_runs
          WHERE id = ?`
      )
      .get(result.runner.runId);

    assert.equal(run.status, 'COMPLETED');

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

test('autonomous entrypoint requires injected Discovery rawFeatures', async () => {
  const { dir, dbPath } = tempDbPath();

  const storage = new SqliteStorageDriver({ dbPath });
  const llmRouter = new LLMRouter({
    priority: ['e2e-stub'],
    allowPaidProviders: false,
    registry: stubRegistry()
  });

  try {
    await assert.rejects(
      () =>
        runAutonomousEntrypoint({
          storage,
          llmRouter,
          discovery: {
            opportunitySource: new SingleCandidateSource()
          }
        }),
      /requires deps\.discovery\.rawFeatures/
    );
  } finally {
    storage.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
