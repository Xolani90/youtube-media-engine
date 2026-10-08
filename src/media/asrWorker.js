import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ASR_PROVIDER, TIMING_SOURCE } from './constants.js';
import { finalizeArtifact, sha256File } from './artifactStore.js';
import { canonicalStringify } from '../production/manifest.js';

/**
 * Local ASR worker: audio -> transcript + segment timestamps.
 *
 * Donor: whisper.cpp (ggml-org/whisper.cpp, MIT) run as an external CLI
 * process, exactly as Kokoro is run as a child process by narration.js.
 * The engine keeps ownership of orchestration, state, retries, artifacts
 * and provenance; whisper.cpp only turns audio into timestamped text.
 *
 * Disabled by default. Set ASR_PROVIDER=whisper.cpp and WHISPER_CPP_MODEL
 * (path to a ggml model file) to enable. Optional:
 *   WHISPER_CPP_BIN         executable (default "whisper-cli")
 *   WHISPER_CPP_LANGUAGE    language code (default "en")
 *   WHISPER_CPP_TIMEOUT_MS  per-run timeout (default 10 minutes)
 *   WHISPER_CPP_VERSION     free-text donor version/commit to record
 *
 * Timestamps are segment-level. Word-level timestamps are NOT produced
 * and are never fabricated: `words` is null.
 */

const DEFAULT_BIN = 'whisper-cli';
const DEFAULT_LANGUAGE = 'en';
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
// whisper.cpp may round the last segment a little past the real audio end.
const DURATION_TOLERANCE_SECONDS = 1.0;

export const TRANSCRIPT_ARTIFACT_TYPE = 'asr_transcript_v1';
export const TRANSCRIPT_FILENAME = 'transcript.json';

/** Controlled ASR failure. `reason` is a stable machine-readable code. */
export class AsrError extends Error {
  constructor(reason, message) {
    super(message ? `${reason}: ${message}` : reason);
    this.name = 'AsrError';
    this.reason = reason;
  }
}

/** ASR_PROVIDER: unset/'none' -> disabled (default); 'whisper.cpp' -> enabled; anything else throws. */
export function resolveAsrMode(env = process.env) {
  const v = (env.ASR_PROVIDER ?? ASR_PROVIDER.NONE).trim().toLowerCase();
  if (v === '' || v === ASR_PROVIDER.NONE) return ASR_PROVIDER.NONE;
  if (v === ASR_PROVIDER.WHISPER_CPP) return ASR_PROVIDER.WHISPER_CPP;
  throw new AsrError('ASR_CONFIG_INVALID', `ASR_PROVIDER must be one of none, whisper.cpp (got "${v}")`);
}

export function resolveWhisperConfig(env = process.env) {
  const timeoutRaw = env.WHISPER_CPP_TIMEOUT_MS;
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  if (timeoutRaw !== undefined && String(timeoutRaw).trim() !== '') {
    timeoutMs = Number(timeoutRaw);
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new AsrError('ASR_CONFIG_INVALID', `WHISPER_CPP_TIMEOUT_MS must be a positive number of milliseconds (got "${timeoutRaw}")`);
    }
  }
  return {
    bin: (env.WHISPER_CPP_BIN || DEFAULT_BIN).trim(),
    model: (env.WHISPER_CPP_MODEL || '').trim(),
    language: (env.WHISPER_CPP_LANGUAGE || DEFAULT_LANGUAGE).trim(),
    version: (env.WHISPER_CPP_VERSION || '').trim() || null,
    timeoutMs
  };
}

/**
 * Parses whisper.cpp `-oj` JSON into segments. Throws AsrError on any
 * structural problem. Offsets are milliseconds in whisper.cpp output.
 */
export function parseWhisperJson(text) {
  let doc;
  try {
    doc = JSON.parse(text);
  } catch (err) {
    throw new AsrError('ASR_OUTPUT_MALFORMED', `output is not valid JSON (${err.message})`);
  }
  const transcription = doc?.transcription;
  if (!Array.isArray(transcription)) {
    throw new AsrError('ASR_OUTPUT_MALFORMED', 'missing "transcription" array');
  }
  const segments = transcription.map((seg, i) => {
    const from = seg?.offsets?.from;
    const to = seg?.offsets?.to;
    if (typeof from !== 'number' || typeof to !== 'number' || typeof seg?.text !== 'string') {
      throw new AsrError('ASR_OUTPUT_MALFORMED', `segment ${i} lacks numeric offsets.from/to or string text`);
    }
    return { start: from / 1000, end: to / 1000, text: seg.text.trim() };
  });
  const language = typeof doc?.result?.language === 'string' ? doc.result.language : null;
  return { language, segments };
}

/** Validates a parsed result against the real audio duration. Throws AsrError('ASR_OUTPUT_INVALID'). */
export function validateAsrResult({ segments }, durationSeconds) {
  const bad = (msg) => { throw new AsrError('ASR_OUTPUT_INVALID', msg); };
  if (!Array.isArray(segments) || segments.length === 0) bad('no segments');
  let prevStart = -Infinity;
  segments.forEach((s, i) => {
    if (!Number.isFinite(s.start) || !Number.isFinite(s.end)) bad(`segment ${i} has non-numeric timestamps`);
    if (s.start < 0) bad(`segment ${i} starts before 0`);
    if (s.end < s.start) bad(`segment ${i} ends before it starts`);
    if (s.start < prevStart) bad(`segment ${i} starts before the previous segment`);
    if (Number.isFinite(durationSeconds) && s.end > durationSeconds + DURATION_TOLERANCE_SECONDS) {
      bad(`segment ${i} ends at ${s.end}s, beyond audio duration ${durationSeconds}s`);
    }
    prevStart = s.start;
  });
  if (!segments.some((s) => s.text.length > 0)) bad('transcript text is empty');
}

