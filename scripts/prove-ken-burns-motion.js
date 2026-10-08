// Manual, opt-in, one-shot script. NOT part of `npm test`.
//
// Purpose: render ONE real, existing still image (e.g. a Pixabay asset you
// already acquired) through the REAL Media Production path with Ken Burns
// motion, then verify the artifact with ffprobe: container, codec, dimensions,
// duration, checksum, persisted media_artifacts row, motion descriptors in
// render_spec, and that the video is not static. Disposable DB/dirs under
// os.tmpdir(); no publication; rights status is seeded VERIFIED for the
// disposable DB only (this script proves the render, not rights).
//
// Usage: node scripts/prove-ken-burns-motion.js <path-to-image> [more images...]
// Needs real ffmpeg, ffprobe and espeak-ng. Exit: 0 proven, 1 failure, 2 prerequisite.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync, execFileSync } from 'node:child_process';
import { SqliteStorageDriver } from '../src/storage/SqliteStorageDriver.js';
import { runProduction } from '../src/production/pipeline.js';
import { runMediaProduction } from '../src/media/pipeline.js';
import { AssetProvenanceRepository } from '../src/state/AssetProvenance.js';
import { sha256File } from '../src/media/artifactStore.js';

const images = process.argv.slice(2);
const fail = (code, msg) => { console.error(msg); process.exit(code); };
if (images.length === 0 || images.some((p) => !fs.existsSync(p))) fail(2, 'usage: node scripts/prove-ken-burns-motion.js <image> [image...] (all must exist)');
for (const bin of ['ffmpeg', 'ffprobe', 'espeak-ng']) {
  if (spawnSync(bin, ['--version'], { stdio: 'ignore' }).error) fail(2, `missing prerequisite: ${bin}`);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ken-burns-proof-'));
const dbPath = path.join(tmp, 'proof.db');
const storage = new SqliteStorageDriver({ dbPath });
await storage.migrate();
const now = () => new Date().toISOString();
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`); if (!ok) process.exitCode = 1; };

try {
  const oppId = crypto.randomUUID(); const briefId = crypto.randomUUID(); const scriptId = crypto.randomUUID(); const cvId = crypto.randomUUID();
  storage.run(`INSERT INTO opportunities (id, title, source, discovered_at, status) VALUES (?, 'Ken Burns proof', 'rss', ?, 'DISCOVERED')`, [oppId, now()]);
  storage.run(`INSERT INTO content_briefs (id, opportunity_id, working_title, core_question, target_audience, viewer_promise, hook, angle, narrative_structure, key_claims, counterpoints, original_insights, visual_ideas, monetization_opportunities, risk_assessment, created_at) VALUES (?, ?, 'T', 'Q', 'A', 'P', 'H', 'Angle', 'S', '[]', 'C', 'I', 'V', 'M', 'R', ?)`, [briefId, oppId, now()]);
  storage.run(`INSERT INTO scripts (id, content_brief_id, version, body, claim_links, created_at) VALUES (?, ?, 1, ?, '[]', ?)`, [scriptId, briefId, 'This is a rehearsal narration to prove deterministic Ken Burns motion on a real image. Nothing here is published.', now()]);
  storage.run(`INSERT INTO content_versions (id, content_brief_id, script_id, state, created_at) VALUES (?, ?, ?, 'PRODUCTION_READY', ?)`, [cvId, briefId, scriptId, now()]);
  const repo = new AssetProvenanceRepository(storage);
  for (const location of images.map((p) => path.resolve(p))) {
    const assetId = repo.recordAsset({ assetType: 'image', location, checksum: sha256File(location), verificationStatus: 'VERIFIED' });
    repo.recordUsage({ assetId, contentVersionId: cvId, usageContext: 'b-roll' });
  }
  runProduction({ storage, contentBriefId: briefId, artifactsDir: path.join(tmp, 'production') });
  const res = runMediaProduction({ storage, contentBriefId: briefId, artifactsDir: path.join(tmp, 'media') });
  check('runMediaProduction outcome RENDERED', res.outcome === 'RENDERED', res.outcome + (res.reason ? `: ${res.reason}` : ''));
  if (res.outcome !== 'RENDERED') process.exit(1);

  const a = res.mediaArtifact;
  const row = storage.get('SELECT * FROM media_artifacts WHERE content_version_id = ?', [cvId]);
  const p = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', a.artifact_path]).toString());
  const v = p.streams.find((s) => s.codec_type === 'video'); const au = p.streams.find((s) => s.codec_type === 'audio');
  const spec = JSON.parse(a.render_spec_json);
  console.log(`container=${p.format.format_name} video=${v.codec_name} ${v.width}x${v.height} audio=${au?.codec_name} duration=${p.format.duration}s sha256=${a.artifact_checksum}`);
  check('existing artifact row is the one returned', row?.id === a.id);
  check('container mp4', /mp4/.test(p.format.format_name));
  check('h264 + aac', v.codec_name === 'h264' && au?.codec_name === 'aac');
  check('1280x720', v.width === 1280 && v.height === 720);
  check('duration matches narration', Math.abs(parseFloat(p.format.duration) - a.narration_duration_seconds) < 0.25, `${p.format.duration} vs ${a.narration_duration_seconds}`);
  check('checksum matches file bytes', sha256File(a.artifact_path) === a.artifact_checksum);
  check('motion recorded on every image segment', spec.visual_timing.every((s) => s.motion), spec.visual_timing.map((s) => s.motion?.mode).join(','));
  const f0 = path.join(tmp, 'f0.png'); const f1 = path.join(tmp, 'f1.png');
  execFileSync('ffmpeg', ['-y', '-ss', '0', '-i', a.artifact_path, '-frames:v', '1', f0], { stdio: 'ignore' });
  execFileSync('ffmpeg', ['-y', '-ss', String(Math.max(0, spec.visual_timing[0].duration_seconds - 0.2)), '-i', a.artifact_path, '-frames:v', '1', f1], { stdio: 'ignore' });
  check('video is not static (first vs late frame differ)', sha256File(f0) !== sha256File(f1));
  check('no publications created', storage.get('SELECT COUNT(*) AS n FROM publications').n === 0);
  console.log(process.exitCode ? 'RESULT: FAILED' : 'RESULT: PROVEN');
} finally {
  storage.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
