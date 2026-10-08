import { execFileSync } from 'node:child_process';

// Background-music mixing with narration-keyed ducking (worker capability).
//
// SCOPE: this module is audio signal processing only. It never selects music,
// never decides whether an asset is allowed, and never touches rights,
// publication or Gate 2. The caller (pipeline.js) hands it an asset that has
// ALREADY passed the existing D-G2 rights re-check and checksum verification;
// there is deliberately no code path here that can authorize anything.
//
// Signal path (built as ONE FFmpeg filter graph inside the existing mux step):
//   narration ─┬──────────────────────────────┐
//              └─ key ─┐                      ├─ amix ─ loudnorm (EXISTING R128) ─ aac
//   music ─ gain ─ fades ─ sidechaincompress ──┘
// Ducking is FFmpeg's sidechaincompress keyed by the narration, so the music is
// attenuated only while narration energy exceeds the threshold, and recovers
// over `release_ms` in gaps. The existing loudnorm stays LAST, on the mix, so
// the final artifact is normalized exactly as the narration-only path is.

export const MUSIC_ASSET_TYPE = 'music';

/** Fixed, versioned defaults. No randomness and no environment tuning: same inputs -> same graph. */
export const MUSIC_MIX_DEFAULTS = Object.freeze({
  version: 1,
  music_gain_db: -12,      // music level before ducking, relative to narration
  threshold: 0.02,         // sidechain linear threshold (~ -34 dBFS): speech exceeds it, room noise does not
  ratio: 12,               // compression ratio applied to the music while narration is present
  attack_ms: 20,           // fast enough that the music is down before words start landing
  release_ms: 600,         // slow recovery: no pumping between words, returns in real gaps
  makeup: 1,
  fade_in_seconds: 0.5,
  fade_out_seconds: 1.5
});

export class AudioMixError extends Error {
  constructor(reason, detail = '') {
    super(`audio_mix_${reason}${detail ? `: ${detail}` : ''}`);
    this.name = 'AudioMixError';
    this.reason = reason;
  }
}

/** MUSIC_DUCKING=on (default) | off. Only has an effect when a music asset is attached. Mirrors resolveMotionEnabled. */
export function resolveMusicMixEnabled(env = process.env) {
  const v = (env.MUSIC_DUCKING ?? 'on').trim().toLowerCase();
  if (v === '' || v === 'on' || v === '1' || v === 'true') return true;
  if (v === 'off' || v === '0' || v === 'false' || v === 'none') return false;
  throw new AudioMixError('CONFIG_INVALID', `MUSIC_DUCKING must be one of on, off (got "${v}")`);
}

/**
 * The attached music asset to use: asset_type === 'music', lowest id first (a
 * deterministic total order). Selection among attached assets only; this never
 * chooses or acquires music.
 */
export function selectMusicAsset(assets) {
  const music = (assets ?? []).filter((a) => a.asset_type === MUSIC_ASSET_TYPE);
  music.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return music[0] ?? null;
}

const RANGES = Object.freeze({
  music_gain_db: [-60, 0],
  threshold: [0.001, 1],
  ratio: [1, 20],
  attack_ms: [0.01, 2000],
  release_ms: [0.01, 9000],
  makeup: [1, 64],
  fade_in_seconds: [0, 10],
  fade_out_seconds: [0, 10]
});

/** Returns a complete, validated parameter object (defaults + overrides). Throws AudioMixError on any invalid value. */
export function resolveMixParams(overrides = {}) {
  const params = { ...MUSIC_MIX_DEFAULTS, ...overrides };
  for (const [key, [lo, hi]] of Object.entries(RANGES)) {
    const v = params[key];
    if (typeof v !== 'number' || !Number.isFinite(v) || v < lo || v > hi) {
      throw new AudioMixError('PARAMS_INVALID', `${key} must be a number in [${lo}, ${hi}] (got ${v})`);
    }
  }
  return params;
}

const num = (n) => String(Math.round(n * 1e6) / 1e6);

/**
 * Pure: the filter_complex string for narration (input 1) + music (input 2).
 * Same params + duration + sample rate + loudnorm targets -> byte-identical string.
 */
export function buildMusicMixFilter({ params, narrationDurationSeconds, sampleRate, loudnorm }) {
  const p = resolveMixParams(params);
  if (typeof narrationDurationSeconds !== 'number' || !Number.isFinite(narrationDurationSeconds) || narrationDurationSeconds <= 0) {
    throw new AudioMixError('DURATION_INVALID', `narration duration must be > 0 (got ${narrationDurationSeconds})`);
  }
  if (!Number.isInteger(sampleRate) || sampleRate <= 0) throw new AudioMixError('SAMPLE_RATE_INVALID', String(sampleRate));
  const d = Math.round(narrationDurationSeconds * 1000) / 1000;
  const fadeIn = Math.min(p.fade_in_seconds, d);
  const fadeOut = Math.min(p.fade_out_seconds, d);
  const common = `aresample=${sampleRate},aformat=sample_fmts=fltp:channel_layouts=stereo`;
  return [
    `[1:a]${common},asplit=2[nar][key]`,
    `[2:a]${common},volume=${num(p.music_gain_db)}dB,afade=t=in:st=0:d=${num(fadeIn)},afade=t=out:st=${num(d - fadeOut)}:d=${num(fadeOut)}[mus]`,
    `[mus][key]sidechaincompress=threshold=${num(p.threshold)}:ratio=${num(p.ratio)}:attack=${num(p.attack_ms)}:release=${num(p.release_ms)}:makeup=${num(p.makeup)}[duck]`,
    `[nar][duck]amix=inputs=2:duration=first:dropout_transition=0[mix]`,
    // loudnorm === null only when the caller explicitly opted out of normalization (normalizeLoudness: false).
    loudnorm
      ? `[mix]loudnorm=I=${loudnorm.I}:TP=${loudnorm.TP}:LRA=${loudnorm.LRA}[aout]`
      : '[mix]anull[aout]'
  ].join(';');
}

/**
 * Confirms a music file is a decodable audio file with positive duration.
 * Throws AudioMixError; the pipeline maps that onto the existing RENDER_FAILED
 * semantics (an unusable music file never silently degrades the artifact).
 */
export function probeMusicFile(filePath) {
  let info;
  try {
    info = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', filePath], { stdio: ['ignore', 'pipe', 'pipe'] }).toString());
  } catch (err) {
    throw new AudioMixError('MUSIC_INVALID', `ffprobe could not read the file (${String(err.message).split('\n')[0]})`);
  }
  const audio = (info.streams ?? []).find((s) => s.codec_type === 'audio');
  if (!audio) throw new AudioMixError('MUSIC_INVALID', 'no audio stream');
  const duration = parseFloat(audio.duration ?? info.format?.duration);
  if (!Number.isFinite(duration) || duration <= 0) throw new AudioMixError('MUSIC_INVALID', `non-positive duration (${duration})`);
  return { duration_seconds: duration, codec: audio.codec_name, sample_rate: Number(audio.sample_rate) || null, channels: audio.channels ?? null };
}
