import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { analyzeMediaQa, defaultRunner, parseAnalysisOutput, silentSecondsWithinAudio, writeQaReportArtifact, verifyQaReportBinding, resolveMediaQaEnabled, QA_STATUS, QA_SEVERITY, QA_THRESHOLDS } from '../../src/media/qaWorker.js';
import { renderMotionClip, planMotion } from '../../src/media/motion.js';

// Real FFmpeg/FFprobe, real worker. Synthetic media is deterministic; every generated file is removed.

const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'media-qa-'));
after(() => fs.rmSync(WORK, { recursive: true, force: true }));

const W = 320; const H = 240;
const ff = (args) => execFileSync('ffmpeg', ['-v', 'error', '-y', ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
const out = (name) => path.join(WORK, name);
const enc = ['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-ar', '48000'];
const moving = (d) => ['-f', 'lavfi', '-i', `testsrc2=s=${W}x${H}:r=24:d=${d}`];
const speechLike = (d, vol = 2) => ['-f', 'lavfi', '-i', `sine=frequency=220:duration=${d}:sample_rate=48000,volume=${vol}`];
const checks = (r) => r.findings.map((f) => f.check);
const sev = (r, check) => r.findings.find((f) => f.check === check)?.severity;

function make(name, inputs, extra = []) { const f = out(name); ff([...inputs, ...enc, ...extra, f]); return f; }

test('legitimate moving video with sane audio: COMPLETE, no FAIL_CANDIDATE, nothing enforced', () => {
  const f = make('good.mp4', [...moving(6), ...speechLike(6)]);
  const r = analyzeMediaQa(f);
  assert.equal(r.status, QA_STATUS.COMPLETE, JSON.stringify(r.unavailable));
  assert.equal(r.decode.ok, true);
  assert.equal(r.black.black_seconds, 0);
  assert.equal(r.freeze.frozen_seconds, 0);
  assert.ok(!r.findings.some((x) => x.severity === QA_SEVERITY.FAIL_CANDIDATE), JSON.stringify(r.findings));
  assert.ok(r.findings.every((x) => x.enforced === false));
  assert.equal(r.mode, 'DIAGNOSTIC');
  assert.match(r.tools.ffmpeg.version, /^\d/);
  assert.match(r.file.sha256, /^[0-9a-f]{64}$/);
});

test('completely black video is a FAIL_CANDIDATE (black_video)', () => {
  const f = make('black.mp4', [...['-f', 'lavfi', '-i', `color=c=black:s=${W}x${H}:r=24:d=6`], ...speechLike(6)]);
  const r = analyzeMediaQa(f);
  assert.equal(r.status, QA_STATUS.COMPLETE);
  assert.equal(sev(r, 'black_video'), QA_SEVERITY.FAIL_CANDIDATE);
  assert.ok(r.black.ratio >= 0.9);
});

test('fully frozen video is detected (WARN-only by calibration) and the EOF-running freeze is reported as unterminated, not dropped', () => {
  const f = make('frozen.mp4', [...['-f', 'lavfi', '-i', `color=c=0x336699:s=${W}x${H}:r=24:d=6`], ...speechLike(6)]);
  const r = analyzeMediaQa(f);
  assert.equal(sev(r, 'frozen_video'), QA_SEVERITY.WARN);
  assert.ok(r.freeze.ratio >= 0.9);
  assert.ok(r.freeze.segments.some((x) => x.unterminated), 'FFmpeg 6.1 emits only freeze_start for a freeze to EOF');
});

test('freeze that continues to EOF after legitimate motion is still measured (parser: start with no end)', () => {
  // 3 s of motion then 5 s frozen to end of file.
  const f = out('freeze-eof.mp4');
  ff([...moving(3), ...speechLike(8), '-filter_complex', '[0:v]trim=0:3,setpts=PTS-STARTPTS[a];[a]tpad=stop_mode=clone:stop_duration=5[v]', '-map', '[v]', '-map', '1:a', ...enc, f]);
  const r = analyzeMediaQa(f);
  const seg = r.freeze.segments.at(-1);
  assert.ok(seg, 'a freeze segment must be reported');
  assert.ok(seg.duration >= 4, `freeze to EOF duration ${seg.duration}`);
  assert.ok(seg.start >= 2.5 && seg.start <= 3.5, `freeze starts after the motion (${seg.start})`);
  assert.ok(['frozen_segment', 'frozen_video'].some((c) => checks(r).includes(c)));
  // Version-independent parser contract: a start event with no terminator must be closed against the stream duration.
  const p = parseAnalysisOutput('[freezedetect @ 0x1] lavfi.freezedetect.freeze_start: 3\n', { videoDuration: 8, audioDuration: 8 });
  assert.deepEqual(p.freeze, [{ start: 3, end: 8, duration: 5, unterminated: true }]);
  // ...and a terminated event (newer builds) is parsed as terminated.
  const p2 = parseAnalysisOutput('lavfi.freezedetect.freeze_start: 3\nlavfi.freezedetect.freeze_duration: 2\nlavfi.freezedetect.freeze_end: 5\n', { videoDuration: 8, audioDuration: 8 });
  assert.deepEqual(p2.freeze, [{ start: 3, duration: 2, end: 5, unterminated: false }]);
});

test('silent audio track is a FAIL_CANDIDATE (effectively_silent_audio)', () => {
  const f = make('silent.mp4', [...moving(6), '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=mono:d=6']);
  const r = analyzeMediaQa(f);
  assert.equal(r.status, QA_STATUS.COMPLETE, JSON.stringify(r.unavailable));
  assert.equal(sev(r, 'effectively_silent_audio'), QA_SEVERITY.FAIL_CANDIDATE);
  // The ratio is a fraction of the audio duration, so it can never leave 0..1 (FFmpeg may close an EOF silence slightly late).
  assert.ok(r.silence.ratio >= 0 && r.silence.ratio <= 1, `silent ratio ${r.silence.ratio}`);
  assert.ok(r.silence.silent_seconds <= r.streams.audio.duration_seconds, `silent ${r.silence.silent_seconds}s of ${r.streams.audio.duration_seconds}s`);
});

test('silent seconds are clamped to the audio duration (an EOF silence closed past the end cannot push the ratio above 1); shorter silences are untouched', () => {
  assert.equal(silentSecondsWithinAudio(10.005, 10), 10);
  assert.equal(silentSecondsWithinAudio(4, 10), 4);
  assert.equal(silentSecondsWithinAudio(0, 10), 0);
  assert.equal(silentSecondsWithinAudio(3.2, null), 3.2, 'unknown audio duration: nothing to clamp against');
});

test('near-silent audio is a FAIL_CANDIDATE', () => {
  const f = make('near-silent.mp4', [...moving(6), ...speechLike(6, 0.0005)]);
  const r = analyzeMediaQa(f);
  assert.equal(sev(r, 'effectively_silent_audio'), QA_SEVERITY.FAIL_CANDIDATE, JSON.stringify(r.loudness));
});

test('excessively loud audio is flagged (loudness deviation FAIL_CANDIDATE + true-peak WARN)', () => {
  const f = make('loud.mp4', [...moving(6), ...speechLike(6, 8)], ['-af', 'alimiter=limit=1:level=disabled']);
  const r = analyzeMediaQa(f);
  assert.equal(sev(r, 'loudness_deviation'), QA_SEVERITY.FAIL_CANDIDATE, JSON.stringify(r.loudness));
  assert.ok(r.loudness.deviation_lu > QA_THRESHOLDS.loudness.fail_candidate_abs_deviation_lu);
  assert.equal(sev(r, 'true_peak_overshoot'), QA_SEVERITY.WARN, JSON.stringify(r.loudness)); // a real overshoot (+1.4 dBFS in calibration) is still flagged, warn-only
});

test('audio/video duration mismatch is flagged', () => {
  const f = out('mismatch.mp4');
  ff([...moving(10), ...speechLike(4), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', f]);
  const r = analyzeMediaQa(f);
  assert.ok(r.av_duration_discrepancy_seconds > 5, `discrepancy ${r.av_duration_discrepancy_seconds}`);
  assert.equal(sev(r, 'av_duration_mismatch'), QA_SEVERITY.FAIL_CANDIDATE);
});

test('truncated media is flagged via the decode pass, never reported clean', () => {
  const good = make('to-truncate.mp4', [...moving(10), ...speechLike(10)], ['-movflags', '+faststart']);
  const bytes = fs.readFileSync(good);
  const f = out('truncated.mp4');
  fs.writeFileSync(f, bytes.subarray(0, Math.floor(bytes.length * 0.45)));
  const r = analyzeMediaQa(f);
  assert.equal(r.clean, false);
  assert.ok(r.decode.error_line_count > 0 || r.unavailable.length > 0 || r.probe.ok === false, JSON.stringify({ d: r.decode, u: r.unavailable }));
  assert.ok(r.findings.some((x) => x.check === 'decode_errors' && x.severity === QA_SEVERITY.FAIL_CANDIDATE) || r.unavailable.length > 0);
});

test('corrupted media is flagged via the decode pass, never reported clean', () => {
  const good = make('to-corrupt.mp4', [...moving(10), ...speechLike(10)], ['-movflags', '+faststart']);
  const bytes = Buffer.from(fs.readFileSync(good));
  for (let i = Math.floor(bytes.length * 0.4); i < Math.floor(bytes.length * 0.6); i += 7) bytes[i] ^= 0xff;
  const f = out('corrupt.mp4');
  fs.writeFileSync(f, bytes);
  const r = analyzeMediaQa(f);
  assert.equal(r.clean, false);
  assert.ok(r.findings.some((x) => x.check === 'decode_errors') || r.unavailable.length > 0, JSON.stringify({ d: r.decode, u: r.unavailable }));
});

const DARK_STILLS = {
  // Textured dark stills: realistic low-key photos/graphics.
  'dark-textured': ['-f', 'lavfi', '-i', 'testsrc2=s=1280x720:r=1:d=1', '-vf', 'eq=brightness=-0.45'],
  'dark-gradient-noise': ['-f', 'lavfi', '-i', 'gradients=s=1280x720:d=1:n=2:seed=7', '-vf', 'eq=brightness=-0.35,noise=alls=12:allf=t']
};

test('legitimate textured dark-still Ken Burns clips from the REAL renderMotionClip: no freeze or black finding across every motion plan', () => {
  let clips = 0;
  for (const [name, args] of Object.entries(DARK_STILLS)) {
    const still = out(`${name}.png`);
    ff([...args, '-frames:v', '1', still]);
    for (let i = 0; i < 6; i++) {
      const motion = planMotion({ assetId: `asset-${i}`, segmentIndex: i });
      const clip = out(`kb-${name}-${i}.mp4`);
      renderMotionClip({ imagePath: still, outputPath: clip, motion, width: 640, height: 360, fps: 24, durationSeconds: 8 });
      const f = out(`kb-${name}-${i}-av.mp4`);
      ff(['-i', clip, ...speechLike(8), '-c:v', 'copy', '-c:a', 'aac', '-shortest', f]);
      const r = analyzeMediaQa(f, { context: { kenBurnsMotion: true } });
      assert.equal(r.status, QA_STATUS.COMPLETE, JSON.stringify(r.unavailable));
      assert.deepEqual(checks(r).filter((c) => /frozen|black/.test(c)), [], `${name} plan ${i} (${motion.mode}): ${JSON.stringify(r.freeze)}`);
      clips++;
    }
  }
  assert.equal(clips, 12);
});

test('DOCUMENTED LIMITATION: near-uniform dark still + real motion is indistinguishable from a freeze, so it is WARN-only and never black/FAIL_CANDIDATE', () => {
  const still = out('uniform-dark.png');
  ff(['-f', 'lavfi', '-i', 'color=c=0x0a0a14:s=1280x720:d=1', '-vf', 'noise=alls=3:allf=t', '-frames:v', '1', still]);
  const clip = out('kb-uniform.mp4');
  renderMotionClip({ imagePath: still, outputPath: clip, motion: planMotion({ assetId: 'asset-0', segmentIndex: 0 }), width: 640, height: 360, fps: 24, durationSeconds: 8 });
  const f = out('kb-uniform-av.mp4');
  ff(['-i', clip, ...speechLike(8), '-c:v', 'copy', '-c:a', 'aac', '-shortest', f]);
  const r = analyzeMediaQa(f, { context: { kenBurnsMotion: true } });
  assert.ok(!r.findings.some((x) => x.severity === QA_SEVERITY.FAIL_CANDIDATE), JSON.stringify(r.findings));
  assert.ok(!checks(r).some((c) => c === 'black_video'), 'pix_th 0.03 must not call a legitimate near-black still black');
});

test('a truly static video is still detected at the calibrated freeze noise level (-70dB)', () => {
  assert.equal(QA_THRESHOLDS.freeze.noise_db, -70);
  const f = make('static.mp4', [...['-f', 'lavfi', '-i', `color=c=0x203040:s=${W}x${H}:r=24:d=8`], ...speechLike(8)]);
  assert.equal(sev(analyzeMediaQa(f), 'frozen_video'), QA_SEVERITY.WARN);
});

test('stillness is downgraded to WARN (not FAIL_CANDIDATE) when the caller says Ken Burns motion was disabled', () => {
  const f = make('static-ctx.mp4', [...['-f', 'lavfi', '-i', `color=c=0x203040:s=${W}x${H}:r=24:d=8`], ...speechLike(8)]);
  const r = analyzeMediaQa(f, { context: { kenBurnsMotion: false } });
  assert.equal(sev(r, 'frozen_video'), QA_SEVERITY.WARN);
});

// ---- tool / subprocess failure handling: never a clean report when analysis did not run ----

test('missing FFmpeg/FFprobe executables: explicit unavailable, FAILED/INCOMPLETE, never clean', () => {
  const f = make('for-missing.mp4', [...moving(2), ...speechLike(2)]);
  const r = analyzeMediaQa(f, { ffmpegPath: path.join(WORK, 'no-such-ffmpeg'), ffprobePath: path.join(WORK, 'no-such-ffprobe') });
  assert.equal(r.clean, false);
  assert.notEqual(r.status, QA_STATUS.COMPLETE);
  assert.ok(r.unavailable.some((u) => u.check === 'ffmpeg' && u.reason === 'EXECUTABLE_NOT_FOUND'));
  assert.ok(r.unavailable.some((u) => u.check === 'ffprobe' && u.reason === 'EXECUTABLE_NOT_FOUND'));
});

test('real subprocess timeout is recorded (1 ms budget against real ffmpeg), never clean', () => {
  const f = make('for-timeout.mp4', [...moving(2), ...speechLike(2)]);
  const r = analyzeMediaQa(f, { timeoutMs: { version: 1 } });
  assert.equal(r.clean, false);
  assert.ok(r.unavailable.some((u) => /TIMEOUT/.test(u.reason)), JSON.stringify(r.unavailable));
});

test('failed analysis subprocess (non-zero exit, no diagnostics) -> detector checks unavailable, status INCOMPLETE, never clean', () => {
  const f = make('for-fail.mp4', [...moving(2), ...speechLike(2)]);
  const runner = (cmd, args, o) => (args.includes('-vf') || args.includes('-af')
    ? { status: 1, signal: null, stdout: '', stderr: '', error: null }
    : defaultRunner(cmd, args, o));
  const r = analyzeMediaQa(f, { runner });
  assert.equal(r.status, QA_STATUS.INCOMPLETE);
  assert.equal(r.clean, false);
  for (const c of ['black', 'freeze', 'loudness', 'silence']) assert.ok(r.unavailable.some((u) => u.check === c), `${c} must be unavailable`);
});

test('malformed ffprobe JSON and missing ebur128 summary are explicit, never clean', () => {
  const f = make('for-malformed.mp4', [...moving(2), ...speechLike(2)]);
  const badProbe = analyzeMediaQa(f, { runner: (cmd, args, o) => (args.includes('-print_format') ? { status: 0, signal: null, stdout: '{not json', stderr: '', error: null } : defaultRunner(cmd, args, o)) });
  assert.ok(badProbe.unavailable.some((u) => u.reason === 'PROBE_OUTPUT_MALFORMED'));
  assert.equal(badProbe.clean, false);

  const noSummary = analyzeMediaQa(f, { runner: (cmd, args, o) => (args.includes('-af') ? { status: 0, signal: null, stdout: '', stderr: 'garbage with no detector output', error: null } : defaultRunner(cmd, args, o)) });
  assert.ok(noSummary.unavailable.some((u) => u.check === 'loudness' && u.reason === 'EBUR128_SUMMARY_MISSING_OR_UNPARSEABLE'));
  assert.equal(noSummary.status, QA_STATUS.INCOMPLETE);
  assert.equal(noSummary.clean, false);
});

test('missing file, empty file and a file with no audio stream are explicit', () => {
  assert.ok(analyzeMediaQa(out('nope.mp4')).unavailable.some((u) => u.reason === 'FILE_MISSING'));
  fs.writeFileSync(out('empty.mp4'), '');
  assert.ok(analyzeMediaQa(out('empty.mp4')).unavailable.some((u) => u.reason === 'FILE_EMPTY'));
  const f = out('video-only.mp4');
  ff([...moving(2), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', f]);
  const r = analyzeMediaQa(f);
  assert.ok(r.unavailable.some((u) => u.check === 'audio_checks' && u.reason === 'NO_AUDIO_STREAM'));
  assert.equal(r.clean, false);
});

// ---- report <-> artifact checksum binding ----

test('report is bound to the exact artifact checksum; attaching it to a different file is detected', () => {
  const a = make('bind-a.mp4', [...moving(3), ...speechLike(3)]);
  const b = make('bind-b.mp4', [...moving(4), ...speechLike(4)]);
  const report = analyzeMediaQa(a);
  const w = writeQaReportArtifact({ dir: WORK, filename: 'bind-report.json', report, artifactPath: a });
  assert.equal(w.written, true);
  assert.deepEqual(verifyQaReportBinding({ reportPath: w.path, artifactPath: a, expectedReportChecksum: w.checksum }).bound, true);
  assert.equal(verifyQaReportBinding({ reportPath: w.path, artifactPath: b }).reason, 'ARTIFACT_CHECKSUM_MISMATCH');
  // refuses to write a report for bytes it did not analyse
  assert.equal(writeQaReportArtifact({ dir: WORK, filename: 'x.json', report, artifactPath: b }).written, false);
  // tampered report is detected by the recorded report checksum
  fs.writeFileSync(w.path, fs.readFileSync(w.path, 'utf8').replace('DIAGNOSTIC', 'ENFORCED'));
  assert.equal(verifyQaReportBinding({ reportPath: w.path, artifactPath: a, expectedReportChecksum: w.checksum }).reason, 'REPORT_CHECKSUM_MISMATCH');
});

test('MEDIA_QA switch: on by default, off only for an explicit off value, unknown values never silently disable', () => {
  assert.equal(resolveMediaQaEnabled({}), true);
  assert.equal(resolveMediaQaEnabled({ MEDIA_QA: 'off' }), false);
  assert.equal(resolveMediaQaEnabled({ MEDIA_QA: 'banana' }), true);
});