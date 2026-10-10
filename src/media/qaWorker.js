import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { canonicalStringify } from '../production/manifest.js';
import { LOUDNORM_TARGETS } from './render.js';

// Automated final-video QA (FFmpeg/FFprobe only, no new dependency).
//
// EVIDENCE-FIRST: this worker MEASURES and REPORTS. Every check it emits is
// `enforced: false`. Nothing here rejects a render, changes a retry, or
// authorizes anything -- a QA report is NOT proof of factual accuracy, rights
// clearance, originality or publication authorization. It also never throws:
// a missing tool, a timeout, malformed output or an incomplete analysis is
// recorded as an explicit `unavailable` measurement and a non-COMPLETE
// status, and a report is only `clean: true` when the required analysis ran
// successfully AND found nothing.
//
// The thresholds below are PROPOSED candidates pending Owner review of
// calibration evidence (scripts/prove-media-qa.js). They classify findings
// (FAIL_CANDIDATE vs WARN) inside the report only.

export const QA_REPORT_TYPE = 'media_qa_report_v1';
export const QA_MODE = 'DIAGNOSTIC';
export const QA_STATUS = Object.freeze({ COMPLETE: 'COMPLETE', INCOMPLETE: 'INCOMPLETE', FAILED: 'FAILED' });
export const QA_SEVERITY = Object.freeze({ FAIL_CANDIDATE: 'FAIL_CANDIDATE', WARN: 'WARN' });

/** Proposed, NOT activated. `class` records whether a breach would be file corruption or subjective tuning. */
export const QA_THRESHOLDS = Object.freeze({
  decode_errors: Object.freeze({ class: 'CORRUPTION', fail_candidate_min_error_lines: 1 }),
  silence: Object.freeze({
    class: 'CORRUPTION_OR_PIPELINE_FAULT',
    noise_floor_db: -50, min_segment_seconds: 1,
    integrated_loudness_fail_candidate_below_lufs: -50, silent_ratio_fail_candidate_min: 0.9
  }),
  av_duration_mismatch: Object.freeze({ class: 'CORRUPTION_OR_PIPELINE_FAULT', warn_seconds: 0.25, fail_candidate_seconds: 1.0 }),
  black: Object.freeze({
    // pix_th 0.03, not FFmpeg's 0.10: at 0.10 a legitimate near-black still (rgb 10,10,20) counts as 100% black.
    class: 'PIPELINE_FAULT', pic_th: 0.98, pix_th: 0.03, min_segment_seconds: 2,
    warn_min_segment_seconds: 2, fail_candidate_ratio_min: 0.9
  }),
  freeze: Object.freeze({
    // WARN-ONLY by evidence: pan/zoom over a near-uniform dark still yields visually identical frames, which no
    // freezedetect noise level (-60..-80dB) can tell apart from a real freeze. Never a hard-fail candidate.
    class: 'WARN_ONLY_INDISTINGUISHABLE_FROM_UNIFORM_STILLS', noise_db: -70, min_segment_seconds: 2,
    warn_min_segment_seconds: 2
  }),
  loudness: Object.freeze({
    class: 'SUBJECTIVE_TUNING', target_lufs: LOUDNORM_TARGETS.I,
    warn_abs_deviation_lu: 2, fail_candidate_abs_deviation_lu: 6
  }),
  true_peak: Object.freeze({ class: 'SUBJECTIVE_TUNING_WARN_ONLY', target_dbtp: LOUDNORM_TARGETS.TP, warn_above_dbtp: -0.5 })
});

const DEFAULT_TIMEOUTS_MS = Object.freeze({ version: 15_000, probe: 30_000, analysis: 15 * 60_000 });
const MAX_BUFFER_BYTES = 64 * 1024 * 1024;
const MAX_ERROR_LINES_RECORDED = 20;

