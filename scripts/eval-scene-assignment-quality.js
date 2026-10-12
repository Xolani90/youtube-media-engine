#!/usr/bin/env node
/**
 * Independent scene-assignment relevance evaluation (NOT the frozen V2 evaluation).
 * Reads a manifest + an image directory you supply, scores with the real SigLIP
 * batch worker (SCENE_RELEVANCE_MODEL_DIR required), then reports semantic
 * relevance for the existing 'on' / 'batch' / 'batch-all' assignment modes.
 * Local only: no network, no DB, no provider calls, no model download.
 *
 *   node scripts/eval-scene-assignment-quality.js <manifest.json> <image-dir> [--out report.json] [--scores matrix.json]
 *
 * --scores skips the model and uses a saved [scene][image] matrix (repeatability).
 * Runtime of the real scoring is measured separately from relevance.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { rankSceneBatch } from '../src/media/sceneRelevanceBatch.js';
import { validateManifest, evaluate, MODES } from './eval-scene-assignment-quality-lib.js';

const args = process.argv.slice(2);
const pos = [];
const opt = {};
for (let i = 0; i < args.length; i++) { if (args[i] === '--out') opt.out = args[++i]; else if (args[i] === '--scores') opt.scores = args[++i]; else pos.push(args[i]); }
if (pos.length !== 2) { console.error('usage: eval-scene-assignment-quality.js <manifest.json> <image-dir> [--out report.json] [--scores matrix.json]'); process.exit(2); }

const manifest = validateManifest(JSON.parse(fs.readFileSync(pos[0], 'utf8')));
const dir = path.resolve(pos[1]);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ame-sa-quality-'));
let report;
try {
  const files = manifest.images.map((im) => {
    if (im.kind === 'missing') return path.join(tmp, `missing-${im.id}.png`); // never created
    if (im.kind === 'corrupt') { const p = path.join(tmp, `corrupt-${im.id}.png`); fs.writeFileSync(p, Buffer.from('not an image')); return p; }
    const p = path.join(dir, im.file);
    if (!opt.scores && !fs.existsSync(p)) throw new Error(`fixture image not found: ${p}`);
    return p;
  });
  let scores; let scoringMs = null;
  if (opt.scores) scores = JSON.parse(fs.readFileSync(opt.scores, 'utf8'));
  else {
    const t0 = Date.now();
    const res = rankSceneBatch({ texts: manifest.scenes.map((s) => s.text), images: files });
    scoringMs = Date.now() - t0;
    if (!res.ok) throw new Error(`scoring failed (fallback): ${res.reason}`);
    scores = res.scores;
  }
  report = { ...evaluate(manifest, scores), scoringMs, scores };
} catch (err) { console.error(`Failed: ${err.message}`); process.exit(1); } finally { fs.rmSync(tmp, { recursive: true, force: true }); }

const pct = (x) => (x === null ? 'n/a' : `${(x * 100).toFixed(1)}%`);
console.log(`Scenes ${report.scenes}, images ${report.images}, manifest ${report.manifestSha256.slice(0, 12)}`);
console.log(`RANKING  top-1 ${pct(report.ranking.top1Accuracy)} (95% CI ${report.ranking.top1CI95?.join('..')}), top-${report.ranking.k} ${pct(report.ranking.topKAccuracy)}, MRR ${report.ranking.mrr?.toFixed(3)}, hard-negative ranked #1: ${report.ranking.hardNegativeTop1}`);
for (const m of MODES) {
  const a = report.assignments[m];
  console.log(`ASSIGN ${m.padEnd(9)} relevant ${pct(a.relevantRate)} (CI ${a.relevantCI95?.join('..')}), false-selection ${pct(a.falseSelectionRate)}, hard-negative picked ${a.hardNegativeSelected}, unusable picked ${a.unusableSelected}, forced off top-1 ${a.forcedOffTop1}, no-relevant scenes filled ${a.noRelevantSceneFilled}; same picks as ${MODES[0]}: ${report.selectionEquivalence[m]}`);
}
if (report.scoringMs !== null) console.log(`Scoring runtime (batch worker, one call): ${(report.scoringMs / 1000).toFixed(1)} s`);
if (opt.out) { fs.writeFileSync(opt.out, JSON.stringify(report, null, 2)); console.log(`Report written: ${opt.out}`); }
