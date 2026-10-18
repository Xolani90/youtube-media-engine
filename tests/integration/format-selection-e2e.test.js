import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { SqliteStorageDriver } from '../../src/storage/SqliteStorageDriver.js';
import { runProduction } from '../../src/production/pipeline.js';
import { runMediaProduction, runShortFormProduction } from '../../src/media/pipeline.js';
import {
  FORMAT_DECISION,
  runFormatSelection,
  runFormatAwareShortForm,
  getFormatDecision
} from '../../src/media/formatSelection.js';
import { OUTCOME } from '../../src/media/constants.js';
import { selectEligibleShortFormProductions, selectEligiblePublications } from '../../src/autonomous/workSelection.js';
import { AssetProvenanceRepository } from '../../src/state/AssetProvenance.js';

function freshStorage() {
  const dbPath = path.join(os.tmpdir(), `format-sel-${Date.now()}-${Math.random()}.db`);
  return { storage: new SqliteStorageDriver({ dbPath }), dbPath };
}
function freshDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
}
function cleanup(storage, dbPath, ...dirs) {
  storage.close();
  for (const f of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) fs.rmSync(f, { force: true });
  for (const d of dirs) if (d) fs.rmSync(d, { recursive: true, force: true });
}
const nowISO = () => new Date().toISOString();
const uuid = () => crypto.randomUUID();

// ---------------------------------------------------------------- seeding

/** Opportunity -> research project -> brief -> script -> content_version, with N verified claims over M sources. */
function seedItem(storage, {
  state = 'PRODUCED',
  body = 'A short narration body.',
  verifiedClaims = null, // null = no research project at all
  sources = 0,
  estimates = {}
} = {}) {
  const opportunityId = uuid();
  storage.run(
    `INSERT INTO opportunities (id, title, source, discovered_at, status, novelty, story_potential, production_difficulty)
     VALUES (?, 'Opp', 'rss', ?, 'DISCOVERED', ?, ?, ?)`,
    [opportunityId, nowISO(), estimates.novelty ?? null, estimates.story_potential ?? null, estimates.production_difficulty ?? null]
  );
  let researchProjectId = null;
  if (verifiedClaims !== null) {
    researchProjectId = uuid();
    storage.run(
      `INSERT INTO research_projects (id, opportunity_id, status, created_at) VALUES (?, ?, 'RESEARCH_COMPLETE', ?)`,
      [researchProjectId, opportunityId, nowISO()]
    );
    const sourceIds = [];
    for (let i = 0; i < sources; i++) {
      const sid = uuid();
      storage.run(
        `INSERT INTO sources (id, research_project_id, url, retrieved_at) VALUES (?, ?, ?, ?)`,
        [sid, researchProjectId, `https://example.test/s${i}`, nowISO()]
      );
      sourceIds.push(sid);
    }
    for (let i = 0; i < verifiedClaims; i++) {
      const cid = uuid();
      storage.run(
        `INSERT INTO claims (id, research_project_id, claim, claim_type, evidence_status, created_at)
         VALUES (?, ?, ?, 'FACT', 'VERIFIED', ?)`,
        [cid, researchProjectId, `claim ${i}`, nowISO()]
      );
      if (sourceIds.length > 0) {
        storage.run(
          `INSERT INTO claim_sources (id, claim_id, source_id, role, created_at) VALUES (?, ?, ?, 'primary', ?)`,
          [uuid(), cid, sourceIds[i % sourceIds.length], nowISO()]
        );
      }
    }
  }
  const contentBriefId = uuid();
  storage.run(
    `INSERT INTO content_briefs
      (id, opportunity_id, research_project_id, working_title, core_question, target_audience, viewer_promise,
       hook, angle, narrative_structure, key_claims, counterpoints, original_insights, visual_ideas,
       monetization_opportunities, risk_assessment, created_at)
     VALUES (?, ?, ?, 'Title', 'Q', 'A', 'P', 'H', 'Angle', 'S', '[]', 'C', 'I', 'V', 'M', 'R', ?)`,
    [contentBriefId, opportunityId, researchProjectId, nowISO()]
  );
  const scriptId = uuid();
  storage.run(
    `INSERT INTO scripts (id, content_brief_id, version, body, claim_links, created_at) VALUES (?, ?, 1, ?, '[]', ?)`,
    [scriptId, contentBriefId, body, nowISO()]
  );
  const contentVersionId = uuid();
  storage.run(
    `INSERT INTO content_versions (id, content_brief_id, script_id, state, created_at) VALUES (?, ?, ?, ?, ?)`,
    [contentVersionId, contentBriefId, scriptId, state, nowISO()]
  );
  return { opportunityId, researchProjectId, contentBriefId, scriptId, contentVersionId };
}

