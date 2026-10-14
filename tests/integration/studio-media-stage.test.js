import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { SqliteStorageDriver } from '../../src/storage/SqliteStorageDriver.js';
import { runProduction } from '../../src/production/pipeline.js';
import { runMediaProduction } from '../../src/media/pipeline.js';
import { mediaDir } from '../../src/media/artifactStore.js';
import { AssetProvenanceRepository } from '../../src/state/AssetProvenance.js';
import { writeStudioPlan, STUDIO_PLAN_FILENAME, STUDIO_DECISION } from '../../src/studio/mediaStage.js';

// Real FFmpeg + the real pipeline. Narration needs espeak-ng exactly as the existing
// media e2e tests do; without it these tests are skipped, never faked.
const hasTool = (cmd, args) => { try { return spawnSync(cmd, args, { stdio: 'ignore' }).status === 0; } catch { return false; } };
const CAN_RUN = hasTool('ffmpeg', ['-version']) && hasTool('espeak-ng', ['--version']);
const opts = { skip: CAN_RUN ? false : 'ffmpeg and espeak-ng are required for a real media render' };

const BODY = 'This is the first sentence of a longer test script. Here is a second sentence with more content. '
  + 'A third sentence continues the narration further still. Finally, a fourth sentence wraps up the script.';
const nowISO = () => new Date().toISOString();

function withEnv(vars, fn) {
  const prev = {};
  for (const k of Object.keys(vars)) { prev[k] = process.env[k]; if (vars[k] === undefined) delete process.env[k]; else process.env[k] = vars[k]; }
  try { return fn(); } finally { for (const k of Object.keys(vars)) { if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k]; } }
}

async function setup() {
  const dbPath = path.join(os.tmpdir(), `studio-media-${Date.now()}-${Math.random()}.db`);
  const storage = new SqliteStorageDriver({ dbPath });
  await storage.migrate();
  const dirs = ['prod', 'media', 'assets'].map((p) => fs.mkdtempSync(path.join(os.tmpdir(), `studio-${p}-`)));
  const [prodDir, mediaRoot, assetsDir] = dirs;
  const oppId = crypto.randomUUID();
  storage.run(`INSERT INTO opportunities (id, title, source, discovered_at, status) VALUES (?, 'T', 'rss', ?, 'DISCOVERED')`, [oppId, nowISO()]);
  const briefId = crypto.randomUUID();
  storage.run(
    `INSERT INTO content_briefs (id, opportunity_id, working_title, core_question, target_audience, viewer_promise, hook, angle, narrative_structure, key_claims, counterpoints, original_insights, visual_ideas, monetization_opportunities, risk_assessment, created_at)
     VALUES (?, ?, 'T', 'Q', 'A', 'P', 'H', 'Angle', 'Structure', '[]', 'C', 'I', 'V', 'M', 'R', ?)`, [briefId, oppId, nowISO()]);
  const scriptId = crypto.randomUUID();
  storage.run(`INSERT INTO scripts (id, content_brief_id, version, body, claim_links, created_at) VALUES (?, ?, 1, ?, '[]', ?)`, [scriptId, briefId, BODY, nowISO()]);
  const cvId = crypto.randomUUID();
  storage.run(`INSERT INTO content_versions (id, content_brief_id, script_id, state, created_at) VALUES (?, ?, ?, 'PRODUCTION_READY', ?)`, [cvId, briefId, scriptId, nowISO()]);
  const repo = new AssetProvenanceRepository(storage);
  const image = (name, color) => {
    const location = path.join(assetsDir, name);
    execFileSync('ffmpeg', ['-f', 'lavfi', '-i', `color=c=${color}:s=64x64:d=1`, '-frames:v', '1', '-y', location], { stdio: 'ignore' });
    return location;
  };
  const addAsset = (name, color, status = 'VERIFIED') => {
    const location = image(name, color);
    const id = repo.recordAsset({ assetType: 'image', location, verificationStatus: status });
    repo.recordUsage({ assetId: id, contentVersionId: cvId, usageContext: 'studio-frame' });
    return { id, location };
  };
  const cleanup = () => {
    storage.close();
    for (const f of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) fs.rmSync(f, { force: true });
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  };
  const produce = () => { const r = runProduction({ storage, contentBriefId: briefId, artifactsDir: prodDir }); assert.equal(r.outcome, 'PRODUCED'); };
  const media = () => runMediaProduction({ storage, contentBriefId: briefId, artifactsDir: mediaRoot });
  const planDir = () => { const d = mediaDir(mediaRoot, cvId); fs.mkdirSync(d, { recursive: true }); return d; };
  const decisions = () => storage.all(`SELECT decision, reason FROM decision_log WHERE subject_id = ? ORDER BY rowid`, [cvId]);
  return { storage, briefId, cvId, addAsset, cleanup, produce, media, planDir, decisions, mediaRoot };
}