/** Bounded, shell-free subprocess. Never throws; returns a plain result object. */
export function defaultRunner(command, args, { timeoutMs }) {
  const r = spawnSync(command, args, {
    shell: false, encoding: 'utf8', timeout: timeoutMs, killSignal: 'SIGKILL',
    maxBuffer: MAX_BUFFER_BYTES, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true
  });
  return { status: r.status, signal: r.signal ?? null, stdout: r.stdout ?? '', stderr: r.stderr ?? '', error: r.error ? { code: r.error.code ?? null, message: String(r.error.message) } : null };
}

function sha256OfFile(file) {
  const h = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.allocUnsafe(1024 * 1024);
    let n;
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) h.update(buf.subarray(0, n));
  } finally { fs.closeSync(fd); }
  return h.digest('hex');
}

function runFailure(r) {
  if (r.error) return r.error.code === 'ENOENT' ? 'EXECUTABLE_NOT_FOUND' : (r.error.code === 'ETIMEDOUT' ? 'TIMEOUT' : (r.error.code === 'ENOBUFS' ? 'OUTPUT_TOO_LARGE' : `SPAWN_ERROR_${r.error.code ?? 'UNKNOWN'}`));
  if (r.signal) return `KILLED_${r.signal}`;
  if (r.status !== 0) return `EXIT_${r.status}`;
  return null;
}

function readVersion(runner, command, timeoutMs) {
  const r = runner(command, ['-version'], { timeoutMs });
  const failure = runFailure(r);
  if (failure) return { version: null, failure };
  const m = /version\s+(\S+)/.exec(String(r.stdout).split('\n')[0] ?? '');
  return m ? { version: m[1], failure: null } : { version: null, failure: 'VERSION_UNPARSEABLE' };
}

const num = (v) => { const n = typeof v === 'string' ? Number.parseFloat(v) : v; return Number.isFinite(n) ? n : null; };
const round = (n, d = 3) => (n === null ? null : Math.round(n * 10 ** d) / 10 ** d);

function streamDuration(stream, formatDuration) {
  const own = num(stream?.duration);
  if (own !== null && own > 0) return { seconds: own, source: 'stream' };
  const fmt = num(formatDuration);
  return fmt !== null && fmt > 0 ? { seconds: fmt, source: 'format_fallback' } : { seconds: null, source: null };
}

/** Parses the info-level lines FFmpeg's detector filters print. Tolerant of version differences; never assumes an event is terminated. */
export function parseAnalysisOutput(stderr, { videoDuration, audioDuration }) {
  const lines = String(stderr).split(/\r?\n/);
  const out = { black: [], freeze: [], silence: [], loudness: null, truePeak: null, summaryFound: false };

  let openFreezeStart = null;
  let openSilenceStart = null;
  let inSummary = false;
  let section = null;
  for (const line of lines) {
    let m;
    if ((m = /black_start:([\d.]+)\s+black_end:([\d.]+)\s+black_duration:([\d.]+)/.exec(line))) {
      out.black.push({ start: Number(m[1]), end: Number(m[2]), duration: Number(m[3]), unterminated: false });
      continue;
    }
    if ((m = /freeze_start:\s*([\d.]+)/.exec(line))) { openFreezeStart = Number(m[1]); continue; }
    if ((m = /freeze_duration:\s*([\d.]+)/.exec(line)) && openFreezeStart !== null) {
      out.freeze.push({ start: openFreezeStart, duration: Number(m[1]), end: openFreezeStart + Number(m[1]), unterminated: false });
      openFreezeStart = null; continue;
    }
    if (/freeze_end:\s*[\d.]+/.test(line)) continue; // end is derived from freeze_duration; an end without a start is ignored
    if ((m = /silence_start:\s*(-?[\d.]+)/.exec(line))) { openSilenceStart = Math.max(0, Number(m[1])); continue; }
    if ((m = /silence_end:\s*([\d.]+)\s*\|\s*silence_duration:\s*([\d.]+)/.exec(line)) && openSilenceStart !== null) {
      out.silence.push({ start: openSilenceStart, end: Number(m[1]), duration: Number(m[2]), unterminated: false });
      openSilenceStart = null; continue;
    }
    if (/Summary:/.test(line) && /ebur128/.test(line)) { inSummary = true; out.summaryFound = true; section = null; continue; }
    if (inSummary) {
      if (/Integrated loudness:/.test(line)) { section = 'I'; continue; }
      if (/True peak:/.test(line)) { section = 'TP'; continue; }
      if (/Loudness range:|Sample peak:/.test(line)) { section = null; continue; }
      if (section === 'I' && (m = /^\s*I:\s*(-?[\d.]+|-inf)\s*LUFS/.exec(line))) { out.loudness = m[1] === '-inf' ? -Infinity : Number(m[1]); continue; }
      if (section === 'TP' && (m = /^\s*Peak:\s*(-?[\d.]+|-inf)\s*dBFS/.exec(line))) { out.truePeak = m[1] === '-inf' ? -Infinity : Number(m[1]); continue; }
    }
  }
  // Events FFmpeg never closed (freeze/silence running to end-of-file) are closed against the measured stream
  // duration and flagged `unterminated`, so a freeze or silence to EOF is never silently dropped.
  if (openFreezeStart !== null) {
    const end = videoDuration ?? null;
    out.freeze.push({ start: openFreezeStart, end, duration: end === null ? null : Math.max(0, end - openFreezeStart), unterminated: true });
  }
  if (openSilenceStart !== null) {
    const end = audioDuration ?? null;
    out.silence.push({ start: openSilenceStart, end, duration: end === null ? null : Math.max(0, end - openSilenceStart), unterminated: true });
  }
  return out;
}

