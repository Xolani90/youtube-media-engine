// EVALUATION ONLY. Step 3 of 4. Calls the EXISTING rankSceneImages() from
// src/media/sceneRelevance.js once per scene (one child-process worker run each),
// unchanged: no scoring, threshold or preprocessing is altered here.
//
// usage: SCENE_RELEVANCE_MODEL_DIR=C:\models\siglip-base-patch16-224 node scripts/eval-scene-relevance-run.js [--no-calibrate]
//
// Writes eval/scene-relevance/results.json (candidate IDs, scores, ranks, per-call
// wall time, failures, environment). Do NOT look at the scores before you have
// finished and exported your human judgments.
//
// Latency: each worker call reloads tokenizer, processor and both models.
// Calibration times a 1-image call vs an all-candidates call on the first
// scene (2 repeats each) to separate fixed load cost from per-image scoring.
//
// EVAL_WORKER_PATH is a testing hook only; the path is recorded in results.json
// and the report flags any non-default worker.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { rankSceneImages } from '../src/media/sceneRelevance.js';

const EVAL_DIR = path.resolve(process.env.EVAL_DIR || path.join('eval', 'scene-relevance'));
const calibrate = !process.argv.includes('--no-calibrate');
const modelDir = process.env.SCENE_RELEVANCE_MODEL_DIR;
if (!modelDir) {
  console.error('SCENE_RELEVANCE_MODEL_DIR is not set (local SigLIP model folder).');
  process.exit(1);
}
const workerPath = process.env.EVAL_WORKER_PATH ? path.resolve(process.env.EVAL_WORKER_PATH) : null;
const opts = workerPath ? { workerPath } : {};

const scenesDoc = JSON.parse(fs.readFileSync(path.join(EVAL_DIR, 'scenes.json'), 'utf8'));
const cand = JSON.parse(fs.readFileSync(path.join(EVAL_DIR, 'candidates.json'), 'utf8'));

let preprocessorConfig = null;
try { preprocessorConfig = JSON.parse(fs.readFileSync(path.join(modelDir, 'preprocessor_config.json'), 'utf8')); } catch { /* recorded as null */ }
let gitHead = null;
try { gitHead = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(); } catch { /* not fatal */ }

function timedRank(text, images) {
  const t0 = performance.now();
  const result = rankSceneImages({ text, images }, opts);
  return { result, ms: Math.round(performance.now() - t0) };
}
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;

const results = { meta: {
  startedAt: new Date().toISOString(),
  node: process.version, platform: process.platform, gitHead,
  modelDirName: path.basename(path.resolve(modelDir)),
  dtype: process.env.SCENE_RELEVANCE_DTYPE || 'q8 (worker default)',
  preprocessorConfig,
  workerPath: workerPath || 'default (src/media/sceneRelevanceWorker.js)'
}, scenes: [], calibration: null };

for (const scene of scenesDoc.scenes) {
  const entry = cand.scenes[scene.id];
  if (!entry) { console.log(`${scene.id}: no candidates, skipped`); continue; }
  const idByPath = new Map(entry.candidates.map((c) => [path.resolve(EVAL_DIR, ...c.localPath.split('/')), c.candidateId]));
  const images = [...idByPath.keys()];
  console.log(`${scene.id}: ranking ${images.length} candidates...`);
  const { result, ms } = timedRank(scene.description, images);
  const rec = {
    sceneId: scene.id, description: scene.description, candidateCount: images.length, ms,
    ok: result.ok === true, fallback: result.fallback === true, reason: result.reason ?? null,
    ranking: result.ranking.map((r) => ({ candidateId: idByPath.get(r.path), score: r.score, rank: r.rank })),
    imageErrors: (result.errors || []).map((e) => ({ candidateId: idByPath.get(e.path), error: e.error }))
  };
  results.scenes.push(rec);
  console.log(`  ${rec.ok ? 'ok' : 'FAILED (fallback): ' + rec.reason}  ${ms} ms  imageErrors=${rec.imageErrors.length}`);
}

if (calibrate) {
  const first = results.scenes.find((s) => s.ok);
  if (first) {
    const entry = cand.scenes[first.sceneId];
    const all = entry.candidates.map((c) => path.resolve(EVAL_DIR, ...c.localPath.split('/')));
    const desc = scenesDoc.scenes.find((s) => s.id === first.sceneId).description;
    console.log(`calibration on ${first.sceneId}: 2x 1-image call, 2x ${all.length}-image call...`);
    const one = [timedRank(desc, [all[0]]), timedRank(desc, [all[0]])];
    const many = [timedRank(desc, all), timedRank(desc, all)];
    const okAll = [...one, ...many].every((x) => x.result.ok);
    if (okAll) {
      const m1 = mean(one.map((x) => x.ms)), mN = mean(many.map((x) => x.ms));
      const perImage = (mN - m1) / (all.length - 1);
      const order = (r) => r.ranking.map((x) => path.basename(x.path)).join(',');
      results.calibration = {
        sceneId: first.sceneId, oneImageMs: one.map((x) => x.ms), allImagesMs: many.map((x) => x.ms), imagesInFullCall: all.length,
        estimatedPerImageMs: Math.round(perImage), estimatedFixedLoadMs: Math.round(m1 - perImage),
        sameRankingAcrossRepeats: order(many[0].result) === order(many[1].result)
      };
    } else {
      results.calibration = { sceneId: first.sceneId, error: 'a calibration call fell back; no estimate' };
    }
  }
}

results.meta.finishedAt = new Date().toISOString();
fs.writeFileSync(path.join(EVAL_DIR, 'results.json'), JSON.stringify(results, null, 2));
console.log(`\nWrote ${path.join(EVAL_DIR, 'results.json')}`);
console.log('Next: finish human judgments (contact sheet) if you have not, then node scripts/eval-scene-relevance-report.js');