/** A long-form media_artifacts row whose render_spec carries real, hand-built timing (no ffmpeg). */
function seedCraftedLongFormArtifact(storage, item, { durationSeconds, segmentSeconds = 10 }) {
  const visual = [];
  const captions = [];
  for (let t = 0; t < durationSeconds; t += segmentSeconds) {
    const d = Math.min(segmentSeconds, durationSeconds - t);
    visual.push({ start_seconds: t, duration_seconds: d });
    captions.push({ start_seconds: t, duration_seconds: d, text: `cap ${t}` });
  }
  const spec = { narration: { duration_seconds: durationSeconds, provider: 'test' }, visual_timing: visual, captions };
  const productionId = uuid();
  storage.run(
    `INSERT INTO productions (id, content_version_id, script_id, artifact_type, artifact_path, artifact_checksum, manifest_json, created_at)
     VALUES (?, ?, ?, 'production_manifest_v1', '/tmp/x', 'deadbeef', '{}', ?)`,
    [productionId, item.contentVersionId, item.scriptId, nowISO()]
  );
  const id = uuid();
  storage.run(
    `INSERT INTO media_artifacts
      (id, production_id, content_version_id, render_spec_json, render_spec_checksum,
       narration_path, narration_duration_seconds, artifact_path, artifact_checksum,
       duration_seconds, width, height, video_codec, audio_codec, created_at)
     VALUES (?, ?, ?, ?, 'chk', '/tmp/n.wav', ?, '/tmp/v.mp4', 'chk2', ?, 1280, 720, 'h264', 'aac', ?)`,
    [id, productionId, item.contentVersionId, JSON.stringify(spec), durationSeconds, durationSeconds, nowISO()]
  );
  return id;
}

function decisionRows(storage, contentVersionId) {
  return storage.all(
    `SELECT * FROM decision_log WHERE subject_type = 'content_version' AND subject_id = ? AND decision LIKE 'FORMAT_%'`,
    [contentVersionId]
  );
}

const selectedBriefIds = (rows) => rows.map((r) => r.contentBriefId);

// ------------------------------------------------- DB-level behaviour (no ffmpeg)

