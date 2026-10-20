// EVALUATION ONLY (v2). NEEDS the local SigLIP model folder. Not run in Stage A.
//
// Calls the EXISTING rankSceneImages() once per item, unchanged: no scoring,
// threshold or preprocessing is altered. REFUSES to start unless
// judgments-manifest.json exists and every frozen hash (preregistration,
// scenes.json, negatives.json, candidates.json, each judgments file, and the bytes of every
// candidate image) still matches and every
// judgments file validates strictly. It never repairs or re-hashes anything,
// and it refuses to overwrite an existing results.json.
//
// MODEL PIN. Before ANY inference it hashes the actual bytes of the two pinned ONNX files and refuses on a missing,
// unreadable, non-regular or different file (pins: PINNED_MODEL in the lib, from THIRD_PARTY_NOTICES.md). It re-checks
// before every worker call and once more after the run; any change aborts without writing results.json. The verified
// identity (not a hash recorded afterwards) is bound into results.json and the report re-checks it against the pins.
// EVAL_MODEL_PINS_FILE is a testing hook, honoured only together with EVAL_WORKER_PATH, and makes the report INVALID.
//
// usage: SCENE_RELEVANCE_MODEL_DIR=C:\models\siglip-base-patch16-224 node scripts/eval-scene-relevance-v2-run.js [--no-timing]
//
// Latency procedure (fixed in advance): timing scenes A02, C03, F03 each get
// 2 calls with 1 image and 2 calls with all their candidates; per-image cost =
// (mean all-images ms - mean 1-image ms) / (N-1); fixed load = 1-image ms minus
// one image. Every worker call reloads the models (current architecture).
// EVAL_WORKER_PATH is a testing hook only and is flagged in results.json.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { rankSceneImages } from '../src/media/sceneRelevance.js';
import { DEFAULT_EVAL_DIR, TIMING_SCENES, readJsonStrict, buildItems, loadFrozen, verifyCandidateIntegrity, candidateIntegritySha256, sha256File, stableStringify, PINNED_MODEL, UNPINNED_MODEL_FILES, validatePins, verifyModelIdentity } from './eval-scene-relevance-v2-lib.js';

const EVAL_DIR = path.resolve(process.env.EVAL_DIR || DEFAULT_EVAL_DIR);
const die = (m) => { console.error(`RUN REFUSED: ${m}`); process.exit(1); };
const modelDir = process.env.SCENE_RELEVANCE_MODEL_DIR;
if (!modelDir) die('SCENE_RELEVANCE_MODEL_DIR is not set (local SigLIP model folder).');
const resultsPath = path.join(EVAL_DIR, 'results.json');
if (fs.existsSync(resultsPath)) die('results.json already exists; it is never overwritten (archive it explicitly if a rerun is authorised).');

let items; let frozen;
try {
  items = buildItems(readJsonStrict(path.join(EVAL_DIR, 'scenes.json')), readJsonStrict(path.join(EVAL_DIR, 'negatives.json')), readJsonStrict(path.join(EVAL_DIR, 'candidates.json')));
  frozen = loadFrozen(EVAL_DIR, items);
} catch (e) { die(e.message); }
const primary = frozen.judgments[frozen.manifest.primaryReviewer];
if (primary.sawModelScoresFirst) die('primary reviewer saw model scores first; judgments are not blind.');

const workerPath = process.env.EVAL_WORKER_PATH ? path.resolve(process.env.EVAL_WORKER_PATH) : null;
const opts = workerPath ? { workerPath } : {};
const abs = (c) => path.resolve(EVAL_DIR, ...c.localPath.split('/'));
for (const it of items) for (const c of it.candidates) if (!fs.existsSync(abs(c))) die(`image file missing: ${c.localPath}`);