// A silent interval cannot be longer than the audio itself. FFmpeg can close an end-of-file silence a few
// milliseconds past the measured audio duration, which made the ratio exceed 1; clamp to the valid 0..duration range.
export function silentSecondsWithinAudio(silentSeconds, audioSeconds) {
  return audioSeconds > 0 ? Math.min(silentSeconds, audioSeconds) : silentSeconds;
}
function sumDurations(segs) { return segs.reduce((a, s) => a + (s.duration ?? 0), 0); }
function maxDuration(segs) { return segs.reduce((a, s) => Math.max(a, s.duration ?? 0), 0); }

/**
 * Analyses one media file. Never throws. `context` is caller-supplied, recorded verbatim
 * (e.g. { kenBurnsMotion: true }) so a report can state whether stillness was expected.
 */
export function analyzeMediaQa(filePath, {
  runner = defaultRunner, ffmpegPath = 'ffmpeg', ffprobePath = 'ffprobe',
  timeoutMs = {}, context = {}, now = () => Date.now()
} = {}) {
  const t0 = now();
  const timeouts = { ...DEFAULT_TIMEOUTS_MS, ...timeoutMs };
  const unavailable = [];
  const findings = [];
  const noteUnavailable = (check, reason) => unavailable.push({ check, reason });

  const report = {
    artifact_type: QA_REPORT_TYPE, mode: QA_MODE, status: QA_STATUS.FAILED, clean: false,
    file: { name: path.basename(String(filePath ?? '')), size_bytes: null, sha256: null },
    tools: { ffmpeg: { path: ffmpegPath, version: null }, ffprobe: { path: ffprobePath, version: null } },
    context,
    analysis_duration_ms: null,
    probe: { ok: false, failure: null },
    streams: { video: null, audio: null },
    av_duration_discrepancy_seconds: null,
    decode: { ran: false, ok: null, error_line_count: null, error_lines: [], failure: null },
    black: { ran: false, segments: [], black_seconds: null, ratio: null },
    freeze: { ran: false, segments: [], frozen_seconds: null, ratio: null },
    silence: { ran: false, segments: [], silent_seconds: null, ratio: null },
    loudness: { ran: false, integrated_lufs: null, true_peak_dbfs: null, target_lufs: LOUDNORM_TARGETS.I, deviation_lu: null },
    thresholds: QA_THRESHOLDS,
    methods: {},
    findings, unavailable
  };
  const finish = () => {
    report.analysis_duration_ms = now() - t0;
    const complete = report.status === QA_STATUS.COMPLETE;
    report.clean = complete && findings.length === 0 && unavailable.length === 0;
    return report;
  };

  try {
    // --- file identity ---
    let st;
    try { st = fs.statSync(filePath); } catch { st = null; }
    if (!st || !st.isFile()) { noteUnavailable('file', 'FILE_MISSING'); return finish(); }
    if (st.size <= 0) { noteUnavailable('file', 'FILE_EMPTY'); return finish(); }
    report.file.size_bytes = st.size;
    report.file.sha256 = sha256OfFile(filePath);

    // --- tool availability ---
    const fv = readVersion(runner, ffmpegPath, timeouts.version);
    const pv = readVersion(runner, ffprobePath, timeouts.version);
    report.tools.ffmpeg.version = fv.version; report.tools.ffprobe.version = pv.version;
    if (fv.failure) noteUnavailable('ffmpeg', fv.failure);
    if (pv.failure) noteUnavailable('ffprobe', pv.failure);
    if (fv.failure || pv.failure) return finish();

    // --- probe ---
    const probeArgs = ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', filePath];
    report.methods.probe = `${path.basename(ffprobePath)} ${probeArgs.slice(0, -1).join(' ')} <file>`;
    const pr = runner(ffprobePath, probeArgs, { timeoutMs: timeouts.probe });
    const pf = runFailure(pr);
    if (pf) { report.probe.failure = pf; noteUnavailable('probe', pf); return finish(); }
    let probe;
    try { probe = JSON.parse(pr.stdout); } catch { report.probe.failure = 'PROBE_OUTPUT_MALFORMED'; noteUnavailable('probe', 'PROBE_OUTPUT_MALFORMED'); return finish(); }
    if (!probe || typeof probe !== 'object' || !Array.isArray(probe.streams)) { report.probe.failure = 'PROBE_OUTPUT_MALFORMED'; noteUnavailable('probe', 'PROBE_OUTPUT_MALFORMED'); return finish(); }
    report.probe.ok = true;

    const vs = probe.streams.find((s) => s.codec_type === 'video');
    const as = probe.streams.find((s) => s.codec_type === 'audio');
    const vd = vs ? streamDuration(vs, probe.format?.duration) : { seconds: null, source: null };
    const ad = as ? streamDuration(as, probe.format?.duration) : { seconds: null, source: null };
    if (vs) report.streams.video = { codec: vs.codec_name ?? null, width: vs.width ?? null, height: vs.height ?? null, duration_seconds: round(vd.seconds), duration_source: vd.source, avg_frame_rate: vs.avg_frame_rate ?? null };
    if (as) report.streams.audio = { codec: as.codec_name ?? null, sample_rate: num(as.sample_rate), channels: as.channels ?? null, duration_seconds: round(ad.seconds), duration_source: ad.source };
    if (!vs) noteUnavailable('video_checks', 'NO_VIDEO_STREAM');
    if (!as) noteUnavailable('audio_checks', 'NO_AUDIO_STREAM');

    // --- A/V duration discrepancy (container-reported stream durations) ---
    if (vs && as) {
      if (vd.source === 'stream' && ad.source === 'stream') {
        report.av_duration_discrepancy_seconds = round(Math.abs(vd.seconds - ad.seconds));
      } else {
        noteUnavailable('av_duration_discrepancy', 'STREAM_DURATIONS_NOT_BOTH_REPORTED');
      }
    }

    // --- pass 1: full-file decode (any decoder complaint is evidence) ---
    const decodeArgs = ['-v', 'error', '-nostdin', '-i', filePath, '-f', 'null', '-'];
    report.methods.decode = `${path.basename(ffmpegPath)} ${decodeArgs.slice(0, 2).join(' ')} -nostdin -i <file> -f null -`;
    const dr = runner(ffmpegPath, decodeArgs, { timeoutMs: timeouts.analysis });
    const df = runFailure(dr);
    report.decode.ran = true;
    const errLines = String(dr.stderr ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    report.decode.error_line_count = errLines.length;
    report.decode.error_lines = errLines.slice(0, MAX_ERROR_LINES_RECORDED);
    if (df && !(df.startsWith('EXIT_') && errLines.length > 0)) {
      // The decode pass itself did not run to a verdict (spawn error / timeout / killed / non-zero with no diagnostics).
      report.decode.ok = null; report.decode.failure = df;
      noteUnavailable('decode', df);
    } else {
      report.decode.ok = errLines.length === 0 && df === null;
      if (df) report.decode.failure = df;
    }

    // --- pass 2: black / freeze / loudness / silence (one decode of the file) ---
    const th = QA_THRESHOLDS;
    const vf = vs ? `blackdetect=d=${th.black.min_segment_seconds}:pic_th=${th.black.pic_th}:pix_th=${th.black.pix_th},freezedetect=n=${th.freeze.noise_db}dB:d=${th.freeze.min_segment_seconds}` : null;
    const af = as ? `ebur128=peak=true:framelog=quiet,silencedetect=n=${th.silence.noise_floor_db}dB:d=${th.silence.min_segment_seconds}` : null;
    if (vf || af) {
      const aArgs = ['-hide_banner', '-nostats', '-nostdin', '-i', filePath, ...(vf ? ['-vf', vf] : ['-vn']), ...(af ? ['-af', af] : ['-an']), '-f', 'null', '-'];
      report.methods.analysis = { video_filter: vf, audio_filter: af, note: 'single pass; log-level info; events never closed by FFmpeg are closed against stream duration and flagged unterminated' };
      const ar = runner(ffmpegPath, aArgs, { timeoutMs: timeouts.analysis });
      const af_ = runFailure(ar);
      if (af_) {
        for (const c of [vf && 'black', vf && 'freeze', af && 'loudness', af && 'silence'].filter(Boolean)) noteUnavailable(c, `ANALYSIS_${af_}`);
      } else {
        const parsed = parseAnalysisOutput(ar.stderr, { videoDuration: vd.seconds, audioDuration: ad.seconds });
        if (vf) {
          report.black.ran = true; report.black.segments = parsed.black;
          report.black.black_seconds = round(sumDurations(parsed.black));
          report.black.ratio = vd.seconds ? round(sumDurations(parsed.black) / vd.seconds, 4) : null;
          report.freeze.ran = true; report.freeze.segments = parsed.freeze;
          const fz = sumDurations(parsed.freeze);
          report.freeze.frozen_seconds = round(fz);
          report.freeze.ratio = vd.seconds ? round(fz / vd.seconds, 4) : null;
          if (parsed.freeze.some((s) => s.unterminated && s.duration === null)) noteUnavailable('freeze_unterminated_extent', 'VIDEO_DURATION_UNKNOWN');
        }
        if (af) {
          if (!parsed.summaryFound || parsed.loudness === null) {
            noteUnavailable('loudness', 'EBUR128_SUMMARY_MISSING_OR_UNPARSEABLE');
          } else {
            report.loudness.ran = true; report.loudness.integrated_lufs = Number.isFinite(parsed.loudness) ? round(parsed.loudness, 1) : -Infinity;
            report.loudness.true_peak_dbfs = parsed.truePeak === null ? null : (Number.isFinite(parsed.truePeak) ? round(parsed.truePeak, 1) : -Infinity);
            report.loudness.deviation_lu = Number.isFinite(parsed.loudness) ? round(parsed.loudness - th.loudness.target_lufs, 1) : null;
            if (parsed.truePeak === null) noteUnavailable('true_peak', 'EBUR128_TRUE_PEAK_MISSING');
          }
          report.silence.ran = true; report.silence.segments = parsed.silence;
          const sl = silentSecondsWithinAudio(sumDurations(parsed.silence), ad.seconds);
          report.silence.silent_seconds = round(sl);
          report.silence.ratio = ad.seconds ? round(sl / ad.seconds, 4) : null;
          if (parsed.silence.some((s) => s.unterminated && s.duration === null)) noteUnavailable('silence_unterminated_extent', 'AUDIO_DURATION_UNKNOWN');
        }
      }
    }

    // --- findings (classification only; nothing here is enforced) ---
    const add = (check, severity, detail) => findings.push({ check, severity, enforced: false, ...detail });
    if (report.decode.ran && report.decode.ok === false) add('decode_errors', QA_SEVERITY.FAIL_CANDIDATE, { error_line_count: report.decode.error_line_count, failure: report.decode.failure });
    if (report.av_duration_discrepancy_seconds !== null) {
      const d = report.av_duration_discrepancy_seconds;
      if (d > th.av_duration_mismatch.fail_candidate_seconds) add('av_duration_mismatch', QA_SEVERITY.FAIL_CANDIDATE, { seconds: d });
      else if (d > th.av_duration_mismatch.warn_seconds) add('av_duration_mismatch', QA_SEVERITY.WARN, { seconds: d });
    }
    if (report.black.ran) {
      const longest = maxDuration(report.black.segments);
      if (report.black.ratio !== null && report.black.ratio >= th.black.fail_candidate_ratio_min) add('black_video', QA_SEVERITY.FAIL_CANDIDATE, { ratio: report.black.ratio, black_seconds: report.black.black_seconds });
      else if (longest >= th.black.warn_min_segment_seconds) add('black_segment', QA_SEVERITY.WARN, { longest_segment_seconds: round(longest), black_seconds: report.black.black_seconds });
    }
    if (report.freeze.ran) {
      const longest = maxDuration(report.freeze.segments);
      const unterminated = report.freeze.segments.some((x) => x.unterminated);
      const expected = context.kenBurnsMotion === false ? { motion_disabled_stillness_expected: true } : {};
      if (report.freeze.ratio !== null && report.freeze.ratio >= 0.9) add('frozen_video', QA_SEVERITY.WARN, { ratio: report.freeze.ratio, frozen_seconds: report.freeze.frozen_seconds, unterminated, ...expected });
      else if (longest >= th.freeze.warn_min_segment_seconds) add('frozen_segment', QA_SEVERITY.WARN, { longest_segment_seconds: round(longest), frozen_seconds: report.freeze.frozen_seconds, unterminated, ...expected });
    }
    if (report.loudness.ran) {
      const i = report.loudness.integrated_lufs;
      if (i < th.silence.integrated_loudness_fail_candidate_below_lufs || (report.silence.ratio !== null && report.silence.ratio >= th.silence.silent_ratio_fail_candidate_min)) {
        add('effectively_silent_audio', QA_SEVERITY.FAIL_CANDIDATE, { integrated_lufs: i, silent_ratio: report.silence.ratio });
      } else {
        const dev = Math.abs(report.loudness.deviation_lu);
        if (dev > th.loudness.fail_candidate_abs_deviation_lu) add('loudness_deviation', QA_SEVERITY.FAIL_CANDIDATE, { integrated_lufs: i, deviation_lu: report.loudness.deviation_lu });
        else if (dev > th.loudness.warn_abs_deviation_lu) add('loudness_deviation', QA_SEVERITY.WARN, { integrated_lufs: i, deviation_lu: report.loudness.deviation_lu });
      }
      const tp = report.loudness.true_peak_dbfs;
      if (tp !== null && tp > th.true_peak.warn_above_dbtp) add('true_peak_overshoot', QA_SEVERITY.WARN, { true_peak_dbfs: tp, target_dbtp: th.true_peak.target_dbtp });
    } else if (report.silence.ran && report.silence.ratio !== null && report.silence.ratio >= th.silence.silent_ratio_fail_candidate_min) {
      add('effectively_silent_audio', QA_SEVERITY.FAIL_CANDIDATE, { integrated_lufs: null, silent_ratio: report.silence.ratio });
    }

    // --- file must not have changed under the analysis ---
    let after;
    try { after = sha256OfFile(filePath); } catch { after = null; }
    if (after !== report.file.sha256) { noteUnavailable('file_stability', 'FILE_CHANGED_DURING_ANALYSIS'); report.status = QA_STATUS.INCOMPLETE; return finish(); }

    report.status = unavailable.length === 0 ? QA_STATUS.COMPLETE : QA_STATUS.INCOMPLETE;
    return finish();
  } catch (err) {
    noteUnavailable('analysis', `UNEXPECTED_${String(err?.message ?? err).split('\n')[0].slice(0, 200)}`);
    report.status = QA_STATUS.FAILED;
    return finish();
  }
}

// ---------------------------------------------------------------------------
// Persistence / binding (file artifact + decision_log reference; no migration)
// ---------------------------------------------------------------------------

/** MEDIA_QA=off disables the diagnostic step entirely. Default: on. Never alters render, validation or promotion. */
export function resolveMediaQaEnabled(env = process.env) {
  const v = (env.MEDIA_QA ?? 'on').trim().toLowerCase();
  if (v === '' || v === 'on' || v === '1' || v === 'true') return true;
  if (v === 'off' || v === '0' || v === 'false' || v === 'none') return false;
  return true; // an unrecognised value never silently disables evidence collection
}

/**
 * Writes the report beside the artifact, bound to it by the SHA-256 of the exact
 * bytes the report describes. Refuses (returns null) if the file now at
 * `artifactPath` is not the file that was analysed.
 */
export function writeQaReportArtifact({ dir, filename, report, artifactPath }) {
  const actual = sha256OfFile(artifactPath);
  if (!report?.file?.sha256 || actual !== report.file.sha256) {
    return { written: false, reason: 'ARTIFACT_CHECKSUM_MISMATCH', expected: report?.file?.sha256 ?? null, actual };
  }
  const bound = { ...report, file: { ...report.file, name: path.basename(artifactPath) } };
  const finalPath = path.join(dir, filename);
  const tmpPath = path.join(dir, `.${filename}.tmp-${process.pid}-${Date.now()}`);
  try {
    fs.writeFileSync(tmpPath, canonicalStringify(bound), 'utf8');
    fs.renameSync(tmpPath, finalPath);
  } finally { fs.rmSync(tmpPath, { force: true }); }
  return { written: true, path: finalPath, checksum: sha256OfFile(finalPath), artifactChecksum: actual };
}

/** Re-derives the binding from disk. A report attached to a different file (or edited) is detected. */
export function verifyQaReportBinding({ reportPath, artifactPath, expectedReportChecksum = null }) {
  let reportChecksum; let parsed;
  try { reportChecksum = sha256OfFile(reportPath); parsed = JSON.parse(fs.readFileSync(reportPath, 'utf8')); } catch { return { bound: false, reason: 'REPORT_UNREADABLE' }; }
  if (parsed?.artifact_type !== QA_REPORT_TYPE) return { bound: false, reason: 'NOT_A_QA_REPORT' };
  if (expectedReportChecksum && reportChecksum !== expectedReportChecksum) return { bound: false, reason: 'REPORT_CHECKSUM_MISMATCH' };
  let artifactChecksum;
  try { artifactChecksum = sha256OfFile(artifactPath); } catch { return { bound: false, reason: 'ARTIFACT_UNREADABLE' }; }
  if (parsed.file?.sha256 !== artifactChecksum) return { bound: false, reason: 'ARTIFACT_CHECKSUM_MISMATCH' };
  return { bound: true, reportChecksum, artifactChecksum };
}