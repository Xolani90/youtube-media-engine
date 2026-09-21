import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { SqliteStorageDriver } from '../../src/storage/SqliteStorageDriver.js';
import { config } from '../../src/config/index.js';
import { runAutonomousOperation } from '../../src/autonomous/runner.js';
import {
  selectEligibleResearch,
  selectEligibleBriefs,
  selectEligibleScripts,
  selectEligibleFactChecks,
  selectEligibleOriginalityChecks,
  selectEligibleQualityGates,
  selectEligibleProductions,
  selectEligibleAssetProvisioning,
  selectEligibleMediaProductions,
  selectEligiblePublications
} from '../../src/autonomous/workSelection.js';
import { runPublication } from '../../src/publication/pipeline.js';
import { PublicationProvider } from '../../src/publication/PublicationProvider.js';
import { PUBLICATION_RESULT_STATUS } from '../../src/publication/constants.js';
import { AssetSourceProvider } from '../../src/providers/asset/AssetSourceProvider.js';

function freshStorage() {
  const dbPath = path.join(os.tmpdir(), `autonomous-runner-${Date.now()}-${Math.random()}.db`);
  return { storage: new SqliteStorageDriver({ dbPath }), dbPath };
}

function cleanup(storage, dbPath, ...files) {
  storage.close();
  fs.rmSync(dbPath, { force: true });
  fs.rmSync(`${dbPath}-wal`, { force: true });
  fs.rmSync(`${dbPath}-shm`, { force: true });
  for (const f of files) fs.rmSync(f, { force: true });
}

function nowISO() {
  return new Date().toISOString();
}

function insertOpportunity(storage, { status = 'DISCOVERED' } = {}) {
  const id = crypto.randomUUID();
  storage.run(
    `INSERT INTO opportunities (id, title, source, discovered_at, status) VALUES (?, 'T', 'rss', ?, ?)`,
    [id, nowISO(), status]
  );
  return id;
}

function insertResearchProject(storage, opportunityId, { status = 'RESEARCHING' } = {}) {
  const id = crypto.randomUUID();
  storage.run(
    `INSERT INTO research_projects (id, opportunity_id, status, created_at) VALUES (?, ?, ?, ?)`,
    [id, opportunityId, status, nowISO()]
  );
  return id;
}

function insertContentBrief(storage, opportunityId, { researchProjectId = null } = {}) {
  const id = crypto.randomUUID();
  storage.run(
    `INSERT INTO content_briefs (id, opportunity_id, research_project_id, working_title, created_at) VALUES (?, ?, ?, 'T', ?)`,
    [id, opportunityId, researchProjectId, nowISO()]
  );
  return id;
}

function insertScript(storage, contentBriefId) {
  const id = crypto.randomUUID();
  storage.run(
    `INSERT INTO scripts (id, content_brief_id, version, body, claim_links, created_at) VALUES (?, ?, 1, 'Body.', '[]', ?)`,
    [id, contentBriefId, nowISO()]
  );
  return id;
}

function insertContentVersion(storage, contentBriefId, scriptId, state) {
  const id = crypto.randomUUID();
  storage.run(
    `INSERT INTO content_versions (id, content_brief_id, script_id, state, created_at) VALUES (?, ?, ?, ?, ?)`,
    [id, contentBriefId, scriptId, state, nowISO()]
  );
  return id;
}

function insertMediaArtifact(storage, contentVersionId, mediaFilePath) {
  const productionId = crypto.randomUUID();
  storage.run(
    `INSERT INTO productions (id, content_version_id, script_id, artifact_type, artifact_path, artifact_checksum, manifest_json, created_at)
     VALUES (?, ?, (SELECT script_id FROM content_versions WHERE id = ?), 'production_manifest_v1', '/tmp/x', 'deadbeef', '{}', ?)`,
    [productionId, contentVersionId, contentVersionId, nowISO()]
  );
  const mediaArtifactId = crypto.randomUUID();
  storage.run(
    `INSERT INTO media_artifacts
      (id, production_id, content_version_id, render_spec_json, render_spec_checksum,
       narration_path, narration_duration_seconds, artifact_path, artifact_checksum,
       duration_seconds, width, height, video_codec, audio_codec, created_at)
     VALUES (?, ?, ?, '{}', 'chk', '/tmp/n.wav', 5.0, ?, 'chk2', 5.0, 1280, 720, 'h264', 'aac', ?)`,
    [mediaArtifactId, productionId, contentVersionId, mediaFilePath, nowISO()]
  );
  return mediaArtifactId;
}

/**
 * Builds a full opportunity -> content_brief -> script -> content_version
 * chain at a given content_versions.state. The opportunity is seeded past
 * 'HANDED_TO_RESEARCH' (an arbitrary later status) precisely so it is
 * NOT also picked up by selectEligibleResearch -- these chains already
 * have a content_brief, so re-selecting them for Research would be
 * wrong regardless.
 */
function seedChainAtState(storage, state) {
  const opportunityId = insertOpportunity(storage, { status: 'RESEARCH_HANDED_OFF_TEST_FIXTURE' });
  const contentBriefId = insertContentBrief(storage, opportunityId);
  const scriptId = insertScript(storage, contentBriefId);
  const contentVersionId = insertContentVersion(storage, contentBriefId, scriptId, state);
  return { opportunityId, contentBriefId, scriptId, contentVersionId };
}

// ---------------------------------------------------------------------
// 1. Work-selection query correctness per stage
// ---------------------------------------------------------------------

test('selectEligibleResearch: only HANDED_TO_RESEARCH opportunities without an existing research_project', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();

  const eligible = insertOpportunity(storage, { status: 'HANDED_TO_RESEARCH' });
  const wrongStatus = insertOpportunity(storage, { status: 'SCORED' });
  const alreadyResearched = insertOpportunity(storage, { status: 'HANDED_TO_RESEARCH' });
  insertResearchProject(storage, alreadyResearched, { status: 'RESEARCH_COMPLETE' });

  const result = selectEligibleResearch(storage).map((r) => r.opportunityId);
  assert.deepEqual(result.sort(), [eligible].sort());
  assert.ok(!result.includes(wrongStatus));
  assert.ok(!result.includes(alreadyResearched));

  cleanup(storage, dbPath);
});

