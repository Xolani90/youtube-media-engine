import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { SqliteStorageDriver } from '../../src/storage/SqliteStorageDriver.js';
import { LLMRouter } from '../../src/providers/llm/router.js';
import { OpportunitySource } from '../../src/providers/opportunity/OpportunitySource.js';
import { ResearchSourceProvider } from '../../src/research/ResearchSourceProvider.js';
import { AssetSourceProvider } from '../../src/providers/asset/AssetSourceProvider.js';
import { PublicationProvider } from '../../src/publication/PublicationProvider.js';
import { PUBLICATION_RESULT_STATUS } from '../../src/publication/constants.js';
import { SystemRunRecorder } from '../../src/state/SystemRun.js';
import { runAutonomousEntrypoint } from '../../src/index.js';
import { config } from '../../src/config/index.js';
import researchPolicy from '../../config/research_policy.json' with { type: 'json' };
import briefPolicy from '../../config/brief_policy.json' with { type: 'json' };
import scriptPolicy from '../../config/script_policy.json' with { type: 'json' };

/**
 * CANONICAL AUTONOMOUS ENTRYPOINT FULL-CHAIN REHEARSAL (Owner-authorized,
 * TEST-ONLY).
 *
 * Drives `runAutonomousEntrypoint()` from src/index.js -- NOT
 * runAutonomousOperation() directly -- from a brand-new, un-migrated
 * temporary database through ONE invocation:
 *
 *   migrate -> ADR-0024 acquire -> Discovery (source fetch, Memory Ledger,
 *   real pipeline incl. real feature computation) -> ledger outcomes ->
 *   runner -> research, brief, script, fact-check, originality,
 *   quality-gate, production, asset-provisioning, rights-verification,
 *   media-production, publication -> ADR-0024 release.
 *
 * COMPLEMENTS (does not replace) autonomous-full-chain-rehearsal.test.js,
 * which is the runner-level rehearsal that starts at the Discovery handoff.
 *
 * WHAT IS REAL: the entrypoint, storage migration, the ADR-0024 guard,
 * Discovery (dedup/proposition/feature computation/scoring/top-K), the
 * Discovery Memory Ledger, the runner, buildStages(), workSelection.js, all
 * eleven stage implementations, D-C2 authorization, real ffmpeg/ffprobe.
 *
 * WHAT IS STUBBED (external/provider boundaries only):
 *   - OpportunitySource (would be RSS over the network)
 *   - LLMRouter provider (would be Groq/etc.)
 *   - Research source provider + page fetch (would be Tavily + HTTP)
 *   - Asset provider (would be Pixabay)
 *   - Publication adapter (would be YouTube)
 *   - Narration: real espeak-ng if installed, otherwise POSIX stand-in.
 * globalThis.fetch is additionally replaced by a recorder that throws, so any
 * un-stubbed network attempt fails the test and is counted.
 *
 * PREREQUISITES (checked in before(); missing ones FAIL the file loudly, they
 * never skip): ffmpeg + ffprobe on PATH; on win32 also espeak-ng on PATH
 * (the stand-in narrator needs a POSIX shell).
 *
 * Isolation: temp DB and temp production/media/asset directories; the
 * repository's data/ directory is never used and is checked for unchanged
 * state around the run.
 */

const hasFfmpeg = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0
  && spawnSync('ffprobe', ['-version'], { stdio: 'ignore' }).status === 0;
const hasRealEspeak = spawnSync('espeak-ng', ['--version'], { stdio: 'ignore' }).status === 0;

const SOURCE_URL = 'https://acme.com/press-release';
const CLAIM_TEXT = 'Acme reported one billion dollars in Q3 revenue.';
const WORKING_TITLE = 'Entrypoint Rehearsal Title';
const ACTION = (contentVersionId) => `publish:youtube:${contentVersionId}`;
const STAGES = ['research', 'brief', 'script', 'fact-check', 'originality', 'quality-gate',
  'production', 'asset-provisioning', 'rights-verification', 'media-production', 'publication'];