/** Two uneven studio segments over the narration; the last one is long enough to absorb any narration rounding. */
function plan(a, b, narration) {
  const cut = Math.round(narration * 0.3 * 1000) / 1000;
  return [
    { asset_id: a.id, location: a.location, start_seconds: 0, duration_seconds: cut },
    { asset_id: b.id, location: b.location, start_seconds: cut, duration_seconds: Math.round((narration - cut) * 1000) / 1000 }
  ];
}

/** Narration length of the real espeak output for BODY, measured by rendering once without studio. */
async function measuredNarration() {
  const t = await setup();
  try {
    t.addAsset('m.png', 'blue'); t.produce();
    const r = withEnv({ STUDIO_VISUALS: undefined }, () => t.media());
    assert.equal(r.outcome, 'RENDERED');
    return r.mediaArtifact.narration_duration_seconds;
  } finally { t.cleanup(); }
}

function pixelAt(video, seconds) {
  const out = execFileSync('ffmpeg', ['-v', 'error', '-ss', String(seconds), '-i', video, '-frames:v', '1', '-vf', 'scale=1:1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { stdio: ['ignore', 'pipe', 'pipe'] });
  return [out[0], out[1], out[2]];
}

test('1. STUDIO_VISUALS off (default): a studio plan on disk is ignored and legacy timing is unchanged', opts, async () => {
  const narr = await measuredNarration();
  const a = await setup(); const b = await setup();
  try {
    for (const t of [a, b]) { t.addAsset('a.png', 'blue'); t.addAsset('b.png', 'red'); t.produce(); }
    // a: studio plan present but flag unset; b: no plan at all. Both must produce the identical legacy timing.
    const [x, y] = [a, b].map((t) => t.storage.all('SELECT asset_id FROM asset_usages WHERE content_version_id = ?', [t.cvId]));
    assert.equal(x.length, 2); assert.equal(y.length, 2);
    const assetsA = a.storage.all('SELECT a.id, a.location FROM assets a JOIN asset_usages u ON u.asset_id = a.id WHERE u.content_version_id = ?', [a.cvId]);
    writeStudioPlan(a.planDir(), { visualTiming: plan(assetsA[0], assetsA[1], narr), durationSeconds: narr, characterId: 'c' });
    const ra = withEnv({ STUDIO_VISUALS: undefined }, () => a.media());
    const rb = withEnv({ STUDIO_VISUALS: undefined }, () => b.media());
    assert.equal(ra.outcome, 'RENDERED'); assert.equal(rb.outcome, 'RENDERED');
    const shape = (r) => JSON.parse(r.mediaArtifact.render_spec_json).visual_timing.map((s) => [s.asset_type, s.start_seconds, s.duration_seconds]);
    assert.deepEqual(shape(ra), shape(rb));
    for (const t of [a, b]) assert.ok(!t.decisions().some((d) => d.decision.startsWith('STUDIO_VISUALS_')), 'no studio decision may be logged when off');
  } finally { a.cleanup(); b.cleanup(); }
});

test('2. enabled + valid plan + verified assets: studio timing reaches the real render spec and the real video, and APPLIED is logged', opts, async () => {
  const narr = await measuredNarration();
  const t = await setup();
  try {
    const A = t.addAsset('a.png', 'blue'); const B = t.addAsset('b.png', 'red');
    t.produce();
    const timing = plan(A, B, narr);
    const { checksum } = writeStudioPlan(t.planDir(), { visualTiming: timing, durationSeconds: narr, characterId: 'char-1' });
    const r = withEnv({ STUDIO_VISUALS: 'on' }, () => t.media());
    assert.equal(r.outcome, 'RENDERED');
    const spec = JSON.parse(r.mediaArtifact.render_spec_json);
    assert.deepEqual(spec.visual_timing.map((s) => s.asset_id), [A.id, B.id]);
    assert.equal(spec.visual_timing[0].start_seconds, 0);
    assert.equal(spec.visual_timing[1].start_seconds, timing[1].start_seconds);
    const end = spec.visual_timing[1].start_seconds + spec.visual_timing[1].duration_seconds;
    assert.ok(Math.abs(end - r.mediaArtifact.narration_duration_seconds) < 0.01);
    const applied = t.decisions().filter((d) => d.decision === STUDIO_DECISION.APPLIED);
    assert.equal(applied.length, 1);
    assert.match(applied[0].reason, /^studio_plan_[0-9a-f]{64}_2_segments$/);
    assert.ok(typeof checksum === 'string' && checksum.length === 64);
    // Inspect the actual artifact: first frame is blue (asset A), a late frame is red (asset B).
    const early = pixelAt(r.mediaArtifact.artifact_path, timing[0].duration_seconds / 2);
    const late = pixelAt(r.mediaArtifact.artifact_path, timing[1].start_seconds + timing[1].duration_seconds / 2);
    assert.ok(early[2] > early[0] + 60, `expected blue early, got ${early}`);
    assert.ok(late[0] > late[2] + 60, `expected red late, got ${late}`);
  } finally { t.cleanup(); }
});

test('3. enabled + invalid plan: RENDER_FAILED with the testable reason, no artifact, no APPLIED, no silent legacy substitution', opts, async () => {
  const narr = await measuredNarration();
  const t = await setup();
  try {
    const A = t.addAsset('a.png', 'blue'); const B = t.addAsset('b.png', 'red');
    t.produce();
    const bad = plan(A, B, narr); bad[1].start_seconds += 0.5; // gap
    writeStudioPlan(t.planDir(), { visualTiming: bad, durationSeconds: narr, characterId: 'c' });
    const r = withEnv({ STUDIO_VISUALS: 'on' }, () => t.media());
    assert.equal(r.outcome, 'RENDER_FAILED');
    assert.match(r.reason, /STUDIO_TIMING_GAP_OR_OVERLAP/);
    assert.equal(t.storage.get('SELECT COUNT(*) n FROM media_artifacts').n, 0);
    assert.ok(!t.decisions().some((d) => d.decision === STUDIO_DECISION.APPLIED));
    assert.ok(!t.decisions().some((d) => d.decision === STUDIO_DECISION.FALLBACK));
    // unparsable plan and wrong duration are rejected too
    fs.writeFileSync(path.join(t.planDir(), STUDIO_PLAN_FILENAME), '{not json');
    assert.match(withEnv({ STUDIO_VISUALS: 'on' }, () => t.media()).reason, /STUDIO_PLAN_UNREADABLE/);
    writeStudioPlan(t.planDir(), { visualTiming: plan(A, B, narr + 5), durationSeconds: narr + 5, characterId: 'c' });
    assert.match(withEnv({ STUDIO_VISUALS: 'on' }, () => t.media()).reason, /STUDIO_TIMING_DURATION_MISMATCH/);
  } finally { t.cleanup(); }
});

test('4. enabled + missing/unattached assets: plan naming an unattached asset fails explicitly; absent plan falls back and the fallback is logged', opts, async () => {
  const narr = await measuredNarration();
  const t = await setup();
  try {
    const A = t.addAsset('a.png', 'blue'); const B = t.addAsset('b.png', 'red');
    t.produce();
    const ghost = { ...plan(A, B, narr) };
    ghost[1] = { ...ghost[1], asset_id: 'not-attached-to-this-content-version' };
    writeStudioPlan(t.planDir(), { visualTiming: Object.values(ghost), durationSeconds: narr, characterId: 'c' });
    const r = withEnv({ STUDIO_VISUALS: 'on' }, () => t.media());
    assert.equal(r.outcome, 'RENDER_FAILED');
    assert.match(r.reason, /STUDIO_ASSET_NOT_ATTACHED/);
    // plan removed: observable legacy fallback, never reported as a studio render
    fs.rmSync(path.join(t.planDir(), STUDIO_PLAN_FILENAME));
    const r2 = withEnv({ STUDIO_VISUALS: 'on' }, () => t.media());
    assert.equal(r2.outcome, 'RENDERED');
    const ds = t.decisions().map((d) => d.decision);
    assert.ok(ds.includes(STUDIO_DECISION.FALLBACK));
    assert.ok(!ds.includes(STUDIO_DECISION.APPLIED));
  } finally { t.cleanup(); }
});

test('5. an invalid STUDIO_VISUALS value is a RENDER_FAILED configuration error, never silently defaulted', opts, async () => {
  const t = await setup();
  try {
    t.addAsset('a.png', 'blue'); t.produce();
    const r = withEnv({ STUDIO_VISUALS: 'maybe' }, () => t.media());
    assert.equal(r.outcome, 'RENDER_FAILED');
    assert.match(r.reason, /STUDIO_VISUALS must be one of on, off/);
  } finally { t.cleanup(); }
});

test('6. rights gate still blocks first: UNVERIFIED or DISPUTED studio assets never reach studio sequencing or a render', opts, async () => {
  const narr = await measuredNarration();
  for (const status of ['UNVERIFIED', 'DISPUTED']) {
    const t = await setup();
    try {
      // Production (an earlier stage) refuses non-VERIFIED assets itself, so verify first, produce, then
      // change the status: exactly the "rights changed since Production" case Media's re-check exists for.
      const A = t.addAsset('a.png', 'blue'); const B = t.addAsset('b.png', 'red');
      t.produce();
      t.storage.run('UPDATE assets SET verification_status = ? WHERE id = ?', [status, B.id]);
      writeStudioPlan(t.planDir(), { visualTiming: plan(A, B, narr), durationSeconds: narr, characterId: 'c' });
      const r = withEnv({ STUDIO_VISUALS: 'on' }, () => t.media());
      assert.equal(r.outcome, 'ASSET_RIGHTS_BLOCKED');
      assert.equal(r.reason, status);
      assert.equal(t.storage.get('SELECT COUNT(*) n FROM media_artifacts').n, 0);
      assert.ok(!t.decisions().some((d) => d.decision.startsWith('STUDIO_VISUALS_')));
    } finally { t.cleanup(); }
  }
});

test('7. studio and legacy visual_timing contracts are compatible: same segment keys, contiguous, accepted by buildRenderSpec', opts, async () => {
  const narr = await measuredNarration();
  const a = await setup(); const b = await setup();
  try {
    for (const t of [a, b]) { t.addAsset('a.png', 'blue'); t.addAsset('b.png', 'red'); t.produce(); }
    const assetsA = a.storage.all('SELECT a.id, a.location FROM assets a JOIN asset_usages u ON u.asset_id = a.id WHERE u.content_version_id = ?', [a.cvId]);
    writeStudioPlan(a.planDir(), { visualTiming: plan(assetsA[0], assetsA[1], narr), durationSeconds: narr, characterId: 'c' });
    const studio = JSON.parse(withEnv({ STUDIO_VISUALS: 'on' }, () => a.media()).mediaArtifact.render_spec_json).visual_timing;
    const legacy = JSON.parse(withEnv({ STUDIO_VISUALS: undefined }, () => b.media()).mediaArtifact.render_spec_json).visual_timing;
    assert.deepEqual(Object.keys(studio[0]).sort(), Object.keys(legacy[0]).sort());
    for (const tl of [studio, legacy]) {
      assert.equal(tl[0].start_seconds, 0);
      for (let i = 1; i < tl.length; i++) assert.equal(tl[i].start_seconds, Math.round((tl[i - 1].start_seconds + tl[i - 1].duration_seconds) * 1000) / 1000);
    }
  } finally { a.cleanup(); b.cleanup(); }
});
