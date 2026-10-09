// Manual, opt-in, one-shot script. NOT part of `npm test`.
//
// Purpose: reproducible calibration evidence for the DIAGNOSTIC final-video QA
// worker (src/media/qaWorker.js). It generates real media on THIS machine, runs
// the real worker, and prints: FFmpeg/FFprobe versions, the exact analysis
// filters, each input's characteristics, measured results and MEASURED runtime.
// It activates nothing and changes no repository state; output goes to
// os.tmpdir() (and an optional JSON file).
//
// Inputs:
//   * legitimate: textured dark stills through the REAL renderMotionClip (every
//     motion plan) then the REAL muxNarration (loudnorm included) with REAL
//     narration from synthesizeNarration() when an engine is installed.
//   * defects: black, frozen, silent, near-silent, over-loud, A/V mismatch,
//     truncated and corrupted files.
//   * limitation case: near-uniform dark still + motion (indistinguishable from a freeze).
//
// If no narration engine works here, narration is reported as UNAVAILABLE and a
// clearly-labelled SYNTHETIC tone is used instead -- that run does NOT calibrate
// speech loudness, and the script says so.
//
// Usage: node scripts/prove-media-qa.js [--json <out.json>] [--seconds <N>]
// Run it on EACH FFmpeg build you intend to support (Windows, WSL/Ubuntu, CI) and compare.
// Exit: 0 all expectations met, 1 an expectation failed, 2 prerequisite missing.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { analyzeMediaQa, QA_THRESHOLDS } from '../src/media/qaWorker.js';
import { renderMotionClip, planMotion } from '../src/media/motion.js';
import { muxNarration } from '../src/media/render.js';
import { synthesizeNarration, probeDurationSeconds } from '../src/media/narration.js';

const args = process.argv.slice(2);
const opt = (name, dflt = null) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dflt; };
const SECONDS = Number(opt('--seconds', 10));
const JSON_OUT = opt('--json');
const fail = (code, msg) => { console.error(msg); process.exit(code); };
for (const bin of ['ffmpeg', 'ffprobe']) if (spawnSync(bin, ['-version'], { stdio: 'ignore' }).error) fail(2, `missing prerequisite: ${bin}`);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'media-qa-proof-'));
const ff = (a) => execFileSync('ffmpeg', ['-v', 'error', '-y', ...a], { stdio: ['ignore', 'pipe', 'pipe'] });
const enc = ['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-ar', '48000'];
const tone = (d, vol) => ['-f', 'lavfi', '-i', `sine=frequency=220:duration=${d}:sample_rate=48000,volume=${vol}`];
const rows = []; let expectationsFailed = 0;

function record(name, file, { expectFindings = [], forbidFindings = [], forbidSeverity = null, kind }) {
  const t = process.hrtime.bigint();
  const r = analyzeMediaQa(file, { context: { kenBurnsMotion: true } });
  const wall = Number(process.hrtime.bigint() - t) / 1e6;
  const found = r.findings.map((f) => f.check);
  const ok = expectFindings.every((c) => found.includes(c))
    && forbidFindings.every((c) => !found.includes(c))
    && (!forbidSeverity || r.findings.every((f) => f.severity !== forbidSeverity));
  if (!ok) expectationsFailed++;
  const dur = r.streams.video?.duration_seconds ?? null;
  rows.push({
    case: name, kind, ok: ok ? 'PASS' : 'FAIL', status: r.status, media_s: dur, qa_wall_ms: Math.round(wall),
    realtime_x: dur ? Number((dur / (wall / 1000)).toFixed(1)) : null,
    I_lufs: r.loudness.integrated_lufs, TP_dbfs: r.loudness.true_peak_dbfs, av_diff_s: r.av_duration_discrepancy_seconds,
    black_s: r.black.black_seconds, frozen_s: r.freeze.frozen_seconds, silent_ratio: r.silence.ratio,
    decode_err_lines: r.decode.error_line_count, findings: found.join(',') || '-', unavailable: r.unavailable.map((u) => `${u.check}:${u.reason}`).join(',') || '-'
  });
  return r;
}

// ---------- tools ----------
const first = (cmd) => (spawnSync(cmd, ['-version'], { encoding: 'utf8' }).stdout ?? '').split('\n')[0];
console.log(`platform: ${process.platform} ${os.release()} | node ${process.version}`);
console.log(first('ffmpeg')); console.log(first('ffprobe'));

