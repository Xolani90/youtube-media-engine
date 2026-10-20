/**
 * Multi-scene visuals by default: end-to-end through the REAL pipeline stages.
 *
 *   Production -> Asset Provisioning -> Rights Verification -> Media Production (real narration, FFmpeg render, ffprobe)
 *
 * FIXTURE TEST, NOT A REAL-NETWORK PROOF. The asset provider is a deterministic fake that writes real PNG
 * files (via FFmpeg) and describes them the way the Pixabay provider does (origin, license, provenance notes,
 * checksum). No Pixabay/Gemini/Tavily call is made. What it proves is the wiring and the fallback/reporting
 * contract; whether real stock photos are relevant to a real script is only established by the real-media
 * harness (scripts/prove-fresh-autonomous-to-media.js), which needs live credentials.
 *
 * MULTI_SCENE_VISUALS is deliberately NOT set in the default-path tests below: that is the point.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { SqliteStorageDriver } from '../../src/storage/SqliteStorageDriver.js';
import { runProduction } from '../../src/production/pipeline.js';
import { runAssetProvisioning } from '../../src/asset-provisioning/pipeline.js';
import { runRightsVerification } from '../../src/rights-verification/pipeline.js';
import { runMediaProduction } from '../../src/media/pipeline.js';
import { planScenes, parseSceneUsageContext } from '../../src/asset-provisioning/scenePlan.js';
import { AssetSourceProvider } from '../../src/providers/asset/AssetSourceProvider.js';

const SCRIPT = [
  'Small business owners lose hours every week to paperwork. Most of it is invoices and tax forms.',
  'A laptop and a simple template can cut that time in half. Owners who automate invoices report fewer errors.',
  'Coffee shop owners often plan inventory on paper documents. A shared spreadsheet replaces those notes quickly.',
  'Modern office tools are cheap and easy to try. Start with one task and measure the time saved.',
  'Then repeat the process for payroll and tax reminders. Each small win compounds across the year.',
  'The result is more time for customers and less time lost to admin. That is the real return on automation.'
].join(' ');
const IDEAS = 'business owner, laptop, modern office, coffee shop interior, planning documents';
const COLORS = ['blue', 'red', 'green', 'yellow', 'purple', 'orange', 'cyan', 'magenta'];

// ---------- helpers ----------

const nowISO = () => new Date().toISOString();

function withEnv(vars, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  const restore = () => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } };
  return Promise.resolve().then(fn).finally(restore);
}

function makeWorld() {
  const dbPath = path.join(os.tmpdir(), `ms-default-e2e-${Date.now()}-${Math.random()}.db`);
  const storage = new SqliteStorageDriver({ dbPath });
  const dirs = ['production', 'media', 'assets'].map((n) => fs.mkdtempSync(path.join(os.tmpdir(), `ms-default-${n}-`)));
  return {
    storage, dbPath, productionDir: dirs[0], mediaDir: dirs[1], assetsDir: dirs[2],
    cleanup() {
      storage.close();
      for (const f of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) fs.rmSync(f, { force: true });
      for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
    }
  };
}

function seedContent(storage, { visualIdeas = IDEAS, body = SCRIPT } = {}) {
  const opportunityId = crypto.randomUUID();
  storage.run(`INSERT INTO opportunities (id, title, source, discovered_at, status) VALUES (?, 'Test opportunity', 'rss', ?, 'DISCOVERED')`, [opportunityId, nowISO()]);
  const contentBriefId = crypto.randomUUID();
  storage.run(
    `INSERT INTO content_briefs
      (id, opportunity_id, working_title, core_question, target_audience, viewer_promise,
       hook, angle, narrative_structure, key_claims, counterpoints, original_insights, visual_ideas,
       monetization_opportunities, risk_assessment, created_at)
     VALUES (?, ?, 'T', 'Q', 'A', 'P', 'H', 'Angle', 'Structure', '[]', 'C', 'I', ?, 'M', 'R', ?)`,
    [contentBriefId, opportunityId, visualIdeas, nowISO()]
  );
  const scriptId = crypto.randomUUID();
  storage.run(`INSERT INTO scripts (id, content_brief_id, version, body, claim_links, created_at) VALUES (?, ?, 1, ?, '[]', ?)`, [scriptId, contentBriefId, body, nowISO()]);
  const contentVersionId = crypto.randomUUID();
  storage.run(`INSERT INTO content_versions (id, content_brief_id, script_id, state, created_at) VALUES (?, ?, ?, 'PRODUCTION_READY', ?)`, [contentVersionId, contentBriefId, scriptId, nowISO()]);
  return { contentBriefId, contentVersionId };
}

function makeImage(dir, name, color) {
  const location = path.join(dir, name);
  execFileSync('ffmpeg', ['-f', 'lavfi', '-i', `color=c=${color}:s=64x64:d=1`, '-frames:v', '1', '-y', location], { stdio: ['ignore', 'pipe', 'pipe'] });
  return location;
}

const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

/**
 * Deterministic fake provider that describes its assets like PixabayAssetSourceProvider does.
 * `behaviour(query, callIndex)` may return: undefined (acquire a fresh, distinct image), 'null' (nothing found),
 * 'same' (always the first image => duplicates), or { license } / { origin } overrides.
 */
