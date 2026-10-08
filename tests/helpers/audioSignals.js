// Test helper (NOT a test: outside tests/unit and tests/integration, so not matched by the `npm test` globs).
//
// Synthetic, license-free audio for audio-mix tests and the proof script, plus an
// objective tone-level meter. Signals are chosen so each contribution to a mix is
// separable by FREQUENCY: "narration" is a 1 kHz burst, "music" a continuous 220 Hz
// tone. A Goertzel filter on the decoded mix then measures how loud each is inside
// any time window -- no reliance on filter-command strings.

import { execFileSync, spawnSync } from 'node:child_process';

export const NARRATION_HZ = 1000;
export const MUSIC_HZ = 220;

/** Mono 22.05 kHz WAV: 1 kHz bursts at the given [start,end] second windows, silence elsewhere. */
export function writeBurstNarrationWav(file, { duration, bursts, amplitude = 0.5 }) {
  const gate = bursts.map(([a, b]) => `between(t,${a},${b})`).join('+');
  execFileSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', `aevalsrc='${amplitude}*sin(2*PI*${NARRATION_HZ}*t)*(${gate})':s=22050:d=${duration}`, '-ac', '1', file], { stdio: 'ignore' });
}

/** Stereo 44.1 kHz WAV: continuous 220 Hz tone (the stand-in for a licensed music bed). */
export function writeMusicWav(file, { duration, amplitude = 0.5 }) {
  execFileSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', `sine=f=${MUSIC_HZ}:d=${duration}:sample_rate=44100`, '-af', `volume=${amplitude * 8}`, '-ac', '2', file], { stdio: 'ignore' });
}

export function writeSilentVideo(file, { duration }) {
  execFileSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', `color=c=black:s=320x180:r=24:d=${duration}`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', file], { stdio: 'ignore' });
}

/** Decode any media file's audio to mono float samples at `rate`. */
export function decodeMono(file, rate = 16000) {
  const buf = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-vn', '-ac', '1', '-ar', String(rate), '-f', 'f32le', '-'], { maxBuffer: 1 << 28 });
  return { samples: new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 4)), rate };
}

/** Tone level in dB (relative, consistent across calls) of `hz` within [from,to] seconds, via Goertzel. */
export function toneLevelDb(decoded, hz, from, to) {
  const { samples, rate } = decoded;
  const a = Math.max(0, Math.floor(from * rate));
  const b = Math.min(samples.length, Math.floor(to * rate));
  const n = b - a;
  if (n <= 0) throw new Error(`empty window ${from}-${to}`);
  const w = (2 * Math.PI * hz) / rate;
  const coeff = 2 * Math.cos(w);
  let s1 = 0; let s2 = 0;
  for (let i = a; i < b; i++) {
    const hann = 0.5 - 0.5 * Math.cos((2 * Math.PI * (i - a)) / (n - 1));
    const s0 = samples[i] * hann + coeff * s1 - s2;
    s2 = s1; s1 = s0;
  }
  const power = s1 * s1 + s2 * s2 - coeff * s1 * s2;
  const amp = (2 * Math.sqrt(Math.max(power, 1e-30))) / (n * 0.5);
  return 20 * Math.log10(Math.max(amp, 1e-12));
}

/** Integrated loudness (LUFS) of a media file's audio via FFmpeg's ebur128 meter (summary parsed from stderr). */
export function measureIntegratedLufs(file) {
  const r = spawnSync('ffmpeg', ['-nostats', '-i', file, '-vn', '-af', 'ebur128', '-f', 'null', '-'], { encoding: 'utf8', maxBuffer: 1 << 26 });
  const m = /Integrated loudness:\s*\n\s*I:\s*(-?[\d.]+) LUFS/.exec(r.stderr ?? '');
  if (!m) throw new Error('could not parse ebur128 summary');
  return parseFloat(m[1]);
}