// ---------- narration (real if available) ----------
let narrationPath = path.join(tmp, 'narration.wav'); let narrationReal = false; let narrationProvider = null; let narrationNote;
const NARRATION_TEXT = 'Octopuses have three hearts. Two pump blood through the gills, and one pumps it around the rest of the body. When the animal swims, the heart that serves the body actually stops beating, which is one reason octopuses prefer to crawl.';
try {
  const r = synthesizeNarration(NARRATION_TEXT, narrationPath);
  narrationProvider = r.provider; narrationReal = true; narrationNote = `real narration via ${r.provider}`;
} catch (err) {
  narrationNote = `UNAVAILABLE (${String(err.message).split('\n')[0].slice(0, 160)}); using a SYNTHETIC tone -- speech loudness is NOT calibrated by this run`;
  ff([...tone(SECONDS, 1), '-f', 'wav', narrationPath]);
}
const narrationSeconds = probeDurationSeconds(narrationPath);
console.log(`narration: ${narrationNote}; ${narrationSeconds.toFixed(2)} s`);

// ---------- legitimate inputs ----------
const STILLS = {
  'dark-textured': ['-f', 'lavfi', '-i', 'testsrc2=s=1280x720:r=1:d=1', '-vf', 'eq=brightness=-0.45'],
  'dark-gradient-noise': ['-f', 'lavfi', '-i', 'gradients=s=1280x720:d=1:n=2:seed=7', '-vf', 'eq=brightness=-0.35,noise=alls=12:allf=t'],
  'mid-tone': ['-f', 'lavfi', '-i', 'testsrc2=s=1280x720:r=1:d=1']
};
for (const [name, a] of Object.entries(STILLS)) {
  const still = path.join(tmp, `${name}.png`); ff([...a, '-frames:v', '1', still]);
  for (let i = 0; i < 6; i++) {
    const motion = planMotion({ assetId: `asset-${i}`, segmentIndex: i });
    const clip = path.join(tmp, `${name}-${i}.mp4`);
    renderMotionClip({ imagePath: still, outputPath: clip, motion, width: 1280, height: 720, fps: 24, durationSeconds: Math.ceil(narrationSeconds) + 1 });
    const out = path.join(tmp, `${name}-${i}-final.mp4`);
    muxNarration({ silentVideoPath: clip, narrationPath, audioEncoder: 'aac', outputPath: out });
    record(`legit ${name} / ${motion.mode} #${i}${narrationReal ? '' : ' (synthetic audio)'}`, out, { kind: 'legitimate', forbidFindings: ['frozen_video', 'frozen_segment', 'black_video', 'black_segment', 'decode_errors'], forbidSeverity: 'FAIL_CANDIDATE' });
  }
}
{ // documented limitation
  const still = path.join(tmp, 'uniform-dark.png');
  ff(['-f', 'lavfi', '-i', 'color=c=0x0a0a14:s=1280x720:d=1', '-vf', 'noise=alls=3:allf=t', '-frames:v', '1', still]);
  const clip = path.join(tmp, 'uniform-dark.mp4');
  renderMotionClip({ imagePath: still, outputPath: clip, motion: planMotion({ assetId: 'asset-0', segmentIndex: 0 }), width: 1280, height: 720, fps: 24, durationSeconds: Math.ceil(narrationSeconds) + 1 });
  const out = path.join(tmp, 'uniform-dark-final.mp4'); muxNarration({ silentVideoPath: clip, narrationPath, audioEncoder: 'aac', outputPath: out });
  record('LIMITATION near-uniform dark still + motion (freeze is WARN-only, never FAIL_CANDIDATE)', out, { kind: 'limitation', forbidSeverity: 'FAIL_CANDIDATE', forbidFindings: ['black_video'] });
}