class FixtureProvider extends AssetSourceProvider {
  constructor(assetsDir, behaviour = () => undefined) {
    super();
    this.assetsDir = assetsDir; this.behaviour = behaviour; this.queries = []; this.files = [];
  }
  get id() { return 'fixture-pixabay-like'; }
  async healthCheck() { return true; }
  async acquireVisualAsset({ query }) {
    const n = this.queries.length;
    this.queries.push(query);
    const b = this.behaviour(query, n);
    if (b === 'null') return null;
    const file = b === 'same' && this.files.length ? this.files[0] : makeImage(this.assetsDir, `asset-${n}.png`, COLORS[n % COLORS.length]);
    if (!this.files.includes(file)) this.files.push(file);
    const over = typeof b === 'object' && b ? b : {};
    return {
      assetType: 'image',
      location: file,
      checksum: sha256(file),
      origin: over.origin ?? `https://pixabay.com/photos/fixture-${n}/`,
      license: over.license ?? 'Pixabay Content License',
      attributionRequired: false,
      attributionText: null,
      usageRestrictions: 'fixture',
      provenanceNotes: 'provider=pixabay; fixture',
      verificationStatus: 'UNVERIFIED'
    };
  }
}

/** Runs Production -> Asset Provisioning -> Rights Verification -> Media Production against one world. */
async function runChain(world, { provider, provisionArgs = {}, content = {} }) {
  const { storage } = world;
  await storage.migrate();
  const { contentBriefId, contentVersionId } = seedContent(storage, content);
  const production = runProduction({ storage, contentBriefId, artifactsDir: world.productionDir });
  assert.equal(production.outcome, 'PRODUCED');
  const provisioning = await runAssetProvisioning({ storage, contentBriefId, provider, ...provisionArgs });
  const rights = runRightsVerification({ storage, contentBriefId });
  const media = runMediaProduction({ storage, contentBriefId, artifactsDir: world.mediaDir });
  return { contentBriefId, contentVersionId, production, provisioning, rights, media };
}

function sceneAssetRows(storage, contentVersionId) {
  return storage.all(
    `SELECT a.id, a.verification_status, a.license, a.location, u.usage_context, u.provisioning_claim
       FROM asset_usages u JOIN assets a ON a.id = u.asset_id
      WHERE u.content_version_id = ?`, [contentVersionId]
  ).map((r) => ({ ...r, scene: parseSceneUsageContext(r.usage_context) }))
    .sort((x, y) => (x.scene?.order ?? 0) - (y.scene?.order ?? 0));
}

function decisionRow(storage, contentVersionId, decision) {
  const r = storage.get('SELECT reason FROM decision_log WHERE subject_id = ? AND decision = ? ORDER BY created_at DESC', [contentVersionId, decision]);
  return r ? r.reason : null;
}

// ---------- 1. the default path ----------

