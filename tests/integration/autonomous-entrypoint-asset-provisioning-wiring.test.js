import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import { SqliteStorageDriver } from '../../src/storage/SqliteStorageDriver.js';
import { LLMRouter } from '../../src/providers/llm/router.js';
import { OpportunitySource } from '../../src/providers/opportunity/OpportunitySource.js';
import { ResearchSourceProvider } from '../../src/research/ResearchSourceProvider.js';
import { PixabayAssetSourceProvider } from '../../src/providers/asset/PixabayAssetSourceProvider.js';
import { runAutonomousEntrypoint } from '../../src/index.js';

// No Discovery/Research work in these tests -- only the Asset
// Provisioning stage's provider wiring in src/index.js is under test.
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

class NoCandidatesResearchSourceProvider extends ResearchSourceProvider {
  get id() {
    return 'no-candidates-research-stub';
  }

  async healthCheck() {
    return true;
  }

  async discoverCandidates() {
    return { candidates: [], failures: [] };
  }
}

function tempDbPath() {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'media-engine-asset-wiring-')
  );
  return { dir, dbPath: path.join(dir, 'test.db') };
}

function nowISO() {
  return new Date().toISOString();
}

// Seeds a single content_version in state PRODUCED so the runner's
// asset-provisioning stage has exactly one eligible item and actually
// invokes its run() (see selectEligibleAssetProvisioning in
// src/autonomous/workSelection.js), which is what causes
// src/index.js's assetProvisioning.provider wiring to be exercised.
function seedProducedContent(storage) {
  const opportunityId = crypto.randomUUID();
  storage.run(
    `INSERT INTO opportunities (id, title, source, discovered_at, status) VALUES (?, 'Test opportunity', 'rss', ?, 'DISCOVERED')`,
    [opportunityId, nowISO()]
  );
  const contentBriefId = crypto.randomUUID();
  storage.run(
    `INSERT INTO content_briefs
      (id, opportunity_id, working_title, core_question, target_audience, viewer_promise,
       hook, angle, narrative_structure, key_claims, counterpoints, original_insights, visual_ideas,
       monetization_opportunities, risk_assessment, created_at)
     VALUES (?, ?, 'T', 'Q', 'A', 'P', 'H', 'Angle', 'Structure', '[]', 'C', 'I', 'A quiet forest path', 'M', 'R', ?)`,
    [contentBriefId, opportunityId, nowISO()]
  );
  const scriptId = crypto.randomUUID();
  storage.run(
    `INSERT INTO scripts (id, content_brief_id, version, body, claim_links, created_at)
     VALUES (?, ?, 1, 'Script body.', '[]', ?)`,
    [scriptId, contentBriefId, nowISO()]
  );
  const contentVersionId = crypto.randomUUID();
  storage.run(
    `INSERT INTO content_versions (id, content_brief_id, script_id, state, created_at) VALUES (?, ?, ?, 'PRODUCED', ?)`,
    [contentVersionId, contentBriefId, scriptId, nowISO()]
  );
  return { contentBriefId };
}

function baseDeps({ storage, capturedProviders, assetProvisioning }) {
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
    research: { sourceProvider: new NoCandidatesResearchSourceProvider() },
    assetProvisioning,
    // Substitute only the asset-provisioning stage's real pipeline
    // function so no real Pixabay network call happens; capture
    // whatever provider src/index.js actually supplied for assertion.
    stageFns: {
      'asset-provisioning': ({ provider }) => {
        capturedProviders.push(provider);
        return { count: 0 };
      }
    }
  };
}

test('autonomous entrypoint supplies a default PixabayAssetSourceProvider to the asset-provisioning stage when none is injected', async () => {
  const { dir, dbPath } = tempDbPath();
  const storage = new SqliteStorageDriver({ dbPath });
  const capturedProviders = [];

  try {
    await storage.migrate();
    seedProducedContent(storage);

    await runAutonomousEntrypoint(
      baseDeps({ storage, capturedProviders, assetProvisioning: undefined })
    );

    assert.equal(capturedProviders.length, 1);
    assert.ok(capturedProviders[0] instanceof PixabayAssetSourceProvider);
  } finally {
    storage.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('autonomous entrypoint still honors an explicitly injected asset provider override', async () => {
  const { dir, dbPath } = tempDbPath();
  const storage = new SqliteStorageDriver({ dbPath });
  const capturedProviders = [];
  const overrideProvider = { id: 'override-stub' };

  try {
    await storage.migrate();
    seedProducedContent(storage);

    await runAutonomousEntrypoint(
      baseDeps({
        storage,
        capturedProviders,
        assetProvisioning: { provider: overrideProvider }
      })
    );

    assert.equal(capturedProviders.length, 1);
    assert.equal(capturedProviders[0], overrideProvider);
  } finally {
    storage.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
