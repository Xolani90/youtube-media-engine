#!/usr/bin/env node
// Calibrates SCENE_RELEVANCE_MIN_SCORE from labelled examples. Read-only; needs the local SigLIP model.
//
//   $env:SCENE_RELEVANCE_MODEL_DIR = "C:\models\siglip-base-patch16-224"
//   node scripts/calibrate-scene-relevance.js examples.json
//
// examples.json: { "cases": [ { "text": "scene narration", "good": ["a.jpg"], "bad": ["b.jpg"] } ] }
// Image paths are relative to the JSON file. Prints every score, the best separating threshold, and
// how many bad images it rejects and good images it would wrongly reject. It never edits any config.
import fs from 'node:fs';
import path from 'node:path';
import { rankSceneImages } from '../src/media/sceneRelevance.js';

const file = process.argv[2];
if (!file) { console.error('usage: node scripts/calibrate-scene-relevance.js <examples.json>'); process.exit(2); }
if (!process.env.SCENE_RELEVANCE_MODEL_DIR) { console.error('SCENE_RELEVANCE_MODEL_DIR is not set'); process.exit(2); }
const base = path.dirname(path.resolve(file));
const { cases } = JSON.parse(fs.readFileSync(file, 'utf8'));
if (!Array.isArray(cases) || cases.length === 0) { console.error('examples.json needs a non-empty "cases" array'); process.exit(2); }

const good = []; const bad = [];
for (const c of cases) {
  for (const [label, list] of [['good', c.good ?? []], ['bad', c.bad ?? []]]) {
    for (const rel of list) {
      const img = path.resolve(base, rel);
      const r = rankSceneImages({ text: c.text, images: [img] });
      const score = r.ok ? r.ranking[0].score : null;
      console.log(`${label.padEnd(4)} ${score === null ? 'ERROR(' + r.reason + ')' : score.toFixed(4)}  ${rel}  <-  ${c.text.slice(0, 60)}`);
      if (score !== null) (label === 'good' ? good : bad).push(score);
    }
  }
}
if (!good.length || !bad.length) { console.error('Need at least one scored good AND one scored bad example.'); process.exit(1); }

const all = [...new Set([...good, ...bad])].sort((a, b) => a - b);
let best = null;
for (let i = 0; i < all.length; i++) {
  const t = i === 0 ? all[0] - 1e-6 : (all[i - 1] + all[i]) / 2;
  const badRejected = bad.filter((s) => s < t).length;
  const goodRejected = good.filter((s) => s < t).length;
  const quality = badRejected / bad.length - goodRejected / good.length;
  if (!best || quality > best.quality) best = { t, badRejected, goodRejected, quality };
}
console.log(`\ngood: n=${good.length} min=${Math.min(...good).toFixed(4)}  bad: n=${bad.length} max=${Math.max(...bad).toFixed(4)}`);
console.log(`best separating threshold: ${best.t.toFixed(4)}  rejects ${best.badRejected}/${bad.length} bad, wrongly rejects ${best.goodRejected}/${good.length} good`);
if (Math.min(...good) <= Math.max(...bad)) console.log('WARNING: good and bad scores overlap; no threshold separates them. Add examples or do not enable the filter.');
console.log('Set it yourself:  $env:SCENE_RELEVANCE_MIN_SCORE = "' + best.t.toFixed(4) + '"   (review the list above first)');