test('selectEligibleBriefs: only RESEARCH_COMPLETE research_projects without an existing content_brief', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();

  const opp1 = insertOpportunity(storage, { status: 'HANDED_TO_RESEARCH' });
  const eligible = insertResearchProject(storage, opp1, { status: 'RESEARCH_COMPLETE' });

  const opp2 = insertOpportunity(storage, { status: 'HANDED_TO_RESEARCH' });
  const stillResearching = insertResearchProject(storage, opp2, { status: 'RESEARCHING' });

  const opp3 = insertOpportunity(storage, { status: 'HANDED_TO_RESEARCH' });
  const alreadyBriefed = insertResearchProject(storage, opp3, { status: 'RESEARCH_COMPLETE' });
  insertContentBrief(storage, opp3, { researchProjectId: alreadyBriefed });

  const result = selectEligibleBriefs(storage).map((r) => r.researchProjectId);
  assert.deepEqual(result, [eligible]);
  assert.ok(!result.includes(stillResearching));
  assert.ok(!result.includes(alreadyBriefed));

  cleanup(storage, dbPath);
});

test('per-content_versions-state work-selection queries return exactly the content_brief_id at that state, and exclude every other state', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();

  const cases = [
    ['BRIEF_CREATED', selectEligibleScripts],
    ['SCRIPT_DRAFT', selectEligibleFactChecks],
    ['FACT_CHECK', selectEligibleOriginalityChecks],
    ['ORIGINALITY_CHECK', selectEligibleQualityGates],
    ['PRODUCTION_READY', selectEligibleProductions],
    ['PRODUCED', selectEligibleMediaProductions]
  ];

  const seeded = cases.map(([state]) => ({ state, ...seedChainAtState(storage, state) }));
  // A handful of terminal/failure states and an unrelated in-progress
  // state, to prove they are excluded from every one of the queries above.
  seedChainAtState(storage, 'REJECTED');
  seedChainAtState(storage, 'BLOCKED');
  seedChainAtState(storage, 'PUBLISHED');
  seedChainAtState(storage, 'QUALITY_GATE');

  for (const [state, selectFn] of cases) {
    const expected = seeded.find((s) => s.state === state).contentBriefId;
    const result = selectFn(storage).map((r) => r.contentBriefId);
    assert.deepEqual(result, [expected], `selectFn for state ${state} returned an unexpected set`);
  }

  cleanup(storage, dbPath);
});

test('selectEligiblePublications: state=PRODUCED with a media_artifacts row, excluding PRODUCED-without-media and PUBLISHED', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();

  const videoFile = path.join(os.tmpdir(), `autonomous-pub-${crypto.randomUUID()}.mp4`);
  fs.writeFileSync(videoFile, 'fake mp4 bytes');

  const withMedia = seedChainAtState(storage, 'PRODUCED');
  insertMediaArtifact(storage, withMedia.contentVersionId, videoFile);

  const withoutMedia = seedChainAtState(storage, 'PRODUCED');

  const published = seedChainAtState(storage, 'PUBLISHED');
  insertMediaArtifact(storage, published.contentVersionId, videoFile);

  const result = selectEligiblePublications(storage).map((r) => r.contentBriefId);
  assert.deepEqual(result, [withMedia.contentBriefId]);
  assert.ok(!result.includes(withoutMedia.contentBriefId));
  assert.ok(!result.includes(published.contentBriefId));

  cleanup(storage, dbPath, videoFile);
});

// ---------------------------------------------------------------------
// 2. Runner dispatches each selected item to the right stage function
// ---------------------------------------------------------------------

test('runner dispatches each eligible item to its stage function, exactly once per item, and advances state so later stages see it in the same invocation', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();

  // Only seed at the very first stage (Research) -- each mock stage
  // function below "advances" its own item to the next stage's eligible
  // condition, proving a single invocation carries an item through
  // multiple stages via repeated sweeps.
  const opportunityId = insertOpportunity(storage, { status: 'HANDED_TO_RESEARCH' });

  const calls = [];
  let researchProjectId;
  let contentBriefId;
  let scriptId;
  let contentVersionId;

  const stageFns = {
    research: async ({ opportunityId: oppId }) => {
      calls.push(['research', oppId]);
      researchProjectId = insertResearchProject(storage, oppId, { status: 'RESEARCH_COMPLETE' });
      return {};
    },
    brief: async ({ researchProjectId: rpId }) => {
      calls.push(['brief', rpId]);
      contentBriefId = insertContentBrief(storage, opportunityId, { researchProjectId: rpId });
      scriptId = insertScript(storage, contentBriefId);
      contentVersionId = insertContentVersion(storage, contentBriefId, scriptId, 'BRIEF_CREATED');
      return {};
    },
    script: async ({ contentBriefId: cbId }) => {
      calls.push(['script', cbId]);
      storage.run(`UPDATE content_versions SET state = 'SCRIPT_DRAFT' WHERE content_brief_id = ?`, [cbId]);
      return {};
    },
    'fact-check': async ({ contentBriefId: cbId }) => {
      calls.push(['fact-check', cbId]);
      storage.run(`UPDATE content_versions SET state = 'FACT_CHECK' WHERE content_brief_id = ?`, [cbId]);
      return {};
    },
    originality: async ({ contentBriefId: cbId }) => {
      calls.push(['originality', cbId]);
      storage.run(`UPDATE content_versions SET state = 'ORIGINALITY_CHECK' WHERE content_brief_id = ?`, [cbId]);
      return {};
    },
    'quality-gate': async ({ contentBriefId: cbId }) => {
      calls.push(['quality-gate', cbId]);
      // Terminal for this test -- stop advancing here.
      return {};
    }
  };

  const result = await runAutonomousOperation({
    storage,
    stageFns,
  });

  assert.deepEqual(
    calls.map((c) => c[0]),
    ['research', 'brief', 'script', 'fact-check', 'originality', 'quality-gate']
  );
  assert.equal(calls.filter((c) => c[0] === 'research').length, 1, 'research called exactly once');
  assert.equal(calls[0][1], opportunityId);
  assert.ok(researchProjectId && contentBriefId && scriptId && contentVersionId);
  // The mock quality-gate stage never advances state (deliberately, to
  // keep this test focused on dispatch order), so the item remains
  // eligible for 'quality-gate' forever -- the no_progress guard is what
  // stops the sweep, not a genuine absence of eligible work.
  assert.equal(result.stopReason, 'no_progress');
  assert.ok(result.sweeps >= 6);
  const qgCount = result.processed.find((p) => p.stage === 'quality-gate').count;
  assert.equal(qgCount, 1);

  cleanup(storage, dbPath);
});

