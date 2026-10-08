import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  AsrError, resolveAsrMode, resolveWhisperConfig, parseWhisperJson, validateAsrResult,
  transcribeAudio, writeTranscriptArtifact, TRANSCRIPT_ARTIFACT_TYPE
} from '../../src/media/asrWorker.js';
import { synthesizeNarration } from '../../src/media/narration.js';
import { sha256File } from '../../src/media/artifactStore.js';

const hasEspeak = spawnSync('espeak-ng', ['--version']).status === 0;
// The adapter tests below use a #!/bin/sh stand-in for the whisper.cpp CLI, which Windows cannot execute
// (same convention as the existing media tests).
const posixSkip = process.platform === 'win32' && 'requires a POSIX shell for the whisper.cpp stand-in';
const REAL_BIN = process.env.WHISPER_CPP_BIN;
const REAL_MODEL = process.env.WHISPER_CPP_MODEL;

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'asr-test-'));
}

/** A real 3-second WAV (sine tone) made by FFmpeg. Used only to exercise the adapter around a stand-in executable. */
function makeAudio(dir, seconds = 3) {
  const p = path.join(dir, 'audio.wav');
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`, p]);
  return p;
}

/**
 * Stand-in for the whisper.cpp CLI, ONLY for unit-testing the adapter's
 * argument handling, output parsing and failure paths. It is NOT used for
 * any acceptance proof. It honours `-of <prefix>` like the real CLI.
 */
function makeFakeWhisper(dir, behavior = 'ok') {
  const bin = path.join(dir, 'fake-whisper');
  const good = JSON.stringify({
    result: { language: 'en' },
    transcription: [
      { offsets: { from: 0, to: 1500 }, text: ' Hello there.' },
      { offsets: { from: 1500, to: 2900 }, text: ' This is a test.' }
    ]
  });
  const bodies = {
    ok: `printf '%s' '${good}' > "$PREFIX.json"`,
    malformed: `printf '%s' 'not json' > "$PREFIX.json"`,
    nooutput: ':',
    fail: 'echo "boom" >&2; exit 3',
    beyond: `printf '%s' '{"transcription":[{"offsets":{"from":0,"to":99000},"text":"x"}]}' > "$PREFIX.json"`,
    unordered: `printf '%s' '{"transcription":[{"offsets":{"from":2000,"to":2500},"text":"a"},{"offsets":{"from":100,"to":900},"text":"b"}]}' > "$PREFIX.json"`,
    backwards: `printf '%s' '{"transcription":[{"offsets":{"from":900,"to":100},"text":"a"}]}' > "$PREFIX.json"`,
    empty: `printf '%s' '{"transcription":[{"offsets":{"from":0,"to":500},"text":"  "}]}' > "$PREFIX.json"`,
    zero: `printf '%s' '{"transcription":[]}' > "$PREFIX.json"`
  };
  fs.writeFileSync(bin, `#!/bin/sh\nPREFIX=""\nwhile [ $# -gt 0 ]; do if [ "$1" = "-of" ]; then PREFIX="$2"; fi; shift; done\n${bodies[behavior]}\n`, { mode: 0o755 });
  const model = path.join(dir, 'ggml-fake.bin');
  fs.writeFileSync(model, 'model');
  return { bin, model };
}

function envFor({ bin, model }, extra = {}) {
  return { ...process.env, WHISPER_CPP_BIN: bin, WHISPER_CPP_MODEL: model, ...extra };
}

// --- 1. Adapter contract + 4. provider identity ---

