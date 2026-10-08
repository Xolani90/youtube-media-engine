// Manual, opt-in, one-shot script. NOT part of `npm test`.
//
// Purpose: prove background-music ducking on REAL audio through the REAL Media
// Production path, with objective measurements -- not a filter string.
//
//  1. Production-path render: real narration (the configured local TTS), a generated
//     (license-free, synthetic) music bed attached as a VERIFIED 'music' asset, real
//     motion/FFmpeg/FFprobe, persisted media_artifacts row. Inspects the MP4 and the
//     checksum, confirms music is in render_spec and that no publication exists.
//  2. Ducking measurement on the same narration and the same filter graph
//     (buildMusicMixFilter via muxNarration): the music's own contribution is isolated
//     by subtracting a narration-only render from the mix (lossless PCM, loudnorm off
//     so gains are comparable), then its RMS is compared inside real speech windows vs
//     real silent gaps, and against an identical mix with ducking disabled (ratio 1).
//
// Disposable DB/dirs under os.tmpdir(); no publication; rights status is seeded VERIFIED
// for the disposable DB only (this proves audio mixing, not rights).
//
// Usage: node scripts/prove-audio-ducking.js
// Needs real ffmpeg, ffprobe and espeak-ng. Exit: 0 proven, 1 failure, 2 prerequisite.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync, execFileSync } from 'node:child_process';
import { SqliteStorageDriver } from '../src/storage/SqliteStorageDriver.js';
import { runProduction } from '../src/production/pipeline.js';
import { runMediaProduction } from '../src/media/pipeline.js';
import { muxNarration } from '../src/media/render.js';
import { synthesizeNarration, probeDurationSeconds } from '../src/media/narration.js';
import { AssetProvenanceRepository } from '../src/state/AssetProvenance.js';
import { sha256File } from '../src/media/artifactStore.js';

const fail = (code, msg) => { console.error(msg); process.exit(code); };
for (const bin of ['ffmpeg', 'ffprobe', 'espeak-ng']) {
  if (spawnSync(bin, ['--version'], { stdio: 'ignore' }).error) fail(2, `missing prerequisite: ${bin}`);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'audio-ducking-proof-'));