// ---------------------------------------------------------------------
// 3. Runner stops cleanly when no work remains / no infinite loop
// ---------------------------------------------------------------------

test('runner stops with stopReason no_work on a single invocation when nothing is eligible', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();

  const result = await runAutonomousOperation({ storage });

  assert.equal(result.stopReason, 'no_work');
  assert.equal(result.sweeps, 1);
  assert.ok(result.processed.every((p) => p.count === 0));

  cleanup(storage, dbPath);
});

test('runner stops with stopReason no_progress instead of looping forever when a stage function never changes eligibility', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();

  seedChainAtState(storage, 'BRIEF_CREATED');
  let scriptCalls = 0;

  const result = await runAutonomousOperation({
    storage,
    stageFns: {
      script: async () => {
        scriptCalls += 1;
        // Deliberately does NOT change content_versions.state -- the
        // item remains eligible for 'script' forever, the way a stuck
        // no-op stage call would.
        return {};
      }
    }
  });

  assert.equal(result.stopReason, 'no_progress');
  // Called once (the sweep that discovered it was still eligible after
  // no change) -- the guard must prevent a second, third, ... call, not
  // merely cap it at some arbitrary large number.
  assert.equal(scriptCalls, 1);
  assert.ok(result.sweeps <= 3, 'runner must not loop indefinitely');

  cleanup(storage, dbPath);
});

test('a stage error aborts the run and is rethrown when no onStageError handler is given', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  seedChainAtState(storage, 'BRIEF_CREATED');

  await assert.rejects(
    () =>
      runAutonomousOperation({
        storage,
        stageFns: {
          script: async () => {
            throw new Error('boom');
          }
        }
      }),
    /boom/
  );

  cleanup(storage, dbPath);
});

test('a stage error is swallowed and reported via onStageError, and the run completes', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  seedChainAtState(storage, 'BRIEF_CREATED');

  const errors = [];
  const result = await runAutonomousOperation({
    storage,
    onStageError: (stage, item, err) => errors.push({ stage, item, message: err.message }),
    stageFns: {
      script: async () => {
        throw new Error('boom');
      }
    }
  });

  assert.equal(errors.length, 1);
  assert.equal(errors[0].stage, 'script');
  assert.equal(errors[0].message, 'boom');
  // No progress was possible on that item (state never advanced), so the
  // no_progress guard still applies rather than looping.
  assert.equal(result.stopReason, 'no_progress');

  cleanup(storage, dbPath);
});

// ---------------------------------------------------------------------
// 3b. Asset Provisioning runner integration (E2)
// ---------------------------------------------------------------------

class StubAssetProvider extends AssetSourceProvider {
  constructor({ location, verificationStatus = 'VERIFIED' } = {}) {
    super();
    this._location = location;
    this._verificationStatus = verificationStatus;
    this.calls = 0;
  }
  get id() {
    return 'stub';
  }
  async healthCheck() {
    return true;
  }
  async acquireVisualAsset() {
    this.calls += 1;
    if (!this._location) return null;
    return {
      assetType: 'image',
      location: this._location,
      origin: 'stub-provider',
      license: 'Test License',
      verificationStatus: this._verificationStatus
    };
  }
}

test('selectEligibleAssetProvisioning: only content_versions.state = PRODUCED, same shape as buildStages() expects', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();

  const eligible = seedChainAtState(storage, 'PRODUCED');
  seedChainAtState(storage, 'PRODUCTION_READY');
  seedChainAtState(storage, 'PUBLISHED');

  const result = selectEligibleAssetProvisioning(storage).map((r) => r.contentBriefId);
  assert.deepEqual(result, [eligible.contentBriefId]);

  cleanup(storage, dbPath);
});

test('runner stage order: production runs before asset-provisioning, which runs before media-production', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();

  seedChainAtState(storage, 'PRODUCTION_READY');
  const calls = [];

  await runAutonomousOperation({
    storage,
    stageFns: {
      production: async ({ contentBriefId }) => {
        calls.push('production');
        storage.run(`UPDATE content_versions SET state = 'PRODUCED' WHERE content_brief_id = ?`, [contentBriefId]);
        return {};
      },
      'asset-provisioning': async () => {
        calls.push('asset-provisioning');
        return {};
      },
      'media-production': async () => {
        calls.push('media-production');
        return {};
      }
    }
  });

  const order = calls.filter((c) => ['production', 'asset-provisioning', 'media-production'].includes(c));
  assert.deepEqual(order, ['production', 'asset-provisioning', 'media-production']);

  cleanup(storage, dbPath);
});

test('asset-provisioning stage receives the configured provider through the runner dependency object', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();

  seedChainAtState(storage, 'PRODUCED');
  const provider = new StubAssetProvider({ location: null });

  let receivedProvider = null;
  await runAutonomousOperation({
    storage,
    assetProvisioning: { provider },
    stageFns: {
      'asset-provisioning': async (callArgs) => {
        receivedProvider = callArgs.provider;
        return {};
      }
    }
  });

  assert.equal(receivedProvider, provider);

  cleanup(storage, dbPath);
});

