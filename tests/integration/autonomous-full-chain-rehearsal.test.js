import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { SqliteStorageDriver } from '../../src/storage/SqliteStorageDriver.js';
import { LLMRouter } from '../../src/providers/llm/router.js';
import { ResearchSourceProvider } from '../../src/research/ResearchSourceProvider.js';
import { AssetSourceProvider } from '../../src/providers/asset/AssetSourceProvider.js';
import { PublicationProvider } from '../../src/publication/PublicationProvider.js';
import { PUBLICATION_RESULT_STATUS } from '../../src/publication/constants.js';
import { AssetProvenanceRepository } from '../../src/state/AssetProvenance.js';
import { runAutonomousOperation } from '../../src/autonomous/runner.js';
import { config } from '../../src/config/index.js';
import researchPolicy from '../../config/research_policy.json' with { type: 'json' };
import briefPolicy from '../../config/brief_policy.json' with { type: 'json' };
import scriptPolicy from '../../config/script_policy.json' with { type: 'json' };

/**
 * FULL-CHAIN SIMULATION REHEARSAL (Owner-authorized, test-only).
 *
 * BOUNDARY: every scenario starts at the Discovery HANDOFF, i.e. an
 * `opportunities` row with status HANDED_TO_RESEARCH and an
 * opportunity_proposition, exactly the shape Discovery's real pipeline
 * persists (see tests/integration/research-pipeline-e2e.test.js). Discovery
 * itself (RSS -> dedup -> scoring -> top-K, and the Discovery Memory
 * Ledger) is NOT exercised here; it is covered by its own tests. ADR-0010
 * places Discovery outside the runner, and this test respects that.
 *
 * WHAT IS REAL: the real `runAutonomousOperation()` with the real
 * `buildStages()` and real `workSelection.js` queries (NO `stageFns`), the
 * real stage functions for all eleven stages (Research, Brief, Script,
 * Fact-check, Originality, Quality Gate, Production, Asset Provisioning,
 * Rights Verification, Media Production, Publication), real SQLite, real
 * migrations, real D-C2 authorization (`assertExternalActionAllowed`), real
 * ffmpeg/ffprobe rendering.
 *
 * WHAT IS STUBBED, at the provider boundary only:
 *   - LLM: one deterministic LLMRouter provider that answers the research
 *     claim-extraction, Brief and Script prompts.
 *   - Research source discovery + page fetch: a fixed URL and a fake fetch.
 *   - Asset source: a fake AssetSourceProvider that returns a local image.
 *   - Publication: a recording PublicationProvider; nothing touches YouTube.
 *   - Narration engine: the real `espeak-ng` if installed; otherwise (POSIX
 *     only) a stand-in on PATH that emits a WAV via ffmpeg, as in
 *     tests/integration/media-script-contract-pipeline.test.js.
 *
 * FAULT INJECTION (scenarios 4 and 5 only): the stub Script LLM call, which
 * runs between two real stages, alters the database to model an upstream
 * condition (a claim invalidated / a DISPUTED asset attached). The real
 * Fact-check and Quality Gate then decide on their own logic.
 *
 * No network, no credentials, no real YouTube.
 */

const hasFfmpeg = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0
  && spawnSync('ffprobe', ['-version'], { stdio: 'ignore' }).status === 0;
const hasRealEspeak = spawnSync('espeak-ng', ['--version'], { stdio: 'ignore' }).status === 0;
const skipReason =
  !hasFfmpeg ? 'requires ffmpeg/ffprobe on PATH'
  : (!hasRealEspeak && process.platform === 'win32') ? 'requires espeak-ng (or a POSIX shell for the stand-in)'
  : false;

const SOURCE_URL = 'https://acme.com/press-release';
const CLAIM_TEXT = 'Acme reported one billion dollars in Q3 revenue.';
const WORKING_TITLE = 'Rehearsal Title';
const ACTION = (contentVersionId) => `publish:youtube:${contentVersionId}`;