test('adapter contract: valid audio -> structured whisper.cpp result', { skip: posixSkip }, () => {
  const dir = tmpDir();
  try {
    const audio = makeAudio(dir);
    const r = transcribeAudio(audio, { env: envFor(makeFakeWhisper(dir)), durationSeconds: 3 });
    assert.equal(r.provider, 'whisper.cpp');
    assert.equal(r.donor.name, 'whisper.cpp');
    assert.equal(r.donor.license, 'MIT');
    assert.equal(r.language, 'en');
    assert.equal(r.duration, 3);
    assert.equal(r.timestampFormat, 'seconds');
    assert.equal(r.model, 'ggml-fake.bin');
    assert.equal(r.words, null, 'word timestamps are never fabricated');
    assert.equal(r.segments.length, 2);
    assert.equal(r.segments[0].text, 'Hello there.');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// --- 2. Timestamps ---

test('segment timestamps are numeric, ordered, end >= start, in seconds', { skip: posixSkip }, () => {
  const dir = tmpDir();
  try {
    const audio = makeAudio(dir);
    const { segments } = transcribeAudio(audio, { env: envFor(makeFakeWhisper(dir)), durationSeconds: 3 });
    let prev = -Infinity;
    for (const s of segments) {
      assert.equal(typeof s.start, 'number');
      assert.equal(typeof s.end, 'number');
      assert.ok(s.end >= s.start);
      assert.ok(s.start >= prev);
      prev = s.start;
    }
    assert.deepEqual(segments.map((s) => [s.start, s.end]), [[0, 1.5], [1.5, 2.9]]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// --- 3. Transcript on a real fixture (only where real whisper.cpp + espeak-ng exist) ---

test('REAL whisper.cpp: non-empty transcript with valid timestamps for a spoken fixture',
  { skip: !(REAL_BIN && REAL_MODEL && hasEspeak) && 'needs WHISPER_CPP_BIN, WHISPER_CPP_MODEL and espeak-ng' },
  () => {
    const dir = tmpDir();
    try {
      const wav = path.join(dir, 'speech.wav');
      synthesizeNarration('This is a short test of local speech recognition.', wav, { mode: 'espeak-ng' });
      const r = transcribeAudio(wav);
      assert.equal(r.provider, 'whisper.cpp');
      assert.ok(r.segments.length > 0);
      assert.ok(r.segments.map((s) => s.text).join(' ').trim().length > 0);
      validateAsrResult(r, r.duration);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

// --- 5. Failure handling: always a controlled AsrError, never silent success ---

function assertAsrFailure(fn, reason) {
  assert.throws(fn, (err) => err instanceof AsrError && err.reason === reason, `expected ${reason}`);
}

test('failure: missing audio file', () => {
  const dir = tmpDir();
  try {
    assertAsrFailure(() => transcribeAudio(path.join(dir, 'nope.wav'), { env: envFor(makeFakeWhisper(dir)) }), 'ASR_AUDIO_MISSING');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('failure: unavailable executable', () => {
  const dir = tmpDir();
  try {
    const audio = makeAudio(dir);
    const f = makeFakeWhisper(dir);
    assertAsrFailure(() => transcribeAudio(audio, { env: envFor({ ...f, bin: path.join(dir, 'does-not-exist') }) }), 'ASR_EXECUTABLE_UNAVAILABLE');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('failure: model not configured, and model file missing', () => {
  const dir = tmpDir();
  try {
    const audio = makeAudio(dir);
    const f = makeFakeWhisper(dir);
    assertAsrFailure(() => transcribeAudio(audio, { env: envFor({ ...f, model: '' }) }), 'ASR_MODEL_UNAVAILABLE');
    assertAsrFailure(() => transcribeAudio(audio, { env: envFor({ ...f, model: path.join(dir, 'missing.bin') }) }), 'ASR_MODEL_UNAVAILABLE');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('failure: non-zero exit, no output file, malformed JSON, empty/invalid segments', { skip: posixSkip }, () => {
  const dir = tmpDir();
  try {
    const audio = makeAudio(dir);
    const cases = {
      fail: 'ASR_EXEC_FAILED', nooutput: 'ASR_OUTPUT_MISSING', malformed: 'ASR_OUTPUT_MALFORMED',
      zero: 'ASR_OUTPUT_INVALID', empty: 'ASR_OUTPUT_INVALID', backwards: 'ASR_OUTPUT_INVALID',
      unordered: 'ASR_OUTPUT_INVALID', beyond: 'ASR_OUTPUT_INVALID'
    };
    for (const [behavior, reason] of Object.entries(cases)) {
      assertAsrFailure(() => transcribeAudio(audio, { env: envFor(makeFakeWhisper(dir, behavior)), durationSeconds: 3 }), reason);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('parseWhisperJson rejects structurally wrong output', () => {
  assert.throws(() => parseWhisperJson('{}'), (e) => e.reason === 'ASR_OUTPUT_MALFORMED');
  assert.throws(() => parseWhisperJson('{"transcription":[{"text":"x"}]}'), (e) => e.reason === 'ASR_OUTPUT_MALFORMED');
});

test('config: ASR is off by default; invalid provider or timeout is rejected', () => {
  assert.equal(resolveAsrMode({}), 'none');
  assert.equal(resolveAsrMode({ ASR_PROVIDER: 'whisper.cpp' }), 'whisper.cpp');
  assert.throws(() => resolveAsrMode({ ASR_PROVIDER: 'vosk' }), (e) => e.reason === 'ASR_CONFIG_INVALID');
  assert.throws(() => resolveWhisperConfig({ WHISPER_CPP_TIMEOUT_MS: '-5' }), (e) => e.reason === 'ASR_CONFIG_INVALID');
});

// --- 7 (artifact): engine-owned transcript artifact + provenance + checksum ---

test('transcript artifact: provenance recorded, checksum matches the bytes, timing_source is asr', { skip: posixSkip }, () => {
  const dir = tmpDir();
  try {
    const audio = makeAudio(dir);
    const r = transcribeAudio(audio, { env: envFor(makeFakeWhisper(dir)), durationSeconds: 3 });
    const { path: p, checksum } = writeTranscriptArtifact(dir, r, { audioPath: audio });
    assert.equal(checksum, sha256File(p));
    const a = JSON.parse(fs.readFileSync(p, 'utf8'));
    assert.equal(a.artifact_type, TRANSCRIPT_ARTIFACT_TYPE);
    assert.equal(a.timing_source, 'asr');
    assert.equal(a.provider, 'whisper.cpp');
    assert.equal(a.input_audio.sha256, sha256File(audio));
    assert.equal(a.timestamp_format, 'seconds');
    assert.equal(a.segments.length, 2);
    assert.equal(fs.readdirSync(dir).filter((f) => f.startsWith('.transcript.json.tmp')).length, 0, 'no tmp file left behind');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// --- 6. Existing narration compatibility: the adapter accepts the audio the real narrator writes ---

test('accepts the audio artifact produced by the existing narration system (espeak-ng path)',
  { skip: posixSkip || (!hasEspeak && 'espeak-ng not installed') },
  () => {
    const dir = tmpDir();
    try {
      const wav = path.join(dir, 'narration.wav');
      synthesizeNarration('A short narration line for the compatibility check.', wav, { mode: 'espeak-ng' });
      const r = transcribeAudio(wav, { env: envFor(makeFakeWhisper(dir)), durationSeconds: 3 });
      assert.equal(r.provider, 'whisper.cpp');
      assert.ok(r.segments.length > 0);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