function describeExecError(err, timeoutMs) {
  if (err.code === 'ETIMEDOUT' || err.killed === true) return `timed out after ${timeoutMs}ms (raise WHISPER_CPP_TIMEOUT_MS)`;
  const stderr = String(err.stderr || '').split('\n').map((l) => l.trim()).filter(Boolean);
  return (stderr.at(-1) || String(err.message || err).split('\n')[0]).slice(0, 300);
}

/**
 * Transcribes `audioPath` with whisper.cpp. Synchronous (child process),
 * like narration.js. Returns a structured, validated result:
 *   { provider: 'whisper.cpp', donor, model, language, duration,
 *     segments: [{start, end, text}], words: null, timestampFormat }
 * Throws AsrError on any failure -- never returns partial/fake data.
 *
 * @param {string} audioPath existing narration audio (any format ffmpeg reads)
 * @param {object} [opts]
 * @param {number} [opts.durationSeconds] measured narration duration (probed when omitted)
 * @param {object} [opts.env]
 */
export function transcribeAudio(audioPath, opts = {}) {
  const env = opts.env ?? process.env;
  const cfg = resolveWhisperConfig(env);

  if (!audioPath || !fs.existsSync(audioPath) || fs.statSync(audioPath).size <= 44) {
    throw new AsrError('ASR_AUDIO_MISSING', `no usable audio at ${audioPath}`);
  }
  if (!cfg.model) throw new AsrError('ASR_MODEL_UNAVAILABLE', 'WHISPER_CPP_MODEL is not set');
  if (!fs.existsSync(cfg.model)) throw new AsrError('ASR_MODEL_UNAVAILABLE', `model file not found: ${cfg.model}`);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'asr-'));
  try {
    // whisper.cpp wants 16 kHz mono 16-bit PCM WAV.
    const wav16 = path.join(tmp, 'input16k.wav');
    try {
      execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', audioPath, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', wav16], { stdio: ['ignore', 'ignore', 'pipe'] });
    } catch (err) {
      throw new AsrError('ASR_CONVERSION_FAILED', describeExecError(err, 0));
    }

    const outPrefix = path.join(tmp, 'out');
    try {
      execFileSync(cfg.bin, ['-m', cfg.model, '-f', wav16, '-l', cfg.language, '-oj', '-of', outPrefix, '-np'], {
        stdio: ['ignore', 'ignore', 'pipe'], timeout: cfg.timeoutMs, maxBuffer: 16 * 1024 * 1024
      });
    } catch (err) {
      if (err.code === 'ENOENT') throw new AsrError('ASR_EXECUTABLE_UNAVAILABLE', `cannot execute "${cfg.bin}" (set WHISPER_CPP_BIN)`);
      throw new AsrError('ASR_EXEC_FAILED', describeExecError(err, cfg.timeoutMs));
    }

    const jsonPath = `${outPrefix}.json`;
    if (!fs.existsSync(jsonPath)) throw new AsrError('ASR_OUTPUT_MISSING', 'whisper.cpp produced no JSON output');
    const parsed = parseWhisperJson(fs.readFileSync(jsonPath, 'utf8'));

    let duration = opts.durationSeconds;
    if (!Number.isFinite(duration) || duration <= 0) {
      duration = Number.parseFloat(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', audioPath], { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim());
    }
    validateAsrResult(parsed, duration);

    return {
      provider: ASR_PROVIDER.WHISPER_CPP,
      donor: { name: 'whisper.cpp', license: 'MIT', version: cfg.version },
      model: path.basename(cfg.model),
      language: parsed.language ?? cfg.language,
      duration,
      timestampFormat: 'seconds',
      segments: parsed.segments,
      words: null
    };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * Persists the engine-owned transcript artifact next to narration.wav
 * (`<dir>/transcript.json`) using the existing tmp -> atomic rename
 * convention, and returns { path, checksum } (sha256 of the file bytes).
 * Records provenance: provider/donor/model, input audio + its checksum,
 * timestamp format, language, duration, and timing_source 'asr'.
 */
export function writeTranscriptArtifact(dir, result, { audioPath }) {
  const finalPath = path.join(dir, TRANSCRIPT_FILENAME);
  const tmpPath = path.join(dir, `.${TRANSCRIPT_FILENAME}.tmp-${process.pid}-${Date.now()}`);
  const artifact = {
    artifact_type: TRANSCRIPT_ARTIFACT_TYPE,
    timing_source: TIMING_SOURCE.ASR,
    provider: result.provider,
    donor: result.donor,
    model: result.model,
    language: result.language,
    duration_seconds: result.duration,
    timestamp_format: result.timestampFormat,
    input_audio: { file: path.basename(audioPath), sha256: sha256File(audioPath) },
    segments: result.segments,
    words: result.words
  };
  try {
    fs.writeFileSync(tmpPath, canonicalStringify(artifact), 'utf8');
    finalizeArtifact(tmpPath, finalPath);
  } finally {
    fs.rmSync(tmpPath, { force: true });
  }
  return { path: finalPath, checksum: sha256File(finalPath) };
}
