// EVALUATION ONLY (v2). OFFLINE. Freezes the human judgments BEFORE any model run.
//
// Reads each reviewer's BLIND export (blind-judgments-<id>.json, opaque IDs only),
// translates it with answer-key.json into canonical judgments-<id>.json (written
// once, never overwritten), validates it strictly, then writes
// judgments-manifest.json with the SHA-256 of each canonical judgments file, of
// each blind file, and of the preregistration, scenes.json, negatives.json, candidates.json and
// answer-key.json (so the key can never be changed or regenerated afterwards). It also records, in the
// manifest only (never in reviewer-facing files), the SHA-256 of every evaluated image's bytes with the
// candidate and scene IDs that use it; it refuses if an image does not match candidates.json. The run script and the report
// verify those hashes. This script REFUSES to overwrite an existing manifest and
// never edits a judgments file: to change anything, a human must archive the old
// results and manifest and start a documented new freeze.
//
// usage: node scripts/eval-scene-relevance-v2-freeze.js --primary owner [--second other]
// Refuses if results.json already exists (judgments must precede scores).
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_EVAL_DIR, ANSWER_KEY_FILE, FROZEN_FILES, readJsonStrict, buildItems, validateAnswerKey, translateBlindJudgments, validateJudgments, validateManifest, buildCandidateIntegrity, CANDIDATES_FILE, sha256File, sha256Hex, stableStringify } from './eval-scene-relevance-v2-lib.js';

const EVAL_DIR = path.resolve(process.env.EVAL_DIR || DEFAULT_EVAL_DIR);
const argv = process.argv.slice(2);
const val = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null; };
const die = (m) => { console.error(`FREEZE REFUSED: ${m}`); process.exit(1); };
const primary = val('--primary'); const second = val('--second');
if (!primary) die('--primary <reviewerId> is required');
if (second && second === primary) die('--second must differ from --primary');
const manifestPath = path.join(EVAL_DIR, 'judgments-manifest.json');
if (fs.existsSync(manifestPath)) die('judgments-manifest.json already exists; frozen judgments are never overwritten');
if (fs.existsSync(path.join(EVAL_DIR, 'results.json'))) die('results.json already exists; judgments must be frozen before any model run');

let items;
try { items = buildItems(readJsonStrict(path.join(EVAL_DIR, 'scenes.json')), readJsonStrict(path.join(EVAL_DIR, 'negatives.json')), readJsonStrict(path.join(EVAL_DIR, 'candidates.json'))); }
catch (e) { die(e.message); }

let key;
try { const kp = path.join(EVAL_DIR, ANSWER_KEY_FILE); if (!fs.existsSync(kp)) die(`${ANSWER_KEY_FILE} not found (run the contact-sheet script first)`); key = validateAnswerKey(readJsonStrict(kp), items); }
catch (e) { die(e.message); }

// Validate everything in memory first; write nothing until every reviewer passes.
const pending = []; const judgmentFiles = {}; const blindFiles = {};
for (const id of [primary, second].filter(Boolean)) {
  const bf = `blind-judgments-${id}.json`; const f = `judgments-${id}.json`; const bp = path.join(EVAL_DIR, bf);
  if (!fs.existsSync(bp)) die(`${bf} not found`);
  if (fs.existsSync(path.join(EVAL_DIR, f))) die(`${f} already exists; canonical judgments are never overwritten`);
  let j; try { j = validateJudgments(translateBlindJudgments(readJsonStrict(bp), key, bf), items, bf); } catch (e) { die(e.message); }
  if (j.reviewerId !== id) die(`${bf}: reviewerId inside the file is "${j.reviewerId}"`);
  if (j.sawModelScoresFirst) die(`${bf}: reviewer saw model scores first; these judgments are not blind and cannot be frozen for the evaluation`);
  const text = stableStringify(j);
  pending.push({ f, text }); judgmentFiles[f] = sha256Hex(text); blindFiles[bf] = sha256File(bp);
  if (j.aiSuggestedLabels) console.log(`NOTE: ${bf} declares AI-suggested labels; the report will state they are not fully independent.`);
}
const frozenFiles = {};
for (const f of FROZEN_FILES) { if (!fs.existsSync(path.join(EVAL_DIR, f))) die(`${f} is missing`); frozenFiles[f] = sha256File(path.join(EVAL_DIR, f)); }
let candidateIntegrity;
try { candidateIntegrity = buildCandidateIntegrity(EVAL_DIR, items, frozenFiles[CANDIDATES_FILE]); } catch (e) { die(e.message); }
const manifest = validateManifest({ schema: 'scene-relevance-v2-judgments-manifest', frozenAt: new Date().toISOString(), primaryReviewer: primary, secondReviewer: second || null, frozenFiles, judgmentFiles, blindJudgmentFiles: blindFiles, candidateIntegrity });
for (const { f, text } of pending) fs.writeFileSync(path.join(EVAL_DIR, f), text, { flag: 'wx' });
fs.writeFileSync(manifestPath, stableStringify(manifest), { flag: 'wx' });
console.log(`Wrote ${manifestPath}`);
for (const [f, h] of Object.entries({ ...frozenFiles, ...judgmentFiles, ...blindFiles })) console.log(`  ${h}  ${f}`);
console.log('Judgments are frozen. Next: the model run (needs approval and a local model folder).');
