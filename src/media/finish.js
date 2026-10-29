import { spawnSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { runFfmpeg, FfmpegExecError } from './ffmpegFailure.js';

// Cinematic finishing pass (worker capability, long-form only).
//
// SCOPE: pure signal processing on an ALREADY RENDERED and muxed file: colour
// grade, BT.709 tagging, fades, two-pass loudness normalisation and a
// true-peak limiter. It never selects assets, never touches rights, the
// database, Gate 2 or publication, and never changes the render spec (the
// finished file is the same container shape: h264 + aac, same resolution).
//
// Why a second pass at all: the muxed file's audio went through single-pass
// loudnorm (dynamic mode), which can overshoot true peak after AAC encoding, and
// the still-image render is untagged/flat. A failure here is a render failure
// (the pipeline never silently degrades the artifact).

export const FINISH_PROFILE = Object.freeze({ OFF: 'off', CINEMATIC: 'cinematic' });

/** Targets for the finished programme. -14 LUFS is YouTube's reference level; TP leaves AAC headroom. */
export const FINISH_AUDIO_TARGETS = Object.freeze({ I: -14, TP: -2, LRA: 9, LIMITER: 0.84 });
export const FINISH_FADE_SECONDS = Object.freeze({ IN: 0.8, OUT: 1.2 });

export class FinishError extends Error {
  constructor(reason, detail = '') {
    super(`finish_${reason}${detail ? `: ${detail}` : ''}`);
    this.name = 'FinishError';
    this.reason = reason;
  }
}

/** FINISH_PROFILE=cinematic (default) | off. */
export function resolveFinishProfile(env = process.env) {
  const v = (env.FINISH_PROFILE ?? FINISH_PROFILE.CINEMATIC).trim().toLowerCase();
  if (v === '') return FINISH_PROFILE.CINEMATIC;
  if (v === 'off' || v === '0' || v === 'false' || v === 'none') return FINISH_PROFILE.OFF;
  if (v === 'cinematic' || v === 'on' || v === '1' || v === 'true') return FINISH_PROFILE.CINEMATIC;
  throw new FinishError('CONFIG_INVALID', `FINISH_PROFILE must be one of cinematic, off (got "${v}")`);
}

/** RENDER_RESOLUTION=720 (default) | 1080 -> long-form frame size. Short-form keeps its own portrait frame. */
export function resolveRenderSize(env = process.env, defaults = { width: 1280, height: 720 }) {
  const v = (env.RENDER_RESOLUTION ?? '').trim();
  if (v === '' || v === '720') return { ...defaults };
  if (v === '1080') return { width: 1920, height: 1080 };
  throw new FinishError('CONFIG_INVALID', `RENDER_RESOLUTION must be 720 or 1080 (got "${v}")`);
}

const GRADE = Object.freeze({
  // Cool shadows / warm highlights, gentle S-curve, slight saturation, soft vignette.
  colorbalance: 'rs=-0.035:bs=0.05:rh=0.05:bh=-0.045',
  curve: '0/0 0.25/0.215 0.75/0.79 1/1',
  saturation: 1.08,
  vignette: 'PI/5'
});

/** Maps ffprobe stream tags to scale-filter input colour arguments (untagged SD/HD streams get a sane default). */
export function inputColour(stream) {
  const range = stream.color_range === 'pc' || String(stream.pix_fmt || '').startsWith('yuvj') ? 'pc' : 'tv';
  const known = { bt709: 'bt709', bt470bg: 'bt470bg', smpte170m: 'smpte170m' };
  const matrix = known[stream.color_space] ?? (Number(stream.height) >= 720 ? 'bt709' : 'smpte170m');
  return { range, matrix };
}

const fixed = (n) => Number(n).toFixed(3);

/** Pure: the -vf chain for the finishing pass. Output keeps the input frame size. */
export function buildFinishVideoFilter({ stream, durationSeconds }) {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) throw new FinishError('DURATION_INVALID', String(durationSeconds));
  const { range, matrix } = inputColour(stream);
  const fadeOutStart = Math.max(0, durationSeconds - FINISH_FADE_SECONDS.OUT);
  return [
    `scale=iw:ih:flags=lanczos+accurate_rnd:in_range=${range}:in_color_matrix=${matrix}:out_range=pc`,
    'format=gbrp',
    `colorbalance=${GRADE.colorbalance}`,
    `curves=all='${GRADE.curve}'`,
    `eq=saturation=${GRADE.saturation}`,
    `vignette=${GRADE.vignette}`,
    'scale=out_range=tv:out_color_matrix=bt709:flags=lanczos+accurate_rnd',
    'format=yuv420p',
    // Fades come LAST, in the final limited-range YUV, so they end on true black (luma 16).
    // Fading earlier, in full-range RGB, ended at luma ~30 on FFmpeg 9.0.2 (grey flash at both ends).
    `fade=t=in:st=0:d=${FINISH_FADE_SECONDS.IN}`,
    `fade=t=out:st=${fixed(fadeOutStart)}:d=${FINISH_FADE_SECONDS.OUT}`
  ].join(',');
}

