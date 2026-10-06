#!/usr/bin/env node
// Manual, opt-in, DISPOSABLE proof of the real YouTube publication boundary.
//
//   real rendered MP4 -> Publication pipeline (Gate 2 + D-C2) -> YouTubeAdapter
//   -> provider-confirmed video id
//
// Never part of `npm test`, never invoked by application startup.
//
// Two modes:
//
//   PREFLIGHT (default)  No external request of any kind. Validates the MP4,
//                        credentials presence, seeds a temp DB, passes the REAL
//                        Gate 2, builds the publication request and runs the
//                        pipeline in SIMULATION so it stops at D-C2 with
//                        AUTHORIZATION_DENIED. The adapter is never reachable.
//
//   LIVE                 Only when AUTHORIZE_LIVE_YOUTUBE_PUBLISH=true (exact).
//                        Performs exactly ONE runPublication() call, forced
//                        private, never a second video upload.
//
// Required env (names only are ever printed, never values):
//   PROOF_MP4_PATH            previously rendered MP4 (Media Production proof)
//   YOUTUBE_CLIENT_ID / YOUTUBE_CLIENT_SECRET / YOUTUBE_REFRESH_TOKEN
// Optional env:
//   AUTHORIZE_LIVE_YOUTUBE_PUBLISH=true   enable the single live upload
//   PROOF_TITLE                           working title (default below)
//   INCLUDE_THUMBNAIL=true                allow the pipeline's follow-on
//                                         thumbnail upload (default: skipped)
//
// Authorization: the Owner file config/authorized_external_actions.json is
// NEVER read for this proof nor written. In LIVE mode a temp file holding the
// single per-item entry `publish:youtube:<contentVersionId>` is substituted
// in-process through config.authorizedExternalActionsPath (the same mechanism
// the e2e tests use). A per-item grant supplies no visibility, so the adapter's
// private default applies; this harness additionally forces `private`.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { SqliteStorageDriver } from '../src/storage/SqliteStorageDriver.js';
import { runProduction } from '../src/production/pipeline.js';
import { runPublication } from '../src/publication/pipeline.js';
import { buildPublicationRequest } from '../src/publication/PublicationRequest.js';
import { YouTubeAdapter } from '../src/publication/youtube/YouTubeAdapter.js';
import { AssetProvenanceRepository } from '../src/state/AssetProvenance.js';
import { sha256File } from '../src/media/artifactStore.js';
import { config } from '../src/config/index.js';
import { passGate2, recordVerification } from '../tests/helpers/gate2.js';

const LIVE = process.env.AUTHORIZE_LIVE_YOUTUBE_PUBLISH === 'true';
const INCLUDE_THUMBNAIL = process.env.INCLUDE_THUMBNAIL === 'true';
const TITLE = process.env.PROOF_TITLE || 'Publication boundary proof (private)';
const REQUIRED_CREDS = ['YOUTUBE_CLIENT_ID', 'YOUTUBE_CLIENT_SECRET', 'YOUTUBE_REFRESH_TOKEN'];
const nowISO = () => new Date().toISOString();
// Best-effort cleanup: close the DB first (Windows cannot delete an open file)
// and never let a cleanup error hide or replace the report.
function cleanupWorkspace(storage, dir) {
  try { storage.close(); } catch { /* already closed */ }
  try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch (err) { console.error(`cleanup warning (non-fatal): ${err.code ?? err.message}; remove manually: ${dir}`); }
}

const report = { mode: LIVE ? 'LIVE' : 'PREFLIGHT', checks: {} };
function check(name, ok, detail) {
  report.checks[name] = ok ? 'ok' : `FAIL${detail ? `: ${detail}` : ''}`;
  if (!ok) return false;
  return true;
}
function fail(code, msg) {
  console.error(JSON.stringify({ ...report, stoppedBefore: 'any external request', exit: code, reason: msg }, null, 2));
  process.exit(code);
}

