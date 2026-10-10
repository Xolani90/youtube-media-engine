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
import { sha256File } from '../../src/media/artifactStore.js';
import { verifyQaReportBinding, QA_STATUS } from '../../src/media/qaWorker.js';
import { AssetProvenanceRepository } from '../../src/state/AssetProvenance.js';

// Final-video QA through the REAL Media Production path (actual narration + FFmpeg + FFprobe).
// Evidence-first: QA records a bound report and NEVER changes the media outcome.

const freshDir = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
const nowISO = () => new Date().toISOString();
const withEnv = (key, value, fn) => {
  const prev = process.env[key];
  if (value === undefined) delete process.env[key]; else process.env[key] = value;
  try { return fn(); } finally { if (prev === undefined) delete process.env[key]; else process.env[key] = prev; }
};

async function setup({ stillFilter = null, images = 2 } = {}) {
  const dbPath = path.join(os.tmpdir(), `qa-int-${Date.now()}-${Math.random()}.db`);
  const storage = new SqliteStorageDriver({ dbPath });
  await storage.migrate();
  const dirs = { production: freshDir('qa-prod'), media: freshDir('qa-media'), assets: freshDir('qa-assets') };
  const opportunityId = crypto.randomUUID();
  storage.run(`INSERT INTO opportunities (id, title, source, discovered_at, status) VALUES (?, 'Test opportunity', 'rss', ?, 'DISCOVERED')`, [opportunityId, nowISO()]);
  const contentBriefId = crypto.randomUUID();
  storage.run(
    `INSERT INTO content_briefs
      (id, opportunity_id, working_title, core_question, target_audience, viewer_promise,
       hook, angle, narrative_structure, key_claims, counterpoints, original_insights, visual_ideas,
       monetization_opportunities, risk_assessment, created_at)
     VALUES (?, ?, 'QA E2E Title', 'Q', 'A', 'A concise promise', 'H', 'Angle', 'Structure', '[]', 'C', 'I', 'V', 'M', 'R', ?)`,
    [contentBriefId, opportunityId, nowISO()]
  );
  const scriptId = crypto.randomUUID();
  storage.run(`INSERT INTO scripts (id, content_brief_id, version, body, claim_links, created_at) VALUES (?, ?, 1, ?, '[]', ?)`,
    [scriptId, contentBriefId, 'This is a short narration script for the QA test video. It has a second sentence too.', nowISO()]);
  const contentVersionId = crypto.randomUUID();
  storage.run(`INSERT INTO content_versions (id, content_brief_id, script_id, state, created_at) VALUES (?, ?, ?, 'PRODUCTION_READY', ?)`, [contentVersionId, contentBriefId, scriptId, nowISO()]);
  const repo = new AssetProvenanceRepository(storage);
  for (let i = 0; i < images; i++) {
    const location = path.join(dirs.assets, `img${i}.png`);
    const src = stillFilter ? ['-f', 'lavfi', '-i', `color=c=black:s=640x360:d=1`] : ['-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=1:d=1', '-vf', `hue=h=${i * 90}`];
    execFileSync('ffmpeg', [...src, '-frames:v', '1', '-y', location], { stdio: 'ignore' });
    const assetId = repo.recordAsset({ assetType: 'image', location, verificationStatus: 'VERIFIED' });
    repo.recordUsage({ assetId, contentVersionId, usageContext: 'b-roll' });
  }
  runProduction({ storage, contentBriefId, artifactsDir: dirs.production });
  return {
    storage, contentBriefId, contentVersionId, dirs,
    cleanup: () => {
      storage.close();
      for (const f of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) fs.rmSync(f, { force: true });
      for (const d of Object.values(dirs)) fs.rmSync(d, { recursive: true, force: true });
    }
  };
}

const qaRows = (ctx) => ctx.storage.all(`SELECT decision, reason FROM decision_log WHERE subject_id = ? AND decision LIKE 'MEDIA_QA_%'`, [ctx.contentVersionId]);

