import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NARRATION_ENGINE, NARRATION_PROVIDER } from './constants.js';

const KOKORO_WORKER = fileURLToPath(new URL('./kokoroWorker.js', import.meta.url));
const DEFAULT_KOKORO_TIMEOUT_MS = 10 * 60 * 1000; // first run may download the model

/** espeak-ng: local, free, deterministic CLI synthesis (the original v1 engine). */
function runEspeak(text, outputWavPath) {
  execFileSync(NARRATION_ENGINE, ['-w', outputWavPath, text], { stdio: ['ignore', 'ignore', 'pipe'] });
}

/**
 * Kokoro neural TTS (donor: hexgrad/kokoro-js, Apache-2.0) run as a child
 * process so this module's interface stays synchronous. Kokoro synthesizes
 * the exact text it is given and nothing else.
 */
function runKokoro(text, outputWavPath, { timeoutMs = DEFAULT_KOKORO_TIMEOUT_MS } = {}) {
  const textFile = path.join(os.tmpdir(), `kokoro-in-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
  fs.writeFileSync(textFile, text, 'utf8');
  try {
    execFileSync(process.execPath, [KOKORO_WORKER, textFile, outputWavPath], { stdio: ['ignore', 'ignore', 'pipe'], timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 });
    if (!fs.existsSync(outputWavPath) || fs.statSync(outputWavPath).size <= 44) {
      throw new Error('kokoro produced no audio data');
    }
  } catch (err) {
    const lines = String(err.stderr || '').split('\n').map((l) => l.trim()).filter(Boolean);
    const marked = lines.reverse().find((l) => l.startsWith('KOKORO_ERROR:'));
    const detail = marked ? marked.slice('KOKORO_ERROR:'.length).trim() : String(err.message || err).split('\n')[0].slice(0, 300);
    throw new Error(`kokoro failed: ${detail}`);
  } finally {
    fs.rmSync(textFile, { force: true });
  }
}

/** Provider policy from NARRATION_PROVIDER: 'espeak-ng' (default) | 'auto' | 'kokoro'. */
export function resolveNarrationProviderMode(env = process.env) {
  const v = (env.NARRATION_PROVIDER || NARRATION_PROVIDER.ESPEAK).trim().toLowerCase();
  if (![NARRATION_PROVIDER.ESPEAK, NARRATION_PROVIDER.AUTO, NARRATION_PROVIDER.KOKORO].includes(v)) {
    throw new Error(`NARRATION_PROVIDER must be one of espeak-ng, auto, kokoro (got "${v}")`);
  }
  return v;
}

/**
 * Synthesizes narration audio for `text` to `outputWavPath`.
 *
 * Provider mode (NARRATION_PROVIDER, or opts.mode):
 *   espeak-ng  espeak-ng only (default until Kokoro is proven on the host)
 *   auto       Kokoro preferred; ANY Kokoro failure falls back to espeak-ng
 *   kokoro     Kokoro only; a failure throws (no silent downgrade)
 *
 * Returns { provider, fallbackReason } where `provider` is the engine that
 * ACTUALLY produced the file, so callers can record it. Throws on failure of
 * the last engine tried -- the caller treats that as NARRATION_FAILED.
 * opts.engines is a fault-injection seam for tests.
 */
export function synthesizeNarration(text, outputWavPath, opts = {}) {
  if (!text || !text.trim()) {
    throw new Error('synthesizeNarration requires non-empty text');
  }
  const mode = opts.mode ?? resolveNarrationProviderMode();
  const engines = { kokoro: runKokoro, [NARRATION_PROVIDER.ESPEAK]: runEspeak, ...(opts.engines || {}) };

  if (mode === NARRATION_PROVIDER.ESPEAK) {
    engines[NARRATION_PROVIDER.ESPEAK](text, outputWavPath);
    return { provider: NARRATION_PROVIDER.ESPEAK, fallbackReason: null };
  }
  try {
    engines.kokoro(text, outputWavPath);
    return { provider: NARRATION_PROVIDER.KOKORO, fallbackReason: null };
  } catch (err) {
    fs.rmSync(outputWavPath, { force: true });
    if (mode === NARRATION_PROVIDER.KOKORO) throw err;
    const fallbackReason = String(err.message).split('\n')[0].slice(0, 300);
    engines[NARRATION_PROVIDER.ESPEAK](text, outputWavPath);
    return { provider: NARRATION_PROVIDER.ESPEAK, fallbackReason };
  }
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