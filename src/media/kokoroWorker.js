// Kokoro TTS worker (donor: hexgrad/kokoro-js, Apache-2.0). Run as a CHILD
// PROCESS by src/media/narration.js -- never imported by the pipeline -- so
// the media pipeline's synchronous narration interface is unchanged.
//
// usage: node kokoroWorker.js <input-text-file> <output-wav>
// env:   KOKORO_MODEL_ID (default onnx-community/Kokoro-82M-v1.0-ONNX)
//        KOKORO_VOICE    (default af_heart)
//        KOKORO_DTYPE    (default q8)
// First use downloads the model (~90 MB for q8) into the Hugging Face
// transformers cache (see docs note in THIRD_PARTY_NOTICES.md).
//
// Kokoro owns synthesis ONLY: it receives final script text and returns audio.
import fs from 'node:fs';
import { encodeWav16, concatFloat32 } from './kokoroSupport.js';

const [inputPath, outputPath] = process.argv.slice(2);
if (!inputPath || !outputPath) {
  console.error('usage: kokoroWorker.js <input-text-file> <output-wav>');
  process.exit(2);
}

const text = fs.readFileSync(inputPath, 'utf8');
if (!text.trim()) { console.error('empty text'); process.exit(2); }

const modelId = process.env.KOKORO_MODEL_ID || 'onnx-community/Kokoro-82M-v1.0-ONNX';
const voice = process.env.KOKORO_VOICE || 'af_heart';
const dtype = process.env.KOKORO_DTYPE || 'q8';

try {
  const { KokoroTTS, TextSplitterStream } = await import('kokoro-js');
  const tts = await KokoroTTS.from_pretrained(modelId, { dtype, device: 'cpu' });

  // The donor's own sentence splitter + streaming path keeps every utterance
  // inside the model's token limit for long scripts.
  const splitter = new TextSplitterStream();
  const stream = tts.stream(splitter, { voice });
  splitter.push(text);
  splitter.close();

  const parts = [];
  let sampleRate = null;
  for await (const { audio } of stream) {
    sampleRate ??= audio.sampling_rate;
    if (audio.sampling_rate !== sampleRate) throw new Error('inconsistent sampling rate from Kokoro');
    parts.push(audio.audio);
  }
  if (parts.length === 0) throw new Error('Kokoro produced no audio');

  fs.writeFileSync(outputPath, encodeWav16(concatFloat32(parts), sampleRate));
} catch (err) {
  // One concise line: the underlying libraries can attach very large (minified
  // source) context to errors, which must never flood the parent's stderr.
  console.error(`KOKORO_ERROR: ${String(err?.message ?? err).replace(/\s+/g, ' ').slice(0, 300)}`);
  process.exit(1);
}