test('DEFAULT (no MULTI_SCENE_VISUALS): planned scenes -> distinct verified assets -> narration-aligned multi-scene render', async () => {
  await withEnv({ MULTI_SCENE_VISUALS: undefined }, async () => {
    const world = makeWorld();
    try {
      const provider = new FixtureProvider(world.assetsDir);
      const { contentVersionId, provisioning, rights, media } = await runChain(world, { provider });

      // A script produces several planned scenes.
      const plan = planScenes({ visualIdeas: IDEAS, scriptBody: SCRIPT });
      assert.ok(plan.length >= 3, `expected >= 3 planned scenes, got ${plan.length}`);
      assert.equal(provisioning.sceneReport.planned_scenes, plan.length);

      // Distinct scene assets and spans survive provisioning.
      assert.equal(provisioning.outcome, 'PROVISIONED');
      const rows = sceneAssetRows(world.storage, contentVersionId);
      assert.equal(rows.length, plan.length, 'every planned scene got an asset');
      assert.equal(new Set(rows.map((r) => r.id)).size, rows.length, 'asset ids are distinct');
      assert.equal(new Set(rows.map((r) => sha256(r.location))).size, rows.length, 'image bytes are distinct');
      assert.equal(rows.filter((r) => r.provisioning_claim !== null).length, 1, 'exactly one provisioning claim row');
      rows.forEach((r, i) => {
        assert.ok(r.scene, `asset ${i} carries a parseable scene span`);
        assert.equal(r.scene.order, i + 1);
        assert.equal(r.scene.count, plan.length);
      });

      // Scene-specific queries: never the fused whole-video query; the scene that narrates the coffee shop gets the coffee-shop term.
      assert.ok(!provider.queries.includes(IDEAS), 'the fused whole-video query is not used');
      assert.equal(new Set(provider.queries).size, provider.queries.length, 'no query repeated');
      const coffeeAt = SCRIPT.indexOf('Coffee shop') / SCRIPT.length;
      const coffeeScene = plan.find((s) => coffeeAt >= s.span.start && coffeeAt < s.span.end);
      assert.match(provider.queries[coffeeScene.index], /coffee/i, 'the coffee-shop narration is matched with the coffee-shop visual term');

      // Rights verification covers every asset.
      assert.equal(rights.outcome.length > 0, true);
      assert.equal(world.storage.get(`SELECT COUNT(*) n FROM asset_verifications WHERE decision = 'VERIFIED'`).n, rows.length);
      for (const r of sceneAssetRows(world.storage, contentVersionId)) assert.equal(r.verification_status, 'VERIFIED');

      // Media: the renderer consumed exactly the scene sequence.
      assert.equal(media.outcome, 'RENDERED');
      const spec = JSON.parse(media.mediaArtifact.render_spec_json);
      assert.deepEqual(spec.visual_timing.map((t) => t.asset_id), rows.map((r) => r.id), 'render order == scene order, one segment per scene');
      assert.equal(spec.visual_timing[0].start_seconds, 0);
      const last = spec.visual_timing.at(-1);
      assert.ok(Math.abs(last.start_seconds + last.duration_seconds - media.mediaArtifact.narration_duration_seconds) < 0.01);
      const captionStarts = new Set(spec.captions.map((c) => c.start_seconds));
      for (const seg of spec.visual_timing.slice(1)) assert.ok(captionStarts.has(seg.start_seconds), `cut at ${seg.start_seconds}s lands on a caption boundary`);
      for (let i = 1; i < spec.visual_timing.length; i++) assert.ok(spec.visual_timing[i].start_seconds > spec.visual_timing[i - 1].start_seconds);

      // The report says so, and says it honestly.
      const rep = media.sceneReport;
      assert.equal(rep.mode, 'scene_aligned');
      assert.equal(rep.narration_aligned, true);
      assert.equal(rep.planned_scenes, plan.length);
      assert.equal(rep.accepted_assets, plan.length);
      assert.equal(rep.rendered_scenes, plan.length);
      assert.equal(rep.distinct_rendered_assets, plan.length);
      assert.equal(rep.fallback_reason, null);
      assert.equal(rep.degraded, false);
      assert.deepEqual(JSON.parse(decisionRow(world.storage, contentVersionId, 'SCENE_SEQUENCING_REPORT')), rep);
      assert.equal(decisionRow(world.storage, contentVersionId, 'SCENE_ALIGNMENT_DEGRADED'), null);
      const summary = JSON.parse(decisionRow(world.storage, contentVersionId, 'SCENE_PROVISIONING_SUMMARY'));
      assert.deepEqual([summary.planned_scenes, summary.accepted_assets, summary.skipped_scenes.length], [plan.length, plan.length, 0]);

      // The QA report is bound to the file AND carries the scene report; no scene finding.
      const qa = JSON.parse(fs.readFileSync(path.join(path.dirname(media.mediaArtifact.artifact_path), 'media-qa.json'), 'utf8'));
      assert.deepEqual(qa.scene_report, rep);
      assert.ok(!qa.findings.some((f) => f.check === 'scene_alignment'));

      // It is a real, distinct-frames video.
      const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_streams', media.mediaArtifact.artifact_path]).toString());
      assert.ok(probe.streams.find((s) => s.codec_type === 'video'));
      assert.ok(probe.streams.find((s) => s.codec_type === 'audio'));
    } finally { world.cleanup(); }
  });
});