// ---------------------------------------------------------------- narrator
let restoreNarrator = () => {};
before(() => {
  if (skipReason || hasRealEspeak) return;
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rehearsal-bin-'));
  const shim = path.join(binDir, 'espeak-ng');
  // argv: -w <output.wav> <text>
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
class SingleSourceProvider extends ResearchSourceProvider {
  get id() { return 'rehearsal-source'; }
  async healthCheck() { return true; }
  async discoverCandidates() { return { candidates: [{ url: SOURCE_URL, title: 't', snippet: 's' }] }; }
}

const fakeFetch = async () => ({
  ok: true, status: 200,
  headers: { get: () => 'text/html' },
  text: async () => '<html><body>Acme reported one billion dollars in Q3 revenue.</body></html>'
});

class MockYouTube extends PublicationProvider {
  constructor() { super(); this.calls = []; }
  get id() { return 'youtube'; }
  async publish(request) {
    this.calls.push(request);
    return { status: PUBLICATION_RESULT_STATUS.SUCCESS, provider: 'youtube', providerItemId: 'REHEARSAL_VIDEO_ID', providerUrl: 'https://youtu.be/REHEARSAL_VIDEO_ID' };
  }
}

function makeFixtureImage(dir) {
  const location = path.join(dir, 'asset.png');
  execFileSync('ffmpeg', ['-f', 'lavfi', '-i', 'color=c=blue:s=64x64:d=1', '-frames:v', '1', '-y', location], { stdio: ['ignore', 'pipe', 'pipe'] });
  return location;
}

class FakeAssetProvider extends AssetSourceProvider {
  constructor({ imagePath, onAcquire }) { super(); this.imagePath = imagePath; this.onAcquire = onAcquire; this.calls = 0; }
  get id() { return 'rehearsal-assets'; }
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
      provenanceNotes: 'provider=pixabay', // what the real Pixabay provider records; selects the Pixabay rights policy
      verificationStatus: 'UNVERIFIED'
    };
  }
}

