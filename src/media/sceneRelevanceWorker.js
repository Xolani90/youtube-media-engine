// SigLIP scene-relevance worker (donor: huggingface/transformers.js, Apache-2.0;
// model google/siglip-base-patch16-224, Apache-2.0 declared on the model page;
// ONNX conversion Xenova/siglip-base-patch16-224 declares NO license -- see
// THIRD_PARTY_NOTICES.md). Run as a CHILD PROCESS by sceneRelevance.js; never
// imported by the pipeline.
//
// usage: node sceneRelevanceWorker.js <request.json> <output.json>
// env:   SCENE_RELEVANCE_MODEL_DIR (REQUIRED) local directory holding
//          config.json, preprocessor_config.json, tokenizer files and
//          onnx/text_model_quantized.onnx + onnx/vision_model_quantized.onnx
//        SCENE_RELEVANCE_DTYPE (default q8)
// Remote model access is DISABLED: the worker never downloads anything. A
// missing model directory or file is an explicit failure.
import fs from 'node:fs';
import path from 'node:path';
import { cosine } from './sceneRelevance.js';

const [inputPath, outputPath] = process.argv.slice(2);
if (!inputPath || !outputPath) {
  console.error('usage: sceneRelevanceWorker.js <request.json> <output.json>');
  process.exit(2);
}

try {
  const { text, images } = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
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

  // SigLIP was trained with max-length padding.
  const textInputs = tokenizer([text], { padding: 'max_length', truncation: true });
  const { pooler_output: tOut } = await textModel(textInputs);
  const textVec = Array.from(tOut.data);

  const scores = [];
  const errors = [];
  for (const p of images) {
    try {
      const img = await tf.RawImage.read(p);
      const { pooler_output: vOut } = await visionModel(await processor(img));
      scores.push({ path: p, score: cosine(textVec, Array.from(vOut.data)) });
    } catch (err) {
      errors.push({ path: p, error: String(err?.message ?? err).replace(/\s+/g, ' ').slice(0, 200) });
    }
  }
  fs.writeFileSync(outputPath, JSON.stringify({ scores, errors }));
} catch (err) {
  console.error(`SCENE_RELEVANCE_ERROR: ${String(err?.message ?? err).replace(/\s+/g, ' ').slice(0, 300)}`);
  process.exit(1);
}