test('same-sweep integration: a PRODUCED item is provisioned by Asset Provisioning before Media Production runs, and Media Production sees the persisted asset', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();

  const assetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autonomous-asset-provisioning-'));
  const assetPath = path.join(assetDir, 'forest.jpg');
  fs.writeFileSync(assetPath, 'real-local-visual-file-bytes');

  const seeded = seedChainAtState(storage, 'PRODUCED');
  // Give the content_brief usable visual context so Asset Provisioning's
  // own deriveVisualQuery() does not short-circuit with NO_VISUAL_CONTEXT.
  storage.run(`UPDATE content_briefs SET visual_ideas = 'A quiet forest path' WHERE id = ?`, [seeded.contentBriefId]);
  const productionId = crypto.randomUUID();
  storage.run(
    `INSERT INTO productions (id, content_version_id, script_id, artifact_type, artifact_path, artifact_checksum, manifest_json, created_at)
     VALUES (?, ?, ?, 'production_manifest_v1', '/tmp/manifest.json', 'deadbeef', '{}', ?)`,
    [productionId, seeded.contentVersionId, seeded.scriptId, nowISO()]
  );

  const provider = new StubAssetProvider({ location: assetPath });
  let mediaProductionSawAsset = false;

  const result = await runAutonomousOperation({
    storage,
    assetProvisioning: { provider },
    stageFns: {
      // Media Production's real render path depends on FFmpeg/espeak,
      // which are not deterministically available in this test
      // environment (see the 7 documented pre-existing Media/FFmpeg
      // failures) -- this stub substitutes only the render step, while
      // still asserting the actual cross-stage integration: that by the
      // time media-production is dispatched, the asset Asset
      // Provisioning persisted is already visible via real storage
      // reads, not a fake handed to it in-memory.
      'media-production': async ({ storage: s, contentBriefId }) => {
        const cv = s.get('SELECT * FROM content_versions WHERE content_brief_id = ?', [contentBriefId]);
        const assetUsage = s.get('SELECT * FROM asset_usages WHERE content_version_id = ?', [cv.id]);
        mediaProductionSawAsset = Boolean(assetUsage);
        return {};
      }
    }
  });

  assert.equal(provider.calls, 1, 'the injected provider was actually invoked by the real Asset Provisioning stage');
  assert.ok(mediaProductionSawAsset, 'media-production must see the asset persisted by asset-provisioning in the same sweep');

  const assetUsageRow = storage.get('SELECT * FROM asset_usages WHERE content_version_id = ?', [seeded.contentVersionId]);
  assert.ok(assetUsageRow);
  const assetRow = storage.get('SELECT * FROM assets WHERE id = ?', [assetUsageRow.asset_id]);
  assert.equal(assetRow.location, assetPath);

  const cv = storage.get('SELECT * FROM content_versions WHERE id = ?', [seeded.contentVersionId]);
  assert.equal(cv.state, 'PRODUCED', 'asset-provisioning must never transition content_versions.state');
  assert.equal(result.processed.find((p) => p.stage === 'asset-provisioning').count, 1);

  cleanup(storage, dbPath);
  fs.rmSync(assetDir, { recursive: true, force: true });
});

test('provisioning failure: no exception, structured outcome only, and existing no-progress protection still terminates the run', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();

  const seeded = seedChainAtState(storage, 'PRODUCED');
  storage.run(`UPDATE content_briefs SET visual_ideas = 'A quiet forest path' WHERE id = ?`, [seeded.contentBriefId]);
  const productionId = crypto.randomUUID();
  storage.run(
    `INSERT INTO productions (id, content_version_id, script_id, artifact_type, artifact_path, artifact_checksum, manifest_json, created_at)
     VALUES (?, ?, ?, 'production_manifest_v1', '/tmp/manifest.json', 'deadbeef', '{}', ?)`,
    [productionId, seeded.contentVersionId, seeded.scriptId, nowISO()]
  );

  // Provider returns null -> Asset Provisioning's own NO_ASSET_ACQUIRED
  // structured outcome (never an exception).
  const provider = new StubAssetProvider({ location: null });

  const result = await runAutonomousOperation({
    storage,
    assetProvisioning: { provider }
  });

  assert.equal(result.stopReason, 'no_progress');
  assert.ok(result.sweeps <= 3, 'runner must not loop indefinitely on a provisioning failure');
  // asset-provisioning does not transition state, so it remains
  // eligible for both asset-provisioning and media-production every
  // sweep -- the no-progress guard (not a runner code change) is what
  // stops the loop, exactly as for any other stuck no-op stage.
  assert.equal(provider.calls, 1);
  const cv = storage.get('SELECT * FROM content_versions WHERE id = ?', [seeded.contentVersionId]);
  assert.equal(cv.state, 'PRODUCED');
  const assetUsageRow = storage.get('SELECT * FROM asset_usages WHERE content_version_id = ?', [seeded.contentVersionId]);
  assert.equal(assetUsageRow, undefined, 'no asset row is persisted on a failed acquisition');

  cleanup(storage, dbPath);
});

// ---------------------------------------------------------------------
// 4. Genuine two-invocation race, reusing the real runPublication
// ---------------------------------------------------------------------

class MockAdapter extends PublicationProvider {
  constructor(resultOrFn) {
    super();
    this._resultOrFn = resultOrFn;
    this.calls = [];
  }
  get id() {
    return 'mock';
  }
  async publish(request) {
    this.calls.push(request);
    return typeof this._resultOrFn === 'function' ? this._resultOrFn(request) : this._resultOrFn;
  }
}