// ---------------------------------------------------------------- harness
async function makeHarness({ onScript, onAssetAcquire } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rehearsal-'));
  const storage = new SqliteStorageDriver({ dbPath: path.join(dir, 'rehearsal.db') });
  await storage.migrate();

  // Discovery handoff (see BOUNDARY note above).
  const opportunityId = crypto.randomUUID();
  storage.run(
    `INSERT INTO opportunities (id, title, source, discovered_at, status, opportunity_proposition)
     VALUES (?, 'Rehearsal opportunity', 'rss', ?, 'HANDED_TO_RESEARCH', ?)`,
    [opportunityId, new Date().toISOString(), JSON.stringify({
      subject: 'Acme', target_audience: 'Investors', audience_problem: 'p',
      core_question: 'Did Acme report strong Q3 revenue?', gap: 'g', angle: 'a', differentiation: 'd',
      commercial_relevance: 'c', core_question_type: 'FACTUAL'
    })]
  );

  const llmCalls = { research: 0, brief: 0, script: 0, unexpected: 0 };
  const router = new LLMRouter({
    priority: ['rehearsal-llm'],
    allowPaidProviders: false,
    registry: {
      'rehearsal-llm': () => ({
        id: 'rehearsal-llm', isPaid: false,
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
            const brief = storage.get('SELECT key_claims FROM content_briefs LIMIT 1');
            const claimIds = JSON.parse(brief.key_claims);
            onScript?.(storage);
            text = JSON.stringify({
              hook: 'Acme has news.', narrative: 'Here is what happened this quarter.',
              sections: [{ heading: 'Revenue', content: 'Acme reported strong quarterly revenue.', claim_ids: claimIds }],
              counterpoints: 'Some analysts urge caution.', conclusion: 'That is the story.', call_to_action: null
            });
          } else {
            llmCalls.unexpected += 1;
            throw new Error('rehearsal LLM stub received an unexpected prompt');
          }
          return { text, model: 'rehearsal-llm', requestId: null, inputTokens: 1, outputTokens: 1, estimatedCost: 0, isPaid: false };
        }
      })
    }
  });

  const productionDir = path.join(dir, 'production');
  const mediaDir = path.join(dir, 'media');
  const imagePath = makeFixtureImage(dir);
  const assetProvider = new FakeAssetProvider({ imagePath, onAcquire: () => onAssetAcquire?.(storage, dir) });
  const adapter = new MockYouTube();

  const run = (mode) => runAutonomousOperation({
    storage, mode,
    llmRouter: router,
    researchPolicy, briefPolicy, scriptPolicy,
    research: {
      sourceProvider: new SingleSourceProvider(),
      classification: { authoritativeDomains: ['acme.com'] },
      fetchImpl: fakeFetch
    },
    production: { artifactsDir: productionDir },
    assetProvisioning: { provider: assetProvider },
    media: { artifactsDir: mediaDir },
    publication: { adapter }
  });

  return { dir, storage, opportunityId, llmCalls, assetProvider, adapter, run, cleanup: () => { storage.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

/** Sets process-global config (as the existing publication tests do) around `fn`. */
async function withConfig({ runMode, autonomousEnabled, authorizedFile }, fn) {
  const original = {
    runMode: config.runMode, autonomousEnabled: config.autonomousEnabled,
    authorizedExternalActionsPath: config.authorizedExternalActionsPath
  };
  config.runMode = runMode;
  config.autonomousEnabled = autonomousEnabled;
  config.authorizedExternalActionsPath = authorizedFile;
  try { return await fn(); } finally { Object.assign(config, original); }
}

function authFile(dir, actions) {
  const file = path.join(dir, 'authorized_external_actions.json');
  fs.writeFileSync(file, JSON.stringify(actions));
  return file;
}

const count = (storage, sql, params = []) => storage.get(sql, params).n;
const processedOf = (result) => Object.fromEntries(result.processed.map((p) => [p.stage, p.count]));
const contentVersion = (h) => h.storage.get('SELECT * FROM content_versions');

/** Asserts the upstream chain (stages 1-6) ran once each and left its real artifacts. */
function assertUpstreamThroughQualityGate(h) {
  const project = h.storage.get('SELECT * FROM research_projects WHERE opportunity_id = ?', [h.opportunityId]);
  assert.equal(project.status, 'RESEARCH_COMPLETE');
  const claim = h.storage.get('SELECT * FROM claims');
  assert.equal(claim.claim, CLAIM_TEXT);
  assert.equal(claim.evidence_status, 'VERIFIED');
  assert.equal(count(h.storage, 'SELECT COUNT(*) n FROM content_briefs'), 1);
  assert.equal(count(h.storage, 'SELECT COUNT(*) n FROM scripts'), 1);
  assert.equal(count(h.storage, `SELECT COUNT(*) n FROM fact_checks`), 1);
  assert.equal(h.storage.get('SELECT status FROM fact_checks').status, 'PASS');
  assert.equal(count(h.storage, 'SELECT COUNT(*) n FROM originality_checks'), 1);
}

function assertNoPublicationSideEffects(h) {
  assert.equal(h.adapter.calls.length, 0, 'publication adapter must not be called');
  assert.equal(count(h.storage, `SELECT COUNT(*) n FROM publications WHERE status = 'PUBLISHED'`), 0);
}

function assertNothingDownstreamOfFactCheckOrGate(h) {
  assert.equal(count(h.storage, 'SELECT COUNT(*) n FROM productions'), 0);
  assert.equal(count(h.storage, 'SELECT COUNT(*) n FROM media_artifacts'), 0);
  assert.equal(count(h.storage, 'SELECT COUNT(*) n FROM publications'), 0);
  assert.equal(count(h.storage, 'SELECT COUNT(*) n FROM asset_usages WHERE provisioning_claim IS NOT NULL'), 0);
  assert.equal(h.assetProvider.calls, 0, 'asset provider must not be called');
  assertNoPublicationSideEffects(h);
}

// ---------------------------------------------------------------- scenarios
// Stage counts for a run that reaches the Publication boundary. The runner
// snapshots eligibility at the start of each sweep, so an item advances one
// state per sweep; Asset Provisioning / Rights Verification / Media Production
// (all keyed on state PRODUCED) do their real work in the sweep after
// Production and are then re-dispatched once more, idempotently, in the sweep
// that also dispatches Publication. Those re-dispatches must not duplicate
// anything; that is asserted below through the provider call count and the
// row counts staying at 1.
function assertReachedPublicationBoundary(h, result) {
  const p = processedOf(result);
  for (const stage of ['research', 'brief', 'script', 'fact-check', 'originality', 'quality-gate', 'production']) {
    assert.equal(p[stage], 1, `${stage} ran exactly once`);
  }
  for (const stage of ['asset-provisioning', 'rights-verification', 'media-production']) {
    assert.equal(p[stage], 2, `${stage} dispatched twice (real work once, then an idempotent no-op re-dispatch)`);
  }
  assert.equal(p.publication, 1, 'publication was dispatched exactly once');
  assert.deepEqual(h.llmCalls, { research: 1, brief: 1, script: 1, unexpected: 0 }, 'exactly one LLM call per LLM stage');
  assertUpstreamThroughQualityGate(h);
  assert.equal(count(h.storage, 'SELECT COUNT(*) n FROM productions'), 1);
  assert.equal(h.assetProvider.calls, 1, 'asset acquired once (idempotent on re-dispatch)');
  assert.equal(count(h.storage, 'SELECT COUNT(*) n FROM assets'), 1);
  assert.equal(h.storage.get('SELECT verification_status v FROM assets').v, 'VERIFIED');
  assert.equal(count(h.storage, `SELECT COUNT(*) n FROM asset_verifications WHERE decision = 'VERIFIED'`), 1);
  assert.equal(count(h.storage, 'SELECT COUNT(*) n FROM media_artifacts'), 1);
  const artifact = h.storage.get('SELECT * FROM media_artifacts');
  assert.ok(fs.existsSync(artifact.artifact_path), 'a real rendered media file exists');
  assert.ok(fs.statSync(artifact.artifact_path).size > 0);
}

test('1. SIMULATION: item traverses all stages to the Publication boundary; publication denied because the run is SIMULATION; adapter not called',
  { skip: skipReason }, async () => {
    const h = await makeHarness();
    try {
      const auth = authFile(h.dir, []);
      // autonomy ON and LIVE process config: the ONLY reason for denial must be the run's own SIMULATION mode.
      const result = await withConfig({ runMode: 'LIVE', autonomousEnabled: true, authorizedFile: auth }, () => h.run('SIMULATION'));

      assert.equal(result.mode, 'SIMULATION');
      assert.equal(result.stopReason, 'no_progress');
      assertReachedPublicationBoundary(h, result);
      assert.equal(contentVersion(h).state, 'PRODUCED', 'item stops at PRODUCED');
      const denial = h.storage.get(`SELECT reason FROM decision_log WHERE decision = 'AUTHORIZATION_DENIED'`);
      assert.match(denial.reason, /run mode is SIMULATION, not LIVE/);
      assertNoPublicationSideEffects(h);
      assert.equal(count(h.storage, 'SELECT COUNT(*) n FROM publications'), 0);
      const run = h.storage.get('SELECT * FROM system_runs WHERE id = ?', [result.runId]);
      assert.equal(run.mode, 'SIMULATION');
      assert.equal(run.status, 'COMPLETED');
      assert.equal(run.stop_reason, 'no_progress');
    } finally { h.cleanup(); }
  });

test('2. LIVE + empty authorization: reaches Publication, AUTHORIZATION_DENIED, adapter not called',
  { skip: skipReason }, async () => {
    const h = await makeHarness();
    try {
      const auth = authFile(h.dir, []);
      const result = await withConfig({ runMode: 'LIVE', autonomousEnabled: true, authorizedFile: auth }, () => h.run('LIVE'));

      assert.equal(result.mode, 'LIVE');
      assert.equal(result.stopReason, 'no_progress');
      assertReachedPublicationBoundary(h, result);
      const cv = contentVersion(h);
      assert.equal(cv.state, 'PRODUCED');
      const denial = h.storage.get(`SELECT reason FROM decision_log WHERE decision = 'AUTHORIZATION_DENIED'`);
      assert.ok(denial.reason.includes(ACTION(cv.id)), 'denial names the exact runtime action id');
      assert.match(denial.reason, /not present in Owner-controlled/);
      assertNoPublicationSideEffects(h);
      assert.equal(count(h.storage, 'SELECT COUNT(*) n FROM publications'), 0);
    } finally { h.cleanup(); }
  });

test('3. LIVE + exact runtime action authorized: Handoff -> ... -> Publication -> PUBLISHED in ONE runAutonomousOperation invocation; adapter called exactly once',
  { skip: skipReason }, async () => {
    let authorizedActionId = null;
    let authPath = null;
    const h = await makeHarness({
      // The Owner approving the specific runtime action while the run is in progress: the id is read from the
      // pipeline's own content_versions row (it only exists once Brief has run) and written to the
      // authorization file, which the real D-C2 check re-reads on every call.
      onAssetAcquire: (storage) => {
        const cv = storage.get('SELECT id FROM content_versions');
        authorizedActionId = ACTION(cv.id);
        fs.writeFileSync(authPath, JSON.stringify([authorizedActionId]));
      }
    });
    try {
      authPath = authFile(h.dir, []);
      const result = await withConfig({ runMode: 'LIVE', autonomousEnabled: true, authorizedFile: authPath }, () => h.run('LIVE'));

      assert.equal(result.mode, 'LIVE');
      assert.equal(result.stopReason, 'no_work', 'nothing left to do after PUBLISHED');
      assertReachedPublicationBoundary(h, result);
      const cv = contentVersion(h);
      assert.equal(cv.state, 'PUBLISHED');
      assert.deepEqual(JSON.parse(fs.readFileSync(authPath, 'utf8')), [ACTION(cv.id)], 'exactly the one runtime action id is authorized');
      assert.equal(authorizedActionId, ACTION(cv.id));

      assert.equal(h.adapter.calls.length, 1, 'adapter called exactly once');
      const request = h.adapter.calls[0];
      assert.equal(request.title, WORKING_TITLE);
      assert.equal(request.mediaFilePath, h.storage.get('SELECT artifact_path p FROM media_artifacts').p);
      const publication = h.storage.get('SELECT * FROM publications');
      assert.equal(publication.status, 'PUBLISHED');
      assert.equal(publication.provider_item_id, 'REHEARSAL_VIDEO_ID');
      assert.equal(publication.content_version_id, cv.id);
      assert.equal(count(h.storage, `SELECT COUNT(*) n FROM decision_log WHERE decision = 'AUTHORIZATION_DENIED'`), 0);
    } finally { h.cleanup(); }
  });

test('3b. Owner workflow across invocations: LIVE run denied -> exact runtime action authorized -> second invocation publishes once',
  { skip: skipReason }, async () => {
    const h = await makeHarness();
    try {
      const auth = authFile(h.dir, []);
      await withConfig({ runMode: 'LIVE', autonomousEnabled: true, authorizedFile: auth }, async () => {
        const first = await h.run('LIVE');
        assert.equal(first.stopReason, 'no_progress');
        assert.equal(h.adapter.calls.length, 0);
        const cv = contentVersion(h);
        assert.equal(cv.state, 'PRODUCED');

        fs.writeFileSync(auth, JSON.stringify([ACTION(cv.id)]));
        const second = await h.run('LIVE');
        assert.equal(second.stopReason, 'no_work');
        assert.equal(processedOf(second).publication, 1);
        for (const stage of ['research', 'brief', 'script', 'fact-check', 'originality', 'quality-gate', 'production']) {
          assert.equal(processedOf(second)[stage], 0, `${stage} is not re-run`);
        }
        assert.equal(contentVersion(h).state, 'PUBLISHED');
        assert.equal(h.adapter.calls.length, 1, 'adapter called exactly once across both invocations');
        assert.equal(count(h.storage, 'SELECT COUNT(*) n FROM publications'), 1);
        assert.equal(count(h.storage, 'SELECT COUNT(*) n FROM productions'), 1);
        assert.equal(count(h.storage, 'SELECT COUNT(*) n FROM media_artifacts'), 1);
      });
    } finally { h.cleanup(); }
  });

test('4. Fact-check REJECT: runner stops at Fact-check (state SCRIPT_DRAFT); no production, asset, media or publication side effects',
  { skip: skipReason }, async () => {
    const h = await makeHarness({
      // Fault injection between real stages: the claim is invalidated after Brief/Script eligibility was computed.
      onScript: (storage) => storage.run(`UPDATE claims SET evidence_status = 'UNSUPPORTED'`)
    });
    try {
      const auth = authFile(h.dir, []);
      const result = await withConfig({ runMode: 'LIVE', autonomousEnabled: true, authorizedFile: auth }, () => h.run('LIVE'));

      assert.equal(result.stopReason, 'no_progress', 'REJECT leaves the item at SCRIPT_DRAFT; the loop guard stops the run');
      const p = processedOf(result);
      for (const stage of ['research', 'brief', 'script', 'fact-check']) assert.equal(p[stage], 1, `${stage} ran once`);
      for (const stage of ['originality', 'quality-gate', 'production', 'asset-provisioning', 'rights-verification', 'media-production', 'publication']) {
        assert.equal(p[stage], 0, `${stage} did not run`);
      }
      assert.equal(h.storage.get('SELECT status FROM fact_checks').status, 'REJECT');
      assert.equal(contentVersion(h).state, 'SCRIPT_DRAFT');
      assert.equal(count(h.storage, 'SELECT COUNT(*) n FROM originality_checks'), 0);
      assertNothingDownstreamOfFactCheckOrGate(h);
      assert.deepEqual(h.llmCalls, { research: 1, brief: 1, script: 1, unexpected: 0 });
    } finally { h.cleanup(); }
  });

test('5. Quality Gate BLOCK: runner stops with the item BLOCKED; no production, asset provisioning, media or publication side effects',
  { skip: skipReason }, async () => {
    const h = await makeHarness({
      // Fault injection between real stages: a DISPUTED asset is already attached to the content version.
      onScript: (storage) => {
        const cv = storage.get('SELECT id FROM content_versions');
        const repo = new AssetProvenanceRepository(storage);
        const assetId = repo.recordAsset({ assetType: 'image', location: '/nonexistent/disputed.png', verificationStatus: 'DISPUTED' });
        repo.recordUsage({ assetId, contentVersionId: cv.id, usageContext: 'b-roll' });
      }
    });
    try {
      const auth = authFile(h.dir, []);
      const result = await withConfig({ runMode: 'LIVE', autonomousEnabled: true, authorizedFile: auth }, () => h.run('LIVE'));

      assert.equal(result.stopReason, 'no_work', 'BLOCKED is terminal; nothing else is eligible');
      const p = processedOf(result);
      for (const stage of ['research', 'brief', 'script', 'fact-check', 'originality', 'quality-gate']) assert.equal(p[stage], 1, `${stage} ran once`);
      for (const stage of ['production', 'asset-provisioning', 'rights-verification', 'media-production', 'publication']) {
        assert.equal(p[stage], 0, `${stage} did not run`);
      }
      assertUpstreamThroughQualityGate(h);
      assert.equal(contentVersion(h).state, 'BLOCKED');
      assertNothingDownstreamOfFactCheckOrGate(h);
      assert.equal(count(h.storage, 'SELECT COUNT(*) n FROM assets'), 1, 'only the injected DISPUTED asset exists');
    } finally { h.cleanup(); }
  });