// ---- 1. Credentials: presence only, values never printed. -----------------
const missing = REQUIRED_CREDS.filter((k) => !process.env[k]);
check('credentials_present', missing.length === 0, `missing: ${missing.join(', ')}`);
if (missing.length) fail(3, `missing credential env vars: ${missing.join(', ')}`);

// ---- 2. Media: real, existing, probed. ------------------------------------
const mp4 = process.env.PROOF_MP4_PATH;
if (!mp4) fail(3, 'PROOF_MP4_PATH is required (a previously rendered MP4 from the Media Production proof).');
if (!check('mp4_exists', fs.existsSync(mp4))) fail(3, 'PROOF_MP4_PATH does not exist');
const size = fs.statSync(mp4).size;
if (!check('mp4_size_gt_0', size > 0)) fail(3, 'MP4 is empty');
const sourceSha = sha256File(mp4);
report.media = { sizeBytes: size, sha256: sourceSha };
let probe;
try {
  probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', mp4], { encoding: 'utf8' }));
} catch (err) {
  check('ffprobe_ok', false, err.message.split('\n')[0]);
  fail(3, 'ffprobe failed');
}
check('ffprobe_ok', true);
const v = probe.streams.find((s) => s.codec_type === 'video');
const a = probe.streams.find((s) => s.codec_type === 'audio');
if (!check('video_stream', !!v) || !check('audio_stream', !!a)) fail(3, 'MP4 needs both a video and an audio stream');
const duration = Number(probe.format.duration);
report.media.durationSeconds = duration;
report.media.video = `${v.codec_name} ${v.width}x${v.height}`;
report.media.audio = a.codec_name;

// ---- 3. Disposable workspace + DB. ----------------------------------------
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ame-yt-proof-'));
const dbPath = path.join(work, 'proof.db');
const storage = new SqliteStorageDriver({ dbPath });
await storage.migrate();
report.workspace = work; // kept on any non-success so an AMBIGUOUS run can be reconciled

// Seed ONLY the minimum downstream state. Never a publications row.
const opportunityId = crypto.randomUUID();
storage.run(`INSERT INTO opportunities (id, title, source, discovered_at, status) VALUES (?, 'Publication proof', 'manual', ?, 'DISCOVERED')`, [opportunityId, nowISO()]);
const contentBriefId = crypto.randomUUID();
storage.run(
  `INSERT INTO content_briefs (id, opportunity_id, working_title, core_question, target_audience, viewer_promise, hook, angle, narrative_structure, key_claims, counterpoints, original_insights, visual_ideas, monetization_opportunities, risk_assessment, created_at)
   VALUES (?, ?, ?, 'Q', 'A', 'Private boundary-proof upload; safe to delete.', 'H', 'Angle', 'Structure', '[]', 'C', 'I', 'V', 'M', 'R', ?)`,
  [contentBriefId, opportunityId, TITLE, nowISO()]
);
const scriptId = crypto.randomUUID();
storage.run(`INSERT INTO scripts (id, content_brief_id, version, body, claim_links, created_at) VALUES (?, ?, 1, 'Private publication boundary proof.', '[]', ?)`, [scriptId, contentBriefId, nowISO()]);
const contentVersionId = crypto.randomUUID();
storage.run(`INSERT INTO content_versions (id, content_brief_id, script_id, state, created_at) VALUES (?, ?, ?, 'PRODUCTION_READY', ?)`, [contentVersionId, contentBriefId, scriptId, nowISO()]);

// One visual asset extracted locally from the MP4 so the real Production stage
// has an input. Its VERIFIED record is seeded provenance (see report note).
const frame = path.join(work, 'frame.png');
execFileSync('ffmpeg', ['-v', 'error', '-i', mp4, '-frames:v', '1', '-y', frame]);
const assetRepo = new AssetProvenanceRepository(storage);
const assetId = assetRepo.recordAsset({ assetType: 'image', location: frame, verificationStatus: 'VERIFIED' });
assetRepo.recordUsage({ assetId, contentVersionId, usageContext: 'b-roll' });