test('two concurrent runner invocations against the same DB file cannot both invoke the Publication provider for the same item', async () => {
  const dbPath = path.join(os.tmpdir(), `autonomous-race-${Date.now()}-${Math.random()}.db`);
  const storageA = new SqliteStorageDriver({ dbPath });
  await storageA.migrate();
  const storageB = new SqliteStorageDriver({ dbPath });

  const videoFile = path.join(os.tmpdir(), `autonomous-race-${crypto.randomUUID()}.mp4`);
  fs.writeFileSync(videoFile, 'fake mp4 bytes');

  const seeded = seedChainAtState(storageA, 'PRODUCED');
  insertMediaArtifact(storageA, seeded.contentVersionId, videoFile);

  const adapterA = new MockAdapter({ status: PUBLICATION_RESULT_STATUS.SUCCESS, provider: 'mock', providerItemId: 'vidA', providerUrl: 'https://x/vidA' });
  const adapterB = new MockAdapter({ status: PUBLICATION_RESULT_STATUS.SUCCESS, provider: 'mock', providerItemId: 'vidB', providerUrl: 'https://x/vidB' });

  const originalPath = config.authorizedExternalActionsPath;
  const originalMode = config.runMode;
  const originalAutonomous = config.autonomousEnabled;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autonomous-race-auth-'));
  const authPath = path.join(dir, 'authorized.json');
  fs.writeFileSync(authPath, JSON.stringify([`publish:mock:${seeded.contentVersionId}`]));
  config.authorizedExternalActionsPath = authPath;
  config.runMode = 'LIVE';
  config.autonomousEnabled = true;

  try {
    const [resultA, resultB] = await Promise.all([
      runAutonomousOperation({
        storage: storageA,
        publication: { provider: 'mock', adapter: adapterA }
      }),
      runAutonomousOperation({
        storage: storageB,
        publication: { provider: 'mock', adapter: adapterB }
      })
    ]);

    assert.ok(resultA && resultB);
    const totalProviderCalls = adapterA.calls.length + adapterB.calls.length;
    assert.equal(totalProviderCalls, 1, 'the provider must be invoked exactly once across both concurrent invocations');

    const rows = storageA.all('SELECT * FROM publications WHERE content_version_id = ?', [seeded.contentVersionId]);
    assert.equal(rows.length, 1, 'the UNIQUE(content_version_id, provider) index must still hold: exactly one publications row');
    assert.equal(rows[0].status, 'PUBLISHED');
  } finally {
    config.authorizedExternalActionsPath = originalPath;
    config.runMode = originalMode;
    config.autonomousEnabled = originalAutonomous;
  }

  storageA.close();
  storageB.close();
  fs.rmSync(dbPath, { force: true });
  fs.rmSync(`${dbPath}-wal`, { force: true });
  fs.rmSync(`${dbPath}-shm`, { force: true });
  fs.rmSync(videoFile, { force: true });
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------
// 5. Crash-simulation: interrupted PENDING publication is never
//    silently re-published by a second runner invocation.
// ---------------------------------------------------------------------

test('crash simulation: a runner invocation after an interrupted publication attempt does not silently resume it as a fresh publish', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();

  const videoFile = path.join(os.tmpdir(), `autonomous-crash-${crypto.randomUUID()}.mp4`);
  fs.writeFileSync(videoFile, 'fake mp4 bytes');
  const seeded = seedChainAtState(storage, 'PRODUCED');
  insertMediaArtifact(storage, seeded.contentVersionId, videoFile);

  // Simulate a process killed mid-publish: a PENDING publications row
  // with no terminal outcome, matching real interruption (checkpoint
  // §12) -- content_versions.state is still PRODUCED.
  const mediaArtifactRow = storage.get('SELECT id FROM media_artifacts WHERE content_version_id = ?', [seeded.contentVersionId]);
  storage.run(
    `INSERT INTO publications (id, content_version_id, media_artifact_id, provider, status, request_json, attempt_count, created_at, updated_at)
     VALUES (?, ?, ?, 'mock', 'PENDING', '{}', 1, ?, ?)`,
    [crypto.randomUUID(), seeded.contentVersionId, mediaArtifactRow.id, nowISO(), nowISO()]
  );

  const adapter = new MockAdapter({ status: PUBLICATION_RESULT_STATUS.SUCCESS, provider: 'mock', providerItemId: 'vid1', providerUrl: 'https://x/vid1' });

  const originalPath = config.authorizedExternalActionsPath;
  const originalMode = config.runMode;
  const originalAutonomous = config.autonomousEnabled;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autonomous-crash-auth-'));
  const authPath = path.join(dir, 'authorized.json');
  fs.writeFileSync(authPath, JSON.stringify([`publish:mock:${seeded.contentVersionId}`]));
  config.authorizedExternalActionsPath = authPath;
  config.runMode = 'LIVE';
  config.autonomousEnabled = true;

  try {
    await runAutonomousOperation({
      storage,
      publication: { provider: 'mock', adapter }
    });
  } finally {
    config.authorizedExternalActionsPath = originalPath;
    config.runMode = originalMode;
    config.autonomousEnabled = originalAutonomous;
  }

  // The provider must never be called against an interrupted PENDING
  // row -- Publication v1 maps it to AMBIGUOUS, never blindly resumed
  // (checkpoint §4/§12), so the runner reaching it produces no new
  // provider call and no duplicate row.
  assert.equal(adapter.calls.length, 0);
  const rows = storage.all('SELECT * FROM publications WHERE content_version_id = ?', [seeded.contentVersionId]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'AMBIGUOUS');
  const cv = storage.get('SELECT * FROM content_versions WHERE id = ?', [seeded.contentVersionId]);
  assert.equal(cv.state, 'PRODUCED');

  cleanup(storage, dbPath, videoFile);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------
// 6. Explicit non-authorization test
// ---------------------------------------------------------------------

test('with authorized_external_actions.json empty, the runner reaching Publication for a genuinely eligible item is still refused, never bypassed', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();

  const videoFile = path.join(os.tmpdir(), `autonomous-noauth-${crypto.randomUUID()}.mp4`);
  fs.writeFileSync(videoFile, 'fake mp4 bytes');
  const seeded = seedChainAtState(storage, 'PRODUCED');
  insertMediaArtifact(storage, seeded.contentVersionId, videoFile);

  const adapter = new MockAdapter({ status: PUBLICATION_RESULT_STATUS.SUCCESS, provider: 'mock', providerItemId: 'vid1', providerUrl: 'https://x/vid1' });

  const originalPath = config.authorizedExternalActionsPath;
  const originalMode = config.runMode;
  const originalAutonomous = config.autonomousEnabled;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autonomous-noauth-'));
  const authPath = path.join(dir, 'authorized.json');
  fs.writeFileSync(authPath, JSON.stringify([])); // empty -- matches config/authorized_external_actions.json's real default
  config.authorizedExternalActionsPath = authPath;
  config.runMode = 'LIVE';
  config.autonomousEnabled = true;

  let result;
  try {
    result = await runAutonomousOperation({
      storage,
      publication: { provider: 'mock', adapter }
    });
  } finally {
    config.authorizedExternalActionsPath = originalPath;
    config.runMode = originalMode;
    config.autonomousEnabled = originalAutonomous;
  }

  assert.equal(adapter.calls.length, 0, 'the provider must never be called when the action is not authorized');
  const rows = storage.all('SELECT * FROM publications WHERE content_version_id = ?', [seeded.contentVersionId]);
  assert.equal(rows.length, 0, 'no publications row is created for a denied attempt');
  const cv = storage.get('SELECT * FROM content_versions WHERE id = ?', [seeded.contentVersionId]);
  assert.equal(cv.state, 'PRODUCED', 'content_versions.state is never advanced past PRODUCED without a confirmed publish');
  // Publication is reached (it is the only eligible item) but its own
  // AUTHORIZATION_DENIED outcome does not throw -- runPublication
  // returns it as a normal outcome -- so the sweep completes cleanly.
  assert.equal(result.stopReason, 'no_progress');
  assert.equal(result.processed.find((p) => p.stage === 'publication').count, 1);

  cleanup(storage, dbPath, videoFile);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------
// 6. D-C2 mode propagation (FIND-DC2-MODE-001): a SIMULATION
//    autonomous run must never reach the Publication provider merely
//    because process-global config.runMode happens to be LIVE.
// ---------------------------------------------------------------------

test('D-C2: a SIMULATION autonomous run does not reach the Publication provider even though process-global config.runMode is LIVE and the action is authorized', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();

  const videoFile = path.join(os.tmpdir(), `autonomous-dc2-${crypto.randomUUID()}.mp4`);
  fs.writeFileSync(videoFile, 'fake mp4 bytes');
  const seeded = seedChainAtState(storage, 'PRODUCED');
  insertMediaArtifact(storage, seeded.contentVersionId, videoFile);

  const adapter = new MockAdapter({ status: PUBLICATION_RESULT_STATUS.SUCCESS, provider: 'mock', providerItemId: 'vid1', providerUrl: 'https://x/vid1' });

  const originalPath = config.authorizedExternalActionsPath;
  const originalMode = config.runMode;
  const originalAutonomous = config.autonomousEnabled;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autonomous-dc2-auth-'));
  const authPath = path.join(dir, 'authorized.json');
  // The exact action is authorized -- this test isolates the mode
  // propagation defect from authorization-file denial (already covered
  // by the preceding test).
  fs.writeFileSync(authPath, JSON.stringify([`publish:mock:${seeded.contentVersionId}`]));
  config.authorizedExternalActionsPath = authPath;
  // The confused-deputy condition: process-global config says LIVE...
  config.runMode = 'LIVE';
  config.autonomousEnabled = true;

  let result;
  try {
    // ...but THIS run is explicitly started as SIMULATION. Per
    // ADR-0008 §3.3, SIMULATION is absolute and must deny the external
    // action regardless of config.runMode.
    result = await runAutonomousOperation({
      storage,
      mode: 'SIMULATION',
      publication: { provider: 'mock', adapter }
    });
  } finally {
    config.authorizedExternalActionsPath = originalPath;
    config.runMode = originalMode;
    config.autonomousEnabled = originalAutonomous;
  }

  // A. the run is actually SIMULATION (persisted + returned).
  assert.equal(result.mode, 'SIMULATION');
  const runRow = storage.get('SELECT mode FROM system_runs WHERE id = ?', [result.runId]);
  assert.equal(runRow.mode, 'SIMULATION');

  // D + E. Publication was genuinely reached (it is the only eligible
  // item, and it is reached exactly once) but the provider was NEVER
  // called -- this is the critical security assertion.
  assert.equal(result.processed.find((p) => p.stage === 'publication').count, 1);
  assert.equal(adapter.calls.length, 0, 'provider.publish() must not be called for a SIMULATION run');

  // F. No publications row reaches PUBLISHED (in fact none is created
  // at all -- the D-C2 check runs before the durable claim/insert).
  const rows = storage.all('SELECT * FROM publications WHERE content_version_id = ?', [seeded.contentVersionId]);
  assert.equal(rows.length, 0, 'no publications row is created when D-C2 denies the action');
  const cv = storage.get('SELECT * FROM content_versions WHERE id = ?', [seeded.contentVersionId]);
  assert.equal(cv.state, 'PRODUCED', 'content_versions.state must never advance to PUBLISHED under SIMULATION');

  // G. The rejection is specifically the D-C2 mode invariant (not a
  // missing-authorization or autonomous-disabled denial, both of which
  // are covered by other tests and would produce a different message).
  const decisions = storage.all(
    `SELECT * FROM decision_log WHERE run_id = ? AND subject_id = ? AND decision = 'AUTHORIZATION_DENIED'`,
    [result.runId, seeded.contentVersionId]
  );
  assert.equal(decisions.length, 1);
  assert.match(decisions[0].reason, /run mode is SIMULATION, not LIVE/);

  assert.equal(result.stopReason, 'no_progress');

  cleanup(storage, dbPath, videoFile);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------
// 5. WS2-A / ADR-0028 invocation outcome aggregation
//
// system_runs.status is derived from the stage.run() results returned in
// THIS invocation: any success -> COMPLETED; attempted work with zero
// successes -> FAILED; nothing attempted -> COMPLETED. stopReason
// (no_work / no_progress) never decides status.
// ---------------------------------------------------------------------

function runRow(storage, runId) {
  return storage.get('SELECT status, stop_reason FROM system_runs WHERE id = ?', [runId]);
}

function setState(storage, contentBriefId, state) {
  storage.run('UPDATE content_versions SET state = ? WHERE content_brief_id = ?', [state, contentBriefId]);
}

// Stage stubs that carry an item BRIEF_CREATED -> ... -> NEEDS_REVIEW (a
// state no selector picks up), each returning that stage's real success shape.
function successChainFns(storage, calls = []) {
  return {
    script: async ({ contentBriefId }) => {
      calls.push(['script', contentBriefId]);
      setState(storage, contentBriefId, 'SCRIPT_DRAFT');
      return { rejected: false };
    },
    'fact-check': async ({ contentBriefId }) => {
      calls.push(['fact-check', contentBriefId]);
      setState(storage, contentBriefId, 'FACT_CHECK');
      return { outcome: 'PASS' };
    },
    originality: async ({ contentBriefId }) => {
      calls.push(['originality', contentBriefId]);
      setState(storage, contentBriefId, 'ORIGINALITY_CHECK');
      return { outcome: 'EVALUATED', transitioned: true };
    },
    'quality-gate': async ({ contentBriefId }) => {
      calls.push(['quality-gate', contentBriefId]);
      setState(storage, contentBriefId, 'NEEDS_REVIEW');
      return { outcome: 'PASS', aggregate: 'PASS', transitioned: true };
    }
  };
}

test('WS2-A: every attempted item succeeds -> COMPLETED', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  seedChainAtState(storage, 'BRIEF_CREATED');

  const calls = [];
  const result = await runAutonomousOperation({ storage, stageFns: successChainFns(storage, calls) });

  assert.deepEqual(calls.map((c) => c[0]), ['script', 'fact-check', 'originality', 'quality-gate']);
  assert.equal(result.stopReason, 'no_work');
  assert.equal(runRow(storage, result.runId).status, 'COMPLETED');

  cleanup(storage, dbPath);
});

test('WS2-A: success plus contained non-success in the same invocation -> COMPLETED, no_progress does not cause FAILED', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  const good = seedChainAtState(storage, 'BRIEF_CREATED');
  const stuck = seedChainAtState(storage, 'BRIEF_CREATED');

  const fns = successChainFns(storage);
  const goodScript = fns.script;
  fns.script = async (args) =>
    args.contentBriefId === stuck.contentBriefId ? { rejected: true, reason: 'X' } : goodScript(args);

  const result = await runAutonomousOperation({ storage, stageFns: fns });

  // The stuck item stays eligible, so the runner stops on no_progress...
  assert.equal(result.stopReason, 'no_progress');
  // ...but the invocation had real successes, so it is not a failure.
  const row = runRow(storage, result.runId);
  assert.equal(row.status, 'COMPLETED');
  assert.equal(row.stop_reason, 'no_progress');
  assert.equal(storage.get('SELECT state FROM content_versions WHERE content_brief_id = ?', [good.contentBriefId]).state, 'NEEDS_REVIEW');

  cleanup(storage, dbPath);
});

test('WS2-A: attempted work with zero successes -> FAILED, driven by counters not by no_progress', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  seedChainAtState(storage, 'BRIEF_CREATED');

  const result = await runAutonomousOperation({
    storage,
    stageFns: { script: async () => ({ rejected: true, reason: 'NO_ELIGIBLE_KEY_CLAIMS' }) }
  });

  assert.equal(result.stopReason, 'no_progress');
  const row = runRow(storage, result.runId);
  assert.equal(row.status, 'FAILED');
  assert.equal(row.stop_reason, 'no_progress');
  assert.equal(result.processed.find((p) => p.stage === 'script').count, 1);

  cleanup(storage, dbPath);
});

test('WS2-A: no_work / zero attempted items -> COMPLETED, and no stage function is called', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();

  const explode = async () => {
    throw new Error('must not be called');
  };
  const result = await runAutonomousOperation({
    storage,
    stageFns: { script: explode, brief: explode, research: explode, publication: explode }
  });

  assert.equal(result.stopReason, 'no_work');
  assert.ok(result.processed.every((p) => p.count === 0));
  assert.equal(runRow(storage, result.runId).status, 'COMPLETED');

  cleanup(storage, dbPath);
});

test('WS2-A: uncaught stage error -> FAILED, rethrown, and later work is not executed (fail fast)', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  seedChainAtState(storage, 'BRIEF_CREATED');
  seedChainAtState(storage, 'BRIEF_CREATED');

  let scriptCalls = 0;
  let laterStageCalls = 0;
  await assert.rejects(
    () =>
      runAutonomousOperation({
        storage,
        stageFns: {
          script: async () => {
            scriptCalls += 1;
            throw new Error('boom');
          },
          'fact-check': async () => {
            laterStageCalls += 1;
            return { outcome: 'PASS' };
          }
        }
      }),
    /boom/
  );

  const { id: runId } = storage.get('SELECT id FROM system_runs ORDER BY started_at DESC LIMIT 1');
  const row = runRow(storage, runId);
  assert.equal(row.status, 'FAILED');
  assert.equal(row.stop_reason, 'boom');
  assert.equal(scriptCalls, 1, 'second eligible item must not run after the fatal error');
  assert.equal(laterStageCalls, 0);

  cleanup(storage, dbPath);
});

