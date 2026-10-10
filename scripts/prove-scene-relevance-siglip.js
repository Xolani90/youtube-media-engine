// Isolated proof for the SigLIP scene-relevance worker. Run on a machine that
// has the model files in a LOCAL directory (nothing is downloaded by this script).
//   SCENE_RELEVANCE_MODEL_DIR=C:\models\siglip-base-patch16-224 node scripts/prove-scene-relevance-siglip.js
// Needs: @huggingface/transformers installed (resolvable from this repo).
// Writes only to a temp scratch dir. Touches no DB, provider, gate or claim.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCanvas } from '@napi-rs/canvas';
import { rankSceneImages } from '../src/media/sceneRelevance.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scene-rel-proof-'));
const colours = { red: '#ff0000', green: '#00ff00', blue: '#0000ff', yellow: '#ffff00' };
const files = {};
for (const [name, hex] of Object.entries(colours)) {
  const c = createCanvas(224, 224); const ctx = c.getContext('2d');
  ctx.fillStyle = hex; ctx.fillRect(0, 0, 224, 224);
  files[name] = path.join(dir, `${name}.png`);
  fs.writeFileSync(files[name], c.toBuffer('image/png'));
}
const corrupt = path.join(dir, 'corrupt.png'); fs.writeFileSync(corrupt, 'not an image');
const images = [...Object.values(files), corrupt];

const results = []; let failed = false;
const check = (name, ok, extra = '') => { results.push({ name, ok, extra }); if (!ok) failed = true; };

const t0 = Date.now();
const runs = [];
for (const prompt of ['a solid red image', 'a solid blue image', 'a solid green image']) {
  const r = rankSceneImages({ text: prompt, images }, { timeoutMs: 10 * 60 * 1000 });
  runs.push({ prompt, r });
}
const ms = Date.now() - t0;
for (const { prompt, r } of runs) {
  if (r.fallback) { check(`${prompt}: worker ran`, false, r.reason); continue; }
  const want = prompt.split(' ')[2];
  check(`${prompt}: matching colour ranks first`, r.ranking[0].path === files[want], r.ranking.map((x) => `${path.basename(x.path)}=${x.score}`).join(' '));
  check(`${prompt}: corrupt image reported, ranked last`, r.ranking.at(-1).path === corrupt && r.errors.some((e) => e.path === corrupt));
}
const a = rankSceneImages({ text: 'a solid red image', images }, { timeoutMs: 10 * 60 * 1000 });
const b = rankSceneImages({ text: 'a solid red image', images }, { timeoutMs: 10 * 60 * 1000 });
check('two identical runs give identical rankings', JSON.stringify(a) === JSON.stringify(b));
const bad = rankSceneImages({ text: 'x', images }, { timeoutMs: 60000, env: { ...process.env, SCENE_RELEVANCE_MODEL_DIR: path.join(dir, 'nope') } });
check('missing model files -> explicit fallback failure', bad.fallback === true && /model file missing/.test(bad.reason), bad.reason);

for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.extra ? '  [' + r.extra + ']' : ''}`);
console.log(`total wall time for 3 ranking runs (incl. model load each): ${ms} ms`);
console.log(`peak RSS of this parent process: ${Math.round(process.memoryUsage().rss / 1e6)} MB (worker memory is separate; measure it in Task Manager)`);
fs.rmSync(dir, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
