// Test double for sceneRelevanceWorker.js. Behaviour chosen by FAKE_MODE.
import fs from 'node:fs';
const [inp, out] = process.argv.slice(2);
const { text, images } = JSON.parse(fs.readFileSync(inp, 'utf8'));
const mode = process.env.FAKE_MODE || 'ok';
if (mode === 'crash') { console.error('SCENE_RELEVANCE_ERROR: model file missing: onnx/text_model_quantized.onnx'); process.exit(1); }
if (mode === 'hang') { setTimeout(() => {}, 60000); }
else {
  // score = 1 when the file name contains the first word of the text
  const key = text.split(/\s+/)[0].toLowerCase();
  const scores = images.filter((p) => !p.includes('bad')).map((p, i) => ({ path: p, score: (p.toLowerCase().includes(key) ? 0.9 : 0.1) - i * 1e-9 }));
  const errors = images.filter((p) => p.includes('bad')).map((p) => ({ path: p, error: 'undecodable image' }));
  fs.writeFileSync(out, JSON.stringify({ scores, errors }));
}