test('WS2-A: a swallowed onStageError throw is not an attempt and never becomes an aggregate failure by itself', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  seedChainAtState(storage, 'BRIEF_CREATED');

  const result = await runAutonomousOperation({
    storage,
    onStageError: () => {},
    stageFns: {
      script: async () => {
        throw new Error('boom');
      }
    }
  });

  assert.equal(result.stopReason, 'no_progress');
  assert.equal(runRow(storage, result.runId).status, 'COMPLETED');

  cleanup(storage, dbPath);
});

test('WS2-A: a retry-paced skip is not an attempt (item is not re-run and is not counted)', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  const paced = seedChainAtState(storage, 'BRIEF_CREATED');
  const mover = seedChainAtState(storage, 'BRIEF_CREATED');

  const scriptCalls = [];
  const result = await runAutonomousOperation({
    storage,
    stageFns: {
      script: async ({ contentBriefId }) => {
        scriptCalls.push(contentBriefId);
        if (contentBriefId === paced.contentBriefId) {
          // Recorded failed attempt: consumes the item's one retry slot
          // for this invocation; state does not change.
          return { rejected: true, reason: 'GEN', attempt: 1 };
        }
        // Non-success, but the state advances so a second sweep happens.
        setState(storage, contentBriefId, 'SCRIPT_DRAFT');
        return { rejected: true, reason: 'GEN' };
      },
      'fact-check': async ({ contentBriefId }) => {
        // Contained non-success that leaves the item at FACT_CHECK-eligible
        // work for Originality (a state no assertion here depends on).
        setState(storage, contentBriefId, 'NEEDS_REVIEW');
        return { outcome: 'REJECT' };
      }
    }
  });

  // Sweep 2 happened (eligibility changed) and the paced item was skipped.
  assert.ok(result.sweeps >= 2);
  assert.equal(scriptCalls.filter((id) => id === paced.contentBriefId).length, 1);
  assert.equal(scriptCalls.filter((id) => id === mover.contentBriefId).length, 1);
  assert.equal(result.processed.find((p) => p.stage === 'script').count, 2);
  // Every executed item was a contained non-success -> FAILED.
  assert.equal(runRow(storage, result.runId).status, 'FAILED');

  cleanup(storage, dbPath);
});