const production = runProduction({ storage, contentBriefId, artifactsDir: path.join(work, 'production') });
if (!check('production_PRODUCED', production.outcome === 'PRODUCED', production.outcome)) fail(4, `runProduction -> ${production.outcome}`);

// Attach the EXISTING render (copied, so the original is never touched and the
// thumbnail lands in the temp dir). No re-render.
const mediaDir = path.join(work, 'media', contentVersionId);
fs.mkdirSync(mediaDir, { recursive: true });
const artifactPath = path.join(mediaDir, 'video.mp4');
fs.copyFileSync(mp4, artifactPath);
if (!check('copy_sha_matches', sha256File(artifactPath) === sourceSha)) fail(4, 'copied MP4 checksum differs');
const prod = storage.get('SELECT id FROM productions WHERE content_version_id = ?', [contentVersionId]);
const renderSpec = JSON.stringify({ attachedExistingRender: true, sourceSha256: sourceSha });
storage.run(
  `INSERT INTO media_artifacts (id, production_id, content_version_id, render_spec_json, render_spec_checksum, narration_path, narration_duration_seconds, artifact_path, artifact_checksum, duration_seconds, width, height, video_codec, audio_codec, created_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  [crypto.randomUUID(), prod.id, contentVersionId, renderSpec, crypto.createHash('sha256').update(renderSpec).digest('hex'),
    artifactPath, duration, artifactPath, sourceSha, duration, v.width, v.height, v.codec_name, a.codec_name, nowISO()]
);

// ---- 4. REAL Gate 2 (the repository's own evaluator; never bypassed). -------
recordVerification(storage, assetId, 'VERIFIED');
let gate2;
try {
  gate2 = passGate2(storage, contentVersionId);
} catch (err) {
  check('gate2_PASS', false, err.message.slice(0, 200));
  fail(4, 'Gate 2 did not pass');
}
check('gate2_PASS', true);
const cvState = storage.get('SELECT state FROM content_versions WHERE id = ?', [contentVersionId]).state;
check('state_FINAL_COMPLIANCE', cvState === 'FINAL_COMPLIANCE', cvState);

// ---- 5. Request construction + visibility assertion. ------------------------
const cv = storage.get('SELECT * FROM content_versions WHERE id = ?', [contentVersionId]);
const brief = storage.get('SELECT * FROM content_briefs WHERE id = ?', [contentBriefId]);
const script = storage.get('SELECT * FROM scripts WHERE id = ?', [scriptId]);
const mediaArtifact = storage.get('SELECT * FROM media_artifacts WHERE content_version_id = ?', [contentVersionId]);
const previewRequest = buildPublicationRequest({ contentVersion: cv, script, contentBrief: brief, mediaArtifact, requestedVisibility: null });
const previewMetadata = new YouTubeAdapter({ defaultPrivacyStatus: 'private' })._buildMetadata({ ...previewRequest, requestedVisibility: 'private' }, 'private');
check('metadata_privacyStatus_private', previewMetadata?.status?.privacyStatus === 'private', String(previewMetadata?.status?.privacyStatus));
if (previewMetadata?.status?.privacyStatus !== 'private') fail(4, 'adapter metadata is not private');

// Wrapper: the only thing the pipeline can call. Forces private, refuses any
// other visibility, counts calls, and refuses a second one. publishThumbnail is
// exposed only on explicit opt-in.
let publishCalls = 0;
const real = new YouTubeAdapter({ defaultPrivacyStatus: 'private' });
const guardedAdapter = {
  get id() { return 'youtube'; },
  async publish(request, context) {
    if (!LIVE) throw new Error('PREFLIGHT: adapter.publish must never be reached');
    publishCalls += 1;
    if (publishCalls > 1) throw new Error('refusing a second video upload');
    if (request.requestedVisibility === 'public' || request.requestedVisibility === 'unlisted') {
      throw new Error(`refusing non-private request visibility: ${request.requestedVisibility}`);
    }
    const forced = { ...request, requestedVisibility: 'private' };
    if (forced.requestedVisibility !== 'private') throw new Error('visibility assertion failed');
    return real.publish(forced, context);
  }
};
if (INCLUDE_THUMBNAIL) guardedAdapter.publishThumbnail = (args) => real.publishThumbnail(args);

// ---- 6. Run the pipeline. ---------------------------------------------------
const origCfg = { p: config.authorizedExternalActionsPath, m: config.runMode, a: config.autonomousEnabled };
let authDir = null;
if (LIVE) {
  authDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ame-yt-auth-'));
  const authFile = path.join(authDir, 'authorized.json');
  fs.writeFileSync(authFile, JSON.stringify([`publish:youtube:${contentVersionId}`]));
  config.authorizedExternalActionsPath = authFile;
  config.runMode = 'LIVE';
  config.autonomousEnabled = true;
} else {
  config.runMode = 'SIMULATION'; // preflight can never authorize, whatever the shell says
}

let result;
try {
  result = await runPublication({ storage, contentBriefId, provider: 'youtube', adapter: guardedAdapter, mode: LIVE ? 'LIVE' : 'SIMULATION' });
} finally {
  Object.assign(config, { authorizedExternalActionsPath: origCfg.p, runMode: origCfg.m, autonomousEnabled: origCfg.a });
  if (authDir) fs.rmSync(authDir, { recursive: true, force: true });
}

// ---- 7. Report (selected fields only; no tokens, no session URL). ----------
const pub = storage.get('SELECT * FROM publications WHERE content_version_id = ?', [contentVersionId]);
const decisions = storage.all?.(`SELECT decision FROM decision_log WHERE subject_id = ? ORDER BY created_at`, [contentVersionId])?.map((d) => d.decision);
report.outcome = result.outcome;
report.reason = result.reason ?? null;
report.adapterPublishCalls = publishCalls;
report.decisions = decisions;
if (!LIVE) {
  const ok = result.outcome === 'AUTHORIZATION_DENIED' && publishCalls === 0 && !pub;
  check('preflight_stopped_at_D-C2', ok, `${result.outcome}, calls=${publishCalls}, publicationRow=${!!pub}`);
  report.verdict = ok ? 'PREFLIGHT OK — no external request was made' : 'PREFLIGHT UNEXPECTED';
  report.workspace = '(deleted)';
  console.log(JSON.stringify(report, null, 2));
  cleanupWorkspace(storage, work);
  process.exit(ok ? 0 : 5);
}

let confirmed = null;
try { confirmed = JSON.parse(pub?.result_json ?? 'null')?.confirmedVisibility ?? null; } catch { /* leave null */ }
report.publication = pub && {
  id: pub.id, status: pub.status, providerItemId: pub.provider_item_id, providerUrl: pub.provider_url,
  failureReason: pub.failure_reason, attemptCount: pub.attempt_count, hasPersistedSession: !!pub.provider_state_json
};
report.visibility = { requested: 'private', providerConfirmed: confirmed };
report.thumbnail = {
  generatedLocally: !!storage.get('SELECT thumbnail_path FROM media_artifacts WHERE content_version_id = ?', [contentVersionId])?.thumbnail_path,
  uploadAttempted: INCLUDE_THUMBNAIL, status: pub?.thumbnail_status ?? null
};
report.verdict =
  result.outcome === 'PUBLISHED' && pub?.provider_item_id ? 'LIVE SUCCESS'
    : result.outcome === 'AMBIGUOUS' ? 'AMBIGUOUS — requires reconciliation (workspace kept; do NOT re-run)'
      : `ATTEMPTED — ${result.outcome}`;
console.log(JSON.stringify(report, null, 2));
if (result.outcome === 'PUBLISHED') cleanupWorkspace(storage, work);
else { try { storage.close(); } catch { /* keep workspace for reconciliation */ } }
process.exit(result.outcome === 'PUBLISHED' ? 0 : 6);