test('BOTH: persisted once with reasons + signals + thresholds + missing signals; idempotent; short is produced', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  try {
    const item = seedItem(storage, { verifiedClaims: 6, sources: 3, estimates: { novelty: 72, story_potential: 64 } });
    seedCraftedLongFormArtifact(storage, item, { durationSeconds: 240 });

    const produced = [];
    const produceShortForm = (args) => { produced.push(args.contentBriefId); return { outcome: OUTCOME.RENDERED }; };

    const r1 = runFormatAwareShortForm({ storage, contentBriefId: item.contentBriefId, runId: null, produceShortForm });
    assert.equal(r1.outcome, OUTCOME.RENDERED);
    assert.deepEqual(produced, [item.contentBriefId]);

    const rows = decisionRows(storage, item.contentVersionId);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].decision, FORMAT_DECISION.BOTH);
    assert.equal(rows[0].stage, 'MEDIA_PRODUCTION');
    assert.ok(rows[0].reason.includes('both formats viable'));
    const snap = JSON.parse(rows[0].config_snapshot);
    assert.equal(snap.rule, 'BOTH_VIABLE');
    assert.equal(snap.signals.verifiedClaims, 6);
    assert.equal(snap.signals.distinctSources, 3);
    assert.equal(snap.signals.narrationDurationSeconds, 240);
    assert.equal(snap.signals.shortSegment.selected, true);
    assert.equal(snap.segment_basis, 'PREFIX_V1');
    assert.equal(snap.context.opportunityEstimates.novelty, 72);
    assert.equal(snap.context.opportunityEstimates.competition, null);
    assert.equal(snap.context.historicalPerformance, 'UNAVAILABLE');
    assert.ok(snap.missing_signals.includes('historical_performance'));
    assert.ok(snap.thresholds.LONG_FORM_MIN_VERIFIED_CLAIMS > 0);

    // Idempotent: a second call neither re-decides nor adds a row.
    const again = runFormatSelection({ storage, contentBriefId: item.contentBriefId });
    assert.equal(again.outcome, 'ALREADY_DECIDED');
    assert.equal(again.decision, FORMAT_DECISION.BOTH);
    assert.equal(decisionRows(storage, item.contentVersionId).length, 1);
  } finally {
    cleanup(storage, dbPath);
  }
});

test('LONG_FORM_ONLY: short is NOT produced, stage reports a normal completion, selector skips the item afterwards, short providers excluded', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  try {
    // Deep material but the first segment alone exceeds the 60s cap -> no valid short segment.
    const item = seedItem(storage, { state: 'FINAL_COMPLIANCE', verifiedClaims: 6, sources: 3 });
    seedCraftedLongFormArtifact(storage, item, { durationSeconds: 300, segmentSeconds: 150 });

    assert.deepEqual(selectedBriefIds(selectEligibleShortFormProductions(storage)), [item.contentBriefId]);

    let called = 0;
    const out = runFormatAwareShortForm({
      storage, contentBriefId: item.contentBriefId,
      produceShortForm: () => { called += 1; return { outcome: OUTCOME.RENDERED }; }
    });
    assert.equal(out.outcome, OUTCOME.SHORT_FORM_NOT_SELECTED);
    assert.equal(out.formatDecision, FORMAT_DECISION.LONG_FORM_ONLY);
    assert.equal(called, 0);

    // Sweep terminates: not re-selected for short-form production.
    assert.deepEqual(selectEligibleShortFormProductions(storage), []);

    // Publication: long-form provider still sees it, short-form providers do not.
    assert.deepEqual(selectedBriefIds(selectEligiblePublications(storage, 'youtube')), [item.contentBriefId]);
    for (const p of ['youtube_shorts', 'tiktok', 'facebook_reels']) {
      assert.deepEqual(selectEligiblePublications(storage, p), [], p);
    }
  } finally {
    cleanup(storage, dbPath);
  }
});

test('SHORT_FORM_ONLY: short is produced; long-form provider is excluded from publication, short providers are not', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  try {
    // 40s narration (within cap, >= min short) with thin evidence.
    const item = seedItem(storage, { state: 'FINAL_COMPLIANCE', verifiedClaims: 2, sources: 1 });
    seedCraftedLongFormArtifact(storage, item, { durationSeconds: 40 });

    const out = runFormatAwareShortForm({
      storage, contentBriefId: item.contentBriefId,
      produceShortForm: () => ({ outcome: OUTCOME.RENDERED })
    });
    assert.equal(out.outcome, OUTCOME.RENDERED);
    assert.equal(getFormatDecision(storage, item.contentVersionId).decision, FORMAT_DECISION.SHORT_FORM_ONLY);

    assert.deepEqual(selectEligiblePublications(storage, 'youtube'), []);
    for (const p of ['youtube_shorts', 'tiktok', 'facebook_reels']) {
      assert.deepEqual(selectedBriefIds(selectEligiblePublications(storage, p)), [item.contentBriefId], p);
    }
  } finally {
    cleanup(storage, dbPath);
  }
});