let pins = PINNED_MODEL; let pinSource = 'repository';
if (process.env.EVAL_MODEL_PINS_FILE) {
  if (!workerPath) die('EVAL_MODEL_PINS_FILE is a testing hook and is only honoured together with EVAL_WORKER_PATH.');
  try { pins = validatePins(readJsonStrict(path.resolve(process.env.EVAL_MODEL_PINS_FILE))); } catch (e) { die(e.message); }
  pinSource = 'test-override';
}
// Pin check BEFORE inference: nothing below (worker, timing, results) happens unless every pinned file matches.
let modelIdentity;
try { modelIdentity = verifyModelIdentity(modelDir, pins, { pinSource }); } catch (e) { die(`model identity not verified: ${e.message}`); }
const reverify = () => {
  try { if (verifyModelIdentity(modelDir, pins, { pinSource }).identitySha256 !== modelIdentity.identitySha256) throw new Error('model identity changed'); }
  catch (e) { die(`${e.message} (model files changed during the run; results.json was NOT written)`); }
};
const unpinnedObserved = {}; // informational only: the repository records no hashes for these, so they are NOT enforced
for (const f of UNPINNED_MODEL_FILES) { const p = path.join(modelDir, f); unpinnedObserved[f] = fs.existsSync(p) ? sha256File(p) : null; }

let preprocessorConfig = null;
try { preprocessorConfig = JSON.parse(fs.readFileSync(path.join(modelDir, 'preprocessor_config.json'), 'utf8')); } catch { /* recorded as null */ }
let gitHead = null; try { gitHead = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(); } catch { /* not fatal */ }
const onnx = Object.fromEntries(Object.entries(modelIdentity.files).map(([rel, f]) => [path.basename(rel), f.sha256]));

const timedRank = (text, images) => { reverify(); const t0 = performance.now(); const result = rankSceneImages({ text, images }, opts); return { result, ms: Math.round(performance.now() - t0) }; };
const out = { schema: 'scene-relevance-v2-results', meta: {
  startedAt: new Date().toISOString(), node: process.version, platform: process.platform, gitHead,
  modelDirName: path.basename(path.resolve(modelDir)), dtype: process.env.SCENE_RELEVANCE_DTYPE || 'q8 (worker default)', preprocessorConfig, onnxSha256: onnx, modelIdentity, unpinnedFilesObserved: unpinnedObserved,
  workerPath: workerPath || 'default (src/media/sceneRelevanceWorker.js)',
  manifestSha256: frozen.manifestSha256, frozenFiles: frozen.manifest.frozenFiles, judgmentFiles: frozen.manifest.judgmentFiles,
  candidatesSha256: frozen.manifest.candidateIntegrity.candidatesSha256, candidateIntegritySha256: candidateIntegritySha256(frozen.manifest.candidateIntegrity)
}, items: [], timing: [] };

for (const it of items) {
  const byPath = new Map(it.candidates.map((c) => [abs(c), c.candidateId]));
  console.log(`${it.itemId}: ranking ${byPath.size} candidates...`);
  const { result, ms } = timedRank(it.description, [...byPath.keys()]);
  out.items.push({
    itemId: it.itemId, kind: it.kind, split: it.split, ms, ok: result.ok === true, fallback: result.fallback === true, reason: result.reason ?? null,
    ranking: result.ranking.map((r) => ({ candidateId: byPath.get(r.path), score: r.score, rank: r.rank })),
    imageErrors: (result.errors || []).map((e) => ({ candidateId: byPath.get(e.path), error: e.error }))
  });
  console.log(`  ${result.ok ? 'ok' : 'FAILED (fallback): ' + result.reason}  ${ms} ms`);
}

if (!process.argv.includes('--no-timing')) {
  for (const id of TIMING_SCENES) {
    const it = items.find((x) => x.itemId === id); const all = it.candidates.map(abs);
    console.log(`timing ${id}: 2x1-image, 2x${all.length}-image`);
    const one = [timedRank(it.description, [all[0]]), timedRank(it.description, [all[0]])];
    const many = [timedRank(it.description, all), timedRank(it.description, all)];
    out.timing.push({ sceneId: id, images: all.length, oneImageMs: one.map((x) => x.ms), allImagesMs: many.map((x) => x.ms), allCallsOk: [...one, ...many].every((x) => x.result.ok) });
  }
}
// Fail closed if candidates.json or any image changed while the run was in progress; nothing is written.
try { verifyCandidateIntegrity(EVAL_DIR, items, frozen.manifest.candidateIntegrity); } catch (e) { die(`${e.message} (detected after the model run; results.json was NOT written)`); }
reverify(); modelIdentity.verifiedAfterInference = true; // re-hashed after the last worker call
out.meta.finishedAt = new Date().toISOString();
fs.writeFileSync(resultsPath, stableStringify(out));
console.log(`\nWrote ${resultsPath}\nNext: node scripts/eval-scene-relevance-v2-report.js --select-rule   then   node scripts/eval-scene-relevance-v2-report.js`);