// ---------- 2. fallbacks when scene assets are unavailable ----------

test('missing LATER-scene assets: the stage and render still succeed, shorter than planned, and the report says exactly how much', async () => {
  await withEnv({ MULTI_SCENE_VISUALS: undefined, KEN_BURNS_MOTION: 'off' }, async () => {
    const world = makeWorld();
    try {
      // Scene 1 and 2 are found; every later query finds nothing.
      const provider = new FixtureProvider(world.assetsDir, (_q, n) => (n >= 2 ? 'null' : undefined));
      const { contentVersionId, provisioning, media } = await runChain(world, { provider });

      const planned = provisioning.sceneReport.planned_scenes;
      assert.ok(planned >= 4);
      assert.equal(provisioning.sceneReport.accepted_assets, 2);
      assert.equal(provisioning.sceneReport.skipped_scenes.length, planned - 2);
      assert.ok(provisioning.sceneReport.skipped_scenes.every((s) => s.reason === 'no_acceptable_candidate'));
      assert.equal(sceneAssetRows(world.storage, contentVersionId).length, 2);

      // Rendered with the two scenes it has; remaining span is tiled onto them (still span-driven, not cyclic).
      assert.equal(media.outcome, 'RENDERED');
      const rep = media.sceneReport;
      assert.equal(rep.planned_scenes, planned);
      assert.equal(rep.accepted_assets, 2);
      assert.equal(rep.rendered_scenes, 2);
      assert.equal(rep.mode, 'scene_aligned');
      assert.equal(rep.narration_aligned, true);
      assert.equal(rep.degraded, false);
      // ...and the shortfall is still on the record rather than hidden.
      const summary = JSON.parse(decisionRow(world.storage, contentVersionId, 'SCENE_PROVISIONING_SUMMARY'));
      assert.equal(summary.fallback_reason, 'some_scene_assets_unavailable');
      assert.equal(summary.skipped_scenes.length, planned - 2);
    } finally { world.cleanup(); }
  });
});

test('only scene 1 acquired (duplicates / nothing found): render succeeds but is reported as NOT narration-aligned, degraded, and QA is not clean', async () => {
  await withEnv({ MULTI_SCENE_VISUALS: undefined, KEN_BURNS_MOTION: 'off' }, async () => {
    const world = makeWorld();
    try {
      // Every query returns the SAME image: duplicates are rejected for scenes 2..N.
      const provider = new FixtureProvider(world.assetsDir, () => 'same');
      const { contentVersionId, provisioning, media } = await runChain(world, { provider });

      const planned = provisioning.sceneReport.planned_scenes;
      assert.ok(planned >= 3);
      assert.equal(provisioning.sceneReport.accepted_assets, 1);
      assert.ok(provisioning.sceneReport.skipped_scenes.every((s) => s.reason === 'duplicate_of_attached_asset'));
      assert.equal(world.storage.get('SELECT COUNT(*) n FROM assets').n, 1, 'duplicate images are never persisted');

      // The safe fallback: the render exists and is valid...
      assert.equal(media.outcome, 'RENDERED');
      assert.ok(fs.statSync(media.mediaArtifact.artifact_path).size > 0);
      // ...but it is not passed off as multi-scene production.
      const rep = media.sceneReport;
      assert.equal(rep.mode, 'single_asset');
      assert.equal(rep.narration_aligned, false);
      assert.equal(rep.planned_scenes, planned);
      assert.equal(rep.accepted_assets, 1);
      assert.equal(rep.distinct_rendered_assets, 1);
      assert.equal(rep.fallback_reason, 'scene_assets_unavailable');
      assert.equal(rep.degraded, true);
      assert.equal(decisionRow(world.storage, contentVersionId, 'SCENE_ALIGNMENT_DEGRADED'), 'scene_assets_unavailable');
      const qa = JSON.parse(fs.readFileSync(path.join(path.dirname(media.mediaArtifact.artifact_path), 'media-qa.json'), 'utf8'));
      assert.equal(qa.clean, false, 'a valid file alone does not make the QA report clean');
      assert.ok(qa.findings.some((f) => f.check === 'scene_alignment' && /scene_assets_unavailable/.test(f.detail)));
      assert.deepEqual(qa.scene_report, rep);
    } finally { world.cleanup(); }
  });
});

