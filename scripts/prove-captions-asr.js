// Manual, opt-in, one-shot acceptance proof for the ASR caption worker.
// NOT part of `npm test`. REAL Kokoro narration -> REAL whisper.cpp ->
// caption worker -> SRT caption artifact. No stand-ins, no fabricated audio.
//
// Usage (same env as scripts/prove-asr-whisper-cpp.js):
//   export WHISPER_CPP_BIN=/path/to/whisper-cli
//   export WHISPER_CPP_MODEL=/path/to/ggml-base.en.bin
//   node scripts/prove-captions-asr.js
//
// Exit codes: 0 = PROVEN; 1 = proof failed; 2 = missing prerequisite.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { synthesizeNarration, probeDurationSeconds } from '../src/media/narration.js';
import { transcribeAudio, writeTranscriptArtifact } from '../src/media/asrWorker.js';
import { buildCaptionsFromAsr, textCorrespondence } from '../src/media/asrCaptions.js';
import { writeSrtFile } from '../src/media/render.js';
import { sha256File } from '../src/media/artifactStore.js';
import { AsrError } from '../src/media/asrWorker.js';

const TEXT = 'Local speech recognition turns narration audio into text with timestamps. This sentence checks that the transcript matches what was spoken. Captions should appear exactly when each phrase is said.';
const log = (m) => console.log(m);

function parseSrt(text) {
  const ts = (h, m, s, ms) => Number(h) * 3600 + Number(m) * 60 + Number(s) + Number(ms) / 1000;
  return text.trim().split(/\n\n+/).map((b) => {
    const [, time, ...rest] = b.split('\n');
    const m = time.match(/(\d+):(\d+):(\d+),(\d+) --> (\d+):(\d+):(\d+),(\d+)/);
    return { start: ts(...m.slice(1, 5)), end: ts(...m.slice(5, 9)), text: rest.join(' ') };
  });
}

async function main() {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'prove-captions-'));
  const audioPath = path.join(work, 'narration.wav');
  log(`work dir: ${work}`);
  let narration;
  try { narration = synthesizeNarration(TEXT, audioPath, { mode: 'kokoro' }); }
  catch (err) { log(`PREREQUISITE MISSING: Kokoro narration failed: ${String(err.message).split('\n')[0]}`); return 2; }
  const duration = probeDurationSeconds(audioPath);

  let asr;
  try { asr = transcribeAudio(audioPath, { durationSeconds: duration }); }
  catch (err) {
    const missing = err instanceof AsrError && ['ASR_EXECUTABLE_UNAVAILABLE', 'ASR_MODEL_UNAVAILABLE'].includes(err.reason);
    log(`${missing ? 'PREREQUISITE MISSING' : 'FAIL'}: ${err.message}`);
    return missing ? 2 : 1;
  }
  const transcript = writeTranscriptArtifact(work, asr, { audioPath });

  let captions;
  try { captions = buildCaptionsFromAsr(asr.segments, duration, { narrationText: TEXT }); }
  catch (err) { log(`FAIL: caption worker rejected real ASR output: ${err.message}`); return 1; }

  const srtPath = path.join(work, 'captions.srt');
  writeSrtFile(captions, srtPath); // the exact writer the burn-in path uses
  const srtSum = sha256File(srtPath);
  const parsed = parseSrt(fs.readFileSync(srtPath, 'utf8'));

  const ordered = parsed.every((c, i) => c.end >= c.start && c.start >= (i ? parsed[i - 1].end - 0.001 : 0));
  const inside = parsed.every((c) => c.start >= 0 && c.end <= duration + 0.001);
  const roundTrip = parsed.length === captions.length && parsed.every((c, i) => c.text === captions[i].text && Math.abs(c.start - captions[i].start_seconds) < 0.002);
  const asrJoined = asr.segments.map((s) => s.text).join(' ').trim();
  const captionJoined = captions.map((c) => c.text).join(' ');
  const recovery = textCorrespondence(asrJoined, TEXT);

  log('--- evidence ---');
  log(`narration provider: ${narration.provider}; audio duration: ${duration.toFixed(3)}s`);
  log(`ASR provider: ${asr.provider} (model ${asr.model}, language ${asr.language})`);
  log(`transcript: ${JSON.stringify(asr.segments.map((s) => s.text).join(' '))}`);
  log(`ASR segments: ${asr.segments.length}; captions: ${captions.length}`);
  log(`ASR text differs from script (whisper mis-transcribed): ${asrJoined.replace(/\s+/g, ' ') !== TEXT ? 'YES' : 'NO'}`);
  log(`caption text equals script: ${captionJoined === TEXT ? 'YES' : 'NO'}`);
  log(`transcript artifact: ${transcript.path} sha256 ${transcript.checksum}`);
  log(`caption artifact: ${srtPath} sha256 ${srtSum}`);
  captions.forEach((c, i) => log(`  #${i + 1} ${c.start_seconds.toFixed(3)} -> ${(c.start_seconds + c.duration_seconds).toFixed(3)}  ${c.text}`));
  log(`timestamps ordered, end>=start: ${ordered ? 'YES' : 'NO'}; inside audio duration: ${inside ? 'YES' : 'NO'}`);
  log(`SRT round-trips to the caption timing: ${roundTrip ? 'YES' : 'NO'}`);
  log(`ASR recovery of script words: ${(recovery * 100).toFixed(0)}% of narration words`);
  log('production-path consumption: the same {text,start_seconds,duration_seconds} array is what runMediaProduction puts in render_spec.captions and burns in via writeSrtFile; proven end-to-end by tests/integration/media-asr-pipeline.test.js ("Captions: corresponding ASR segments...") and by the rehearsal below.');

  if (!ordered || !inside || !roundTrip || recovery < 0.6) { log('RESULT: FAIL'); return 1; }
  log('RESULT: ASR captions PROVEN');
  return 0;
}
main().then((c) => process.exit(c), (e) => { console.error(e); process.exit(1); });
