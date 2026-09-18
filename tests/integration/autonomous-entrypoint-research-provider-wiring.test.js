import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import { SqliteStorageDriver } from '../../src/storage/SqliteStorageDriver.js';
import { LLMRouter } from '../../src/providers/llm/router.js';
import { OpportunitySource } from '../../src/providers/opportunity/OpportunitySource.js';
import { TavilySearchProvider } from '../../src/providers/research/TavilySearchProvider.js';
import { runAutonomousEntrypoint } from '../../src/index.js';

// No Discovery work in these tests -- only the Research stage's
// sourceProvider wiring in src/index.js (ADR-0015) is under test.
class NoCandidatesOpportunitySource extends OpportunitySource {
  get id() {
    return 'no-candidates-stub';
  }

  async healthCheck() {
    return true;
  }

  async fetchCandidates() {
    return { candidates: [], failures: [] };
  }

  normalize(candidate) {
    return candidate;
  }
}

function tempDbPath() {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'media-engine-research-provider-wiring-')
  );
  return { dir, dbPath: path.join(dir, 'test.db') };
}

function nowISO() {
  return new Date().toISOString();
}

// Seeds a single opportunity already HANDED_TO_RESEARCH so the runner's
// research stage has exactly one eligible item and actually invokes its
// run() (see selectEligibleResearch in src/autonomous/workSelection.js),
// which is what causes src/index.js's research.sourceProvider wiring to
// be exercised.
function seedHandedToResearchOpportunity(storage) {
  const opportunityId = crypto.randomUUID();
  storage.run(
    `INSERT INTO opportunities (id, title, source, discovered_at, status) VALUES (?, 'Test opportunity', 'rss', ?, 'HANDED_TO_RESEARCH')`,
    [opportunityId, nowISO()]
  );
  return { opportunityId };
}

function baseDeps({ storage, capturedProviders, research }) {
  return {
    storage,
    llmRouter: new LLMRouter({
      priority: ['unused-stub'],
      allowPaidProviders: false,
      registry: {
        'unused-stub': () => ({
          id: 'unused-stub',
          isPaid: false,
          async healthCheck() {
            return true;
          },
          async complete() {
            throw new Error('LLM should not be called in this wiring test');
          }
        })
      }
    }),
    discovery: { opportunitySource: new NoCandidatesOpportunitySource(), topK: 1 },
    research,
    // Substitute only the research stage's real pipeline function so no
    // real Tavily network call happens; capture whatever sourceProvider
    // src/index.js actually supplied for assertion. This mirrors the
    // existing asset-provisioning wiring test's stageFns pattern.
    stageFns: {
      research: ({ sourceProvider }) => {
        capturedProviders.push(sourceProvider);
        return { count: 0 };
      }
    }
  };
}

test('autonomous entrypoint supplies a default TavilySearchProvider to the research stage when none is injected', async () => {
  const { dir, dbPath } = tempDbPath();
  const storage = new SqliteStorageDriver({ dbPath });
  const capturedProviders = [];

  try {
    await storage.migrate();
    seedHandedToResearchOpportunity(storage);

    await runAutonomousEntrypoint(
      baseDeps({ storage, capturedProviders, research: undefined })
    );

    assert.equal(capturedProviders.length, 1);
    assert.ok(capturedProviders[0] instanceof TavilySearchProvider);
  } finally {
    storage.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('autonomous entrypoint still honors an explicitly injected research sourceProvider override', async () => {
  const { dir, dbPath } = tempDbPath();
  const storage = new SqliteStorageDriver({ dbPath });
  const capturedProviders = [];
  const overrideProvider = { id: 'override-stub' };

  try {
    await storage.migrate();
    seedHandedToResearchOpportunity(storage);

    await runAutonomousEntrypoint(
      baseDeps({
        storage,
        capturedProviders,
        research: { sourceProvider: overrideProvider }
      })
    );

    assert.equal(capturedProviders.length, 1);
    assert.equal(capturedProviders[0], overrideProvider);
  } finally {
    storage.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