// ---------- 3. rights failures block the affected assets ----------

test('rights: one scene asset with an unapproved license -> that asset is NOT_VERIFIED and the render is blocked, the others stay VERIFIED', async () => {
  await withEnv({ MULTI_SCENE_VISUALS: undefined, KEN_BURNS_MOTION: 'off' }, async () => {
    const world = makeWorld();
    try {
      const provider = new FixtureProvider(world.assetsDir, (_q, n) => (n === 2 ? { license: 'Unknown / all rights reserved' } : undefined));
      const { contentVersionId, media } = await runChain(world, { provider });
      const rows = sceneAssetRows(world.storage, contentVersionId);
      assert.ok(rows.length >= 3);
      const bad = rows.filter((r) => r.license === 'Unknown / all rights reserved');
      assert.equal(bad.length, 1);
      assert.equal(bad[0].verification_status, 'UNVERIFIED');
      assert.ok(rows.filter((r) => r.id !== bad[0].id).every((r) => r.verification_status === 'VERIFIED'));
      assert.equal(media.outcome, 'ASSET_RIGHTS_BLOCKED');
      assert.equal(media.mediaArtifact, null);
      assert.equal(world.storage.get('SELECT COUNT(*) n FROM media_artifacts').n, 0);
    } finally { world.cleanup(); }
  });
});

test('rights: a scene asset whose bytes change after provisioning is DISPUTED (checksum) and blocks the render', async () => {
  await withEnv({ MULTI_SCENE_VISUALS: undefined, KEN_BURNS_MOTION: 'off' }, async () => {
    const world = makeWorld();
    try {
      const { storage } = world;
      await storage.migrate();
      const { contentBriefId, contentVersionId } = seedContent(storage);
      assert.equal(runProduction({ storage, contentBriefId, artifactsDir: world.productionDir }).outcome, 'PRODUCED');
      const provider = new FixtureProvider(world.assetsDir);
      await runAssetProvisioning({ storage, contentBriefId, provider });
      const rows = sceneAssetRows(storage, contentVersionId);
      fs.writeFileSync(rows[1].location, 'tampered after provisioning');
      runRightsVerification({ storage, contentBriefId });
      const after = sceneAssetRows(storage, contentVersionId);
      assert.equal(after[1].verification_status, 'DISPUTED');
      assert.ok(after.filter((_, i) => i !== 1).every((r) => r.verification_status === 'VERIFIED'));
      const media = runMediaProduction({ storage, contentBriefId, artifactsDir: world.mediaDir });
      assert.equal(media.outcome, 'ASSET_RIGHTS_BLOCKED');
      assert.equal(storage.get('SELECT COUNT(*) n FROM media_artifacts').n, 0);
    } finally { world.cleanup(); }
  });
});

// ---------- 4. the explicit override ----------

test('MULTI_SCENE_VISUALS=off (explicit override): one asset, cyclic/single timing, reported as multi_scene_disabled and NOT degraded', async () => {
  await withEnv({ MULTI_SCENE_VISUALS: 'off', KEN_BURNS_MOTION: 'off' }, async () => {
    const world = makeWorld();
    try {
      const provider = new FixtureProvider(world.assetsDir);
      const { contentVersionId, provisioning, media } = await runChain(world, { provider });
      assert.equal(provider.queries.length, 1);
      assert.equal(provider.queries[0], IDEAS, 'the original whole-video query is used');
      assert.equal(provisioning.sceneReport.fallback_reason, 'multi_scene_disabled');
      const rows = world.storage.all('SELECT usage_context FROM asset_usages WHERE content_version_id = ?', [contentVersionId]);
      assert.deepEqual(rows.map((r) => r.usage_context), ['b-roll']);
      assert.equal(media.outcome, 'RENDERED');
      assert.equal(media.sceneReport.mode, 'single_asset');
      assert.equal(media.sceneReport.narration_aligned, false);
      assert.equal(media.sceneReport.fallback_reason, 'multi_scene_disabled');
      assert.equal(media.sceneReport.degraded, false);
      assert.equal(decisionRow(world.storage, contentVersionId, 'SCENE_ALIGNMENT_DEGRADED'), null);
      const qa = JSON.parse(fs.readFileSync(path.join(path.dirname(media.mediaArtifact.artifact_path), 'media-qa.json'), 'utf8'));
      assert.ok(!qa.findings.some((f) => f.check === 'scene_alignment'));
    } finally { world.cleanup(); }
  });
});