test('BOTH: neither publication provider type is excluded', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  try {
    const item = seedItem(storage, { state: 'FINAL_COMPLIANCE', verifiedClaims: 6, sources: 3 });
    seedCraftedLongFormArtifact(storage, item, { durationSeconds: 240 });
    runFormatAwareShortForm({ storage, contentBriefId: item.contentBriefId, produceShortForm: () => ({ outcome: OUTCOME.RENDERED }) });
    for (const p of ['youtube', 'youtube_shorts', 'facebook_reels']) {
      assert.deepEqual(selectedBriefIds(selectEligiblePublications(storage, p)), [item.contentBriefId], p);
    }
  } finally {
    cleanup(storage, dbPath);
  }
});

test('missing decisive signal (no research project): UNDECIDED, reason + missing signal recorded, legacy behaviour preserved (short produced, no provider excluded)', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  try {
    const item = seedItem(storage, { state: 'FINAL_COMPLIANCE', verifiedClaims: null });
    seedCraftedLongFormArtifact(storage, item, { durationSeconds: 240 });

    let called = 0;
    const out = runFormatAwareShortForm({
      storage, contentBriefId: item.contentBriefId,
      produceShortForm: () => { called += 1; return { outcome: OUTCOME.RENDERED }; }
    });
    assert.equal(out.outcome, OUTCOME.RENDERED);
    assert.equal(called, 1);

    const row = getFormatDecision(storage, item.contentVersionId);
    assert.equal(row.decision, FORMAT_DECISION.UNDECIDED);
    const snap = JSON.parse(row.config_snapshot);
    assert.equal(snap.rule, 'DECISIVE_SIGNAL_MISSING');
    assert.ok(snap.missing_signals.includes('evidence_depth'));
    assert.equal(snap.signals.verifiedClaims, null);

    for (const p of ['youtube', 'youtube_shorts', 'tiktok']) {
      assert.deepEqual(selectedBriefIds(selectEligiblePublications(storage, p)), [item.contentBriefId], p);
    }
  } finally {
    cleanup(storage, dbPath);
  }
});

test('neither format proven viable: UNDECIDED fallback keeps legacy behaviour (short stage runs, no short-form provider excluded)', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  try {
    // Thin evidence (0 claims) and a 10s narration: no viable long form, no viable short (< minimum).
    const item = seedItem(storage, { state: 'FINAL_COMPLIANCE', verifiedClaims: 0, sources: 0 });
    seedCraftedLongFormArtifact(storage, item, { durationSeconds: 10 });

    // Baseline: legacy provider selection for an item with NO FORMAT_* decision.
    const legacy = {};
    for (const p of ['youtube', 'youtube_shorts', 'tiktok', 'facebook_reels']) {
      legacy[p] = selectedBriefIds(selectEligiblePublications(storage, p));
    }

    let called = 0;
    const out = runFormatAwareShortForm({
      storage, contentBriefId: item.contentBriefId,
      produceShortForm: () => { called += 1; return { outcome: OUTCOME.RENDERED }; }
    });
    assert.equal(out.outcome, OUTCOME.RENDERED);
    assert.equal(called, 1, 'short-form production must still be attempted (legacy behaviour)');

    const row = getFormatDecision(storage, item.contentVersionId);
    assert.equal(row.decision, FORMAT_DECISION.UNDECIDED);
    const snap = JSON.parse(row.config_snapshot);
    assert.equal(snap.rule, 'FALLBACK_NO_FORMAT_PROVEN');
    assert.deepEqual(snap.viable, { long: false, short: false });

    // Same provider selection as the no-decision baseline, and the item is not excluded for any provider.
    for (const p of Object.keys(legacy)) {
      assert.deepEqual(selectedBriefIds(selectEligiblePublications(storage, p)), legacy[p], p);
    }
    for (const p of ['youtube_shorts', 'tiktok', 'facebook_reels']) {
      assert.ok(selectedBriefIds(selectEligiblePublications(storage, p)).includes(item.contentBriefId), p);
    }

    // Idempotent: a second call records no second decision row.
    runFormatAwareShortForm({ storage, contentBriefId: item.contentBriefId, produceShortForm: () => ({ outcome: OUTCOME.ALREADY_RENDERED }) });
    assert.equal(storage.get(`SELECT COUNT(*) AS n FROM decision_log WHERE subject_id = ? AND decision LIKE 'FORMAT_%'`, [item.contentVersionId]).n, 1);
  } finally {
    cleanup(storage, dbPath);
  }
});