/** Pure: audio chain. `measured` null -> measuring pass (JSON stats); otherwise the linear second pass. */
export function buildFinishAudioFilter({ measured = null, durationSeconds, channels = 1 }) {
  const t = FINISH_AUDIO_TARGETS;
  // Mono narration is duplicated to both channels; true stereo input keeps its channels.
  const voice = `${voicePan(channels)},highpass=f=70`;
  const base = `loudnorm=I=${t.I}:TP=${t.TP}:LRA=${t.LRA}`;
  if (!measured) return `${voice},${base}:print_format=json`;
  const m = measured;
  const fadeOutStart = Math.max(0, durationSeconds - FINISH_FADE_SECONDS.OUT);
  return [
    voice,
    `${base}:measured_I=${m.input_i}:measured_TP=${m.input_tp}:measured_LRA=${m.input_lra}:measured_thresh=${m.input_thresh}:offset=${m.target_offset}:linear=true`,
    'aresample=48000',
    `alimiter=limit=${t.LIMITER}:level=disabled`,
    `afade=t=in:st=0:d=${FINISH_FADE_SECONDS.IN}`,
    `afade=t=out:st=${fixed(fadeOutStart)}:d=${FINISH_FADE_SECONDS.OUT}`
  ].join(',');
}

/** Pure: when the source is already 2-channel, keep the channels instead of duplicating channel 0. */
export function voicePan(channels) {
  return Number(channels) >= 2 ? 'pan=stereo|c0=c0|c1=c1' : 'pan=stereo|c0=c0|c1=c0';
}

export function probeForFinish(filePath) {
  let info;
  try {
    info = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', filePath], { stdio: ['ignore', 'pipe', 'pipe'] }).toString());
  } catch (err) {
    throw new FinishError('PROBE_FAILED', String(err.message).split('\n')[0]);
  }
  const video = (info.streams ?? []).find((s) => s.codec_type === 'video');
  const audio = (info.streams ?? []).find((s) => s.codec_type === 'audio');
  const duration = parseFloat(info.format?.duration);
  if (!video) throw new FinishError('NO_VIDEO_STREAM');
  if (!audio) throw new FinishError('NO_AUDIO_STREAM');
  if (!Number.isFinite(duration) || duration <= 0) throw new FinishError('DURATION_INVALID', String(duration));
  return { video, audio, duration };
}

/** Parses the JSON block loudnorm prints to stderr in measuring mode. */
export function parseLoudnormJson(stderr) {
  const text = String(stderr ?? '');
  const start = text.lastIndexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end < start) throw new FinishError('MEASURE_FAILED', 'no loudnorm JSON in output');
  const j = JSON.parse(text.slice(start, end + 1));
  for (const k of ['input_i', 'input_tp', 'input_lra', 'input_thresh', 'target_offset']) {
    if (!Number.isFinite(Number(j[k]))) throw new FinishError('MEASURE_FAILED', `${k} not finite (${j[k]})`);
  }
  return j;
}

function measureLoudness(inputPath, audioFilter, durationSeconds) {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-nostdin', '-i', inputPath, '-vn', '-af', audioFilter, '-t', String(durationSeconds), '-f', 'null', '-'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.error) throw new FfmpegExecError('finish_measure', r.error);
  if (r.status !== 0) throw new FfmpegExecError('finish_measure', { status: r.status, signal: r.signal, stderr: r.stderr });
  return parseLoudnormJson(r.stderr);
}

/**
 * Two-pass finishing encode: measure the programme, then grade + normalise + tag in one encode.
 * inputPath and outputPath must differ; the caller owns promotion/cleanup.
 */
export function finishRenderedVideo({ inputPath, outputPath, preset = 'veryfast', crf = 19 }) {
  if (inputPath === outputPath) throw new FinishError('PATHS_EQUAL');
  const info = probeForFinish(inputPath);
  const channels = info.audio.channels;
  const measured = measureLoudness(inputPath, buildFinishAudioFilter({ measured: null, durationSeconds: info.duration, channels }), info.duration);
  const af = buildFinishAudioFilter({ measured, durationSeconds: info.duration, channels });
  const vf = buildFinishVideoFilter({ stream: info.video, durationSeconds: info.duration });
  runFfmpeg('finish', [
    '-y', '-hide_banner', '-nostdin', '-i', inputPath,
    '-vf', vf, '-af', af,
    '-t', String(info.duration),
    '-c:v', 'libx264', '-preset', preset, '-crf', String(crf), '-profile:v', 'high',
    '-pix_fmt', 'yuv420p', '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv',
    '-c:a', 'aac', '-b:a', '192k', '-ar', '48000',
    '-movflags', '+faststart',
    outputPath
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  if (!fs.existsSync(outputPath) || fs.statSync(outputPath).size <= 0) throw new FinishError('OUTPUT_MISSING');
  return { measured, durationSeconds: info.duration };
}
