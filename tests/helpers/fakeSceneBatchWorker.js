// Test double for sceneRelevanceBatchWorker.js. Behaviour chosen by FAKE_MODE.
// Score = 0.9 when the image file name contains "a<digits in text>." else 0.1.
import fs from 'node:fs';
const [inp, out] = process.argv.slice(2);
const { texts, images } = JSON.parse(fs.readFileSync(inp, 'utf8'));
const mode = process.env.FAKE_MODE || 'ok';
if (process.env.FAKE_CALL_LOG) fs.appendFileSync(process.env.FAKE_CALL_LOG, `${texts.length}x${images.length}\n`);
if (mode === 'crash') { console.error('SCENE_RELEVANCE_ERROR: model file missing: onnx/text_model_quantized.onnx'); process.exit(1); }
if (mode === 'hang') { setTimeout(() => {}, 60000); }
else if (mode === 'badshape') { fs.writeFileSync(out, JSON.stringify({ scores: [[0.5]], errors: [] })); }
else {
  const scores = texts.map((t) => images.map((p) => {
    if (p.includes('bad')) return null;
    const d = (t.match(/\d+/) || [''])[0];
    return p.includes(`a${d}.`) ? 0.9 : 0.1;
  }));
  const errors = images.filter((p) => p.includes('bad')).map((p) => ({ path: p, error: 'undecodable image' }));
  fs.writeFileSync(out, JSON.stringify({ scores, errors }));
}