test('invalid long-form render_spec (unparseable) -> UNDECIDED with narration_duration + short_segment missing; never throws', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  try {
    const item = seedItem(storage, { verifiedClaims: 6, sources: 3 });
    seedCraftedLongFormArtifact(storage, item, { durationSeconds: 240 });
    storage.run('UPDATE media_artifacts SET render_spec_json = ? WHERE content_version_id = ?', ['{not json', item.contentVersionId]);

    const r = runFormatSelection({ storage, contentBriefId: item.contentBriefId });
    assert.equal(r.outcome, 'DECIDED');
    assert.equal(r.decision, FORMAT_DECISION.UNDECIDED);
    assert.ok(r.missingSignals.includes('narration_duration'));
    assert.ok(r.missingSignals.includes('short_segment'));
  } finally {
    cleanup(storage, dbPath);
  }
});

test('no long-form artifact yet: nothing recorded, production function reached with its own unchanged outcome', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  try {
    const item = seedItem(storage, { verifiedClaims: 6, sources: 3 });
    assert.equal(runFormatSelection({ storage, contentBriefId: item.contentBriefId }).outcome, 'NOT_YET_PRODUCED');
    assert.equal(decisionRows(storage, item.contentVersionId).length, 0);

    const out = runFormatAwareShortForm({
      storage, contentBriefId: item.contentBriefId,
      produceShortForm: () => ({ outcome: OUTCOME.NOT_YET_PRODUCED })
    });
    assert.equal(out.outcome, OUTCOME.NOT_YET_PRODUCED);
    assert.equal(decisionRows(storage, item.contentVersionId).length, 0);
  } finally {
    cleanup(storage, dbPath);
  }
});

test('legacy items with no FORMAT_* decision keep today\'s selection exactly (selectors unfiltered)', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  try {
    const item = seedItem(storage, { state: 'FINAL_COMPLIANCE', verifiedClaims: 6, sources: 3 });
    seedCraftedLongFormArtifact(storage, item, { durationSeconds: 240 });
    assert.deepEqual(selectedBriefIds(selectEligibleShortFormProductions(storage)), [item.contentBriefId]);
    for (const p of ['youtube', 'youtube_shorts', 'tiktok', 'facebook_reels']) {
      assert.deepEqual(selectedBriefIds(selectEligiblePublications(storage, p)), [item.contentBriefId], p);
    }
  } finally {
    cleanup(storage, dbPath);
  }
});