test('WS2-A: an executed prerequisite/not-ready result counts as a contained attempted non-success', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  seedChainAtState(storage, 'PRODUCED');

  const result = await runAutonomousOperation({
    storage,
    stageFns: {
      'asset-provisioning': async () => ({ outcome: 'NOT_YET_PRODUCED' }),
      'rights-verification': async () => ({ outcome: 'NOT_YET_PRODUCED' }),
      'media-production': async () => ({ outcome: 'NOT_YET_PRODUCED' }),
      publication: async () => ({ outcome: 'NOT_YET_RENDERED' })
    }
  });

  assert.ok(result.processed.find((p) => p.stage === 'asset-provisioning').count >= 1);
  assert.equal(runRow(storage, result.runId).status, 'FAILED');

  cleanup(storage, dbPath);
});

test('WS2-A: status reflects only the current invocation, not earlier invocations or database history', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();

  // Invocation 1: a genuinely eligible item is attempted and succeeds.
  const itemA = seedChainAtState(storage, 'BRIEF_CREATED');
  const first = await runAutonomousOperation({ storage, stageFns: successChainFns(storage) });
  assert.equal(runRow(storage, first.runId).status, 'COMPLETED');
  assert.equal(
    storage.get('SELECT state FROM content_versions WHERE content_brief_id = ?', [itemA.contentBriefId]).state,
    'NEEDS_REVIEW'
  );

  // Invocation 2: a fresh item is attempted and returns a contained
  // non-success. Item A already succeeded in invocation 1 and is no longer
  // eligible, so this invocation has exactly one attempt and zero successes.
  // Invocation 1's success must not rescue it.
  const itemB = seedChainAtState(storage, 'BRIEF_CREATED');
  const scriptCalls = [];
  const second = await runAutonomousOperation({
    storage,
    stageFns: {
      script: async ({ contentBriefId }) => {
        scriptCalls.push(contentBriefId);
        return { rejected: true, reason: 'NO_ELIGIBLE_KEY_CLAIMS' };
      }
    }
  });
  assert.deepEqual(scriptCalls, [itemB.contentBriefId], 'only the fresh item is attempted in invocation 2');
  assert.equal(runRow(storage, second.runId).status, 'FAILED');
  assert.equal(runRow(storage, first.runId).status, 'COMPLETED', 'earlier run row is unchanged');

  // Invocation 3: nothing is eligible. The FAILED invocation 2 must not
  // leak either: zero attempts in this invocation -> COMPLETED.
  setState(storage, itemB.contentBriefId, 'NEEDS_REVIEW');
  const third = await runAutonomousOperation({ storage });
  assert.equal(third.stopReason, 'no_work');
  assert.equal(runRow(storage, third.runId).status, 'COMPLETED');
  assert.equal(runRow(storage, second.runId).status, 'FAILED', 'earlier run row is unchanged');

  cleanup(storage, dbPath);
});