// ---------- defects ----------
const D = SECONDS;
const mk = (name, inputs, extra = []) => { const f = path.join(tmp, name); ff([...inputs, ...enc, ...extra, f]); return f; };
const moving = (d) => ['-f', 'lavfi', '-i', `testsrc2=s=640x360:r=24:d=${d}`];
const colour = (c, d) => ['-f', 'lavfi', '-i', `color=c=${c}:s=640x360:r=24:d=${d}`];
record('defect black video', mk('d-black.mp4', [...colour('black', D), ...tone(D, 2)]), { kind: 'defect', expectFindings: ['black_video'] });
record('defect frozen video', mk('d-frozen.mp4', [...colour('0x336699', D), ...tone(D, 2)]), { kind: 'defect', expectFindings: ['frozen_video'] });
record('defect silent audio', mk('d-silent.mp4', [...moving(D), '-f', 'lavfi', '-i', `anullsrc=r=48000:cl=mono:d=${D}`]), { kind: 'defect', expectFindings: ['effectively_silent_audio'] });
record('defect near-silent audio', mk('d-nearsilent.mp4', [...moving(D), ...tone(D, 0.0005)]), { kind: 'defect', expectFindings: ['effectively_silent_audio'] });
record('defect over-loud audio', mk('d-loud.mp4', [...moving(D), ...tone(D, 8)], ['-af', 'alimiter=limit=1:level=disabled']), { kind: 'defect', expectFindings: ['loudness_deviation'] });
record('defect A/V duration mismatch', mk('d-mismatch.mp4', [...moving(D), ...tone(Math.max(2, D / 2), 2)]), { kind: 'defect', expectFindings: ['av_duration_mismatch'] });
const good = mk('d-good.mp4', [...moving(D), ...tone(D, 2)], ['-movflags', '+faststart']);
const bytes = fs.readFileSync(good);
fs.writeFileSync(path.join(tmp, 'd-trunc.mp4'), bytes.subarray(0, Math.floor(bytes.length * 0.45)));
const bad = Buffer.from(bytes); for (let i = Math.floor(bad.length * 0.4); i < Math.floor(bad.length * 0.6); i += 7) bad[i] ^= 0xff;
fs.writeFileSync(path.join(tmp, 'd-corrupt.mp4'), bad);
for (const [n, label] of [['d-trunc.mp4', 'defect truncated (45% of bytes)'], ['d-corrupt.mp4', 'defect corrupted bytes']]) {
  const r = analyzeMediaQa(path.join(tmp, n));
  const detected = r.findings.some((f) => f.check === 'decode_errors') || r.unavailable.length > 0;
  if (!detected || r.clean) expectationsFailed++;
  rows.push({ case: label, kind: 'defect', ok: detected && !r.clean ? 'PASS' : 'FAIL', status: r.status, decode_err_lines: r.decode.error_line_count, findings: r.findings.map((f) => f.check).join(',') || '-', unavailable: r.unavailable.map((u) => `${u.check}:${u.reason}`).join(',') || '-' });
}

console.table(rows.map(({ findings, unavailable, ...r }) => r));
for (const r of rows) if (r.findings !== '-' || r.unavailable !== '-') console.log(`  ${r.case}\n    findings: ${r.findings}\n    unavailable: ${r.unavailable}`);
const timed = rows.filter((r) => r.qa_wall_ms);
const total = timed.reduce((a, r) => a + r.qa_wall_ms, 0); const media = timed.reduce((a, r) => a + (r.media_s ?? 0), 0);
console.log(`\nMEASURED runtime: ${timed.length} files, ${media.toFixed(1)} s of media analysed in ${(total / 1000).toFixed(1)} s wall (${(media / (total / 1000)).toFixed(1)}x realtime). No extrapolation to longer videos is made.`);
console.log(`thresholds (proposed, NOT active): ${JSON.stringify(QA_THRESHOLDS)}`);
console.log(`narration: ${narrationNote}`);
if (JSON_OUT) fs.writeFileSync(JSON_OUT, JSON.stringify({ platform: process.platform, node: process.version, ffmpeg: first('ffmpeg'), ffprobe: first('ffprobe'), narration: { real: narrationReal, provider: narrationProvider, note: narrationNote, seconds: narrationSeconds }, rows }, null, 2));
fs.rmSync(tmp, { recursive: true, force: true });
console.log(expectationsFailed === 0 ? '\nPROVEN: every expectation met on this FFmpeg build.' : `\nFAILED: ${expectationsFailed} expectation(s) not met on this FFmpeg build.`);
process.exit(expectationsFailed === 0 ? 0 : 1);