test('analytics: availability only. Enough SUCCESS snapshots for BOTH formats flips the context flag but never the decision', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  try {
    const item = seedItem(storage, { verifiedClaims: 6, sources: 3 });
    seedCraftedLongFormArtifact(storage, item, { durationSeconds: 240 });
    const before = runFormatSelection({ storage, contentBriefId: item.contentBriefId });
    assert.equal(before.decision, FORMAT_DECISION.BOTH);
    const beforeSnap = JSON.parse(getFormatDecision(storage, item.contentVersionId).config_snapshot);
    assert.equal(beforeSnap.context.analyticsSuccessSnapshots.longForm, 0);

    // A second item, after 10 SUCCESS snapshots per format have accumulated.
    for (const provider of ['youtube', 'youtube_shorts']) {
      for (let i = 0; i < 10; i++) {
        const host = seedItem(storage, { verifiedClaims: 0 });
        const mediaId = seedCraftedLongFormArtifact(storage, host, { durationSeconds: 30 });
        const pid = uuid();
        storage.run(
          `INSERT INTO publications (id, content_version_id, media_artifact_id, provider, status, request_json, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'PUBLISHED', '{}', ?, ?)`,
          [pid, host.contentVersionId, mediaId, provider, nowISO(), nowISO()]
        );
        storage.run(
          `INSERT INTO analytics_snapshots (id, publication_id, provider, provider_item_id, period_start, period_end, collected_at, status, result_json, created_at)
           VALUES (?, ?, ?, 'vid', '2026-10-01', '2026-10-07', ?, 'SUCCESS', '{}', ?)`,
          [uuid(), pid, provider, nowISO(), nowISO()]
        );
      }
    }
    const item2 = seedItem(storage, { verifiedClaims: 6, sources: 3 });
    seedCraftedLongFormArtifact(storage, item2, { durationSeconds: 240 });
    const after = runFormatSelection({ storage, contentBriefId: item2.contentBriefId });
    const snap = JSON.parse(getFormatDecision(storage, item2.contentVersionId).config_snapshot);
    assert.equal(snap.context.analyticsSuccessSnapshots.longForm, 10);
    assert.equal(snap.context.analyticsSuccessSnapshots.shortForm, 10);
    assert.equal(snap.context.historicalPerformance, 'AVAILABLE_NOT_CONSUMED_V1');
    assert.ok(!snap.missing_signals.includes('historical_performance'));
    assert.equal(after.decision, before.decision);
  } finally {
    cleanup(storage, dbPath);
  }
});

// ------------------------------------- real media: real ffmpeg + espeak-ng, real production code

function makeFixtureImage(dir, name, color) {
  const location = path.join(dir, name);
  execFileSync('ffmpeg', ['-f', 'lavfi', '-i', `color=c=${color}:s=64x64:d=1`, '-frames:v', '1', '-y', location], {
    stdio: ['ignore', 'pipe', 'pipe']
  });
  return location;
}

async function realRender(seedOpts, bodyWords) {
  const { storage, dbPath } = freshStorage();
  const productionDir = freshDir('fmt-e2e-production');
  const mediaDir = freshDir('fmt-e2e-media');
  const assetsDir = freshDir('fmt-e2e-assets');
  await storage.migrate();
  const sentence = 'The harbour authority reported that cargo volumes rose steadily during the autumn quarter. ';
  const body = sentence.repeat(bodyWords);
  const item = seedItem(storage, { ...seedOpts, state: 'PRODUCTION_READY', body });
  const repo = new AssetProvenanceRepository(storage);
  for (const [name, color] of [['a.png', 'blue'], ['b.png', 'red']]) {
    const assetId = repo.recordAsset({ assetType: 'image', location: makeFixtureImage(assetsDir, name, color), verificationStatus: 'VERIFIED' });
    repo.recordUsage({ assetId, contentVersionId: item.contentVersionId, usageContext: 'b-roll' });
  }
  runProduction({ storage, contentBriefId: item.contentBriefId, artifactsDir: productionDir });
  const longForm = runMediaProduction({ storage, contentBriefId: item.contentBriefId, artifactsDir: mediaDir });
  assert.equal(longForm.outcome, 'RENDERED', `long-form render: ${JSON.stringify(longForm)}`);
  return { storage, dbPath, dirs: [productionDir, mediaDir, assetsDir], mediaDir, item, longForm };
}

function probe(file) {
  const out = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_streams', file], { stdio: ['ignore', 'pipe', 'pipe'] }).toString());
  return out.streams.find((s) => s.codec_type === 'video');
}