test('WS2-A: Research success (RESEARCH_COMPLETE) is counted as success', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  insertOpportunity(storage, { status: 'HANDED_TO_RESEARCH' });

  const result = await runAutonomousOperation({
    storage,
    stageFns: {
      research: async ({ opportunityId }) => {
        const id = insertResearchProject(storage, opportunityId, { status: 'RESEARCH_COMPLETE' });
        // Move the opportunity out of the Research selector, as the real stage does.
        storage.run(`UPDATE opportunities SET status = 'RESEARCH_HANDED_OFF_TEST_FIXTURE' WHERE id = ?`, [opportunityId]);
        return { project: storage.get('SELECT * FROM research_projects WHERE id = ?', [id]), created: true };
      },
      // Brief is then eligible and returns a contained rejection: one success
      // (Research) + one contained non-success (Brief) -> COMPLETED.
      brief: async ({ researchProjectId }) => {
        storage.run(`UPDATE research_projects SET status = 'INSUFFICIENT_EVIDENCE' WHERE id = ?`, [researchProjectId]);
        return { rejected: true, reason: 'NO_ELIGIBLE_KEY_CLAIMS' };
      }
    }
  });

  const research = result.processed.find((p) => p.stage === 'research').count;
  const brief = result.processed.find((p) => p.stage === 'brief').count;
  assert.equal(research, 1);
  assert.equal(brief, 1);
  assert.equal(runRow(storage, result.runId).status, 'COMPLETED');

  cleanup(storage, dbPath);
});

test('WS2-A: Research normal completion with INSUFFICIENT_EVIDENCE is success (completeness outcome, not a fault)', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  insertOpportunity(storage, { status: 'HANDED_TO_RESEARCH' });

  const result = await runAutonomousOperation({
    storage,
    stageFns: {
      research: async ({ opportunityId }) => {
        const id = insertResearchProject(storage, opportunityId, { status: 'INSUFFICIENT_EVIDENCE' });
        storage.run(`UPDATE opportunities SET status = 'RESEARCH_HANDED_OFF_TEST_FIXTURE' WHERE id = ?`, [opportunityId]);
        return {
          project: storage.get('SELECT * FROM research_projects WHERE id = ?', [id]),
          stopReason: 'NO_LOAD_BEARING_CLAIMS'
        };
      }
    }
  });

  assert.equal(result.processed.find((p) => p.stage === 'research').count, 1);
  assert.equal(runRow(storage, result.runId).status, 'COMPLETED');

  cleanup(storage, dbPath);
});

test('WS2-A: Research SOURCE_DISCOVERY_FAILED returned normally, and an already-terminal Research result, are non-success', async () => {
  for (const researchResult of [
    (project) => ({ project: { ...project, status: 'FAILED' }, stopReason: 'SOURCE_DISCOVERY_FAILED' }),
    (project) => ({ project: { ...project, status: 'RESEARCH_COMPLETE' }, alreadyTerminal: true })
  ]) {
    const { storage, dbPath } = freshStorage();
    await storage.migrate();
    insertOpportunity(storage, { status: 'HANDED_TO_RESEARCH' });

    const result = await runAutonomousOperation({
      storage,
      stageFns: {
        research: async ({ opportunityId }) => {
          const id = insertResearchProject(storage, opportunityId, { status: 'FAILED' });
          storage.run(`UPDATE opportunities SET status = 'RESEARCH_HANDED_OFF_TEST_FIXTURE' WHERE id = ?`, [opportunityId]);
          return researchResult({ id });
        }
      }
    });

    assert.equal(result.processed.find((p) => p.stage === 'research').count, 1);
    assert.equal(runRow(storage, result.runId).status, 'FAILED');
    cleanup(storage, dbPath);
  }
});

test('WS2-A: Rights Verification PROCESSED is success; its normal non-success outcomes are contained', async () => {
  const cases = [
    { outcome: 'PROCESSED', expected: 'COMPLETED' },
    { outcome: 'STRUCTURAL_FAILURE', expected: 'FAILED' },
    { outcome: 'NO_ASSETS_ATTACHED', expected: 'FAILED' },
    { outcome: 'NO_ELIGIBLE_ASSETS', expected: 'FAILED' }
  ];
  for (const { outcome, expected } of cases) {
    const { storage, dbPath } = freshStorage();
    await storage.migrate();
    seedChainAtState(storage, 'PRODUCED');

    let rvCalls = 0;
    const result = await runAutonomousOperation({
      storage,
      stageFns: {
        // Every other PRODUCED-state stage is inert (not attempted-success
        // by accident): they return contained non-success, so the outcome
        // of Rights Verification alone decides the invocation status.
        'asset-provisioning': async () => ({ outcome: 'NO_ASSET_ACQUIRED' }),
        'media-production': async () => ({ outcome: 'NO_VISUAL_ASSETS' }),
        publication: async () => ({ outcome: 'NOT_YET_RENDERED' }),
        'rights-verification': async () => {
          rvCalls += 1;
          return { outcome };
        }
      }
    });

    assert.equal(rvCalls, 1, `rights-verification called once for ${outcome}`);
    assert.equal(result.stopReason, 'no_progress');
    assert.equal(runRow(storage, result.runId).status, expected, `status for RV outcome ${outcome}`);
    cleanup(storage, dbPath);
  }
});
