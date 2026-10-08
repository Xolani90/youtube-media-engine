// Manual, opt-in, one-shot acceptance proof for the whisper.cpp ASR worker.
// NOT part of `npm test`. Uses the REAL whisper.cpp executable and model --
// never a stand-in -- so a PROVEN result always means genuine ASR.
//
// Usage:
//   export WHISPER_CPP_BIN=/path/to/whisper-cli        # default: whisper-cli on PATH
//   export WHISPER_CPP_MODEL=/path/to/ggml-base.en.bin  # required
//   node scripts/prove-asr-whisper-cpp.js               # synthesizes REAL Kokoro narration, then transcribes it
//   node scripts/prove-asr-whisper-cpp.js path/to/narration.wav   # transcribe an existing narration artifact
//
// With no argument the script runs the real Kokoro narration worker
// (NARRATION_PROVIDER=kokoro semantics: a Kokoro failure is a hard failure,
// never a silent downgrade to espeak-ng) on a fixed text and checks that the
// transcript recovers that text. With an argument it cannot know which TTS
// made the file, and says so.
//
// Exit codes: 0 = PROVEN; 1 = proof failed; 2 = missing prerequisite.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { synthesizeNarration, probeDurationSeconds } from '../src/media/narration.js';
import { transcribeAudio, writeTranscriptArtifact, validateAsrResult, AsrError } from '../src/media/asrWorker.js';
import { sha256File } from '../src/media/artifactStore.js';

const SAMPLE_TEXT = 'Local speech recognition turns narration audio into text with timestamps. This sentence checks that the transcript matches what was spoken.';

const words = (t) => t.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
const log = (m) => console.log(m);

async function main() {
  const argAudio = process.argv[2];
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'prove-asr-'));
  log(`work dir: ${work}`);

  let audioPath = argAudio;
  let expectedText = null;
  let kokoroUsed = false;
  if (!audioPath) {
    audioPath = path.join(work, 'narration.wav');
    log('synthesizing REAL Kokoro narration (first run may download the model)...');
    try {
      const n = synthesizeNarration(SAMPLE_TEXT, audioPath, { mode: 'kokoro' });
      kokoroUsed = n.provider === 'kokoro';
    } catch (err) {
      log(`PREREQUISITE MISSING: Kokoro narration failed: ${String(err.message).split('\n')[0]}`);
      return 2;
    }
    expectedText = SAMPLE_TEXT;
  } else if (!fs.existsSync(audioPath)) {
    log(`PREREQUISITE MISSING: audio file not found: ${audioPath}`);
    return 2;
  }

  const duration = probeDurationSeconds(audioPath);
  log(`audio: ${audioPath} (${duration.toFixed(2)}s, sha256 ${sha256File(audioPath).slice(0, 16)}...)`);

  let result;
  try {
    result = transcribeAudio(audioPath, { durationSeconds: duration });
  } catch (err) {
    const missing = err instanceof AsrError && ['ASR_EXECUTABLE_UNAVAILABLE', 'ASR_MODEL_UNAVAILABLE'].includes(err.reason);
    log(`${missing ? 'PREREQUISITE MISSING' : 'FAIL'}: ${err.message}`);
    return missing ? 2 : 1;
  }

  validateAsrResult(result, duration);
  const artifact = writeTranscriptArtifact(work, result, { audioPath });
  const text = result.segments.map((s) => s.text).join(' ');
  const last = result.segments.at(-1);

  log('--- evidence ---');
  log(`whisper.cpp executed: YES`);
  log(`provider observed: ${result.provider} (model ${result.model}, language ${result.language})`);
  log(`audio input: ${argAudio ? 'supplied file (TTS provider not verifiable by this script)' : `real Kokoro narration.wav (kokoro=${kokoroUsed})`}`);
  log(`transcript: ${JSON.stringify(text)}`);
  log(`segments: ${result.segments.length}`);
  log(`timestamps valid: YES (numeric, ordered, end>=start, within ${duration.toFixed(2)}s audio)`);
  log(`last segment ends at ${last.end.toFixed(2)}s of ${duration.toFixed(2)}s`);
  log(`transcript artifact: ${artifact.path}`);
  log(`artifact checksum: ${artifact.checksum} (recomputed: ${sha256File(artifact.path) === artifact.checksum ? 'MATCH' : 'MISMATCH'})`);

  if (sha256File(artifact.path) !== artifact.checksum) return 1;
  if (expectedText) {
    const heard = new Set(words(text));
    const want = words(expectedText);
    const recall = want.filter((w) => heard.has(w)).length / want.length;
    log(`text recovery vs spoken text: ${(recall * 100).toFixed(0)}% of words`);
    if (recall < 0.5) { log('FAIL: transcript does not resemble the spoken text'); return 1; }
  }
  log('RESULT: ASR whisper.cpp PROVEN');
  return 0;
}

main().then((code) => process.exit(code), (err) => { console.error(err); process.exit(1); });
