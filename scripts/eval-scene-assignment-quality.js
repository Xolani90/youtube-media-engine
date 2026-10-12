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
import { validateManifest, evaluate, timeAssignment, MODES } from './eval-scene-assignment-quality-lib.js';

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
  const assignmentRuntime = Object.fromEntries(MODES.map((m) => [m, timeAssignment(manifest, scores, m)]));
  report = { ...evaluate(manifest, scores), scoringMs, assignmentRuntime, scores };
} catch (err) { console.error(`Failed: ${err.message}`); process.exit(1); } finally { fs.rmSync(tmp, { recursive: true, force: true }); }

const pct = (x) => (x === null ? 'n/a' : `${(x * 100).toFixed(1)}%`);
console.log(`Scenes ${report.scenes}, images ${report.images}, manifest ${report.manifestSha256.slice(0, 12)}`);
console.log(`RANKING  top-1 ${pct(report.ranking.top1Accuracy)} (95% CI ${report.ranking.top1CI95?.join('..')}), top-${report.ranking.k} ${pct(report.ranking.topKAccuracy)}, MRR ${report.ranking.mrr?.toFixed(3)}, hard-negative ranked #1: ${report.ranking.hardNegativeTop1}`);
for (const m of MODES) {
  const a = report.assignments[m];
  console.log(`ASSIGN ${m.padEnd(9)} relevant ${pct(a.relevantRate)} (CI ${a.relevantCI95?.join('..')}), false-selection ${pct(a.falseSelectionRate)}, hard-negative picked ${a.hardNegativeSelected}, unusable picked ${a.unusableSelected}, forced off top-1 ${a.forcedOffTop1}, no-relevant scenes filled ${a.noRelevantSceneFilled}; same picks as ${MODES[0]}: ${report.selectionEquivalence[m]}`);
}
console.log(`TOTAL SCORE of picks (same matrix): ${MODES.map((m) => `${m} ${report.assignments[m].totalScore.toFixed(4)}`).join(' | ')}`);
console.log(`PER-SCENE PICKS (score; * = not the scene's rank-1 image, R = relevant, H = hard negative)`);
console.log(`  ${'scene'.padEnd(6)}${MODES.map((m) => m.padEnd(22)).join('')}`);
report.assignments[MODES[0]].rows.forEach((_, i) => {
  const cell = (m) => { const r = report.assignments[m].rows[i]; return `${r.pick} ${r.score === null ? 'n/a' : r.score.toFixed(3)}${r.forcedOffTop1 ? '*' : ''}${r.relevant ? 'R' : ''}${r.hardNegative ? 'H' : ''}`.padEnd(22); };
  console.log(`  ${report.assignments[MODES[0]].rows[i].scene.padEnd(6)}${MODES.map(cell).join('')}`);
});
console.log(`ASSIGNMENT RUNTIME (scoring excluded, mean of ${report.assignmentRuntime[MODES[0]].runs} passes): ${MODES.map((m) => `${m} ${report.assignmentRuntime[m].msPerRun} ms`).join(' | ')}`);
console.log(`REPEATED ASSIGNMENT RUNS IDENTICAL: ${MODES.map((m) => `${m} ${report.assignmentRuntime[m].identicalPicks}`).join(' | ')}`);
if (report.scoringMs !== null) console.log(`Scoring runtime (batch worker, one call): ${(report.scoringMs / 1000).toFixed(1)} s`);
if (opt.out) { fs.writeFileSync(opt.out, JSON.stringify(report, null, 2)); console.log(`Report written: ${opt.out}`); }