test('REAL render, SHORT_FORM_ONLY: ~25s narration + thin evidence -> real 1080x1920 short produced, long-form artifact untouched', async () => {
  const r = await realRender({ verifiedClaims: 1, sources: 1 }, 5);
  try {
    const longBefore = r.storage.get('SELECT * FROM media_artifacts WHERE content_version_id = ?', [r.item.contentVersionId]);
    const out = runFormatAwareShortForm({
      storage: r.storage, contentBriefId: r.item.contentBriefId, artifactsDir: r.mediaDir, produceShortForm: runShortFormProduction
    });
    const why = getFormatDecision(r.storage, r.item.contentVersionId)?.reason;
    assert.equal(out.outcome, 'RENDERED', `${JSON.stringify(out)} :: ${why}`);
    assert.equal(getFormatDecision(r.storage, r.item.contentVersionId).decision, FORMAT_DECISION.SHORT_FORM_ONLY);
    const v = probe(out.mediaArtifact.artifact_path);
    assert.equal(v.width, 1080);
    assert.equal(v.height, 1920);
    const longAfter = r.storage.get('SELECT * FROM media_artifacts WHERE content_version_id = ?', [r.item.contentVersionId]);
    assert.deepEqual(longAfter, longBefore);
  } finally {
    cleanup(r.storage, r.dbPath, ...r.dirs);
  }
});

test('REAL render, neither format proven (narration < min, thin evidence): UNDECIDED fallback -> legacy short-form production is attempted, not skipped', async () => {
  const r = await realRender({ verifiedClaims: 0, sources: 0 }, 1);
  try {
    const out = runFormatAwareShortForm({
      storage: r.storage, contentBriefId: r.item.contentBriefId, artifactsDir: r.mediaDir, produceShortForm: runShortFormProduction
    });
    const row = getFormatDecision(r.storage, r.item.contentVersionId);
    assert.equal(row.decision, FORMAT_DECISION.UNDECIDED);
    assert.equal(JSON.parse(row.config_snapshot).rule, 'FALLBACK_NO_FORMAT_PROVEN');
    // The selector must not have suppressed the legacy short-form stage; whatever it
    // reports is its own, unchanged outcome.
    assert.notEqual(out.outcome, OUTCOME.SHORT_FORM_NOT_SELECTED);
    assert.equal(r.storage.get('SELECT COUNT(*) AS n FROM media_artifacts').n, 1);
  } finally {
    cleanup(r.storage, r.dbPath, ...r.dirs);
  }
});

test('REAL render, BOTH: >60s narration + 6 verified claims over 3 sources -> long-form kept AND a real <=60s 1080x1920 short derived from it', async () => {
  const r = await realRender({ verifiedClaims: 6, sources: 3 }, 16);
  try {
    const narration = JSON.parse(r.longForm.mediaArtifact.render_spec_json).narration.duration_seconds;
    assert.ok(narration > 60, `fixture narration must exceed the cap, got ${narration}s`);
    const out = runFormatAwareShortForm({
      storage: r.storage, contentBriefId: r.item.contentBriefId, artifactsDir: r.mediaDir, produceShortForm: runShortFormProduction
    });
    assert.equal(out.outcome, 'RENDERED', JSON.stringify(out));
    assert.equal(getFormatDecision(r.storage, r.item.contentVersionId).decision, FORMAT_DECISION.BOTH);
    const short = out.mediaArtifact;
    assert.equal(short.media_artifact_id, r.longForm.mediaArtifact.id);
    assert.ok(short.duration_seconds > 0 && short.duration_seconds <= 60);
    const v = probe(short.artifact_path);
    assert.equal(`${v.width}x${v.height}`, '1080x1920');
    const lv = probe(r.longForm.mediaArtifact.artifact_path);
    assert.equal(`${lv.width}x${lv.height}`, '1280x720');
  } finally {
    cleanup(r.storage, r.dbPath, ...r.dirs);
  }
});