const storage = new SqliteStorageDriver({ dbPath: path.join(tmp, 'proof.db') });
await storage.migrate();
const now = () => new Date().toISOString();
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`); if (!ok) process.exitCode = 1; };
const ffmpeg = (args) => execFileSync('ffmpeg', ['-v', 'error', '-y', ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
const probe = (f) => JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', f]).toString());
const db = (x) => (20 * Math.log10(Math.max(x, 1e-9))).toFixed(1);

function decode(file, rate = 16000) {
  const buf = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-vn', '-ac', '1', '-ar', String(rate), '-f', 'f32le', '-'], { maxBuffer: 1 << 28 });
  return new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 4));
}
const rms = (x, rate, a, b) => {
  const i0 = Math.floor(a * rate); const i1 = Math.min(x.length, Math.floor(b * rate));
  let s = 0; for (let i = i0; i < i1; i++) s += x[i] * x[i];
  return Math.sqrt(s / Math.max(1, i1 - i0));
};

try {
  // ---- generated music bed (synthetic, no third-party audio): a quiet looping chord with slow tremolo
  const musicPath = path.join(tmp, 'music-bed.wav');
  ffmpeg(['-f', 'lavfi', '-i', 'sine=f=220:d=12:sample_rate=44100', '-f', 'lavfi', '-i', 'sine=f=277.18:d=12:sample_rate=44100', '-f', 'lavfi', '-i', 'sine=f=329.63:d=12:sample_rate=44100',
    '-filter_complex', '[0][1][2]amix=inputs=3:normalize=0,tremolo=f=0.5:d=0.2,volume=3,aformat=channel_layouts=stereo', musicPath]);

  // ================= PART 1: real production path =================
  const oppId = crypto.randomUUID(); const briefId = crypto.randomUUID(); const scriptId = crypto.randomUUID(); const cvId = crypto.randomUUID();
  storage.run(`INSERT INTO opportunities (id, title, source, discovered_at, status) VALUES (?, 'Audio ducking proof', 'rss', ?, 'DISCOVERED')`, [oppId, now()]);
  storage.run(`INSERT INTO content_briefs (id, opportunity_id, working_title, core_question, target_audience, viewer_promise, hook, angle, narrative_structure, key_claims, counterpoints, original_insights, visual_ideas, monetization_opportunities, risk_assessment, created_at) VALUES (?, ?, 'T', 'Q', 'A', 'P', 'H', 'Angle', 'S', '[]', 'C', 'I', 'V', 'M', 'R', ?)`, [briefId, oppId, now()]);
  storage.run(`INSERT INTO scripts (id, content_brief_id, version, body, claim_links, created_at) VALUES (?, ?, 1, ?, '[]', ?)`, [scriptId, briefId, 'This is a rehearsal narration to prove that background music is lowered beneath the voice. The music should return between the sentences. Nothing here is published.', now()]);
  storage.run(`INSERT INTO content_versions (id, content_brief_id, script_id, state, created_at) VALUES (?, ?, ?, 'PRODUCTION_READY', ?)`, [cvId, briefId, scriptId, now()]);
  const repo = new AssetProvenanceRepository(storage);
  for (let i = 0; i < 2; i++) {
    const location = path.join(tmp, `img${i}.png`);
    ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=1:d=1', '-vf', `hue=h=${i * 90}`, '-frames:v', '1', location]);
    const assetId = repo.recordAsset({ assetType: 'image', location, checksum: sha256File(location), verificationStatus: 'VERIFIED' });
    repo.recordUsage({ assetId, contentVersionId: cvId, usageContext: 'b-roll' });
  }
  const musicAssetId = repo.recordAsset({ assetType: 'music', location: musicPath, checksum: sha256File(musicPath), origin: 'generated-for-proof', license: 'synthetic', verificationStatus: 'VERIFIED' });
  repo.recordUsage({ assetId: musicAssetId, contentVersionId: cvId, usageContext: 'background-music' });
  runProduction({ storage, contentBriefId: briefId, artifactsDir: path.join(tmp, 'production') });
  const res = runMediaProduction({ storage, contentBriefId: briefId, artifactsDir: path.join(tmp, 'media') });
  check('runMediaProduction outcome RENDERED', res.outcome === 'RENDERED', res.outcome + (res.reason ? `: ${res.reason}` : ''));
  if (res.outcome !== 'RENDERED') process.exit(1);

  const a = res.mediaArtifact;
  const row = storage.get('SELECT * FROM media_artifacts WHERE content_version_id = ?', [cvId]);
  const p = probe(a.artifact_path);
  const v = p.streams.find((s) => s.codec_type === 'video'); const au = p.streams.find((s) => s.codec_type === 'audio');
  const spec = JSON.parse(a.render_spec_json);
  console.log(`container=${p.format.format_name} video=${v.codec_name} ${v.width}x${v.height} audio=${au?.codec_name} ${au?.sample_rate}Hz ${au?.channels}ch duration=${p.format.duration}s sha256=${a.artifact_checksum}`);
  check('existing artifact row is the one returned', row?.id === a.id);
  check('container mp4', /mp4/.test(p.format.format_name));
  check('h264 video + aac audio', v.codec_name === 'h264' && au?.codec_name === 'aac');
  check('video stream valid (1280x720)', v.width === 1280 && v.height === 720);
  check('duration matches narration', Math.abs(parseFloat(p.format.duration) - a.narration_duration_seconds) < 0.25, `${p.format.duration} vs ${a.narration_duration_seconds}`);
  check('checksum matches file bytes', sha256File(a.artifact_path) === a.artifact_checksum);
  check('music recorded in render_spec (asset id + file sha256 + ducking params)', spec.music?.asset_id === musicAssetId && spec.music?.sha256 === sha256File(musicPath) && spec.music?.params?.ratio > 1);
  check('no publications created', storage.get('SELECT COUNT(*) AS n FROM publications').n === 0);

  // ================= PART 2: objective ducking measurement on real narration =================
  // Real narration with a deliberate 2 s pause between two real TTS passes, so recovery is observable.
  const n1 = path.join(tmp, 'n1.wav'); const n2 = path.join(tmp, 'n2.wav'); const narrationPath = path.join(tmp, 'narration-gap.wav');
  synthesizeNarration('Background music should sit quietly underneath this sentence, so the voice stays clear.', n1);
  synthesizeNarration('Now the voice returns, and the music steps back down again.', n2);
  ffmpeg(['-i', n1, '-f', 'lavfi', '-t', '2', '-i', 'anullsrc=r=22050:cl=mono', '-i', n2,
    '-filter_complex', '[0:a]aresample=22050,aformat=channel_layouts=mono[a];[1:a]aformat=sample_rates=22050:channel_layouts=mono[b];[2:a]aresample=22050,aformat=channel_layouts=mono[c];[a][b][c]concat=n=3:v=0:a=1', narrationPath]);
  const dur = probeDurationSeconds(narrationPath);
  const silentVideo = path.join(tmp, 'silent.mp4');
  ffmpeg(['-f', 'lavfi', '-i', `color=c=black:s=320x180:r=24:d=${dur}`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', silentVideo]);

  const render = (name, { music, params }) => {
    const out = path.join(tmp, `${name}.mov`);
    muxNarration({ silentVideoPath: silentVideo, narrationPath, audioEncoder: 'pcm_s16le', outputPath: out, normalizeLoudness: false, music: music ? { path: musicPath, narrationDurationSeconds: dur, params } : null });
    return decode(out);
  };
  const RATE = 16000;
  const mixDuck = render('mix-duck', { music: true });
  const mixFlat = render('mix-flat', { music: true, params: { ratio: 1 } });
  // Narration-only reference with the SAME channel/gain staging as the mix (amix halves each input).
  const refPath = path.join(tmp, 'ref.mov');
  ffmpeg(['-i', silentVideo, '-i', narrationPath, '-filter_complex', '[1:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,volume=0.5[o]', '-map', '0:v', '-map', '[o]', '-c:v', 'copy', '-c:a', 'pcm_s16le', '-shortest', refPath]);
  const ref = decode(refPath);
  const n = Math.min(mixDuck.length, mixFlat.length, ref.length);
  const musicDuck = new Float32Array(n); const musicFlat = new Float32Array(n);
  for (let i = 0; i < n; i++) { musicDuck[i] = mixDuck[i] - ref[i]; musicFlat[i] = mixFlat[i] - ref[i]; }

  // Speech activity from the real narration itself.
  const sd = spawnSync('ffmpeg', ['-v', 'info', '-i', narrationPath, '-af', 'silencedetect=n=-40dB:d=0.5', '-f', 'null', '-'], { encoding: 'utf8' }).stderr;
  const starts = [...sd.matchAll(/silence_start: ([\d.]+)/g)].map((m) => parseFloat(m[1]));
  const ends = [...sd.matchAll(/silence_end: ([\d.]+)/g)].map((m) => parseFloat(m[1]));
  const gaps = starts.map((s, i) => [s, ends[i] ?? dur]).filter(([s, e]) => e - s >= 1.5).sort((x, y) => (y[1] - y[0]) - (x[1] - x[0]));
  check('real narration contains a measurable silent gap (>= 1.5 s)', gaps.length > 0, gaps[0] ? `${gaps[0][0].toFixed(2)}-${gaps[0][1].toFixed(2)}s` : 'none');
  if (gaps.length === 0) process.exit(1);
  const [gs, ge] = gaps[0];
  const speechWin = [0.4, Math.max(0.6, gs - 0.15)]; // inside the first real utterance
  const gapWin = [gs + 1.0, ge - 0.1];               // after the 600 ms release has had time to recover
  const sp = (x) => rms(x, RATE, ...speechWin);
  const gp = (x) => rms(x, RATE, ...gapWin);
  const depthSpeech = 20 * Math.log10(sp(musicFlat) / Math.max(sp(musicDuck), 1e-9));
  const gapDelta = 20 * Math.log10(gp(musicDuck) / Math.max(gp(musicFlat), 1e-9));
  const recovery = 20 * Math.log10(gp(musicDuck) / Math.max(sp(musicDuck), 1e-9));
  console.log(`music contribution RMS  speech: ducked ${db(sp(musicDuck))} dBFS vs un-ducked ${db(sp(musicFlat))} dBFS | gap: ducked ${db(gp(musicDuck))} dBFS vs un-ducked ${db(gp(musicFlat))} dBFS`);
  console.log(`ducking depth under speech = ${depthSpeech.toFixed(1)} dB; recovery in gap vs speech = +${recovery.toFixed(1)} dB; gap level vs un-ducked = ${gapDelta.toFixed(1)} dB`);
  check('music is present in the mix (un-ducked music contribution is audible)', sp(musicFlat) > 1e-4 && gp(musicFlat) > 1e-4);
  check('ducking attenuates the music by >= 12 dB while the narration is speaking', depthSpeech >= 12, `${depthSpeech.toFixed(1)} dB`);
  check('music recovers in the narration gap (within 3 dB of un-ducked)', Math.abs(gapDelta) <= 3, `${gapDelta.toFixed(1)} dB`);
  check('music is >= 12 dB louder in the gap than under speech (same render)', recovery >= 12, `${recovery.toFixed(1)} dB`);
  const narSp = rms(ref, RATE, ...speechWin);
  check('narration is dominant during speech (voice >= 15 dB above the ducked music)', 20 * Math.log10(narSp / Math.max(sp(musicDuck), 1e-9)) >= 15, `${(20 * Math.log10(narSp / Math.max(sp(musicDuck), 1e-9))).toFixed(1)} dB`);

  // The shipped artifact itself carries the mix: its narration track was mono, so a stereo AAC stream can only come from the music path.
  check('shipped artifact audio is the stereo music mix (narration alone is mono)', au?.channels === 2 && Number(au?.sample_rate) === 48000, `${au?.channels}ch ${au?.sample_rate}Hz`);
  console.log(process.exitCode ? 'RESULT: FAILED' : 'RESULT: PROVEN');
} finally {
  storage.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