// ---------------------------------------------------------------- narrator
let restoreNarrator = () => {};
before(() => {
  if (!hasFfmpeg) {
    throw new Error('PREREQUISITE MISSING: ffmpeg and ffprobe must be on PATH to run the canonical-entrypoint rehearsal (this test does not skip).');
  }
  if (hasRealEspeak) return;
  if (process.platform === 'win32') {
    throw new Error('PREREQUISITE MISSING: espeak-ng must be on PATH on win32 (the stand-in narrator needs a POSIX shell; this test does not skip).');
  }
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ep-rehearsal-bin-'));
  const shim = path.join(binDir, 'espeak-ng');
  fs.writeFileSync(shim, [
    '#!/bin/sh',
    'ffmpeg -loglevel error -f lavfi -i "sine=frequency=440:duration=3" -f wav -y "$2"',
    ''
  ].join('\n'));
  fs.chmodSync(shim, 0o755);
  const previousPath = process.env.PATH;
  process.env.PATH = `${binDir}${path.delimiter}${process.env.PATH}`;
  restoreNarrator = () => {
    process.env.PATH = previousPath;
    fs.rmSync(binDir, { recursive: true, force: true });
  };
});
after(() => restoreNarrator());

// ---------------------------------------------------------------- stubs
class StubOpportunitySource extends OpportunitySource {
  constructor({ onFetch } = {}) { super(); this.fetches = 0; this.onFetch = onFetch; }
  get id() { return 'ep-rehearsal-opportunity-source'; }
  async healthCheck() { return true; }
  async fetchCandidates() {
    this.fetches += 1;
    this.onFetch?.();
    return { candidates: [{ raw: true }], failures: [] };
  }
  normalize() {
    return {
      title: 'Acme reports Q3 revenue',
      description: 'Acme has published the results of its third quarter and the revenue is in the report.',
      source: 'ep-rehearsal',
      sourceUrl: 'https://example.test/acme-q3',
      discoveredAt: new Date().toISOString()
    };
  }
}

class SingleSourceProvider extends ResearchSourceProvider {
  get id() { return 'ep-rehearsal-source'; }
  async healthCheck() { return true; }
  async discoverCandidates() { return { candidates: [{ url: SOURCE_URL, title: 't', snippet: 's' }] }; }
}

const fakeFetch = async () => ({
  ok: true, status: 200,
  headers: { get: () => 'text/html' },
  text: async () => '<html><body>Acme reported one billion dollars in Q3 revenue.</body></html>'
});

class RecordingYouTube extends PublicationProvider {
  constructor({ onPublish } = {}) { super(); this.calls = []; this.onPublish = onPublish; }
  get id() { return 'youtube'; }
  async publish(request) {
    this.calls.push(request);
    this.onPublish?.();
    return { status: PUBLICATION_RESULT_STATUS.SUCCESS, provider: 'youtube', providerItemId: 'EP_REHEARSAL_VIDEO_ID', providerUrl: 'https://youtu.be/EP_REHEARSAL_VIDEO_ID' };
  }
}

class FakeAssetProvider extends AssetSourceProvider {
  constructor({ imagePath, onAcquire }) { super(); this.imagePath = imagePath; this.onAcquire = onAcquire; this.calls = 0; }
  get id() { return 'ep-rehearsal-assets'; }
  async healthCheck() { return true; }
  async acquireVisualAsset() {
    this.calls += 1;
    this.onAcquire?.();
    return {
      assetType: 'image',
      location: this.imagePath,
      checksum: crypto.createHash('sha256').update(fs.readFileSync(this.imagePath)).digest('hex'),
      origin: 'pixabay',
      license: 'Pixabay Content License',
      provenanceNotes: 'provider=pixabay',
      verificationStatus: 'UNVERIFIED'
    };
  }
}

function makeFixtureImage(dir) {
  const location = path.join(dir, 'asset.png');
  execFileSync('ffmpeg', ['-f', 'lavfi', '-i', 'color=c=blue:s=64x64:d=1', '-frames:v', '1', '-y', location], { stdio: ['ignore', 'pipe', 'pipe'] });
  return location;
}

