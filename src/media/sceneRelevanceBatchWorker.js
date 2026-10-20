// Batch variant of the SigLIP scene-relevance worker. Loads the models ONCE,
// encodes each slot text once and each image once, and writes the full
// text-by-image cosine score matrix. Run as a CHILD PROCESS by
// sceneRelevanceBatch.js. Same model, dtype, preprocessing and cosine as
// sceneRelevanceWorker.js (which is unchanged); remote access is DISABLED.
//
// usage: node sceneRelevanceBatchWorker.js <request.json> <output.json>
// request: { texts: string[], images: string[] }
// output:  { scores: (number|null)[][] /* [text][image] */, errors: [{ path, error }] }
import fs from 'node:fs';
import path from 'node:path';
import { cosine } from './sceneRelevance.js';

const [inputPath, outputPath] = process.argv.slice(2);
if (!inputPath || !outputPath) {
  console.error('usage: sceneRelevanceBatchWorker.js <request.json> <output.json>');
  process.exit(2);
}

try {
  const { texts, images } = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
  const modelDir = process.env.SCENE_RELEVANCE_MODEL_DIR;
  if (!modelDir) throw new Error('SCENE_RELEVANCE_MODEL_DIR is not set');
  const dtype = process.env.SCENE_RELEVANCE_DTYPE || 'q8';
  const need = ['config.json', 'preprocessor_config.json', 'tokenizer.json',
    path.join('onnx', 'text_model_quantized.onnx'), path.join('onnx', 'vision_model_quantized.onnx')];
  for (const f of need) {
    if (!fs.existsSync(path.join(modelDir, f))) throw new Error(`model file missing: ${f}`);
  }

  const tf = await import('@huggingface/transformers');
  tf.env.allowRemoteModels = false;
  tf.env.allowLocalModels = true;
  tf.env.localModelPath = path.dirname(path.resolve(modelDir));
  const id = path.basename(path.resolve(modelDir));

  const tokenizer = await tf.AutoTokenizer.from_pretrained(id);
  const processor = await tf.AutoProcessor.from_pretrained(id);
  const textModel = await tf.SiglipTextModel.from_pretrained(id, { dtype });
  const visionModel = await tf.SiglipVisionModel.from_pretrained(id, { dtype });

  // One text at a time (same input shape as the single-text worker) but a single model load.
  const textVecs = [];
  for (const text of texts) {
    const inputs = tokenizer([text], { padding: 'max_length', truncation: true });
    const { pooler_output: tOut } = await textModel(inputs);
    textVecs.push(Array.from(tOut.data));
  }

  const imageVecs = [];
  const errors = [];
  for (const p of images) {
    try {
      const img = await tf.RawImage.read(p);
      const { pooler_output: vOut } = await visionModel(await processor(img));
      imageVecs.push(Array.from(vOut.data));
    } catch (err) {
      imageVecs.push(null);
      errors.push({ path: p, error: String(err?.message ?? err).replace(/\s+/g, ' ').slice(0, 200) });
    }
  }

  const scores = textVecs.map((t) => imageVecs.map((v) => (v ? cosine(t, v) : null)));
  fs.writeFileSync(outputPath, JSON.stringify({ scores, errors }));
} catch (err) {
  console.error(`SCENE_RELEVANCE_ERROR: ${String(err?.message ?? err).replace(/\s+/g, ' ').slice(0, 300)}`);
  process.exit(1);
}
