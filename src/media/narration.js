import { execFileSync } from 'node:child_process';
import { NARRATION_ENGINE } from './constants.js';

/**
 * Synthesizes narration audio for `text` to `outputWavPath` using
 * espeak-ng (Owner brief §5 — local, free, no API key, no provider
 * abstraction: this module hard-codes the one engine v1 supports).
 * espeak-ng is invoked directly via execFileSync — no npm wrapper
 * package exists or is needed for a single, explicit CLI invocation.
 *
 * Throws on any failure (missing binary, espeak-ng error, unwritable
 * path) — the caller is responsible for treating that as
 * NARRATION_FAILED and not proceeding to render.
 */
export function synthesizeNarration(text, outputWavPath) {
  if (!text || !text.trim()) {
    throw new Error('synthesizeNarration requires non-empty text');
  }
  execFileSync(NARRATION_ENGINE, ['-w', outputWavPath, text], { stdio: ['ignore', 'ignore', 'pipe'] });
}

/**
 * Measures the actual duration of an audio (or video) file via FFprobe
 * — never trusted as an estimate, always measured (Owner brief §5/§6).
 * Throws if FFprobe cannot determine a positive duration.
 */
export function probeDurationSeconds(filePath) {
  const out = execFileSync(
    'ffprobe',
    ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', filePath],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  ).toString().trim();
  const duration = parseFloat(out);
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error(`ffprobe could not determine a positive duration for ${filePath} (got "${out}")`);
  }
  return duration;
}