test('valid output continues through the production path; QA report is bound to the exact artifact checksum and referenced in decision_log', async () => {
  const ctx = await setup();
  const res = runMediaProduction({ storage: ctx.storage, contentBriefId: ctx.contentBriefId, artifactsDir: ctx.dirs.media });
  assert.equal(res.outcome, 'RENDERED', String(res.reason));
  const row = ctx.storage.get('SELECT * FROM media_artifacts WHERE content_version_id = ?', [ctx.contentVersionId]);
  assert.equal(sha256File(row.artifact_path), row.artifact_checksum);

  const reportPath = path.join(path.dirname(row.artifact_path), 'media-qa.json');
  assert.ok(fs.existsSync(reportPath), 'QA report written beside the artifact');
  const binding = verifyQaReportBinding({ reportPath, artifactPath: row.artifact_path });
  assert.equal(binding.bound, true);
  assert.equal(binding.artifactChecksum, row.artifact_checksum);

  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  assert.equal(report.mode, 'DIAGNOSTIC');
  assert.equal(report.status, QA_STATUS.COMPLETE, JSON.stringify(report.unavailable));
  assert.ok(report.findings.every((f) => f.enforced === false));
  assert.equal(report.context.kenBurnsMotion, true);
  // Calibration: the real narration + loudnorm + AAC output measures about -1.0..-0.9 dBTP, which must not be flagged (warn line is -0.5).
  assert.ok(!report.findings.some((f) => f.check === 'true_peak_overshoot'), JSON.stringify(report.loudness));

  const logged = qaRows(ctx);
  assert.equal(logged.length, 1);
  assert.equal(logged[0].decision, 'MEDIA_QA_RECORDED');
  assert.ok(logged[0].reason.includes(`artifact_${row.artifact_checksum}`));
  assert.ok(logged[0].reason.includes(`report_${binding.reportChecksum}`));
  // A report cannot be re-attached to a different file undetected.
  const other = path.join(ctx.dirs.media, 'other.mp4');
  fs.copyFileSync(row.artifact_path, other); fs.appendFileSync(other, Buffer.from([0]));
  assert.equal(verifyQaReportBinding({ reportPath, artifactPath: other }).reason, 'ARTIFACT_CHECKSUM_MISMATCH');
  ctx.cleanup();
});

test('diagnostic only: a structurally valid but QA-defective render (all-black stills) is STILL RENDERED, with the defect recorded and no retry/quarantine side effects', async () => {
  const ctx = await setup({ stillFilter: 'black' });
  const retryBefore = ctx.storage.get(`SELECT COUNT(*) AS n FROM stage_retry_state`).n;
  const res = runMediaProduction({ storage: ctx.storage, contentBriefId: ctx.contentBriefId, artifactsDir: ctx.dirs.media });
  assert.equal(res.outcome, 'RENDERED', `new QA findings must not reject a render: ${res.reason}`);
  const row = ctx.storage.get('SELECT * FROM media_artifacts WHERE content_version_id = ?', [ctx.contentVersionId]);
  assert.ok(row, 'artifact row persisted');
  const report = JSON.parse(fs.readFileSync(path.join(path.dirname(row.artifact_path), 'media-qa.json'), 'utf8'));
  const black = report.findings.find((f) => f.check === 'black_video');
  assert.ok(black, `black video must be recorded: ${JSON.stringify(report.findings)}`);
  assert.equal(black.severity, 'FAIL_CANDIDATE');
  assert.equal(black.enforced, false);
  assert.equal(ctx.storage.get(`SELECT COUNT(*) AS n FROM stage_retry_state`).n, retryBefore);
  assert.equal(ctx.storage.all(`SELECT 1 FROM decision_log WHERE subject_id = ? AND decision = 'VALIDATION_FAILED'`, [ctx.contentVersionId]).length, 0);
  ctx.cleanup();
});

test('MEDIA_QA=off writes no report and no decision_log row; the render outcome is unchanged', async () => {
  const ctx = await setup();
  const res = withEnv('MEDIA_QA', 'off', () => runMediaProduction({ storage: ctx.storage, contentBriefId: ctx.contentBriefId, artifactsDir: ctx.dirs.media }));
  assert.equal(res.outcome, 'RENDERED', String(res.reason));
  assert.equal(fs.existsSync(path.join(ctx.dirs.media, ctx.contentVersionId, 'media-qa.json')), false);
  assert.equal(qaRows(ctx).length, 0);
  ctx.cleanup();
});

test('short-form derivative records its own bound QA report', async () => {
  const ctx = await setup();
  assert.equal(runMediaProduction({ storage: ctx.storage, contentBriefId: ctx.contentBriefId, artifactsDir: ctx.dirs.media }).outcome, 'RENDERED');
  const short = runShortFormProduction({ storage: ctx.storage, contentBriefId: ctx.contentBriefId, artifactsDir: ctx.dirs.media });
  assert.equal(short.outcome, 'RENDERED');
  const reportPath = path.join(path.dirname(short.mediaArtifact.artifact_path), 'media-qa-short.json');
  const binding = verifyQaReportBinding({ reportPath, artifactPath: short.mediaArtifact.artifact_path });
  assert.equal(binding.bound, true);
  assert.equal(binding.artifactChecksum, short.mediaArtifact.artifact_checksum);
  assert.equal(JSON.parse(fs.readFileSync(reportPath, 'utf8')).context.stage, 'short_form');
  ctx.cleanup();
});