const FEATURES = {
  novelty: 90, competition: 10, story_potential: 90, evidence_availability: 90,
  production_difficulty: 10, audience_potential: 90, commercial_intent: 90,
  affiliate_potential: 90, lead_generation_potential: 90, product_adjacency: 90,
  sponsorship_potential: 90
};

// ---------------------------------------------------------------- harness
function makeHarness({ mode, failScript = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ep-rehearsal-'));
  const dbPath = path.join(dir, 'ep-rehearsal.db');
  // NOT migrated here: the entrypoint must do it.
  const storage = new SqliteStorageDriver({ dbPath });
  // Independent second connection = what an external observer of the guard sees.
  const observer = new SqliteStorageDriver({ dbPath });
  const runningRows = () => {
    try { return observer.all(`SELECT id, status, mode FROM system_runs WHERE status = 'RUNNING'`); }
    catch { return null; }
  };
  const snapshots = {};
  const snap = (label) => { snapshots[label] = runningRows(); };

  const llmCalls = { features: 0, proposition: 0, research: 0, brief: 0, script: 0, unexpected: 0 };
  const router = new LLMRouter({
    priority: ['ep-rehearsal-llm'],
    allowPaidProviders: false,
    registry: {
      'ep-rehearsal-llm': () => ({
        id: 'ep-rehearsal-llm', isPaid: false,
        async healthCheck() { return true; },
        async complete({ prompt }) {
          let text;
          if (prompt.includes('extract the individual factual/inferential/opinion')) {
            llmCalls.research += 1;
            text = JSON.stringify([{ claim: CLAIM_TEXT, claim_type: 'FACT', is_load_bearing: true }]);
          } else if (prompt.includes('You are drafting a Content Brief.')) {
            llmCalls.brief += 1;
            const claimIds = storage.all(`SELECT id FROM claims WHERE evidence_status = 'VERIFIED'`).map((r) => r.id);
            text = JSON.stringify({
              working_title: WORKING_TITLE, target_audience: 'Investors', viewer_promise: 'A clear answer',
              hook: 'Hook', angle: 'Angle', narrative_structure: 'Structure', counterpoints: 'Counterpoints',
              original_insights: 'Insights', visual_ideas: 'A calm office skyline', monetization_opportunities: 'None',
              risk_assessment: 'Low', key_claims: claimIds
            });
          } else if (prompt.includes('You are drafting a video Script')) {
            llmCalls.script += 1;
            snap('during-script-llm');
            if (failScript) throw new Error('ep-rehearsal: injected script provider failure');
            const brief = storage.get('SELECT key_claims FROM content_briefs LIMIT 1');
            const claimIds = JSON.parse(brief.key_claims);
            text = JSON.stringify({
              hook: 'Acme has news.', narrative: 'Here is what happened this quarter.',
              sections: [{ heading: 'Revenue', content: 'Acme reported strong quarterly revenue.', claim_ids: claimIds }],
              counterpoints: 'Some analysts urge caution.', conclusion: 'That is the story.', call_to_action: null
            });
          } else if (prompt.includes('construct an Opportunity Proposition')) {
            llmCalls.proposition += 1;
            text = JSON.stringify({
              subject: 'Acme', target_audience: 'Investors', audience_problem: 'Unclear whether results are strong.',
              core_question: 'Did Acme report strong Q3 revenue?', gap: 'No plain-language explainer.',
              angle: 'Explain the numbers simply.', differentiation: 'Focus on the primary source.',
              commercial_relevance: 'Investor education.', core_question_type: 'FACTUAL'
            });
          } else if (prompt.includes('sponsorship_potential')) {
            llmCalls.features += 1;
            text = JSON.stringify(FEATURES);
          } else {
            llmCalls.unexpected += 1;
            throw new Error('ep-rehearsal LLM stub received an unexpected prompt');
          }
          return { text, model: 'ep-rehearsal-llm', requestId: null, inputTokens: 1, outputTokens: 1, estimatedCost: 0, isPaid: false };
        }
      })
    }
  });

  const productionDir = path.join(dir, 'production');
  const mediaDir = path.join(dir, 'media');
  const imagePath = makeFixtureImage(dir);
  const authPath = path.join(dir, 'authorized_external_actions.json');
  fs.writeFileSync(authPath, JSON.stringify([]));

  const source = new StubOpportunitySource({ onFetch: () => snap('during-discovery-fetch') });
  const assetProvider = new FakeAssetProvider({
    imagePath,
    onAcquire: () => {
      snap('during-asset-provisioning');
      if (mode === 'LIVE') {
        // The Owner approving the ONE exact runtime action while this single
        // invocation is in flight (same mechanism as the runner-level
        // rehearsal's scenario 3). The id only exists once Brief has run.
        const cv = storage.get('SELECT id FROM content_versions');
        fs.writeFileSync(authPath, JSON.stringify([ACTION(cv.id)]));
      }
    }
  });
  const adapter = new RecordingYouTube({ onPublish: () => snap('during-adapter-publish') });

  const invoke = (overrides = {}) => runAutonomousEntrypoint({
    storage, mode,
    llmRouter: router,
    researchPolicy, briefPolicy, scriptPolicy,
    discovery: { opportunitySource: source, topK: 1 },
    research: {
      sourceProvider: new SingleSourceProvider(),
      classification: { authoritativeDomains: ['acme.com'] },
      fetchImpl: fakeFetch
    },
    production: { artifactsDir: productionDir },
    assetProvisioning: { provider: assetProvider },
    media: { artifactsDir: mediaDir },
    publication: { adapter },
    ...overrides
  });

  return {
    dir, dbPath, storage, observer, llmCalls, source, assetProvider, adapter, authPath,
    snapshots, runningRows, invoke,
    cleanup: () => { observer.close(); storage.close(); fs.rmSync(dir, { recursive: true, force: true }); }
  };
}

/** Process-global config + network tripwire around `fn` (restored in finally). */
async function withIsolation({ authorizedFile }, fn) {
  const original = {
    runMode: config.runMode, autonomousEnabled: config.autonomousEnabled,
    authorizedExternalActionsPath: config.authorizedExternalActionsPath
  };
  const originalFetch = globalThis.fetch;
  const networkAttempts = [];
  globalThis.fetch = async (...args) => {
    networkAttempts.push(String(args[0]?.url ?? args[0]));
    throw new Error('ep-rehearsal: real network call attempted');
  };
  // Autonomy ON and process mode LIVE, so the ONLY thing that can deny
  // publication in the SIMULATION scenario is the run's own SIMULATION mode.
  config.runMode = 'LIVE';
  config.autonomousEnabled = true;
  config.authorizedExternalActionsPath = authorizedFile;
  const dataDir = path.resolve(path.dirname(config.dbPath ?? 'data/media-engine.db'));
  const before = fs.existsSync(dataDir) ? fs.readdirSync(dataDir).sort().map((f) => `${f}:${fs.statSync(path.join(dataDir, f)).mtimeMs}`) : null;
  try {
    return await fn({ networkAttempts });
  } finally {
    const after = fs.existsSync(dataDir) ? fs.readdirSync(dataDir).sort().map((f) => `${f}:${fs.statSync(path.join(dataDir, f)).mtimeMs}`) : null;
    globalThis.fetch = originalFetch;
    Object.assign(config, original);
    assert.deepEqual(after, before, 'repository data/ directory must be untouched by the rehearsal');
  }
}

const count = (storage, sql, params = []) => storage.get(sql, params).n;
const processedOf = (runner) => Object.fromEntries(runner.processed.map((p) => [p.stage, p.count]));
const tableExists = (storage, name) => storage.get(`SELECT COUNT(*) n FROM sqlite_master WHERE type = 'table' AND name = ?`, [name]).n === 1;

function assertPristineBeforeEntrypoint(h) {
  assert.equal(tableExists(h.storage, 'system_runs'), false, 'DB is un-migrated: the entrypoint must perform migration');
  assert.equal(tableExists(h.storage, 'opportunities'), false);
}

function assertDiscoveryExecuted(h, result) {
  assert.equal(h.source.fetches, 1, 'Discovery source fetched exactly once');
  assert.equal(result.discovery.stats.discovered, 1);
  assert.equal(result.discovery.stats.selected, 1);
  assert.equal(h.llmCalls.features, 1, 'real feature computation ran through the LLM stub');
  assert.equal(h.llmCalls.proposition, 1, 'real proposition generation ran');
  // Memory Ledger: real row written by Discovery handling, marked SELECTED.
  const ledger = h.storage.all('SELECT * FROM discovery_observations');
  assert.equal(ledger.length, 1, 'exactly one Memory Ledger row');
  assert.equal(ledger[0].evaluation_outcome, 'SELECTED');
  assert.ok(ledger[0].opportunity_id, 'ledger row links to the opportunity Discovery created');
  const opp = h.storage.get('SELECT * FROM opportunities WHERE id = ?', [ledger[0].opportunity_id]);
  assert.ok(opp, 'Discovery persisted the opportunity');
  const project = h.storage.get('SELECT * FROM research_projects WHERE opportunity_id = ?', [opp.id]);
  assert.ok(project, 'Research ran on the Discovery-created opportunity (not a seeded one)');
  assert.equal(project.status, 'RESEARCH_COMPLETE');
  assert.equal(count(h.storage, 'SELECT COUNT(*) n FROM opportunities'), 1);
}

function assertAllElevenStagesReachedPublicationBoundary(h, result) {
  const p = processedOf(result.runner);
  assert.deepEqual(Object.keys(p).sort(), [...STAGES].sort(), 'all eleven real stages were dispatched');
  for (const stage of ['research', 'brief', 'script', 'fact-check', 'originality', 'quality-gate', 'production']) {
    assert.equal(p[stage], 1, `${stage} ran exactly once`);
  }
  // Asset / rights / media are keyed on PRODUCED: real work once, then one
  // idempotent re-dispatch in the sweep that also dispatches Publication.
  for (const stage of ['asset-provisioning', 'rights-verification', 'media-production']) {
    assert.equal(p[stage], 2, `${stage} dispatched twice (real work once, idempotent no-op once)`);
  }
  assert.equal(p.publication, 1, 'publication dispatched exactly once');
  assert.deepEqual(h.llmCalls, { features: 1, proposition: 1, research: 1, brief: 1, script: 1, unexpected: 0 });
  assert.equal(count(h.storage, 'SELECT COUNT(*) n FROM content_briefs'), 1);
  assert.equal(count(h.storage, 'SELECT COUNT(*) n FROM scripts'), 1);
  assert.equal(h.storage.get('SELECT status FROM fact_checks').status, 'PASS');
  assert.equal(count(h.storage, 'SELECT COUNT(*) n FROM originality_checks'), 1);
  assert.equal(count(h.storage, 'SELECT COUNT(*) n FROM productions'), 1);
  assert.equal(h.assetProvider.calls, 1);
  assert.equal(h.storage.get('SELECT verification_status v FROM assets').v, 'VERIFIED');
  assert.equal(count(h.storage, `SELECT COUNT(*) n FROM asset_verifications WHERE decision = 'VERIFIED'`), 1);
  assert.equal(count(h.storage, 'SELECT COUNT(*) n FROM media_artifacts'), 1);
  const artifact = h.storage.get('SELECT * FROM media_artifacts');
  assert.ok(fs.existsSync(artifact.artifact_path), 'a real rendered media file exists');
  assert.ok(fs.statSync(artifact.artifact_path).size > 0);
  assert.ok(artifact.artifact_path.startsWith(h.dir), 'media artifact was written under the temp directory');
}

/** ADR-0024 evidence for a single successful invocation. */
function assertGuardLifecycle(h, result, expectedMode) {
  // While active: exactly one RUNNING row, at every observed point, and it is THE run.
  const runId = result.runner.runId;
  for (const label of ['during-discovery-fetch', 'during-script-llm', 'during-asset-provisioning']) {
    const rows = h.snapshots[label];
    assert.ok(rows, `snapshot ${label} was taken`);
    assert.equal(rows.length, 1, `exactly one RUNNING row during ${label}`);
    assert.equal(rows[0].id, runId, `the RUNNING row during ${label} is the invocation's run`);
    assert.equal(rows[0].mode, expectedMode);
  }
  // After completion: one row total, COMPLETED, guard released.
  const all = h.storage.all('SELECT * FROM system_runs');
  assert.equal(all.length, 1, 'one invocation == one system_runs row');
  assert.equal(all[0].id, runId);
  assert.equal(all[0].status, 'COMPLETED');
  assert.ok(all[0].finished_at);
  assert.equal(h.runningRows().length, 0, 'no RUNNING row remains');
  // Guard genuinely released: a fresh acquisition succeeds (then is released).
  const probe = new SystemRunRecorder(h.observer).acquireExclusive({ mode: 'SIMULATION' });
  assert.equal(probe.acquired, true, 'guard is free after completion');
  new SystemRunRecorder(h.observer).finish(probe.id, { status: 'COMPLETED', stopReason: 'rehearsal-probe' });
}

// ---------------------------------------------------------------- scenarios
test('E1. SIMULATION via runAutonomousEntrypoint: Discovery -> ... -> Publication boundary; denied by D-C2 before the adapter; guard acquired, COMPLETED, released', async () => {
  const h = makeHarness({ mode: 'SIMULATION' });
  try {
    await withIsolation({ authorizedFile: h.authPath }, async ({ networkAttempts }) => {
      assertPristineBeforeEntrypoint(h);
      const result = await h.invoke();

      assert.notEqual(result.refused, true);
      assert.equal(result.runner.mode, 'SIMULATION');
      assert.equal(result.runner.stopReason, 'no_progress');
      assertDiscoveryExecuted(h, result);
      assertAllElevenStagesReachedPublicationBoundary(h, result);

      // Publication boundary: denied because the run is SIMULATION; adapter never invoked.
      const cv = h.storage.get('SELECT * FROM content_versions');
      assert.equal(cv.state, 'PRODUCED', 'item stops at PRODUCED');
      const denial = h.storage.get(`SELECT reason FROM decision_log WHERE decision = 'AUTHORIZATION_DENIED'`);
      assert.match(denial.reason, /run mode is SIMULATION, not LIVE/);
      assert.equal(h.adapter.calls.length, 0, 'publication adapter NOT called in SIMULATION');
      assert.equal(count(h.storage, 'SELECT COUNT(*) n FROM publications'), 0);
      assert.equal(h.snapshots['during-adapter-publish'], undefined);

      assertGuardLifecycle(h, result, 'SIMULATION');
      assert.deepEqual(networkAttempts, [], 'no real network call was attempted');
    });
  } finally { h.cleanup(); }
});

test('E2. LIVE (safe mock adapter) via runAutonomousEntrypoint: one invocation reaches PUBLISHED through the recording adapter only; no real publication', async () => {
  const h = makeHarness({ mode: 'LIVE' });
  try {
    await withIsolation({ authorizedFile: h.authPath }, async ({ networkAttempts }) => {
      assertPristineBeforeEntrypoint(h);
      const result = await h.invoke();

      assert.equal(result.runner.mode, 'LIVE');
      assert.equal(result.runner.stopReason, 'no_work');
      assertDiscoveryExecuted(h, result);
      assertAllElevenStagesReachedPublicationBoundary(h, result);

      const cv = h.storage.get('SELECT * FROM content_versions');
      assert.equal(cv.state, 'PUBLISHED');
      assert.deepEqual(JSON.parse(fs.readFileSync(h.authPath, 'utf8')), [ACTION(cv.id)], 'exactly one exact runtime action authorized');
      assert.equal(h.adapter.calls.length, 1, 'recording adapter called exactly once');
      assert.equal(h.adapter.calls[0].title, WORKING_TITLE);
      assert.equal(h.adapter.calls[0].mediaFilePath, h.storage.get('SELECT artifact_path p FROM media_artifacts').p);
      const publication = h.storage.get('SELECT * FROM publications');
      assert.equal(publication.status, 'PUBLISHED');
      assert.equal(publication.provider_item_id, 'EP_REHEARSAL_VIDEO_ID');
      assert.equal(publication.content_version_id, cv.id);
      assert.equal(count(h.storage, `SELECT COUNT(*) n FROM decision_log WHERE decision = 'AUTHORIZATION_DENIED'`), 0);

      // ADR-0024: the guard was still held at the moment the adapter was reached.
      const atPublish = h.snapshots['during-adapter-publish'];
      assert.equal(atPublish.length, 1);
      assert.equal(atPublish[0].id, result.runner.runId);

      assertGuardLifecycle(h, result, 'LIVE');
      assert.deepEqual(networkAttempts, [], 'no real network call (so no real YouTube publication) was attempted');
    });
  } finally { h.cleanup(); }
});

test('E3. Failure in Discovery after acquisition: entrypoint rejects, system run is FAILED, guard released, no RUNNING row, no stage work', async () => {
  const h = makeHarness({ mode: 'SIMULATION' });
  try {
    await withIsolation({ authorizedFile: h.authPath }, async ({ networkAttempts }) => {
      let duringFailure = null;
      const failingSource = new StubOpportunitySource({
        onFetch: () => { duringFailure = h.runningRows(); throw new Error('ep-rehearsal: injected Discovery failure'); }
      });
      await assert.rejects(
        () => h.invoke({ discovery: { opportunitySource: failingSource, topK: 1 } }),
        /injected Discovery failure/
      );

      assert.equal(duringFailure.length, 1, 'guard was held (one RUNNING row) when the failure occurred');
      const all = h.storage.all('SELECT * FROM system_runs');
      assert.equal(all.length, 1);
      assert.equal(all[0].status, 'FAILED');
      assert.match(all[0].stop_reason, /injected Discovery failure/);
      assert.ok(all[0].finished_at);
      assert.equal(h.runningRows().length, 0, 'no lingering RUNNING row');
      assert.equal(count(h.storage, 'SELECT COUNT(*) n FROM opportunities'), 0);
      assert.equal(count(h.storage, 'SELECT COUNT(*) n FROM research_projects'), 0);
      assert.equal(h.adapter.calls.length, 0);
      const probe = new SystemRunRecorder(h.observer).acquireExclusive({ mode: 'SIMULATION' });
      assert.equal(probe.acquired, true, 'guard released after failure');
      new SystemRunRecorder(h.observer).finish(probe.id, { status: 'COMPLETED', stopReason: 'rehearsal-probe' });
      assert.deepEqual(networkAttempts, []);
    });
  } finally { h.cleanup(); }
});

test('E4. Failure inside a pipeline stage (Script provider throws) during the entrypoint invocation: FAILED run, guard released, no RUNNING row, nothing downstream, no adapter call', async () => {
  const h = makeHarness({ mode: 'LIVE', failScript: true });
  try {
    await withIsolation({ authorizedFile: h.authPath }, async ({ networkAttempts }) => {
      // Runner semantics (unchanged): without onStageError a stage throw aborts the run and is rethrown.
      await assert.rejects(() => h.invoke(), /injected script provider failure/);

      const all = h.storage.all('SELECT * FROM system_runs');
      assert.equal(all.length, 1, 'one invocation == one system_runs row');
      assert.equal(all[0].status, 'FAILED', 'system run is FAILED');
      assert.match(all[0].stop_reason ?? '', /injected script provider failure/);
      assert.equal(h.runningRows().length, 0, 'no lingering RUNNING row');
      assert.equal(h.snapshots['during-script-llm'].length, 1, 'guard was held while the failing stage ran');
      assert.equal(count(h.storage, 'SELECT COUNT(*) n FROM scripts'), 0);
      assert.equal(count(h.storage, 'SELECT COUNT(*) n FROM productions'), 0);
      assert.equal(count(h.storage, 'SELECT COUNT(*) n FROM publications'), 0);
      assert.equal(h.adapter.calls.length, 0);
      assert.equal(h.assetProvider.calls, 0);
      const probe = new SystemRunRecorder(h.observer).acquireExclusive({ mode: 'SIMULATION' });
      assert.equal(probe.acquired, true, 'guard released after stage failure');
      new SystemRunRecorder(h.observer).finish(probe.id, { status: 'COMPLETED', stopReason: 'rehearsal-probe' });
      assert.deepEqual(networkAttempts, []);
    });
  } finally { h.cleanup(); }
});
