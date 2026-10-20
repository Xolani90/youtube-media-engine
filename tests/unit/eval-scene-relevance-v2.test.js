// Offline tests for the v2 scene-relevance evaluation tooling. No network, no API
// key, no model, no new npm packages. Scripts are exercised against synthetic
// fixtures in a temp directory (EVAL_DIR); the real eval/ folders are never touched.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as L from '../../scripts/eval-scene-relevance-v2-lib.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const REAL = path.join(ROOT, 'eval', 'scene-relevance-v2');
const FAKE_WORKER = path.join(ROOT, 'tests', 'helpers', 'fakeSceneWorker.js');
const script = (n) => path.join(ROOT, 'scripts', `eval-scene-relevance-v2-${n}.js`);
const realScenes = () => L.readJsonStrict(path.join(REAL, 'scenes.json'));
const realNeg = () => L.readJsonStrict(path.join(REAL, 'negatives.json'));
const LETTERS = 'ABCDEFGH';
const RANKS = [1, 3, 6, 8, 11, 13, 16, 18];

function candDoc() {
  const scenes = {};
  const ids = [...realScenes().scenes.map((s) => s.id), ...realNeg().nearMiss.items.map((n) => n.id)];
  for (const id of ids) {
    scenes[id] = { query: 'q', hitsReturned: 20, failures: [], status: 'ok', candidates: [...LETTERS].map((l, i) => ({ candidateId: `${id}-${l}`, sceneId: id, searchRank: RANKS[i], sha256: L.sha256Hex(`${id}-${l}`), localPath: `images/${id}/${id}-${l}.jpg`, tags: 'x' })) };
  }
  return { schema: 'scene-relevance-v2-candidates', scenes };
}
const items = () => L.buildItems(realScenes(), realNeg(), candDoc());

function judgmentsFor(its, { reviewerId = 'owner', ai = false, saw = false, noneIds = ['A05'], relevantNeg = [] } = {}) {
  const out = { schema: 'scene-relevance-v2-judgments', reviewerId, judgedAt: '2026-10-12T10:00:00.000Z', aiSuggestedLabels: ai, sawModelScoresFirst: saw, items: {} };
  for (const it of its) {
    const none = (it.kind !== 'positive' && !relevantNeg.includes(it.itemId)) || noneIds.includes(it.itemId);
    out.items[it.itemId] = none ? { reviewed: true, relevant: [], best: [], noneSuitable: true, notes: '' }
      : { reviewed: true, relevant: [`${it.itemId}-C`, `${it.itemId}-D`], best: [`${it.itemId}-C`], noneSuitable: false, notes: '' };
  }
  return out;
}

// Canonical judgments -> what the reviewer's sheet would export (opaque IDs only).
function toBlind(canon, key) {
  const out = { schema: L.BLIND_JUDGMENTS_SCHEMA, keyId: key.keyId, reviewerId: canon.reviewerId, judgedAt: canon.judgedAt, aiSuggestedLabels: canon.aiSuggestedLabels, sawModelScoresFirst: canon.sawModelScoresFirst, items: {} };
  for (const k of key.items) {
    const e = canon.items[k.itemId]; const fwd = new Map(k.candidates.map((c) => [c.candidateId, c.opaqueCandidateId]));
    out.items[k.opaqueItemId] = { reviewed: e.reviewed, relevant: e.relevant.map((c) => fwd.get(c)), best: e.best.map((c) => fwd.get(c)), noneSuitable: e.noneSuitable, notes: e.notes };
  }
  return out;
}

function makeFixture({ judg = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scene-rel-v2-'));
  for (const f of ['scenes.json', 'negatives.json', 'PREREGISTRATION.md']) fs.copyFileSync(path.join(REAL, f), path.join(dir, f));
  const cd = candDoc(); fs.writeFileSync(path.join(dir, 'candidates.json'), L.stableStringify(cd));
  for (const e of Object.values(cd.scenes)) for (const c of e.candidates) { fs.mkdirSync(path.dirname(path.join(dir, c.localPath)), { recursive: true }); fs.writeFileSync(path.join(dir, c.localPath), c.candidateId); }
  const its = L.buildItems(realScenes(), realNeg(), cd);
  // Reviewer flow: the sheet script creates the key; the reviewer exports a BLIND file; freeze translates it.
  const sheet = run('contact-sheet', [], { EVAL_DIR: dir }); assert.equal(sheet.status, 0, sheet.stderr);
  const key = L.readJsonStrict(path.join(dir, L.ANSWER_KEY_FILE));
  const canon = judgmentsFor(its, judg);
  fs.writeFileSync(path.join(dir, 'blind-judgments-owner.json'), JSON.stringify(toBlind(canon, key), null, 2));
  return { dir, its, key, canon };
}
const run = (name, args, env) => spawnSync(process.execPath, [script(name), ...args], { cwd: ROOT, env: { ...process.env, ...env }, encoding: 'utf8' });
const freeze = (dir, extra = []) => run('freeze', ['--primary', 'owner', ...extra], { EVAL_DIR: dir });

// What a genuine, pin-verified run records: built only from the repository pins.
const genuineIdentity = (over = {}) => ({ ...L.buildModelIdentityRecord(L.PINNED_MODEL, Object.fromEntries(Object.entries(L.PINNED_MODEL.files).map(([rel, h]) => [rel, { sha256: h, bytes: 1000 }])), { verifiedAfterInference: true }), ...over });
const genuineOnnx = () => Object.fromEntries(Object.entries(L.PINNED_MODEL.files).map(([rel, h]) => [rel.split('/').pop(), h]));

// Synthetic results whose scores follow the judgments (relevant high, others low).
function syntheticResults(dir, its, manifest, { tamper } = {}) {
  const j = L.readJsonStrict(path.join(dir, 'judgments-owner.json'));
  const out = { schema: 'scene-relevance-v2-results', meta: { startedAt: 'x', node: 'v', platform: 'p', gitHead: null, modelDirName: 'm', dtype: 'q8', preprocessorConfig: null, workerPath: 'default (src/media/sceneRelevanceWorker.js)', manifestSha256: L.sha256File(path.join(dir, 'judgments-manifest.json')), frozenFiles: manifest.frozenFiles, judgmentFiles: manifest.judgmentFiles, candidatesSha256: manifest.candidateIntegrity.candidatesSha256, candidateIntegritySha256: L.candidateIntegritySha256(manifest.candidateIntegrity), onnxSha256: genuineOnnx(), modelIdentity: genuineIdentity() }, items: [], timing: [{ sceneId: 'A02', images: 8, oneImageMs: [1000, 1000], allImagesMs: [2400, 2400], allCallsOk: true }] };
  for (const it of its) {
    const rel = new Set(j.items[it.itemId].relevant);
    const ranking = it.candidates.map((c, i) => ({ candidateId: c.candidateId, score: rel.size ? (rel.has(c.candidateId) ? (c.candidateId.endsWith('C') ? 0.5 : 0.4) : 0.1 - i * 0.001) : 0.05 - i * 0.0005 }))
      .sort((a, b) => b.score - a.score).map((x, rank) => ({ ...x, rank }));
    out.items.push({ itemId: it.itemId, kind: it.kind, split: it.split, ms: 5000, ok: true, fallback: false, reason: null, ranking, imageErrors: [] });
  }
  if (tamper) tamper(out);
  fs.writeFileSync(path.join(dir, 'results.json'), L.stableStringify(out));
}

// ------------------------------------------------------------------ dataset
test('shipped dataset: 30 scenes, 6 categories x 5, frozen stratified split 12/18 with 2/3 per category', () => {
  const doc = realScenes(); const split = L.validateScenesDoc(doc);
  assert.equal(doc.scenes.length, 30);
  for (const c of 'ABCDEF') {
    const g = doc.scenes.filter((s) => s.category === c);
    assert.equal(g.length, 5);
    assert.equal(g.filter((s) => split[s.id] === 'calibration').length, 2);
    assert.equal(g.filter((s) => split[s.id] === 'heldout').length, 3);
  }
  const held = doc.scenes.filter((s) => s.split === 'heldout').map((s) => s.id).sort();
  assert.deepEqual(held, ['A01', 'A04', 'A05', 'B01', 'B02', 'B05', 'C01', 'C02', 'C04', 'D01', 'D02', 'D04', 'E01', 'E02', 'E04', 'F01', 'F02', 'F04']);
  assert.equal(held.length, 18);
  for (const s of doc.scenes) assert.ok(s.searchQuery.length <= 100 && s.acceptableProxies.length >= 1);
  for (const id of ['F01', 'F02', 'F03', 'F04', 'F05']) assert.ok(doc.scenes.find((s) => s.id === id).acceptableProxies.length >= 2, `${id} proxies`);
});

test('shipped negatives match the deterministic pairing rule; near-miss is 10 items split 5/5', () => {
  const neg = realNeg(); L.validateNegativesDoc(neg, realScenes());
  const cross = L.computeCrossPairs(realScenes().scenes);
  assert.equal(cross.length, 10);
  assert.deepEqual(neg.crossCategory.items, cross);
  const cat = (id) => id[0];
  for (const x of cross) assert.notEqual(cat(x.descriptionScene), cat(x.imageScene), 'cross pairs must span categories');
  assert.equal(cross.filter((x) => x.split === 'heldout').length, 5);
  assert.equal(neg.nearMiss.items.length, 10);
});

test('validateScenesDoc rejects tampered split, duplicate ids and wrong counts', () => {
  const d = realScenes(); d.scenes[0].split = d.scenes[0].split === 'heldout' ? 'calibration' : 'heldout';
  assert.throws(() => L.validateScenesDoc(d), /does not match the SHA-256 rule/);
  const e = realScenes(); e.scenes[1].id = e.scenes[0].id;
  assert.throws(() => L.validateScenesDoc(e), /duplicate|category mismatch/);
  const f = realScenes(); f.scenes.pop();
  assert.throws(() => L.validateScenesDoc(f), /expected 30/);
});

test('validateCandidatesDoc rejects missing scenes, too few candidates and bad ids', () => {
  const ids = realScenes().scenes.map((s) => s.id);
  const a = candDoc(); delete a.scenes.B03;
  assert.throws(() => L.validateCandidatesDoc(a, ids), /no candidates for B03/);
  const b = candDoc(); b.scenes.C01.candidates = b.scenes.C01.candidates.slice(0, 5);
  assert.throws(() => L.validateCandidatesDoc(b, ids), /C01 has 5 candidates/);
  const c = candDoc(); c.scenes.D01.candidates[0].candidateId = 'D02-A';
  assert.throws(() => L.validateCandidatesDoc(c, ids), /bad candidateId/);
  const d = candDoc(); d.scenes.E01.candidates[1].sha256 = 'zz';
  assert.throws(() => L.validateCandidatesDoc(d, ids), /bad sha256/);
  assert.throws(() => L.buildItems(realScenes(), realNeg(), a), /no candidates for B03/);
});

// --------------------------------------------------------------- judgments
test('validateJudgments fails closed on corrupted or inconsistent files', () => {
  const its = items(); const good = () => judgmentsFor(its);
  L.validateJudgments(good(), its);
  const bad = (mut, re) => { const j = good(); mut(j); assert.throws(() => L.validateJudgments(j, its), re); };
  assert.throws(() => L.validateJudgments(null, its), /wrong or missing schema/);
  assert.throws(() => L.validateJudgments([], its), /wrong or missing schema/);
  bad((j) => { j.schema = 'v1'; }, /schema/);
  bad((j) => { j.reviewerId = 'bad id!'; }, /reviewerId/);
  bad((j) => { delete j.aiSuggestedLabels; }, /aiSuggestedLabels/);
  bad((j) => { j.sawModelScoresFirst = 'no'; }, /sawModelScoresFirst/);
  bad((j) => { delete j.items.A01; }, /item A01 missing/);
  bad((j) => { j.items.ZZ9 = j.items.A01; }, /unknown item/);
  bad((j) => { j.items.A01.reviewed = false; }, /not reviewed/);
  bad((j) => { j.items.A01.relevant = ['A01-C', 'A01-C']; }, /duplicate/);
  bad((j) => { j.items.A01.relevant.push('B01-A'); }, /unknown candidate/);
  bad((j) => { j.items.A01.best = ['A01-E']; }, /not relevant/);
  bad((j) => { j.items.A05.relevant = ['A05-A']; }, /noneSuitable but lists relevant/);
  bad((j) => { j.items.A01.relevant = []; j.items.A01.best = []; }, /no relevant candidate and is not marked noneSuitable/);
  bad((j) => { j.items.A01.noneSuitable = 'yes'; }, /noneSuitable must be boolean/);
});

test('loadFrozen: accepts a clean freeze, rejects changed hashes, missing or malformed files', () => {
  const { dir, its } = makeFixture();
  assert.throws(() => L.loadFrozen(dir, its), /not frozen/);
  const r = freeze(dir); assert.equal(r.status, 0, r.stderr);
  const ok = L.loadFrozen(dir, its); assert.equal(ok.manifest.primaryReviewer, 'owner');
  const jp = path.join(dir, 'judgments-owner.json'); const orig = fs.readFileSync(jp, 'utf8');
  fs.writeFileSync(jp, orig.replace('"notes": ""', '"notes": "edited"'));
  assert.throws(() => L.loadFrozen(dir, its), /judgments-owner\.json changed after freezing/);
  fs.writeFileSync(jp, '{ not json'); assert.throws(() => L.loadFrozen(dir, its), /changed after freezing/);
  fs.writeFileSync(jp, orig);
  L.loadFrozen(dir, its);
  fs.appendFileSync(path.join(dir, 'scenes.json'), ' ');
  assert.throws(() => L.loadFrozen(dir, its), /scenes\.json changed after freezing/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('freeze script: refuses overwrite, refuses non-blind judgments, refuses after results exist', () => {
  const a = makeFixture(); assert.equal(freeze(a.dir).status, 0);
  const again = freeze(a.dir); assert.equal(again.status, 1); assert.match(again.stderr, /already exists/);
  const b = makeFixture({ judg: { saw: true } });
  const r = freeze(b.dir); assert.equal(r.status, 1); assert.match(r.stderr, /not blind/);
  assert.equal(fs.existsSync(path.join(b.dir, 'judgments-manifest.json')), false);
  const c = makeFixture(); fs.writeFileSync(path.join(c.dir, 'results.json'), '{}');
  assert.match(freeze(c.dir).stderr, /before any model run/);
  const d = makeFixture(); fs.writeFileSync(path.join(d.dir, 'blind-judgments-owner.json'), '[1,2,3]');
  assert.equal(freeze(d.dir).status, 1);
  for (const x of [a, b, c, d]) fs.rmSync(x.dir, { recursive: true, force: true });
});

test('run script refuses without frozen judgments, with a changed hash, and without a model dir', () => {
  const { dir } = makeFixture();
  const env = { EVAL_DIR: dir, SCENE_RELEVANCE_MODEL_DIR: dir, EVAL_WORKER_PATH: FAKE_WORKER };
  const r1 = run('run', [], env); assert.equal(r1.status, 1); assert.match(r1.stderr, /not frozen/);
  assert.equal(freeze(dir).status, 0);
  fs.appendFileSync(path.join(dir, 'judgments-owner.json'), '\n');
  const r2 = run('run', [], env); assert.equal(r2.status, 1); assert.match(r2.stderr, /changed after freezing/);
  const r3 = run('run', [], { EVAL_DIR: dir, SCENE_RELEVANCE_MODEL_DIR: '' }); assert.equal(r3.status, 1);
  assert.equal(fs.existsSync(path.join(dir, 'results.json')), false, 'no results may be written on refusal');
  fs.rmSync(dir, { recursive: true, force: true });
});

// A tiny stand-in model folder plus a pins file for it (the testing hook). Real pins can never match synthetic bytes.
function fakeModel(over = {}) {
  const md = fs.mkdtempSync(path.join(os.tmpdir(), 'scene-rel-v2-model-')); fs.mkdirSync(path.join(md, 'onnx'));
  const bytes = { 'onnx/text_model_quantized.onnx': 'text-bytes', 'onnx/vision_model_quantized.onnx': 'vision-bytes', ...over };
  for (const [rel, b] of Object.entries(bytes)) fs.writeFileSync(path.join(md, ...rel.split('/')), b);
  for (const f of L.UNPINNED_MODEL_FILES) fs.writeFileSync(path.join(md, f), `{"${f}":1}`);
  const pins = { repo: 'Xenova/siglip-base-patch16-224', revision: L.PINNED_MODEL.revision, files: { 'onnx/text_model_quantized.onnx': L.sha256Hex('text-bytes'), 'onnx/vision_model_quantized.onnx': L.sha256Hex('vision-bytes') } };
  const pinsFile = path.join(md, 'pins.json'); fs.writeFileSync(pinsFile, JSON.stringify(pins));
  return { md, pins, pinsFile };
}
test('run script (fake worker, offline) writes valid results; report then marks the non-default worker INVALID', () => {
  const { dir, its } = makeFixture(); assert.equal(freeze(dir).status, 0);
  const fm = fakeModel();
  const env = { EVAL_DIR: dir, SCENE_RELEVANCE_MODEL_DIR: fm.md, EVAL_MODEL_PINS_FILE: fm.pinsFile, EVAL_WORKER_PATH: FAKE_WORKER, FAKE_MODE: 'ok' };
  const r = run('run', [], env); assert.equal(r.status, 0, r.stderr);
  const res = L.validateResults(L.readJsonStrict(path.join(dir, 'results.json')), its);
  assert.equal(res.items.length, 50); assert.equal(res.timing.length, 3);
  assert.match(res.meta.workerPath, /fakeSceneWorker/);
  const again = run('run', [], env); assert.equal(again.status, 1); assert.match(again.stderr, /already exists/);
  const rep = run('report', ['--select-rule'], { EVAL_DIR: dir }); assert.equal(rep.status, 2);
  assert.match(fs.readFileSync(path.join(dir, 'REPORT.md'), 'utf8'), /INVALID[\s\S]*non-default worker/);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ------------------------------------------------------------------ results
test('validateResults rejects malformed scores, missing items, duplicates and ok-without-scores', () => {
  const its = items();
  const make = () => ({ schema: 'scene-relevance-v2-results', meta: {}, items: its.map((it) => ({ itemId: it.itemId, ms: 1, ok: true, ranking: it.candidates.map((c, i) => ({ candidateId: c.candidateId, score: 0.5 - i * 0.01, rank: i })) })) });
  L.validateResults(make(), its);
  const t = (mut, re) => { const r = make(); mut(r); assert.throws(() => L.validateResults(r, its), re); };
  t((r) => { r.items[0].ranking[0].score = 'high'; }, /malformed score/);
  t((r) => { r.items[0].ranking[0].score = Number.NaN; }, /malformed score/);
  t((r) => { r.items.pop(); }, /has no result/);
  t((r) => { r.items[1] = { ...r.items[0] }; }, /duplicate item/);
  t((r) => { r.items[0].ranking[1].candidateId = r.items[0].ranking[0].candidateId; }, /duplicate candidate/);
  t((r) => { for (const x of r.items[0].ranking) x.score = null; }, /ok with no scores/);
  t((r) => { r.items[0].ranking.pop(); }, /size mismatch/);
  t((r) => { r.items[0].ms = -1; }, /malformed/);
});

// ------------------------------------------------------------------ metrics
const mkItem = (cands) => ({ itemId: 'T01', candidates: cands.map((id, i) => ({ candidateId: id, searchRank: i + 1 })) });
const rec = (pairs, ok = true) => ({ ok, ranking: pairs.map(([candidateId, score]) => ({ candidateId, score })) });

test('tied rankings: a tie at the top only counts when every tied candidate is relevant', () => {
  const it = mkItem(['a', 'b', 'c', 'd']);
  const jr = (relevant, best = []) => ({ relevant, best, noneSuitable: false });
  const tieMixed = L.sceneOutcome(it, rec([['a', 0.5], ['b', 0.5], ['c', 0.1], ['d', 0.1]]), jr(['b']));
  assert.equal(tieMixed.top1, false); assert.equal(tieMixed.tiedAtTop, true);
  const tieAllRel = L.sceneOutcome(it, rec([['a', 0.5], ['b', 0.5], ['c', 0.1], ['d', 0.1]]), jr(['a', 'b']));
  assert.equal(tieAllRel.top1, true);
  assert.equal(tieAllRel.pairHalves, 8); assert.equal(tieAllRel.pairTotal, 4);
  const allTied = L.sceneOutcome(it, rec([['a', 0.2], ['b', 0.2], ['c', 0.2], ['d', 0.2]]), jr(['a']));
  assert.equal(allTied.pairHalves, 3); assert.equal(allTied.pairTotal, 3); // 3 ties x 0.5 -> 3 half-points of 6
  assert.equal(allTied.top1, false);
  const bestTie = L.sceneOutcome(it, rec([['a', 0.5], ['b', 0.5], ['c', 0.1], ['d', 0.1]]), jr(['a', 'b'], ['a']));
  assert.equal(bestTie.bestFirst, false);
  const bestTie2 = L.sceneOutcome(it, rec([['a', 0.5], ['b', 0.5], ['c', 0.1], ['d', 0.1]]), jr(['a', 'b'], ['a', 'b']));
  assert.equal(bestTie2.bestFirst, true);
});

test('sceneOutcome: model failure and unscored candidates count against the model, baseline needs search rank 1', () => {
  const it = mkItem(['a', 'b', 'c']);
  const j = { relevant: ['a'], best: [], noneSuitable: false };
  const failed = L.sceneOutcome(it, rec([['a', null], ['b', null], ['c', null]], false), j);
  assert.equal(failed.modelFailed, true); assert.equal(failed.top1, false); assert.equal(failed.pairHalves, 0); assert.equal(failed.pairTotal, 2); assert.equal(failed.baselineTop1, true);
  const partial = L.sceneOutcome(it, rec([['a', null], ['b', 0.3], ['c', 0.2]]), j);
  assert.equal(partial.top1, false); assert.equal(partial.pairHalves, 0);
  const noRank1 = L.sceneOutcome({ itemId: 'T', candidates: [{ candidateId: 'a', searchRank: 3 }, { candidateId: 'b', searchRank: 5 }] }, rec([['a', 1], ['b', 0]]), { relevant: ['a'], best: [], noneSuitable: false });
  assert.equal(noRank1.baselineAvailable, false);
});

function outcomesFor(split, { successesPerCat = [1, 1, 1, 1, 1, 1], eligible = true } = {}) {
  const scenes = realScenes().scenes.filter((s) => s.split === split).map((s) => ({ itemId: s.id, category: s.category }));
  const out = [];
  const seen = {};
  for (const s of scenes) {
    const k = (seen[s.category] = (seen[s.category] || 0) + 1);
    const i = 'ABCDEF'.indexOf(s.category);
    out.push({ itemId: s.itemId, eligible, noneSuitable: !eligible, modelFailed: false, top1: eligible && k <= successesPerCat[i], top3: eligible, bestDen: false, bestFirst: false, pairHalves: eligible ? 8 : 0, pairTotal: eligible ? 4 : 0, baselineTop1: false, baselineAvailable: true, tiedAtTop: false });
  }
  return { out, scenes };
}

test('category and split accounting: 18 held-out scenes, 3 per category, raw successes/denominators', () => {
  const { out, scenes } = outcomesFor('heldout', { successesPerCat: [3, 2, 1, 0, 3, 1] });
  const agg = L.aggregatePositives(out, scenes);
  assert.equal(agg.scenes, 18); assert.equal(agg.eligible, 18);
  assert.deepEqual(Object.fromEntries(Object.entries(agg.categories).map(([c, v]) => [c, `${v.successes}/${v.scenes}`])), { A: '3/3', B: '2/3', C: '1/3', D: '0/3', E: '3/3', F: '1/3' });
  assert.equal(agg.top1, 10);
  const cal = outcomesFor('calibration'); const ca = L.aggregatePositives(cal.out, cal.scenes);
  assert.equal(ca.scenes, 12); assert.ok(Object.values(ca.categories).every((v) => v.scenes === 2));
});

test('decide: PROMISING needs all four held-out criteria; boundaries use exact integer arithmetic', () => {
  const { out, scenes } = outcomesFor('heldout', { successesPerCat: [3, 3, 3, 3, 3, 3] }); const agg = L.aggregatePositives(out, scenes);
  assert.equal(L.decide(agg).verdict, 'PROMISING');
  // top-1 exactly 70% of 20 passes, 13/20 fails (synthetic aggregate)
  const mk = (over) => ({ ...agg, eligible: 20, top1: 14, baselineTop1: 2, pairHalves: 150, pairTotal: 100, categories: { A: { scenes: 3, successes: 1 } }, ...over });
  assert.equal(L.decide(mk({})).verdict, 'PROMISING');
  assert.notEqual(L.decide(mk({ top1: 13 })).verdict, 'PROMISING');
  assert.equal(L.decide(mk({ pairHalves: 150 - 1 })).verdict, 'INCONCLUSIVE'); // 74.5% pairwise
  assert.equal(L.decide(mk({ baselineTop1: 11 })).verdict, 'PROMISING'); // margin exactly 15 points (3/20)
  assert.equal(L.decide(mk({ baselineTop1: 12 })).verdict, 'INCONCLUSIVE'); // margin 10 points
  assert.equal(L.decide(mk({ baselineTop1: 14 })).verdict, 'NOT PROMISING'); // no better than baseline
});

test('decide: category coverage failure blocks PROMISING; floors give NOT PROMISING; edge cases are INCONCLUSIVE or INVALID', () => {
  const { out, scenes } = outcomesFor('heldout', { successesPerCat: [3, 3, 3, 0, 3, 3] });
  const agg = L.aggregatePositives(out, scenes);
  const cov = L.decide(agg); assert.equal(cov.verdict, 'INCONCLUSIVE'); assert.match(cov.why[0], /category coverage failed in: D/);
  const mk = (over) => ({ ...agg, eligible: 20, top1: 14, baselineTop1: 2, pairHalves: 150, pairTotal: 100, categories: { A: { scenes: 3, successes: 1 } }, ...over });
  assert.equal(L.decide(mk({ top1: 9 })).verdict, 'NOT PROMISING'); // 45% exactly
  assert.equal(L.decide(mk({ top1: 10 })).verdict, 'INCONCLUSIVE'); // 50%
  assert.equal(L.decide(mk({ pairHalves: 120 })).verdict, 'NOT PROMISING'); // 60% exactly
  assert.equal(L.decide(mk({ top1: 12, baselineTop1: 12 })).verdict, 'NOT PROMISING'); // no better than baseline
  assert.equal(L.decide(mk({ eligible: 0, top1: 0, baselineTop1: 0 })).verdict, 'INCONCLUSIVE'); // zero eligible
  assert.match(L.decide(mk({ eligible: 0, top1: 0 })).why[0], /zero eligible/);
  assert.equal(L.decide(mk({ eligible: 11, top1: 11 })).verdict, 'INCONCLUSIVE'); // below preregistered minimum
  assert.equal(L.decide(mk({ pairTotal: 0, pairHalves: 0 })).verdict, 'INCONCLUSIVE');
  assert.equal(L.decide(mk({ baselineMissing: 1 })).verdict, 'INVALID');
});

// ------------------------------------------------- unsuitable-set detection
test('auroc and itemStats handle ties and short rankings', () => {
  assert.equal(L.auroc([0.9, 0.8], [0.1, 0.2]), 1);
  assert.equal(L.auroc([0.5], [0.5]), 0.5);
  assert.equal(L.auroc([], [0.1]), null);
  assert.equal(L.itemStats([{ score: 0.5 }]), null);
  assert.deepEqual(L.itemStats([{ score: 0.5 }, { score: 0.3 }, { score: 0.1 }]), { topScore: 0.5, gapTop1Top2: 0.2, top1MinusMedian: 0.2 });
  assert.equal(L.itemStats([{ score: 0.5 }, { score: null }, { score: 0.1 }]).gapTop1Top2, 0.4);
});

const dItem = (id, kind, split, top) => ({ itemId: id, kind, split, stats: { topScore: top, gapTop1Top2: 0.01, top1MinusMedian: 0.02 } });

test('selectRule: selects from calibration only, reports no usable rule when inadequate', () => {
  const sep = { suitable: [0.5, 0.45, 0.4, 0.42].map((t, i) => dItem(`s${i}`, 'positive', 'calibration', t)), unsuitable: [0.1, 0.12, 0.05, 0.08].map((t, i) => dItem(`n${i}`, 'cross', 'calibration', t)) };
  const r = L.selectRule(sep);
  assert.equal(r.status, 'selected'); assert.equal(r.statistic, 'topScore'); assert.equal(r.calibrationAuroc, 1);
  assert.ok(r.threshold > 0.12 && r.threshold < 0.4);
  const few = L.selectRule({ suitable: sep.suitable, unsuitable: sep.unsuitable.slice(0, 2) });
  assert.equal(few.status, 'none'); assert.match(few.reason, /need >= 3 of each/);
  const overlap = { suitable: [0.3, 0.1, 0.2].map((t, i) => dItem(`s${i}`, 'positive', 'calibration', t)), unsuitable: [0.25, 0.15, 0.35].map((t, i) => dItem(`n${i}`, 'cross', 'calibration', t)) };
  const bad = L.selectRule(overlap); assert.equal(bad.status, 'none'); assert.match(bad.reason, /below the preregistered floor/);
  assert.equal(L.selectRule({ suitable: [], unsuitable: [] }).status, 'none');
});

test('negative-set metrics: false acceptance and false rejection are counted separately; contaminated and failed pairs are disclosed', () => {
  const its = items().filter((i) => ['A01', 'A05', 'XN06', 'XN07', 'NM02'].includes(i.itemId));
  const j = { items: {
    A01: { relevant: ['A01-A'], best: [], noneSuitable: false }, A05: { relevant: [], best: [], noneSuitable: true },
    XN06: { relevant: [], best: [], noneSuitable: true }, XN07: { relevant: ['E01-B'], best: [], noneSuitable: false }, NM02: { relevant: [], best: [], noneSuitable: true } } };
  const mkRec = (id, top, ok = true) => ({ itemId: id, ok, ranking: [{ candidateId: `${id}-A`, score: top }, { candidateId: `${id}-B`, score: top - 0.1 }] });
  const results = { items: [mkRec('A01', 0.5), mkRec('A05', 0.4), mkRec('XN06', 0.1), mkRec('XN07', 0.1), mkRec('NM02', 0.3, false)] };
  const det = L.detectionItems(its, results, j);
  assert.deepEqual(det.suitable.map((x) => x.itemId), ['A01']);
  assert.deepEqual(det.unsuitable.map((x) => x.itemId).sort(), ['A05', 'XN06']);
  assert.deepEqual(det.contaminated, ['XN07']); // reviewer found a relevant image: excluded, disclosed
  assert.deepEqual(det.modelFailed, ['NM02']);
  const ev = L.evaluateRule({ statistic: 'topScore', threshold: 0.35 }, det);
  assert.deepEqual(ev.falseRejection, { count: 0, of: 1 });
  assert.deepEqual(ev.falseAcceptance, { count: 1, of: 2 }); // A05 (0.4) wrongly accepted, XN06 rejected
  assert.equal(ev.auroc, 1);
});

test('cohen kappa: perfect, chance-level and undefined cases', () => {
  assert.equal(L.cohenKappa([true, false, true, false], [true, false, true, false]).kappa, 1);
  const chance = L.cohenKappa([true, true, false, false], [true, false, true, false]); assert.equal(chance.kappa, 0);
  const undef = L.cohenKappa([true, true, true], [true, true, true]); assert.equal(undef.status, 'undefined'); assert.match(undef.reason, /expected agreement is 1/);
  assert.equal(L.cohenKappa([], []).status, 'undefined');
});

test('estimateLoadVsInference separates fixed load from per-image cost; null when unmeasured', () => {
  const e = L.estimateLoadVsInference([{ sceneId: 'A02', images: 8, oneImageMs: [1000, 1000], allImagesMs: [2400, 2400] }]);
  assert.deepEqual(e, { scenes: ['A02'], meanOneImageMs: 1000, perImageMs: 200, fixedLoadMs: 800 });
  assert.equal(L.estimateLoadVsInference([]), null);
});

test('stableStringify is key-order independent', () => {
  assert.equal(L.stableStringify({ b: 1, a: { d: 2, c: [3, { z: 1, y: 2 }] } }), L.stableStringify({ a: { c: [3, { y: 2, z: 1 }], d: 2 }, b: 1 }));
});

// -------------------------------------------- scripts: sheet, fetch, report
test('contact sheet: 50 items, never reads results, shows no scores, order follows the random key', () => {
  const src = fs.readFileSync(script('contact-sheet'), 'utf8');
  assert.ok(!/results\.json/.test(src.replace(/^\/\/.*$/gm, '')), 'sheet script must not reference results.json outside comments');
  const { dir, key } = makeFixture();
  const html = fs.readFileSync(path.join(dir, 'contact-sheet.html'), 'utf8');
  assert.ok(html.includes('"display":"J50"') && !html.includes('"display":"J51"'));
  assert.ok(!/similarity|cosine|"score"/i.test(html));
  assert.ok(html.includes('aiSuggestedLabels') && html.includes('sawModelScoresFirst'));
  const data = JSON.parse(/const DATA = (.*);\nconst KEY/s.exec(html)[1]);
  assert.deepEqual(data.items.map((x) => x.display), Array.from({ length: 50 }, (_, i) => `J${String(i + 1).padStart(2, '0')}`));
  assert.deepEqual(data.items.map((x) => x.id), key.items.map((k) => k.opaqueItemId), 'sheet order is the key order');
  assert.notDeepEqual(key.items.slice(0, 30).map((k) => k.itemId), realScenes().scenes.map((s) => s.id), 'order must not follow scene order');
  fs.rmSync(dir, { recursive: true, force: true });
});

// Reviewer-facing material = the sheet HTML + every file under review-assets/ (names and bytes' paths).
function reviewerFacingText(dir) {
  const files = [path.join(dir, 'contact-sheet.html'), ...fs.readdirSync(path.join(dir, L.REVIEW_ASSET_DIR)).map((f) => path.join(dir, L.REVIEW_ASSET_DIR, f))];
  return { files, text: files.map((f) => `${path.basename(f)}\n${f.endsWith('.html') ? fs.readFileSync(f, 'utf8') : ''}`).join('\n') };
}

test('blindness: reviewer-facing HTML and asset names carry no IDs, classes, tags, paths or key mapping', () => {
  const { dir, its, key } = makeFixture();
  const { files, text } = reviewerFacingText(dir);
  assert.equal(files.length, 1 + 400, 'one sheet + one opaque copy per (item, candidate): 50 items x 8');
  // no real item/candidate IDs (scene ids, XNnn, NMnn, A01-B ...)
  for (const it of its) assert.ok(!text.includes(it.itemId), `real item id ${it.itemId} leaked`);
  assert.ok(!/\b[A-F]\d{2}-[A-H]\b|\bXN\d{2}\b|\bNM\d{2}\b|\b[A-F]\d{2}\b/.test(text), 'an ID-shaped token leaked');
  // no class / category words or leaking structure
  assert.ok(!/negative|positive|near-?miss|cross-?categor|heldout|calibration|answer-?key|candidates\.json|"tags"|"kind"|"split"|"category"/i.test(text), 'a status or structure word leaked');
  // no original paths or provenance
  assert.ok(!/images\/|pixabay|\.\.\//i.test(text), 'an original path or provenance string leaked');
  // no hash of any candidate (sha256) and no copy of the key's mapping
  for (const e of Object.values(candDoc().scenes)) for (const c of e.candidates) assert.ok(!text.includes(c.sha256));
  const data = JSON.parse(/const DATA = (.*);\nconst KEY/s.exec(fs.readFileSync(path.join(dir, 'contact-sheet.html'), 'utf8'))[1]);
  assert.deepEqual(Object.keys(data).sort(), ['items', 'keyId']);
  for (const x of data.items) { assert.deepEqual(Object.keys(x).sort(), ['candidates', 'description', 'display', 'id', 'visualTarget']); for (const c of x.candidates) assert.deepEqual(Object.keys(c).sort(), ['id', 'label', 'src']); }
  // every opaque ID in the sheet is random-looking and none contains a real ID; asset files exist under opaque names only
  for (const x of data.items) { assert.match(x.id, /^i[0-9a-f]{12}$/); for (const c of x.candidates) { assert.match(c.id, /^c[0-9a-f]{16}$/); assert.match(c.src, /^review-assets\/c[0-9a-f]{16}\.jpg$/); assert.ok(fs.existsSync(path.join(dir, ...c.src.split('/')))); } }
  // the key file is the only place the mapping exists, and it is not inside review-assets/
  assert.ok(fs.existsSync(path.join(dir, L.ANSWER_KEY_FILE)));
  assert.ok(!fs.readdirSync(path.join(dir, L.REVIEW_ASSET_DIR)).some((f) => /key|\.json$/i.test(f)));
  assert.ok(!text.includes(key.keyId + key.items[0].itemId));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('answer key: random, unique, validated against the items, and generation never silently remaps it', () => {
  const { dir, its, key } = makeFixture();
  const keyPath = path.join(dir, L.ANSWER_KEY_FILE); const sheetPath = path.join(dir, 'contact-sheet.html');
  L.validateAnswerKey(key, its);
  const all = key.items.flatMap((k) => [k.opaqueItemId, ...k.candidates.map((c) => c.opaqueCandidateId)]);
  assert.equal(new Set(all).size, 50 + 400);
  // two independent keys differ (random, not derived from public IDs)
  const other = L.buildAnswerKey(its); assert.notEqual(other.keyId, key.keyId); assert.notDeepEqual(other.items.map((k) => k.opaqueItemId), key.items.map((k) => k.opaqueItemId));
  // re-running reuses the key byte-for-byte and gives an identical sheet
  const keyBefore = fs.readFileSync(keyPath, 'utf8'); const sheetBefore = fs.readFileSync(sheetPath, 'utf8');
  const again = run('contact-sheet', [], { EVAL_DIR: dir }); assert.equal(again.status, 0, again.stderr);
  assert.equal(fs.readFileSync(keyPath, 'utf8'), keyBefore); assert.equal(fs.readFileSync(sheetPath, 'utf8'), sheetBefore);
  // a key that no longer matches the items is refused, and left untouched
  const bad = JSON.parse(keyBefore); bad.items.pop(); fs.writeFileSync(keyPath, JSON.stringify(bad));
  const refused = run('contact-sheet', [], { EVAL_DIR: dir }); assert.equal(refused.status, 1); assert.match(refused.stderr, /answer-key\.json/);
  assert.equal(fs.readFileSync(keyPath, 'utf8'), JSON.stringify(bad));
  // frozen but key missing: never create a new key
  fs.writeFileSync(keyPath, keyBefore); assert.equal(freeze(dir).status, 0); fs.unlinkSync(keyPath);
  const noKey = run('contact-sheet', [], { EVAL_DIR: dir }); assert.equal(noKey.status, 1); assert.match(noKey.stderr, /silently remap/);
  assert.equal(fs.existsSync(keyPath), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('judgment mapping: blind export translates to the right candidates; frozen files bind the key', () => {
  const { dir, its, key, canon } = makeFixture();
  const r = freeze(dir); assert.equal(r.status, 0, r.stderr);
  const frozen = L.readJsonStrict(path.join(dir, 'judgments-owner.json'));
  assert.deepEqual(frozen.items, Object.fromEntries(Object.entries(canon.items).map(([k, v]) => [k, v])), 'translation reproduces the canonical judgments exactly');
  assert.equal(frozen.items.XN01.noneSuitable, true); assert.deepEqual(frozen.items.A01.relevant, ['A01-C', 'A01-D']); assert.deepEqual(frozen.items.A01.best, ['A01-C']);
  assert.equal(frozen.answerKeyId, key.keyId);
  const m = L.readJsonStrict(path.join(dir, 'judgments-manifest.json'));
  assert.ok(m.frozenFiles[L.ANSWER_KEY_FILE], 'manifest hashes the answer key'); assert.ok(m.blindJudgmentFiles['blind-judgments-owner.json']);
  L.loadFrozen(dir, its);
  fs.appendFileSync(path.join(dir, L.ANSWER_KEY_FILE), ' ');
  assert.throws(() => L.loadFrozen(dir, its), /answer-key\.json changed after freezing/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('judgment mapping fails closed: wrong key, unknown ids, swapped candidate sets, overwrite', () => {
  const { dir, its, key, canon } = makeFixture();
  const bp = path.join(dir, 'blind-judgments-owner.json'); const good = JSON.parse(fs.readFileSync(bp, 'utf8'));
  const tryFreeze = (mut) => { const b = JSON.parse(JSON.stringify(good)); mut(b); fs.writeFileSync(bp, JSON.stringify(b)); return freeze(dir); };
  const firstOpaque = key.items[0].opaqueItemId;
  let r = tryFreeze((b) => { b.keyId = '0'.repeat(16); }); assert.equal(r.status, 1); assert.match(r.stderr, /different answer key/);
  r = tryFreeze((b) => { b.items.iffffffffffff = b.items[firstOpaque]; }); assert.equal(r.status, 1); assert.match(r.stderr, /unknown item/);
  r = tryFreeze((b) => { delete b.items[firstOpaque]; }); assert.equal(r.status, 1); assert.match(r.stderr, /item is missing/);
  r = tryFreeze((b) => { b.items[firstOpaque].relevant = ['cffffffffffffffff']; b.items[firstOpaque].noneSuitable = false; }); assert.equal(r.status, 1); assert.match(r.stderr, /unknown candidate/);
  // a candidate id belonging to a DIFFERENT item is not accepted (ids are per item)
  const otherCand = key.items[1].candidates[0].opaqueCandidateId;
  r = tryFreeze((b) => { b.items[firstOpaque].relevant = [otherCand]; b.items[firstOpaque].noneSuitable = false; }); assert.equal(r.status, 1); assert.match(r.stderr, /unknown candidate/);
  r = tryFreeze((b) => { b.schema = 'scene-relevance-v2-judgments'; }); assert.equal(r.status, 1); assert.match(r.stderr, /schema/);
  // real (non-opaque) ids in a hand-made export are refused
  r = tryFreeze((b) => { b.items = canon.items; }); assert.equal(r.status, 1);
  assert.equal(fs.existsSync(path.join(dir, 'judgments-owner.json')), false, 'nothing is written on refusal');
  assert.equal(fs.existsSync(path.join(dir, 'judgments-manifest.json')), false);
  // canonical file already present: never overwritten
  fs.writeFileSync(bp, JSON.stringify(good)); fs.writeFileSync(path.join(dir, 'judgments-owner.json'), '{}');
  r = freeze(dir); assert.equal(r.status, 1); assert.match(r.stderr, /never overwritten/);
  assert.equal(fs.readFileSync(path.join(dir, 'judgments-owner.json'), 'utf8'), '{}');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('fetch script: dry run makes no network call; real runs need the approval flag and a key', () => {
  const dry = run('fetch', ['--group', 'positive', '--dry-run'], { PIXABAY_API_KEY: '' });
  assert.equal(dry.status, 0, dry.stderr); assert.match(dry.stdout, /30 searches, up to 240 downloads\. No network call made/);
  const nm = run('fetch', ['--group', 'nearmiss', '--dry-run'], {}); assert.match(nm.stdout, /10 searches, up to 80 downloads/);
  const noFlag = run('fetch', ['--group', 'positive'], { PIXABAY_API_KEY: 'k' }); assert.equal(noFlag.status, 1); assert.match(noFlag.stderr, /confirm-stage-approved/);
  const noKey = run('fetch', ['--group', 'positive', '--confirm-stage-approved'], { PIXABAY_API_KEY: '' }); assert.equal(noKey.status, 1); assert.match(noKey.stderr, /PIXABAY_API_KEY is not set/);
  const noGroup = run('fetch', [], {}); assert.equal(noGroup.status, 1);
  const pilot = run('fetch', ['--only', 'A01,C01,F01', '--dry-run'], {}); assert.match(pilot.stdout, /3 searches, up to 24 downloads/);
});

test('report: PROMISING path end to end on synthetic data; rule frozen from calibration only', () => {
  const { dir, its } = makeFixture(); assert.equal(freeze(dir).status, 0);
  const manifest = L.readJsonStrict(path.join(dir, 'judgments-manifest.json'));
  syntheticResults(dir, its, manifest);
  const noRule = run('report', [], { EVAL_DIR: dir }); assert.equal(noRule.status, 2);
  assert.match(fs.readFileSync(path.join(dir, 'REPORT.md'), 'utf8'), /frozen-rule\.json is missing/);
  const sel = run('report', ['--select-rule'], { EVAL_DIR: dir }); assert.equal(sel.status, 0, sel.stderr);
  const fr = L.readJsonStrict(path.join(dir, 'frozen-rule.json'));
  assert.equal(fr.rule.status, 'selected'); assert.equal(fr.selectedFrom, 'calibration-only');
  assert.ok(fr.calibrationItems.suitable.every((id) => realScenes().scenes.find((s) => s.id === id)?.split === 'calibration'));
  assert.equal(run('report', ['--select-rule'], { EVAL_DIR: dir }).status, 1, 'frozen rule is never overwritten');
  const rep = run('report', [], { EVAL_DIR: dir }); assert.equal(rep.status, 0, rep.stderr);
  const m = L.readJsonStrict(path.join(dir, 'metrics.json'));
  assert.equal(m.verdict, 'PROMISING');
  assert.equal(m.heldOut.scenes, 18); assert.equal(m.heldOut.eligible, 17); assert.equal(m.heldOut.top1, 17);
  assert.equal(m.heldOut.baselineTop1, 0);
  assert.deepEqual(m.detection.heldOutCounts.suitable, 17);
  // inclusive detection result: 5 cross + 3 ordinary near-miss + 2 absence + 1 natural none-suitable (A05) = 11 unsuitable
  assert.equal(m.detection.inclusive, true);
  assert.deepEqual(m.detection.heldOutInclusive.falseAcceptance, { count: 0, of: 11 });
  assert.deepEqual(m.detection.heldOutInclusive.falseRejection, { count: 0, of: 17 });
  assert.deepEqual(m.detection.heldOutExcludingAbsenceDiagnostic.falseAcceptance, { count: 0, of: 9 });
  assert.equal(m.integrity.verifiedAgainstDisk, true); assert.equal(m.integrity.evaluatedImages, 320);
  const g = m.detection.groups;
  assert.deepEqual([g.cross.designedHeldOut, g.cross.heldOutEvaluated, g.cross.unsuitableRejected], [5, 5, 5]);
  assert.deepEqual([g.nearmiss.designedCalibration, g.nearmiss.designedHeldOut, g.nearmiss.heldOutEvaluated], [3, 3, 3]);
  assert.deepEqual([g.absence.designedCalibration, g.absence.designedHeldOut, g.absence.heldOutEvaluated, g.absence.unsuitableRejected], [2, 2, 2, 2]);
  assert.deepEqual(m.provisionalSafeguards, { minEligibleHeldOut: 12, calibrationMinPerClass: 3, calibrationMinAuroc: 0.7, note: 'chosen in Stage A; not statistically validated thresholds' });
  assert.deepEqual(m.heldOutIneligibleScenes, ['A05']);
  const md = fs.readFileSync(path.join(dir, 'REPORT.md'), 'utf8');
  assert.match(md, /Verdict \(held-out only\): PROMISING/); assert.match(md, /exploratory coverage safeguard/); assert.match(md, /Licensing gate/);
  assert.match(md, /Provisional safeguards \(chosen in Stage A, not statistically validated\)/);
  assert.match(md, /Cross-category \(gross-mismatch sanity check\) \| 5 \/ 5 \| 5 \| 5\/5/);
  assert.match(md, /Ordinary near-miss \| 3 \/ 3 \| 3 \| 3\/3/);
  assert.match(md, /Absence \/ negation \(reported separately\) \| 2 \/ 2 \| 2 \| 2\/2/);
  assert.match(md, /NOT evidence of fine-grained visual discrimination/); assert.match(md, /stay INSIDE the inclusive result/);
  assert.match(md, /Held-out inclusive result \(every eligible held-out item/); assert.match(md, /suitable 17, unsuitable 11/);
  assert.match(md, /Designed split \(frozen before any score\): ordinary near-miss 3 calibration \/ 3 held-out; absence 2 calibration \/ 2 held-out/);
  assert.match(md, /## Integrity/); assert.match(md, new RegExp(manifest.candidateIntegrity.candidatesSha256));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('report fails closed: tampered judgments, tampered results hash, bad scores and stale rule all give INVALID', () => {
  const setup = (opts) => { const f = makeFixture(); assert.equal(freeze(f.dir).status, 0); const man = L.readJsonStrict(path.join(f.dir, 'judgments-manifest.json')); syntheticResults(f.dir, f.its, man, opts); return f; };
  const verdictOf = (dir) => fs.readFileSync(path.join(dir, 'REPORT.md'), 'utf8');
  const a = setup(); fs.appendFileSync(path.join(a.dir, 'judgments-owner.json'), ' ');
  assert.equal(run('report', ['--select-rule'], { EVAL_DIR: a.dir }).status, 2); assert.match(verdictOf(a.dir), /INVALID[\s\S]*changed after freezing/);
  const b = setup({ tamper: (r) => { r.items[3].ranking[0].score = 'NaN'; } });
  assert.equal(run('report', ['--select-rule'], { EVAL_DIR: b.dir }).status, 2); assert.match(verdictOf(b.dir), /malformed score/);
  const c = setup(); assert.equal(run('report', ['--select-rule'], { EVAL_DIR: c.dir }).status, 0);
  const rp = path.join(c.dir, 'results.json'); const res = L.readJsonStrict(rp); res.items[0].ms += 1; fs.writeFileSync(rp, L.stableStringify(res));
  assert.equal(run('report', [], { EVAL_DIR: c.dir }).status, 2); assert.match(verdictOf(c.dir), /bound to different results/);
  const d = setup({ tamper: (r) => { r.items = r.items.slice(1); } });
  assert.equal(run('report', ['--select-rule'], { EVAL_DIR: d.dir }).status, 2); assert.match(verdictOf(d.dir), /has no result/);
  for (const x of [a, b, c, d]) fs.rmSync(x.dir, { recursive: true, force: true });
});

test('report: zero eligible held-out scenes is INCONCLUSIVE, never favourable', () => {
  // every held-out positive judged none-suitable and every scene scored flat: no separable classes
  const f = makeFixture({ judg: { noneIds: realScenes().scenes.filter((s) => s.split === 'heldout').map((s) => s.id) } });
  assert.equal(freeze(f.dir).status, 0);
  syntheticResults(f.dir, f.its, L.readJsonStrict(path.join(f.dir, 'judgments-manifest.json')));
  assert.equal(run('report', ['--select-rule'], { EVAL_DIR: f.dir }).status, 0);
  const rule = L.readJsonStrict(path.join(f.dir, 'frozen-rule.json')).rule;
  assert.equal(rule.status, 'selected'); // calibration is separable here; held-out has zero suitable items
  assert.equal(run('report', [], { EVAL_DIR: f.dir }).status, 0);
  const m = L.readJsonStrict(path.join(f.dir, 'metrics.json'));
  assert.equal(m.verdict, 'INCONCLUSIVE'); assert.equal(m.heldOut.eligible, 0);
  assert.match(m.verdictBasis[0], /zero eligible/);
  fs.rmSync(f.dir, { recursive: true, force: true });
});

test('report: when calibration cannot separate the classes, no rule is invented and the report says so', () => {
  const f = makeFixture(); assert.equal(freeze(f.dir).status, 0);
  const flat = (r) => { for (const rec of r.items) rec.ranking = rec.ranking.map((x, i) => ({ ...x, score: 0.3 - i * 0.01, rank: i })); };
  syntheticResults(f.dir, f.its, L.readJsonStrict(path.join(f.dir, 'judgments-manifest.json')), { tamper: flat });
  assert.equal(run('report', ['--select-rule'], { EVAL_DIR: f.dir }).status, 0);
  const rule = L.readJsonStrict(path.join(f.dir, 'frozen-rule.json')).rule;
  assert.equal(rule.status, 'none'); assert.equal(rule.threshold, undefined); assert.match(rule.reason, /below the preregistered floor/);
  assert.equal(run('report', [], { EVAL_DIR: f.dir }).status, 0);
  const m = L.readJsonStrict(path.join(f.dir, 'metrics.json'));
  assert.equal(m.detection.heldOutInclusive, null); assert.equal(m.detection.heldOutExcludingAbsenceDiagnostic, null);
  assert.equal(m.detection.groups.absence.unsuitableRejected, null, 'no rule: nothing is invented for any group');
  assert.equal(m.verdict, 'PROMISING'); // ranking quality is perfect here; detection is a separate, unaffected section
  assert.match(fs.readFileSync(path.join(f.dir, 'REPORT.md'), 'utf8'), /NO USABLE RULE ESTABLISHED/);
  fs.rmSync(f.dir, { recursive: true, force: true });
});

test('no secrets: no Pixabay key pattern appears in the v2 sources or data', () => {
  const files = fs.readdirSync(path.join(ROOT, 'scripts')).filter((n) => n.startsWith('eval-scene-relevance-v2-')).map((n) => path.join(ROOT, 'scripts', n))
    .concat(fs.readdirSync(REAL).filter((n) => /\.(json|md)$/.test(n)).map((n) => path.join(REAL, n)));
  for (const f of files) assert.ok(!/\b\d{7,9}-[0-9a-f]{20,}\b/.test(fs.readFileSync(f, 'utf8')), `possible API key in ${f}`);
});

// ------------------------------------------------ negative-set groups (Stage A review)
test('shipped negatives: conditionType marks exactly NM02, NM04, NM06, NM08 as absence/negation; designed counts per group are fixed', () => {
  const neg = realNeg(); L.validateNegativesDoc(neg, realScenes());
  assert.deepEqual(neg.nearMiss.items.filter((n) => n.conditionType === 'absence').map((n) => n.id), ['NM02', 'NM04', 'NM06', 'NM08']);
  assert.deepEqual(neg.nearMiss.items.filter((n) => n.conditionType === 'visual').map((n) => n.id), ['NM01', 'NM03', 'NM05', 'NM07', 'NM09', 'NM10']);
  assert.match(neg.notes, /SUPPLEMENTARY GROSS-MISMATCH SANITY CHECKS/); assert.match(neg.notes, /NOT FROZEN until/);
  const d = L.designedCounts(items());
  assert.deepEqual(d.cross, { calibration: 5, heldout: 5 });
  assert.deepEqual(d.nearmiss, { calibration: 3, heldout: 3 });
  assert.deepEqual(d.absence, { calibration: 2, heldout: 2 });
  const bad = structuredClone(realNeg()); delete bad.nearMiss.items[1].conditionType;
  assert.throws(() => L.validateNegativesDoc(bad, realScenes()), /conditionType/);
  const bad2 = structuredClone(realNeg()); bad2.nearMiss.items[0].conditionType = 'negation';
  assert.throws(() => L.validateNegativesDoc(bad2, realScenes()), /conditionType/);
});

test('partitionDetection keeps absence items out of the headline and discloses their exclusions per group', () => {
  const held = items().filter((i) => ['A01', 'XN06', 'NM10', 'NM02', 'NM04', 'NM06'].includes(i.itemId)); // grouping logic only; split is irrelevant here
  const j = { items: {
    A01: { relevant: ['A01-A'], best: [], noneSuitable: false }, XN06: { relevant: [], best: [], noneSuitable: true }, NM10: { relevant: [], best: [], noneSuitable: true },
    NM02: { relevant: [], best: [], noneSuitable: true }, NM04: { relevant: ['NM04-B'], best: [], noneSuitable: false }, NM06: { relevant: [], best: [], noneSuitable: true } } };
  const mk = (id, top, ok = true) => ({ itemId: id, ok, ranking: [{ candidateId: `${id}-A`, score: top }, { candidateId: `${id}-B`, score: top - 0.1 }] });
  const det = L.detectionItems(held, { items: [mk('A01', 0.5), mk('XN06', 0.1), mk('NM10', 0.1), mk('NM02', 0.4), mk('NM04', 0.4), mk('NM06', 0.3, false)] }, j);
  const parts = L.partitionDetection(det, held);
  assert.deepEqual(parts.headline.suitable.map((x) => x.itemId), ['A01']);
  assert.deepEqual(parts.headline.unsuitable.map((x) => x.itemId).sort(), ['NM10', 'XN06']);
  assert.deepEqual(parts.absence.unsuitable.map((x) => x.itemId), ['NM02']);
  assert.deepEqual(parts.absence.contaminated, ['NM04']); assert.deepEqual(parts.absence.modelFailed, ['NM06']);
  assert.deepEqual(parts.headline.contaminated, []); assert.deepEqual(parts.headline.modelFailed, []);
  assert.equal(L.detectionGroupOf(held.find((i) => i.itemId === 'NM10')), 'nearmiss'); assert.equal(L.detectionGroupOf(held.find((i) => i.itemId === 'NM02')), 'absence');
});

test('report: a contaminated absence item is excluded from its own group and disclosed; the other groups are unaffected', () => {
  const { dir, its } = makeFixture({ judg: { relevantNeg: ['NM08'] } }); assert.equal(freeze(dir).status, 0);
  syntheticResults(dir, its, L.readJsonStrict(path.join(dir, 'judgments-manifest.json')));
  assert.equal(run('report', ['--select-rule'], { EVAL_DIR: dir }).status, 0);
  assert.equal(run('report', [], { EVAL_DIR: dir }).status, 0);
  const m = L.readJsonStrict(path.join(dir, 'metrics.json')); const g = m.detection.groups;
  assert.deepEqual([g.absence.designedHeldOut, g.absence.heldOutEvaluated, g.absence.contaminated], [2, 1, ['NM08']]);
  assert.deepEqual(m.detection.heldOutExcludingAbsenceDiagnostic.falseAcceptance, { count: 0, of: 9 });
  assert.deepEqual(m.detection.heldOutInclusive.falseAcceptance, { count: 0, of: 10 });
  assert.match(fs.readFileSync(path.join(dir, 'REPORT.md'), 'utf8'), /Absence \/ negation \(reported separately\) \| 2 \/ 2 \| 1 \| 1\/1 \| 1\.000 \| 1 \(NM08\)/);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ------------------------------------------------ provisional safeguards
test('provisional safeguards: below-minimum eligible sample is INCONCLUSIVE; a structural error stays INVALID; wording says not validated', () => {
  const agg = (over) => ({ scenes: 18, eligible: 11, noneSuitable: 7, top1: 11, top3: 11, tiedAtTop: 0, bestDen: 11, bestFirst: 11, pairHalves: 2000, pairTotal: 1000, baselineTop1: 0, baselineMissing: 0, modelFailedEligible: 0, modelFailedAll: 0, categories: Object.fromEntries('ABCDEF'.split('').map((c) => [c, { scenes: 3, successes: 2 }])), ...over });
  const low = L.decide(agg({})); assert.equal(low.verdict, 'INCONCLUSIVE'); assert.match(low.why[0], /11 eligible held-out scenes \(< 12 preregistered minimum\)/);
  assert.equal(L.decide(agg({ eligible: 12 })).verdict, 'PROMISING');
  assert.equal(L.decide(agg({ baselineMissing: 1 })).verdict, 'INVALID', 'a structural error outranks the sample-size safeguard');
  assert.equal(L.decide(agg({ eligible: 0 })).verdict, 'INCONCLUSIVE');
  assert.deepEqual([L.CRITERIA.minEligibleHeldOut, L.CRITERIA.rule.minPerClass, L.CRITERIA.rule.minAuroc], [12, 3, 0.7]);
  const pre = fs.readFileSync(path.join(REAL, 'PREREGISTRATION.md'), 'utf8').replace(/\s+/g, ' ');
  assert.match(pre, /PROVISIONAL SAFEGUARDS/); assert.match(pre, /not statistically validated thresholds/);
  assert.match(pre, /structural problem gives INVALID first/);
});

// ------------------------------------------------ preregistration wording and freeze compatibility
test('preregistration: blindness wording matches the implementation, no longer claims a public-ID shuffle, and states the limits', () => {
  const pre = fs.readFileSync(path.join(REAL, 'PREREGISTRATION.md'), 'utf8').replace(/\s+/g, ' ');
  assert.doesNotMatch(pre, /shuffled by SHA-256/); assert.doesNotMatch(pre, /opaque order J01-J50, shuffled/);
  assert.match(pre, /random order stored in a private answer key/); assert.match(pre, /only random opaque item and candidate IDs/);
  assert.match(pre, /partial blinding, not full blindness/); assert.match(pre, /answer-key\.json/);
  assert.match(pre, /NOT fully blind/); assert.match(pre, /image metadata is not stripped/); assert.match(pre, /cannot be an independent blind reviewer/);
  assert.match(pre, /PRE-FREEZE DRAFT/); assert.doesNotMatch(pre, /Status: FROZEN at Stage A/);
  assert.match(pre, /SUPPLEMENTARY GROSS-MISMATCH SANITY CHECKS/); assert.match(pre, /absence\/negation cases/);
  for (const [id, sp] of Object.entries({ NM02: 'heldout', NM04: 'calibration', NM06: 'calibration', NM08: 'heldout' })) assert.match(pre, new RegExp(`\\| ${id} \\|[^|]*\\|[^|]*\\| ${sp} \\| absence \\|`));
  assert.match(pre, /nmsplit:/); assert.match(pre, /INCLUSIVE/); assert.match(pre, /candidateIntegrity/);
});

test('freeze hashes the shipped preregistration and negatives; any later edit to either is detected', () => {
  const { dir, its } = makeFixture(); assert.equal(freeze(dir).status, 0);
  const man = L.readJsonStrict(path.join(dir, 'judgments-manifest.json'));
  for (const f of ['PREREGISTRATION.md', 'negatives.json']) assert.equal(man.frozenFiles[f], L.sha256File(path.join(REAL, f)), `${f} hashed as shipped`);
  assert.doesNotThrow(() => L.loadFrozen(dir, its));
  for (const f of ['PREREGISTRATION.md', 'negatives.json']) {
    const p = path.join(dir, f); const orig = fs.readFileSync(p);
    fs.appendFileSync(p, ' '); assert.throws(() => L.loadFrozen(dir, its), new RegExp(`${f.replace('.', '\\.')} changed after freezing`)); fs.writeFileSync(p, orig);
  }
  assert.doesNotThrow(() => L.loadFrozen(dir, its));
  fs.rmSync(dir, { recursive: true, force: true });
});

// ------------------------------------------------ fetch: insufficient scenes fail closed (offline)
const okRec = (id) => ({ query: 'q', hitsReturned: 20, failures: [], status: 'ok', candidates: [...LETTERS].map((l, i) => ({ candidateId: `${id}-${l}`, sceneId: id, searchRank: RANKS[i], sha256: L.sha256Hex(`${id}-${l}`), localPath: `images/${id}/${id}-${l}.jpg` })) });
const insuffRec = (id, extra = {}) => ({ query: 'q', hitsReturned: 3, hitPixabayIds: [1, 2, 3], candidates: [], failures: [], status: 'insufficient', insufficientReason: 'too_few_hits', recordedAt: '2026-10-12T10:00:00.000Z', ...extra });
const decisionFor = (rec, id, over = {}) => ({ sceneId: id, recordSha256: L.recordSha256(rec), decision: 'retry-same-query', decidedBy: 'owner', decidedAt: '2026-10-12T11:00:00.000Z', reason: 'accept a retry of the same query', ...over });
const decDoc = (...d) => ({ schema: 'scene-relevance-v2-fetch-owner-decisions', decisions: d });

test('insufficientGate: ok scenes pass; insufficient and unrecognised scenes block; only a matching owner decision approves', () => {
  const ins = insuffRec('A01'); const doc = { scenes: { A02: okRec('A02'), A01: ins } };
  assert.deepEqual(L.insufficientGate({ scenes: { A02: okRec('A02') } }, null), { blocked: [], approved: [] });
  assert.deepEqual(L.insufficientGate(null, null), { blocked: [], approved: [] }, 'no candidates.json yet: nothing blocked');
  const g1 = L.insufficientGate(doc, null); assert.deepEqual(g1.blocked.map((b) => b.sceneId), ['A01']); assert.match(g1.blocked[0].reason, /insufficient \(too_few_hits\)/); assert.equal(g1.blocked[0].recordSha256, L.recordSha256(ins));
  const g2 = L.insufficientGate(doc, decDoc(decisionFor(ins, 'A01'))); assert.deepEqual(g2.blocked, []); assert.deepEqual(g2.approved.map((a) => a.sceneId), ['A01']);
  const stale = decisionFor(insuffRec('A01', { recordedAt: '2026-10-11T00:00:00.000Z' }), 'A01'); // hash of an EARLIER failure
  assert.deepEqual(L.insufficientGate(doc, decDoc(stale)).blocked.map((b) => b.sceneId), ['A01'], 'a decision for another record never approves this one');
  assert.deepEqual(L.insufficientGate(doc, decDoc(decisionFor(ins, 'A03'))).blocked.map((b) => b.sceneId), ['A01'], 'a decision for another scene does not apply');
  const odd = { scenes: { A01: { ...okRec('A01'), status: 'weird' }, A02: { ...okRec('A02'), candidates: okRec('A02').candidates.slice(0, 5) } } };
  assert.deepEqual(L.insufficientGate(odd, null).blocked.map((b) => b.sceneId), ['A01', 'A02'], 'unrecognised state and an ok scene below the floor both fail closed');
  assert.deepEqual(L.insufficientGate({ scenes: { A02: { ...okRec('A02'), status: 'weird' } } }, decDoc(decisionFor({ ...okRec('A02'), status: 'weird' }, 'A02'))).approved, [], 'only a recorded insufficient scene can be approved');
});

test('validateFetchDecisions rejects anything but an explicit, complete retry-same-query decision', () => {
  const ins = insuffRec('A01'); const good = decisionFor(ins, 'A01');
  assert.doesNotThrow(() => L.validateFetchDecisions(decDoc(good)));
  assert.throws(() => L.validateFetchDecisions(decDoc({ ...good, decision: 'change-query' })), /retry-same-query/);
  assert.throws(() => L.validateFetchDecisions(decDoc({ ...good, decision: 'mark-ok' })), /retry-same-query/);
  for (const k of ['decidedBy', 'reason']) assert.throws(() => L.validateFetchDecisions(decDoc({ ...good, [k]: '  ' })), new RegExp(`${k} is required`));
  assert.throws(() => L.validateFetchDecisions(decDoc({ ...good, decidedAt: 'soon' })), /ISO date/);
  assert.throws(() => L.validateFetchDecisions(decDoc({ ...good, recordSha256: 'abc' })), /recordSha256/);
  assert.throws(() => L.validateFetchDecisions(decDoc({ ...good, sceneId: '../x' })), /sceneId/);
  assert.throws(() => L.validateFetchDecisions(decDoc(good, good)), /duplicate/);
  assert.throws(() => L.validateFetchDecisions({ schema: 'x', decisions: [] }), /wrong schema/);
});

test('archiveInsufficientScene preserves collected candidates and images, numbers attempts, and never overwrites', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scene-rel-v2-arch-'));
  const mkDownloaded = () => { const rec = insuffRec('A01', { hitsReturned: 20, insufficientReason: 'too_few_downloads', candidates: ['A', 'B', 'C'].map((l) => ({ candidateId: `A01-${l}`, localPath: `images/A01/A01-${l}.jpg`, sha256: L.sha256Hex(l) })) }); fs.mkdirSync(path.join(dir, 'images', 'A01'), { recursive: true }); for (const c of rec.candidates) fs.writeFileSync(path.join(dir, c.localPath), `bytes-${c.candidateId}`); return rec; };
  const rec1 = mkDownloaded(); const doc = { scenes: { A01: rec1, A02: okRec('A02') } };
  assert.throws(() => L.archiveInsufficientScene(doc, 'A01', decisionFor(insuffRec('A01'), 'A01'), dir), /does not match the recorded failure/);
  assert.throws(() => L.archiveInsufficientScene(doc, 'A02', decisionFor(okRec('A02'), 'A02'), dir), /only an insufficient scene/);
  assert.ok(doc.scenes.A01 && fs.existsSync(path.join(dir, 'images', 'A01', 'A01-A.jpg')), 'a refused archive changes nothing');
  assert.equal(L.archiveInsufficientScene(doc, 'A01', decisionFor(rec1, 'A01'), dir, '2026-10-12T12:00:00.000Z'), 1);
  assert.equal(doc.scenes.A01, undefined); assert.ok(doc.scenes.A02, 'other scenes untouched');
  const h = doc.attemptHistory.A01[0]; assert.equal(h.attempt, 1); assert.equal(h.ownerDecision.decidedBy, 'owner'); assert.equal(h.recordSha256, L.recordSha256(rec1));
  assert.deepEqual(h.record.candidates.map((c) => c.localPath), ['A', 'B', 'C'].map((l) => `images/A01.attempt1/A01-${l}.jpg`));
  for (const c of h.record.candidates) assert.equal(fs.readFileSync(path.join(dir, ...c.localPath.split('/')), 'utf8'), `bytes-${c.candidateId}`, 'bytes preserved');
  assert.equal(fs.existsSync(path.join(dir, 'images', 'A01')), false);
  const rec2 = mkDownloaded(); rec2.recordedAt = '2026-10-12T13:00:00.000Z'; doc.scenes.A01 = rec2;
  assert.equal(L.archiveInsufficientScene(doc, 'A01', decisionFor(rec2, 'A01'), dir), 2);
  assert.ok(fs.existsSync(path.join(dir, 'images', 'A01.attempt1', 'A01-A.jpg')) && fs.existsSync(path.join(dir, 'images', 'A01.attempt2', 'A01-A.jpg')));
  doc.scenes.A01 = mkDownloaded(); doc.attemptHistory.A01.pop(); fs.mkdirSync(path.join(dir, 'images', 'A01.attempt2'), { recursive: true });
  assert.throws(() => L.archiveInsufficientScene(doc, 'A01', decisionFor(doc.scenes.A01, 'A01'), dir), /refusing to overwrite an archived attempt/);
  fs.rmSync(dir, { recursive: true, force: true });
});

// A stand-in for fetch(): no real network. It logs each call and answers every Pixabay search with 3 hits (< 6).
function fetchStub(dir) {
  const file = path.join(dir, 'stub-fetch.mjs'); const log = path.join(dir, 'stub-calls.log');
  fs.writeFileSync(file, `import fs from 'node:fs';\nglobalThis.fetch = async (u) => { fs.appendFileSync(${JSON.stringify(log)}, String(u).split('?')[0] + '\\n'); return new Response(JSON.stringify({ hits: [1, 2, 3].map((id) => ({ id, largeImageURL: 'https://stub.invalid/' + id + '.jpg', pageURL: 'p', user: 'u', tags: 't' })) }), { status: 200 }); };\n`);
  return { env: { NODE_OPTIONS: `--import ${new URL(`file://${file.replace(/\\/g, '/').replace(/^([A-Za-z]):/, '/$1:')}`).href}`, PIXABAY_API_KEY: 'test-key-not-real' }, calls: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).length : 0) };
}

test('fetch script: an insufficient scene stops every later run before any network call until the owner records a decision; stale decisions never carry over', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scene-rel-v2-fetch-'));
  for (const f of ['scenes.json', 'negatives.json']) fs.copyFileSync(path.join(REAL, f), path.join(dir, f));
  const stub = fetchStub(dir); const env = { EVAL_DIR: dir, ...stub.env };
  const go = (...a) => run('fetch', [...a, '--confirm-stage-approved'], env);
  const read = () => L.readJsonStrict(path.join(dir, 'candidates.json'));

  // 1. first attempt: the stubbed search returns 3 hits -> recorded as insufficient and the run stops
  const r1 = go('--only', 'A01'); assert.equal(r1.status, 1, r1.stderr); assert.match(r1.stderr, /Recorded as insufficient/); assert.equal(stub.calls(), 1);
  const rec1 = read().scenes.A01; assert.equal(rec1.status, 'insufficient'); assert.equal(rec1.insufficientReason, 'too_few_hits'); assert.ok(rec1.recordedAt); assert.deepEqual(rec1.candidates, []);

  // 2. re-run (same scene, another scene, a group, even --dry-run): refused BEFORE any network call
  for (const args of [['--only', 'A01'], ['--only', 'C01'], ['--group', 'positive'], ['--group', 'nearmiss'], ['--only', 'A01', '--dry-run']]) {
    const r = run('fetch', args.includes('--dry-run') ? args : [...args, '--confirm-stage-approved'], env);
    assert.equal(r.status, 1, `${args.join(' ')}: ${r.stderr}`); assert.match(r.stderr, /FETCH REFUSED before any network call.*A01 \(recorded as insufficient \(too_few_hits\)\)/);
  }
  assert.equal(stub.calls(), 1, 'no network call was attempted by any refused run');
  assert.deepEqual(read().scenes.A01, rec1, 'the insufficient record was not reclassified or replaced');

  // 3. --show-insufficient is offline, exits 0, prints the hash the owner must bind a decision to
  const show = run('fetch', ['--show-insufficient'], env); assert.equal(show.status, 0); assert.ok(show.stdout.includes(L.recordSha256(rec1))); assert.equal(stub.calls(), 1);

  // 4. a malformed or non-explicit decision file keeps the stop in place
  const decPath = path.join(dir, L.FETCH_DECISIONS_FILE);
  fs.writeFileSync(decPath, JSON.stringify(decDoc(decisionFor(rec1, 'A01', { decision: 'change-query' }))));
  const bad = go('--only', 'A01'); assert.equal(bad.status, 1); assert.match(bad.stderr, /retry-same-query/); assert.equal(stub.calls(), 1);

  // 5. an explicit owner decision bound to this record allows exactly one retry; the old attempt is preserved
  fs.writeFileSync(decPath, JSON.stringify(decDoc(decisionFor(rec1, 'A01'))));
  const r5 = go('--only', 'A01'); assert.equal(r5.status, 1, r5.stderr); assert.match(r5.stdout, /owner-approved retry \(same query\); previous attempt preserved as attempt 1/); assert.equal(stub.calls(), 2);
  const after = read(); assert.equal(after.attemptHistory.A01.length, 1); assert.deepEqual(after.attemptHistory.A01[0].record, rec1); assert.equal(after.attemptHistory.A01[0].ownerDecision.decidedBy, 'owner');
  assert.equal(after.scenes.A01.status, 'insufficient', 'the retry failed again and is recorded as a NEW failure'); assert.notEqual(L.recordSha256(after.scenes.A01), L.recordSha256(rec1));

  // 6. the consumed decision does not approve the new failure
  const r6 = go('--only', 'A01'); assert.equal(r6.status, 1); assert.match(r6.stderr, /FETCH REFUSED before any network call/); assert.equal(stub.calls(), 2);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ================================================================ pre-freeze integrity follow-up
// Near-miss split: deterministic, stratified by conditionType, no scores involved.
test('near-miss split: deterministic, balanced by condition type, independent of input order, and enforced on the shipped file', () => {
  const nm = realNeg().nearMiss.items;
  const want = L.computeNearMissSplit(nm);
  assert.deepEqual(want, Object.fromEntries(nm.map((n) => [n.id, n.split])), 'shipped negatives.json equals the documented rule');
  const count = (type, sp) => nm.filter((n) => n.conditionType === type && n.split === sp).length;
  assert.deepEqual([count('absence', 'calibration'), count('absence', 'heldout'), count('visual', 'calibration'), count('visual', 'heldout')], [2, 2, 3, 3]);
  assert.deepEqual(L.computeNearMissSplit([...nm].reverse()), want, 'input order cannot change the split');
  assert.deepEqual(L.computeNearMissSplit(structuredClone(nm).map((n) => ({ ...n, description: 'x', searchQuery: 'y', split: 'heldout' }))), want, 'only id and conditionType matter: no score, text or current split');
  // documented rule, recomputed by hand: ascending sha256('nmsplit:'+id), first floor(n/2) are calibration
  const h = (id) => L.sha256Hex(`nmsplit:${id}`);
  const absence = nm.filter((n) => n.conditionType === 'absence').map((n) => n.id).sort((a, b) => (h(a) < h(b) ? -1 : 1));
  assert.deepEqual(absence.slice(0, 2).map((id) => want[id]), ['calibration', 'calibration']);
  assert.deepEqual(absence.slice(2).map((id) => want[id]), ['heldout', 'heldout']);
  // odd stratum: the extra item goes to held-out; a single item is held-out
  const odd = L.computeNearMissSplit([{ id: 'NM01', conditionType: 'visual' }, { id: 'NM02', conditionType: 'visual' }, { id: 'NM03', conditionType: 'visual' }, { id: 'NM04', conditionType: 'absence' }]);
  assert.deepEqual([...Object.values(odd)].sort(), ['calibration', 'heldout', 'heldout', 'heldout']);
  // tampering that keeps 5/5 but breaks the rule is still rejected
  const bad = structuredClone(realNeg()); const a = bad.nearMiss.items.find((n) => n.split === 'calibration' && n.conditionType === 'visual'); const b = bad.nearMiss.items.find((n) => n.split === 'heldout' && n.conditionType === 'visual');
  [a.split, b.split] = [b.split, a.split];
  assert.throws(() => L.validateNegativesDoc(bad, realScenes()), /does not match the SHA-256 rule/);
  const unbalanced = structuredClone(realNeg()); unbalanced.nearMiss.items.forEach((n) => { n.split = n.conditionType === 'absence' ? 'heldout' : 'calibration'; });
  assert.throws(() => L.validateNegativesDoc(unbalanced, realScenes()), /5\/5|SHA-256 rule/);
  assert.match(realNeg().notes, /nmsplit:/);
});

test('report: the inclusive result keeps difficult absence items; subgroups are diagnostic with their own denominators', () => {
  const { dir, its } = makeFixture(); assert.equal(freeze(dir).status, 0);
  // Held-out absence items NM02/NM08 look like perfect matches to the model (a negation failure): they must hurt the overall result.
  const hard = (r) => { for (const rec of r.items) if (['NM02', 'NM08'].includes(rec.itemId)) rec.ranking = rec.ranking.map((x, i) => ({ ...x, score: 0.9 - i * 0.001 })); };
  syntheticResults(dir, its, L.readJsonStrict(path.join(dir, 'judgments-manifest.json')), { tamper: hard });
  assert.equal(run('report', ['--select-rule'], { EVAL_DIR: dir }).status, 0);
  assert.equal(run('report', [], { EVAL_DIR: dir }).status, 0);
  const m = L.readJsonStrict(path.join(dir, 'metrics.json')); const g = m.detection.groups;
  assert.deepEqual(m.detection.heldOutInclusive.falseAcceptance, { count: 2, of: 11 }, 'both absence failures are counted in the overall result');
  assert.deepEqual(m.detection.heldOutExcludingAbsenceDiagnostic.falseAcceptance, { count: 0, of: 9 }, 'diagnostic view only');
  assert.ok(m.detection.heldOutInclusive.auroc < m.detection.heldOutExcludingAbsenceDiagnostic.auroc);
  assert.deepEqual([g.absence.designedCalibration, g.absence.designedHeldOut, g.absence.heldOutEvaluated, g.absence.unsuitableRejected], [2, 2, 2, 0]);
  assert.deepEqual([g.nearmiss.designedCalibration, g.nearmiss.designedHeldOut, g.nearmiss.heldOutEvaluated, g.nearmiss.unsuitableRejected], [3, 3, 3, 3]);
  assert.deepEqual([g.cross.heldOutEvaluated, g.cross.unsuitableRejected], [5, 5]);
  assert.equal(g.absence.aurocVsSuitable, 0); assert.equal(g.cross.aurocVsSuitable, 1);
  assert.deepEqual(m.detection.heldOutCounts.contaminated, []); assert.deepEqual(m.detection.heldOutCounts.modelFailed, []);
  assert.equal(m.heldOut.scenes, 18, 'ranking verdict inputs are untouched');
  const md = fs.readFileSync(path.join(dir, 'REPORT.md'), 'utf8');
  assert.match(md, /Held-out inclusive result[\s\S]*False acceptance \(unsuitable set accepted\): 2\/11/);
  assert.match(md, /Diagnostic only, absence\/negation items left out[\s\S]*must not replace the inclusive one/);
  assert.match(md, /Absence \/ negation \(reported separately\) \| 2 \/ 2 \| 2 \| 0\/2 \| 0\.000 \|/);
  assert.match(md, /Candidates with no score/); assert.match(md, /Download failures recorded at fetch time/);
  assert.deepEqual(L.CRITERIA.promising, { top1Pct: 70, pairwisePct: 75, baselineMarginPp: 15, minCategorySuccesses: 1 });
  assert.deepEqual(L.CRITERIA.notPromising, { top1AtMostPct: 45, pairwiseAtMostPct: 60 });
  fs.rmSync(dir, { recursive: true, force: true });
});

// Freeze-integrity guarantees.
const mutate = (f, fn) => { const p = path.join(f.dir, ...f.rel.split('/')); fn(p); };
test('freeze records candidates.json and per-image SHA-256 with candidate and scene IDs; nothing leaks to the reviewer sheet', () => {
  const { dir, its } = makeFixture(); assert.equal(freeze(dir).status, 0);
  const man = L.readJsonStrict(path.join(dir, 'judgments-manifest.json')); const ci = man.candidateIntegrity;
  assert.equal(man.frozenFiles['candidates.json'], L.sha256File(path.join(dir, 'candidates.json')));
  assert.equal(ci.candidatesSha256, man.frozenFiles['candidates.json']);
  assert.equal(ci.imageCount, 320);
  assert.deepEqual(ci.images[L.sha256Hex('A01-C')], [{ candidateId: 'A01-C', sceneId: 'A01' }]);
  assert.deepEqual(ci.images[L.sha256Hex('NM10-H')], [{ candidateId: 'NM10-H', sceneId: 'NM10' }]);
  for (const [h, list] of Object.entries(ci.images)) for (const e of list) assert.equal(L.sha256File(path.join(dir, 'images', e.sceneId, `${e.candidateId}.jpg`)), h, 'hash is of the bytes on disk');
  assert.doesNotThrow(() => L.loadFrozen(dir, its));
  const { text } = reviewerFacingText(dir);
  for (const h of Object.keys(ci.images)) assert.ok(!text.includes(h), 'no image hash appears in reviewer-facing material');
  assert.ok(!text.includes(ci.candidatesSha256));
  const key = fs.readFileSync(path.join(dir, L.ANSWER_KEY_FILE), 'utf8');
  assert.ok(!Object.keys(ci.images).some((h) => key.includes(h)), 'the answer key is unchanged and holds no image hashes');
  assert.ok(fs.readFileSync(script('freeze'), 'utf8').includes('candidateIntegrity'));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('candidates.json mutation after freeze: loadFrozen, the run script and the report all fail closed; nothing is re-hashed', () => {
  const { dir, its } = makeFixture(); assert.equal(freeze(dir).status, 0);
  const cp = path.join(dir, 'candidates.json'); const orig = fs.readFileSync(cp);
  const doc = L.readJsonStrict(cp); doc.scenes.A01.candidates[0].searchRank += 1; fs.writeFileSync(cp, L.stableStringify(doc));
  assert.throws(() => L.loadFrozen(dir, L.buildItems(realScenes(), realNeg(), doc)), /candidates\.json changed after freezing/);
  const r = run('run', [], { EVAL_DIR: dir, SCENE_RELEVANCE_MODEL_DIR: dir, EVAL_WORKER_PATH: FAKE_WORKER }); assert.equal(r.status, 1); assert.match(r.stderr, /candidates\.json changed after freezing/);
  assert.equal(fs.existsSync(path.join(dir, 'results.json')), false);
  const man = L.readJsonStrict(path.join(dir, 'judgments-manifest.json'));
  assert.equal(man.candidateIntegrity.candidatesSha256, L.sha256Hex(orig), 'manifest was not silently regenerated');
  assert.equal(run('freeze', ['--primary', 'owner'], { EVAL_DIR: dir }).status, 1, 'cannot refreeze over the manifest');
  fs.writeFileSync(cp, orig); assert.doesNotThrow(() => L.loadFrozen(dir, its));
  // report path: results made before the mutation must not yield a verdict afterwards
  syntheticResults(dir, its, man); fs.writeFileSync(cp, L.stableStringify(doc));
  assert.equal(run('report', ['--select-rule'], { EVAL_DIR: dir }).status, 2);
  assert.match(fs.readFileSync(path.join(dir, 'REPORT.md'), 'utf8'), /INVALID[\s\S]*candidates\.json changed after freezing/);
  assert.ok(!fs.existsSync(path.join(dir, 'metrics.json')) && !fs.existsSync(path.join(dir, 'frozen-rule.json')));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('image-byte mutation after freeze: changed, swapped, missing and re-pointed images all fail closed (a filename is never trusted)', () => {
  const { dir, its } = makeFixture(); assert.equal(freeze(dir).status, 0);
  const img = (id) => path.join(dir, 'images', id.split('-')[0], `${id}.jpg`);
  const a = fs.readFileSync(img('A01-A')); const b = fs.readFileSync(img('A01-B'));
  fs.appendFileSync(img('A01-A'), 'x'); assert.throws(() => L.loadFrozen(dir, its), /image bytes changed after freezing: A01-A/);
  const r = run('run', [], { EVAL_DIR: dir, SCENE_RELEVANCE_MODEL_DIR: dir, EVAL_WORKER_PATH: FAKE_WORKER }); assert.equal(r.status, 1); assert.match(r.stderr, /image bytes changed after freezing/);
  fs.writeFileSync(img('A01-A'), a);
  fs.writeFileSync(img('A01-A'), b); fs.writeFileSync(img('A01-B'), a); // names intact, bytes swapped
  assert.throws(() => L.loadFrozen(dir, its), /image bytes changed after freezing/);
  fs.writeFileSync(img('A01-A'), a); fs.writeFileSync(img('A01-B'), b); assert.doesNotThrow(() => L.loadFrozen(dir, its));
  fs.rmSync(img('NM03-D')); assert.throws(() => L.loadFrozen(dir, its), /image file missing for NM03-D/);
  fs.writeFileSync(img('NM03-D'), 'NM03-D'); assert.doesNotThrow(() => L.loadFrozen(dir, its));
  // report: results from before the change must not produce a verdict afterwards
  syntheticResults(dir, its, L.readJsonStrict(path.join(dir, 'judgments-manifest.json'))); fs.appendFileSync(img('F05-E'), 'x');
  assert.equal(run('report', ['--select-rule'], { EVAL_DIR: dir }).status, 2);
  assert.match(fs.readFileSync(path.join(dir, 'REPORT.md'), 'utf8'), /INVALID[\s\S]*image bytes changed after freezing: F05-E/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('freeze and contact sheet refuse images that disagree with candidates.json before anything is frozen', () => {
  const f = makeFixture(); fs.appendFileSync(path.join(f.dir, 'images', 'B02', 'B02-A.jpg'), 'x');
  const fr = freeze(f.dir); assert.equal(fr.status, 1); assert.match(fr.stderr, /do not match the sha256 in candidates\.json/);
  assert.equal(fs.existsSync(path.join(f.dir, 'judgments-manifest.json')), false); assert.equal(fs.existsSync(path.join(f.dir, 'judgments-owner.json')), false, 'nothing written on refusal');
  const g = makeFixture(); const p = path.join(g.dir, 'images', 'C01', 'C01-B.jpg'); fs.writeFileSync(p, 'changed');
  fs.rmSync(path.join(g.dir, 'contact-sheet.html')); fs.rmSync(path.join(g.dir, L.REVIEW_ASSET_DIR), { recursive: true, force: true });
  const cs = run('contact-sheet', [], { EVAL_DIR: g.dir }); assert.notEqual(cs.status, 0); assert.match(cs.stderr, /does not match the sha256 recorded in candidates\.json/);
  for (const x of [f, g]) fs.rmSync(x.dir, { recursive: true, force: true });
});

test('missing or inconsistent integrity records fail closed (manifest and results)', () => {
  const { dir, its } = makeFixture(); assert.equal(freeze(dir).status, 0);
  const mp = path.join(dir, 'judgments-manifest.json'); const man = L.readJsonStrict(mp);
  const bad = (fn, re) => { const m = structuredClone(man); fn(m); assert.throws(() => L.validateManifest(m), re); };
  bad((m) => { delete m.candidateIntegrity; }, /candidateIntegrity is missing/);
  bad((m) => { delete m.frozenFiles['candidates.json']; }, /missing hash for candidates\.json/);
  bad((m) => { m.candidateIntegrity.candidatesSha256 = 'f'.repeat(64); }, /does not match the frozen hash of candidates\.json/);
  bad((m) => { m.candidateIntegrity.imageCount -= 1; }, /imageCount does not match/);
  bad((m) => { m.candidateIntegrity.images = {}; }, /imageCount does not match/);
  bad((m) => { m.candidateIntegrity.images = {}; m.candidateIntegrity.imageCount = 0; }, /missing or empty/);
  bad((m) => { const k = Object.keys(m.candidateIntegrity.images)[0]; m.candidateIntegrity.images[k] = []; }, /malformed image entry/);
  bad((m) => { const k = Object.keys(m.candidateIntegrity.images)[0]; m.candidateIntegrity.images[k][0].sceneId = 'Z99'; }, /inconsistent candidate\/scene mapping/);
  bad((m) => { const [k1, k2] = Object.keys(m.candidateIntegrity.images); m.candidateIntegrity.images[k1].push(m.candidateIntegrity.images[k2][0]); m.candidateIntegrity.imageCount += 1; }, /twice/);
  const ci = man.candidateIntegrity;
  const drop = structuredClone(ci); const k = Object.keys(drop.images)[0]; delete drop.images[k]; drop.imageCount -= 1;
  assert.throws(() => L.verifyCandidateIntegrity(dir, its, drop), /not in the frozen image record/);
  const extra = structuredClone(ci); extra.images[L.sha256Hex('ghost')] = [{ candidateId: 'A01-Z', sceneId: 'A01' }]; extra.imageCount += 1;
  assert.throws(() => L.verifyCandidateIntegrity(dir, its, extra), /not part of the current evaluation/);
  const wrongHash = structuredClone(ci); const [h1, h2] = Object.keys(wrongHash.images); [wrongHash.images[h1], wrongHash.images[h2]] = [wrongHash.images[h2], wrongHash.images[h1]];
  assert.throws(() => L.verifyCandidateIntegrity(dir, its, wrongHash), /differs from the frozen image record|image bytes changed/);
  assert.doesNotThrow(() => L.verifyCandidateIntegrity(dir, its, ci));
  // a manifest on disk with the record removed is refused by the loader (and so by run and report)
  const stripped = structuredClone(man); delete stripped.candidateIntegrity; fs.writeFileSync(mp, L.stableStringify(stripped));
  assert.throws(() => L.loadFrozen(dir, its), /candidateIntegrity is missing/);
  const r = run('run', [], { EVAL_DIR: dir, SCENE_RELEVANCE_MODEL_DIR: dir, EVAL_WORKER_PATH: FAKE_WORKER }); assert.equal(r.status, 1); assert.match(r.stderr, /candidateIntegrity is missing/);
  fs.writeFileSync(mp, L.stableStringify(man));
  // results that do not record the frozen candidate/image hashes cannot yield a verdict
  for (const [field, re] of [['candidatesSha256', /different candidates\.json/], ['candidateIntegritySha256', /different frozen image record/]]) {
    syntheticResults(dir, its, man, { tamper: (res) => { res.meta[field] = 'a'.repeat(64); } });
    assert.equal(run('report', ['--select-rule'], { EVAL_DIR: dir }).status, 2); assert.match(fs.readFileSync(path.join(dir, 'REPORT.md'), 'utf8'), re);
    syntheticResults(dir, its, man, { tamper: (res) => { delete res.meta[field]; } });
    assert.equal(run('report', ['--select-rule'], { EVAL_DIR: dir }).status, 2);
    fs.rmSync(path.join(dir, 'results.json'));
  }
  assert.ok(!fs.existsSync(path.join(dir, 'frozen-rule.json')));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('integrity: path escapes and inconsistent candidate records are refused; hashes come from bytes, not names', () => {
  const { dir, its } = makeFixture();
  const cd = candDoc(); cd.scenes.A01.candidates[0].localPath = 'images/../../outside.jpg';
  assert.throws(() => L.validateCandidatesDoc(cd, ['A01']), /bad localPath/);
  const it2 = structuredClone(its); const abs = it2.find((i) => i.itemId === 'A01').candidates[0]; abs.localPath = '/etc/hostname';
  assert.throws(() => L.buildCandidateIntegrity(dir, it2, 'a'.repeat(64)), /leaves the evaluation folder/);
  const it3 = structuredClone(its); const xn = it3.find((i) => i.kind === 'cross'); xn.candidates = xn.candidates.map((c) => ({ ...c })); xn.candidates[0].sha256 = 'b'.repeat(64); // clone: cross items share candidate objects with their scene
  assert.throws(() => L.uniqueCandidates(it3), /described inconsistently/);
  assert.throws(() => L.buildCandidateIntegrity(dir, its, 'not-a-hash'), /SHA-256 hex digest/);
  // same bytes under two names hash identically, and both candidates are listed under that one hash
  fs.writeFileSync(path.join(dir, 'images', 'A01', 'A01-A.jpg'), 'dup'); fs.writeFileSync(path.join(dir, 'images', 'A01', 'A01-B.jpg'), 'dup');
  const cd2 = candDoc(); for (const l of 'AB') cd2.scenes.A01.candidates.find((c) => c.candidateId === `A01-${l}`).sha256 = L.sha256Hex('dup');
  const ci = L.buildCandidateIntegrity(dir, L.buildItems(realScenes(), realNeg(), cd2), 'c'.repeat(64));
  assert.deepEqual(ci.images[L.sha256Hex('dup')].map((e) => e.candidateId), ['A01-A', 'A01-B']);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ================================================================ pre-fetch safety patch (freeze guard, model pin)
// Recursive snapshot: relative path -> sha256 (files), 'dir', or 'link'. Used to prove a refused run changed nothing.
function snapshot(dir) {
  const out = {};
  const walk = (d, rel) => { for (const n of fs.readdirSync(d).sort()) { const p = path.join(d, n); const r = rel ? `${rel}/${n}` : n; const st = fs.lstatSync(p); if (st.isDirectory()) { out[r] = 'dir'; walk(p, r); } else if (st.isFile()) out[r] = L.sha256File(p); else out[r] = 'link'; } };
  walk(dir, ''); return out;
}
const fetchFixture = () => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scene-rel-v2-guard-')); for (const f of ['scenes.json', 'negatives.json']) fs.copyFileSync(path.join(REAL, f), path.join(dir, f)); return dir; };

test('freezeState classifies the folder from entry names alone and only "clean" allows collection', () => {
  const mk = (...names) => { const d = fetchFixture(); for (const n of names) { if (n.endsWith('/')) fs.mkdirSync(path.join(d, n)); else fs.writeFileSync(path.join(d, n), '{}'); } return d; };
  assert.equal(L.freezeState(mk()).state, 'clean'); assert.equal(L.freezeState(path.join(os.tmpdir(), 'scene-rel-v2-does-not-exist')).state, 'clean');
  assert.equal(L.assertFetchAllowed(mk()), true);
  const cases = [
    [['judgments-manifest.json'], 'frozen'], [['JUDGMENTS-MANIFEST.JSON'], 'frozen'], [['judgments-manifest.json/'], 'frozen'],
    [['judgments-manifest.json', 'results.json'], 'frozen'],
    [['results.json'], 'inconsistent'], [['judgments-owner.json'], 'inconsistent'], [['frozen-rule.json'], 'inconsistent'], [['metrics.json'], 'inconsistent'], [['REPORT.md'], 'inconsistent'],
    [['judgments-manifest.json.bak'], 'ambiguous'], [['judgments-manifest.old'], 'ambiguous'],
    [['answer-key.json'], 'review-started'], [['blind-judgments-owner.json'], 'review-started'], [['contact-sheet.html'], 'review-started'], [['review-assets/'], 'review-started']
  ];
  for (const [names, want] of cases) { const d = mk(...names); assert.equal(L.freezeState(d).state, want, names.join(',')); assert.throws(() => L.assertFetchAllowed(d), /Fetching, archiving and rewriting candidates are refused/, names.join(',')); fs.rmSync(d, { recursive: true, force: true }); }
  const f = path.join(os.tmpdir(), `scene-rel-v2-file-${process.pid}`); fs.writeFileSync(f, 'x');
  assert.equal(L.freezeState(f).state, 'ambiguous', 'a folder that cannot be listed is ambiguous, never clean'); fs.rmSync(f);
});

test('fetch after freeze: every mode is refused before any network call, and nothing on disk changes', () => {
  const states = { 'manifest': ['judgments-manifest.json'], 'manifest in other case': ['Judgments-Manifest.json'], 'manifest + results': ['judgments-manifest.json', 'results.json'], 'results without manifest': ['results.json'], 'judgments without manifest': ['judgments-owner.json'], 'answer key': ['answer-key.json'], 'blind export': ['blind-judgments-owner.json'], 'manifest-like name': ['judgments-manifest.json.bak'] };
  for (const [label, names] of Object.entries(states)) {
    const dir = fetchFixture(); for (const n of names) fs.writeFileSync(path.join(dir, n), '{}');
    const stub = fetchStub(dir); const env = { EVAL_DIR: dir, ...stub.env }; const before = snapshot(dir);
    for (const args of [['--only', 'A01', '--confirm-stage-approved'], ['--group', 'positive', '--confirm-stage-approved'], ['--group', 'nearmiss', '--confirm-stage-approved'], ['--only', 'A01', '--dry-run'], ['--show-insufficient']]) {
      const r = run('fetch', args, env);
      assert.equal(r.status, 1, `${label} ${args.join(' ')}: ${r.stderr}`); assert.match(r.stderr, /FETCH REFUSED before any network call or file change/);
    }
    assert.equal(stub.calls(), 0, `${label}: no network request`); assert.deepEqual(snapshot(dir), before, `${label}: no file created, changed, renamed or removed`);
    assert.equal(fs.existsSync(path.join(dir, 'candidates.json')), false); assert.equal(fs.existsSync(path.join(dir, 'images')), false);
    fs.rmSync(dir, { recursive: true, force: true });
  }
  const f = path.join(os.tmpdir(), `scene-rel-v2-notadir-${process.pid}`); fs.writeFileSync(f, 'x');
  const r = run('fetch', ['--only', 'A01', '--confirm-stage-approved'], { EVAL_DIR: f, PIXABAY_API_KEY: 'test-key-not-real' }); assert.equal(r.status, 1); assert.match(r.stderr, /"ambiguous"/); fs.rmSync(f);
});

test('fetch after freeze: an owner-approved insufficient-scene retry cannot rename image folders or rewrite candidates.json', () => {
  const dir = fetchFixture();
  const rec = { query: 'q', hitsReturned: 3, hitPixabayIds: [1, 2, 3], candidates: [{ candidateId: 'A01-A', sceneId: 'A01', localPath: 'images/A01/A01-A.jpg', sha256: L.sha256Hex('x') }], failures: [], status: 'insufficient', insufficientReason: 'too_few_downloads', recordedAt: '2026-10-12T10:00:00.000Z' };
  fs.writeFileSync(path.join(dir, 'candidates.json'), L.stableStringify({ schema: 'scene-relevance-v2-candidates', scenes: { A01: rec } }));
  fs.mkdirSync(path.join(dir, 'images', 'A01'), { recursive: true }); fs.writeFileSync(path.join(dir, 'images', 'A01', 'A01-A.jpg'), 'x');
  fs.writeFileSync(path.join(dir, L.FETCH_DECISIONS_FILE), JSON.stringify(decDoc(decisionFor(rec, 'A01'))));
  fs.writeFileSync(path.join(dir, 'judgments-manifest.json'), '{}');
  const stub = fetchStub(dir); const before = snapshot(dir);
  const r = run('fetch', ['--only', 'A01', '--confirm-stage-approved'], { EVAL_DIR: dir, ...stub.env });
  assert.equal(r.status, 1); assert.match(r.stderr, /FETCH REFUSED before any network call or file change/); assert.equal(stub.calls(), 0);
  assert.deepEqual(snapshot(dir), before); assert.ok(fs.existsSync(path.join(dir, 'images', 'A01', 'A01-A.jpg'))); assert.equal(fs.existsSync(path.join(dir, 'images', 'A01.attempt1')), false);
  // the library function is guarded too, independent of the script
  const doc = L.readJsonStrict(path.join(dir, 'candidates.json'));
  assert.throws(() => L.archiveInsufficientScene(doc, 'A01', decisionFor(rec, 'A01'), dir), /Fetching, archiving and rewriting candidates are refused/);
  assert.deepEqual(snapshot(dir), before);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('fetch: a clean folder still proceeds (the guard does not block normal collection), and a freeze created mid-run stops the run before candidates.json is written', () => {
  const clean = fetchFixture(); const s1 = fetchStub(clean);
  const r1 = run('fetch', ['--only', 'A01', '--confirm-stage-approved'], { EVAL_DIR: clean, ...s1.env });
  assert.equal(r1.status, 1); assert.match(r1.stderr, /Recorded as insufficient/); assert.equal(s1.calls(), 1, 'existing insufficient-scene behaviour is unchanged');
  assert.equal(L.readJsonStrict(path.join(clean, 'candidates.json')).scenes.A01.status, 'insufficient');
  fs.rmSync(clean, { recursive: true, force: true });

  const dir = fetchFixture(); const file = path.join(dir, 'freeze-during-search.mjs'); const log = path.join(dir, 'calls.log');
  fs.writeFileSync(file, `import fs from 'node:fs';\nglobalThis.fetch = async (u) => { fs.appendFileSync(${JSON.stringify(log)}, 'call\\n'); fs.writeFileSync(${JSON.stringify(path.join(dir, 'judgments-manifest.json'))}, '{}'); return new Response(JSON.stringify({ hits: [1, 2, 3].map((id) => ({ id, largeImageURL: 'https://stub.invalid/' + id + '.jpg' })) }), { status: 200 }); };\n`);
  const imp = new URL(`file://${file.replace(/\\/g, '/').replace(/^([A-Za-z]):/, '/$1:')}`).href;
  const r2 = run('fetch', ['--only', 'A01', '--confirm-stage-approved'], { EVAL_DIR: dir, NODE_OPTIONS: `--import ${imp}`, PIXABAY_API_KEY: 'test-key-not-real' });
  assert.equal(r2.status, 1); assert.match(r2.stderr, /FETCH STOPPED/); assert.equal(fs.readFileSync(log, 'utf8').trim().split('\n').length, 1, 'only the one search that was already under way');
  assert.equal(fs.existsSync(path.join(dir, 'candidates.json')), false, 'candidates.json was not written after the freeze appeared'); assert.equal(fs.existsSync(path.join(dir, 'images')), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('pinned model constants equal the existing evidence in THIRD_PARTY_NOTICES.md and PREREGISTRATION.md (no invented values)', () => {
  const notices = fs.readFileSync(path.join(ROOT, 'THIRD_PARTY_NOTICES.md'), 'utf8'); const prereg = fs.readFileSync(path.join(REAL, 'PREREGISTRATION.md'), 'utf8');
  for (const doc of [notices, prereg]) {
    assert.ok(doc.includes(L.PINNED_MODEL.revision), 'revision'); assert.ok(doc.includes(L.PINNED_MODEL.repo), 'repo');
    for (const h of Object.values(L.PINNED_MODEL.files)) assert.ok(doc.toUpperCase().includes(h.toUpperCase()), `hash ${h}`);
  }
  assert.deepEqual(Object.keys(L.PINNED_MODEL.files).sort(), ['onnx/text_model_quantized.onnx', 'onnx/vision_model_quantized.onnx']);
  assert.throws(() => { L.PINNED_MODEL.revision = 'x'; L.PINNED_MODEL.files['onnx/text_model_quantized.onnx'] = 'x'; }, TypeError, 'pins are frozen');
});

test('verifyModelIdentity: correct bytes pass; changed, truncated, missing, non-regular and unreadable files are all refused', () => {
  const fm = fakeModel(); const rec = L.verifyModelIdentity(fm.md, fm.pins);
  assert.equal(rec.verifiedBeforeInference, true); assert.equal(rec.verifiedAfterInference, false); assert.equal(rec.pinSource, 'repository');
  assert.equal(rec.files['onnx/text_model_quantized.onnx'].bytes, 'text-bytes'.length); assert.match(rec.identitySha256, /^[0-9a-f]{64}$/);
  const tp = path.join(fm.md, 'onnx', 'text_model_quantized.onnx');
  fs.writeFileSync(tp, 'text-byteS'); assert.throws(() => L.verifyModelIdentity(fm.md, fm.pins), /text_model_quantized\.onnx has SHA-256 .* expected .*inference refused/);
  fs.writeFileSync(tp, 'text-byte'); assert.throws(() => L.verifyModelIdentity(fm.md, fm.pins), /expected/);
  fs.writeFileSync(tp, ''); assert.throws(() => L.verifyModelIdentity(fm.md, fm.pins), /expected/);
  fs.writeFileSync(tp, 'text-bytes'); assert.doesNotThrow(() => L.verifyModelIdentity(fm.md, fm.pins));
  fs.rmSync(path.join(fm.md, 'onnx', 'vision_model_quantized.onnx')); assert.throws(() => L.verifyModelIdentity(fm.md, fm.pins), /missing or unreadable: onnx\/vision_model_quantized\.onnx/);
  fs.mkdirSync(path.join(fm.md, 'onnx', 'vision_model_quantized.onnx')); assert.throws(() => L.verifyModelIdentity(fm.md, fm.pins), /not a regular file/);
  fs.rmdirSync(path.join(fm.md, 'onnx', 'vision_model_quantized.onnx'));
  const real = path.join(fm.md, 'real-vision.bin'); fs.writeFileSync(real, 'vision-bytes');
  let linked = true; try { fs.symlinkSync(real, path.join(fm.md, 'onnx', 'vision_model_quantized.onnx')); } catch { linked = false; }
  if (linked) assert.throws(() => L.verifyModelIdentity(fm.md, fm.pins), /not a regular file/, 'a symlink with the right bytes is still refused (it could be re-pointed after verification)');
  assert.throws(() => L.verifyModelIdentity(path.join(fm.md, 'nope'), fm.pins), /model directory cannot be read/);
  assert.throws(() => L.verifyModelIdentity(path.join(fm.md, 'pins.json'), fm.pins), /not a directory/);
  assert.throws(() => L.verifyModelIdentity('', fm.pins), /not set/);
  assert.throws(() => L.validatePins({ ...fm.pins, revision: 'short' }), /malformed/); assert.throws(() => L.validatePins({ ...fm.pins, files: { '../x': 'a'.repeat(64) } }), /bad entry/);
  assert.throws(() => L.verifyModelIdentity(fm.md, { ...fm.pins, files: {} }), /malformed/, 'an empty pin set can never verify anything');
  fs.rmSync(fm.md, { recursive: true, force: true });
});

test('run script refuses to start inference unless the pinned model bytes verify; nothing is written and the worker never runs', () => {
  const { dir } = makeFixture(); assert.equal(freeze(dir).status, 0);
  const marker = path.join(dir, 'worker-ran'); const worker = path.join(dir, 'marker-worker.mjs'); fs.writeFileSync(worker, `import fs from 'node:fs';\nfs.writeFileSync(${JSON.stringify(marker)}, 'ran');\nawait import(${JSON.stringify(new URL(`file://${FAKE_WORKER.replace(/\\/g, '/').replace(/^([A-Za-z]):/, '/$1:')}`).href)});\n`);
  const base = (md, extra = {}) => ({ EVAL_DIR: dir, SCENE_RELEVANCE_MODEL_DIR: md, EVAL_WORKER_PATH: worker, FAKE_MODE: 'ok', ...extra });
  const expectRefused = (env, re) => { const r = run('run', [], env); assert.equal(r.status, 1, r.stderr); assert.match(r.stderr, re); assert.equal(fs.existsSync(path.join(dir, 'results.json')), false, 'no results.json'); assert.equal(fs.existsSync(marker), false, 'worker never started'); };
  const ok = fakeModel(); const changed = fakeModel({ 'onnx/vision_model_quantized.onnx': 'tampered' }); const missing = fakeModel(); fs.rmSync(path.join(missing.md, 'onnx', 'text_model_quantized.onnx'));
  expectRefused(base(ok.md), /model identity not verified: .*expected/);                       // repository pins, synthetic bytes: cannot match
  expectRefused(base(changed.md, { EVAL_MODEL_PINS_FILE: changed.pinsFile }), /model identity not verified: .*vision_model_quantized\.onnx has SHA-256/); // pins file says 'vision-bytes', folder has other bytes
  expectRefused(base(missing.md, { EVAL_MODEL_PINS_FILE: missing.pinsFile }), /model identity not verified: .*missing or unreadable: onnx\/text_model_quantized\.onnx/);
  const noWorker = run('run', [], { EVAL_DIR: dir, SCENE_RELEVANCE_MODEL_DIR: ok.md, EVAL_MODEL_PINS_FILE: ok.pinsFile }); assert.equal(noWorker.status, 1); assert.match(noWorker.stderr, /only honoured together with EVAL_WORKER_PATH/);
  assert.equal(fs.existsSync(path.join(dir, 'results.json')), false);
  for (const x of [ok, changed, missing]) fs.rmSync(x.md, { recursive: true, force: true });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('run script: model bytes changed DURING the run abort it without writing results.json', () => {
  const { dir } = makeFixture(); assert.equal(freeze(dir).status, 0); const fm = fakeModel();
  const worker = path.join(dir, 'tamper-worker.mjs'); const target = path.join(fm.md, 'onnx', 'vision_model_quantized.onnx');
  fs.writeFileSync(worker, `import fs from 'node:fs';\nfs.writeFileSync(${JSON.stringify(target)}, 'swapped-mid-run');\nawait import(${JSON.stringify(new URL(`file://${FAKE_WORKER.replace(/\\/g, '/').replace(/^([A-Za-z]):/, '/$1:')}`).href)});\n`);
  const r = run('run', [], { EVAL_DIR: dir, SCENE_RELEVANCE_MODEL_DIR: fm.md, EVAL_MODEL_PINS_FILE: fm.pinsFile, EVAL_WORKER_PATH: worker, FAKE_MODE: 'ok' });
  assert.equal(r.status, 1, r.stderr); assert.match(r.stderr, /expected .*model files changed during the run; results\.json was NOT written/); assert.equal(fs.existsSync(path.join(dir, 'results.json')), false);
  fs.rmSync(fm.md, { recursive: true, force: true }); fs.rmSync(dir, { recursive: true, force: true });
});

test('run script (fake worker) binds the VERIFIED identity into results.json; unpinned files are observed but not enforced', () => {
  const { dir } = makeFixture(); assert.equal(freeze(dir).status, 0); const fm = fakeModel();
  const r = run('run', ['--no-timing'], { EVAL_DIR: dir, SCENE_RELEVANCE_MODEL_DIR: fm.md, EVAL_MODEL_PINS_FILE: fm.pinsFile, EVAL_WORKER_PATH: FAKE_WORKER, FAKE_MODE: 'ok' });
  assert.equal(r.status, 0, r.stderr); const m = L.readJsonStrict(path.join(dir, 'results.json')).meta;
  assert.equal(m.modelIdentity.verifiedBeforeInference, true); assert.equal(m.modelIdentity.verifiedAfterInference, true); assert.equal(m.modelIdentity.pinSource, 'test-override');
  assert.equal(m.onnxSha256['text_model_quantized.onnx'], L.sha256Hex('text-bytes')); assert.deepEqual(Object.keys(m.unpinnedFilesObserved).sort(), [...L.UNPINNED_MODEL_FILES].sort());
  assert.throws(() => L.validateModelIdentityRecord(m.modelIdentity), /pins, not the repository pins/, 'an override-pinned run can never satisfy the report');
  fs.rmSync(fm.md, { recursive: true, force: true }); fs.rmSync(dir, { recursive: true, force: true });
});

test('report checks the model identity: genuine passes; wrong, missing, unverified or inconsistent identity metadata is INVALID', () => {
  assert.doesNotThrow(() => L.validateModelIdentityRecord(genuineIdentity()));
  const bad = (over, re) => assert.throws(() => L.validateModelIdentityRecord(typeof over === 'function' ? over(genuineIdentity()) : { ...genuineIdentity(), ...over }), re);
  bad({ pinSource: 'test-override' }, /not the repository pins/); bad({ revision: 'a'.repeat(40) }, /repo or revision/); bad({ repo: 'someone/else' }, /repo or revision/);
  bad({ verifiedBeforeInference: false }, /both before and after/); bad({ verifiedAfterInference: false }, /both before and after/); bad({ verifiedAfterInference: 'true' }, /both before and after/);
  bad({ identitySha256: 'b'.repeat(64) }, /digest is inconsistent/); bad({ schema: 'x' }, /missing/);
  bad((r) => { r.files['onnx/text_model_quantized.onnx'].sha256 = 'c'.repeat(64); return r; }, /differs from the pinned value/);
  bad((r) => { delete r.files['onnx/vision_model_quantized.onnx']; return r; }, /differ from the pinned file set/);
  bad((r) => { r.files['onnx/extra.onnx'] = { sha256: 'd'.repeat(64), bytes: 1 }; return r; }, /differ from the pinned file set/);
  bad((r) => { r.files['onnx/text_model_quantized.onnx'].bytes = 0; return r; }, /size/);
  assert.throws(() => L.validateModelIdentityRecord(undefined), /missing/);
  const setup = (tamper) => { const f = makeFixture(); assert.equal(freeze(f.dir).status, 0); syntheticResults(f.dir, f.its, L.readJsonStrict(path.join(f.dir, 'judgments-manifest.json')), { tamper }); return f; };
  const verdict = (d) => fs.readFileSync(path.join(d, 'REPORT.md'), 'utf8');
  const cases = [
    [(r) => { delete r.meta.modelIdentity; }, /model identity record is missing/],
    [(r) => { r.meta.modelIdentity.files['onnx/vision_model_quantized.onnx'].sha256 = 'e'.repeat(64); }, /differs from the pinned value/],
    [(r) => { r.meta.modelIdentity.verifiedBeforeInference = false; }, /both before and after/],
    [(r) => { r.meta.onnxSha256['text_model_quantized.onnx'] = 'f'.repeat(64); }, /onnxSha256 is inconsistent/],
    [(r) => { delete r.meta.onnxSha256; }, /onnxSha256 is inconsistent/]
  ];
  for (const [tamper, re] of cases) { const f = setup(tamper); assert.equal(run('report', ['--select-rule'], { EVAL_DIR: f.dir }).status, 2); assert.match(verdict(f.dir), re); fs.rmSync(f.dir, { recursive: true, force: true }); }
  const g = setup(); assert.equal(run('report', ['--select-rule'], { EVAL_DIR: g.dir }).status, 0, 'a genuine identity is accepted'); fs.rmSync(g.dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------- freeze evidence (backup + verify)
test('evidence record/verify: backs up a valid freeze outside the folder, never touches the folder, and detects accidental corruption', () => {
  const { dir } = makeFixture(); assert.equal(freeze(dir).status, 0);
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'scene-rel-v2-bk-')), 'backup'); const before = snapshot(dir);
  const rec = run('evidence', ['record', '--out', out], { EVAL_DIR: dir }); assert.equal(rec.status, 0, rec.stderr);
  const mh = L.sha256File(path.join(dir, 'judgments-manifest.json')); assert.ok(rec.stdout.includes(mh)); assert.deepEqual(snapshot(dir), before, 'record changes nothing in the evaluation folder');
  assert.ok(fs.existsSync(path.join(out, 'images', 'A01', 'A01-A.jpg')) && fs.existsSync(path.join(out, 'judgments-manifest.json')) && fs.existsSync(path.join(out, 'candidates.json')));
  const sums = fs.readFileSync(path.join(out, 'EVIDENCE-SHA256SUMS.txt'), 'utf8'); assert.ok(sums.includes(`${mh} *judgments-manifest.json`));
  const ok = run('evidence', ['verify', '--backup', out, '--expect-manifest-sha256', mh], { EVAL_DIR: dir }); assert.equal(ok.status, 0, ok.stderr); assert.match(ok.stdout, /^OK: /);
  assert.match(run('evidence', ['verify', '--backup', out], { EVAL_DIR: dir }).stdout, /cannot detect a manifest and backup edited together/);
  // accidental corruption of the backup, of the live folder, an extra live image, a missing live image
  const bimg = path.join(out, 'images', 'A01', 'A01-A.jpg'); const keep = fs.readFileSync(bimg); fs.appendFileSync(bimg, 'x');
  let v = run('evidence', ['verify', '--backup', out], { EVAL_DIR: dir }); assert.equal(v.status, 1); assert.match(v.stderr, /backup file corrupted.*A01-A\.jpg/); assert.doesNotMatch(v.stderr, /evaluation folder differs/, 'only the backup was damaged'); fs.writeFileSync(bimg, keep);
  fs.appendFileSync(path.join(dir, 'images', 'A01', 'A01-B.jpg'), 'x'); v = run('evidence', ['verify', '--backup', out], { EVAL_DIR: dir }); assert.equal(v.status, 1); assert.match(v.stderr, /evaluation folder differs from the backup.*A01-B\.jpg/); fs.writeFileSync(path.join(dir, 'images', 'A01', 'A01-B.jpg'), fs.readFileSync(path.join(out, 'images', 'A01', 'A01-B.jpg')));
  const limg = path.join(dir, 'images', 'C02', 'C02-D.jpg'); const lkeep = fs.readFileSync(limg); fs.rmSync(limg);
  v = run('evidence', ['verify', '--backup', out], { EVAL_DIR: dir }); assert.equal(v.status, 1); assert.match(v.stderr, /evaluation folder is missing: images\/C02\/C02-D\.jpg/); fs.writeFileSync(limg, lkeep);
  fs.writeFileSync(path.join(dir, 'images', 'C02', 'C02-Z.jpg'), 'new'); v = run('evidence', ['verify', '--backup', out], { EVAL_DIR: dir }); assert.equal(v.status, 1); assert.match(v.stderr, /not in the backup: images\/C02\/C02-Z\.jpg/); fs.rmSync(path.join(dir, 'images', 'C02', 'C02-Z.jpg'));
  assert.equal(run('evidence', ['verify', '--backup', out], { EVAL_DIR: dir }).status, 0, 'restored state verifies again');
  // a wrong or malformed independently recorded hash
  v = run('evidence', ['verify', '--backup', out, '--expect-manifest-sha256', 'a'.repeat(64)], { EVAL_DIR: dir }); assert.equal(v.status, 1); assert.match(v.stderr, /differs from the independently recorded/);
  v = run('evidence', ['verify', '--backup', out, '--expect-manifest-sha256', 'zz'], { EVAL_DIR: dir }); assert.equal(v.status, 1);
  fs.rmSync(path.dirname(out), { recursive: true, force: true }); fs.rmSync(dir, { recursive: true, force: true });
});

test('evidence: a manifest edited together with its backup and sidecar is only caught by the independently recorded hash', () => {
  const { dir } = makeFixture(); assert.equal(freeze(dir).status, 0);
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'scene-rel-v2-bk-')), 'backup'); const recorded = L.sha256File(path.join(dir, 'judgments-manifest.json'));
  assert.equal(run('evidence', ['record', '--out', out], { EVAL_DIR: dir }).status, 0);
  // an editor changes the live manifest AND the backup copy AND the backup's sums and metadata consistently
  const man = L.readJsonStrict(path.join(dir, 'judgments-manifest.json')); man.frozenAt = '2030-01-01T00:00:00.000Z'; const text = L.stableStringify(man); const nh = L.sha256Hex(text);
  fs.writeFileSync(path.join(dir, 'judgments-manifest.json'), text); fs.writeFileSync(path.join(out, 'judgments-manifest.json'), text);
  fs.writeFileSync(path.join(out, 'EVIDENCE-SHA256SUMS.txt'), fs.readFileSync(path.join(out, 'EVIDENCE-SHA256SUMS.txt'), 'utf8').replace(recorded, nh));
  const meta = L.readJsonStrict(path.join(out, 'EVIDENCE.json')); meta.manifestSha256 = nh; fs.writeFileSync(path.join(out, 'EVIDENCE.json'), L.stableStringify(meta));
  assert.equal(run('evidence', ['verify', '--backup', out], { EVAL_DIR: dir }).status, 0, 'without an independent hash the consistent edit passes (documented limitation)');
  const v = run('evidence', ['verify', '--backup', out, '--expect-manifest-sha256', recorded], { EVAL_DIR: dir }); assert.equal(v.status, 1); assert.match(v.stderr, /differs from the independently recorded/);
  fs.rmSync(path.dirname(out), { recursive: true, force: true }); fs.rmSync(dir, { recursive: true, force: true });
});

test('evidence record refuses: no freeze, a backup inside the folder, a non-empty target, a changed image; and never overwrites', () => {
  const unfrozen = makeFixture(); const outRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'scene-rel-v2-bk-'));
  let r = run('evidence', ['record', '--out', path.join(outRoot, 'a')], { EVAL_DIR: unfrozen.dir }); assert.equal(r.status, 1); assert.match(r.stderr, /not a valid freeze/); assert.equal(fs.existsSync(path.join(outRoot, 'a')), false, 'nothing created without a freeze');
  assert.equal(freeze(unfrozen.dir).status, 0); const dir = unfrozen.dir;
  r = run('evidence', ['record', '--out', path.join(dir, 'backup')], { EVAL_DIR: dir }); assert.equal(r.status, 1); assert.match(r.stderr, /outside the evaluation folder/); assert.equal(fs.existsSync(path.join(dir, 'backup')), false);
  const full = path.join(outRoot, 'full'); fs.mkdirSync(full); fs.writeFileSync(path.join(full, 'x'), 'x');
  r = run('evidence', ['record', '--out', full], { EVAL_DIR: dir }); assert.equal(r.status, 1); assert.match(r.stderr, /must not exist or must be empty/); assert.deepEqual(fs.readdirSync(full), ['x']);
  const good = path.join(outRoot, 'good'); assert.equal(run('evidence', ['record', '--out', good], { EVAL_DIR: dir }).status, 0);
  r = run('evidence', ['record', '--out', good], { EVAL_DIR: dir }); assert.equal(r.status, 1, 'an existing backup is never overwritten');
  fs.appendFileSync(path.join(dir, 'images', 'A01', 'A01-B.jpg'), 'x'); const after = path.join(outRoot, 'after');
  r = run('evidence', ['record', '--out', after], { EVAL_DIR: dir }); assert.equal(r.status, 1); assert.match(r.stderr, /image bytes changed after freezing/); assert.equal(fs.existsSync(after), false);
  fs.rmSync(outRoot, { recursive: true, force: true }); fs.rmSync(dir, { recursive: true, force: true });
});

// ------------------------------------------------- post hoc duplicate-overlap sensitivity
const realItems = () => L.buildItems(realScenes(), realNeg(), L.readJsonStrict(path.join(REAL, 'candidates.json')));
// candidates.json is an untracked dataset file. Tests that assert facts about the REAL manifest are skipped, visibly, when it is
// absent (fresh clone, CI); when it is present they run in full. Synthetic tests never depend on it.
const REAL_CANDIDATES = path.join(REAL, 'candidates.json');
const realOnly = fs.existsSync(REAL_CANDIDATES) ? {} : { skip: 'eval/scene-relevance-v2/candidates.json is not present: the real-manifest assertions did NOT run' };
const AUTHORIZED_EXCLUSIONS = ['C03', 'D01', 'E01', 'F04', 'NM04', 'NM06', 'NM09', 'XN05', 'XN07', 'XN10'];
const deepFreeze = (o) => { if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); Object.values(o).forEach(deepFreeze); } return o; };
// Synthetic, deterministic scores/judgments over the REAL item structure: suitable sets score high, unsuitable sets low.
function syntheticScored(its) {
  const results = { items: [] }; const j = { items: {} };
  for (const it of its) {
    const positive = it.kind === 'positive';
    const base = positive ? 0.9 : 0.3;
    const ranking = it.candidates.map((c, i) => ({ candidateId: c.candidateId, score: Math.round((base - i * 0.01) * 1e6) / 1e6 }));
    results.items.push({ itemId: it.itemId, ok: true, ranking, ms: 1 });
    j.items[it.itemId] = positive ? { relevant: [it.candidates[0].candidateId], best: [it.candidates[0].candidateId], noneSuitable: false } : { relevant: [], best: [], noneSuitable: true };
  }
  return { results, j };
}

test('duplicateGroups / duplicateOverlapSummary: the real manifest has 320 records, 300 distinct hashes, 19 groups (13 cross the split)', realOnly, () => {
  const its = realItems(); const s = L.duplicateOverlapSummary(its);
  assert.deepEqual(s, { candidateRecords: 320, distinctImageHashes: 300, duplicateGroups: 19, extraRecords: 20, groupsCrossingSplit: 13 });
  const g = L.duplicateGroups(its);
  assert.equal(g.length, 19); assert.equal(g.filter((x) => x.crossesSplit).length, 13);
  assert.ok(g.every((x) => x.sceneIds.length > 1 && x.sceneIds.every((id) => !id.startsWith('XN'))), 'cross-category items never form a duplicate group');
  assert.equal(L.duplicateOverlapSummary(its).candidateRecords, L.uniqueCandidates(its).size, 'records equal the frozen imageCount basis');
});

test('duplicateGroups ignores deliberate cross-category reuse: unique hashes give no groups and no exclusions even with XN reuse', () => {
  const its = L.buildItems(realScenes(), realNeg(), candDoc()); // synthetic: every candidate has a unique hash; XN items still reuse image sets
  assert.ok(its.some((i) => i.kind === 'cross'));
  assert.equal(L.duplicateGroups(its).length, 0);
  assert.deepEqual(L.duplicateExclusions(its).excluded, []);
  assert.equal(L.duplicateOverlapSummary(its).extraRecords, 0);
});

test('duplicateExclusions: equals the authorized set on the real manifest and isolates the accidental duplicates', realOnly, () => {
  const its = realItems(); const ex = L.duplicateExclusions(its);
  assert.deepEqual(ex.excluded, AUTHORIZED_EXCLUSIONS);
  assert.deepEqual(ex.direct, ['C03', 'D01', 'E01', 'F04', 'NM04', 'NM06', 'NM09']); assert.deepEqual(ex.inherited, ['XN05', 'XN07', 'XN10']);
  const splitOf = new Map(its.map((i) => [i.itemId, i.split]));
  for (const id of ex.direct) assert.ok(L.duplicateGroups(its).some((g) => g.crossesSplit && g.sceneIds.includes(id)), `${id} belongs to a split-crossing duplicate group`);
  // every excluded cross item reuses an excluded scene's images; no other cross item is excluded
  for (const x of its.filter((i) => i.kind === 'cross')) assert.equal(ex.excluded.includes(x.itemId), ex.direct.includes(x.candidateScene));
  // after exclusion no accidental (own-set) duplicate group crosses the split any more
  const kept = its.filter((i) => !ex.excluded.includes(i.itemId));
  assert.equal(L.duplicateGroups(kept).filter((g) => g.crossesSplit).length, 0);
  // what still crosses the split afterwards is only the deliberate cross-category reuse
  const byHash = new Map();
  for (const it of kept) for (const c of it.candidates) { if (!byHash.has(c.sha256)) byHash.set(c.sha256, []); byHash.get(c.sha256).push(it); }
  for (const list of byHash.values()) if (new Set(list.map((i) => i.split)).size > 1) assert.ok(list.some((i) => i.kind === 'cross'), 'residual cross-split sharing involves a cross-category item');
  assert.ok(splitOf.size === 50);
});

test('duplicateSensitivity: re-selects under the unchanged preregistered procedure, is labelled post hoc, and leaves the primary analysis untouched', realOnly, () => {
  const its = deepFreeze(realItems()); const { results, j } = syntheticScored(its); deepFreeze(results); deepFreeze(j);
  const primaryBefore = JSON.stringify({ cal: L.detectionItems(its.filter((i) => i.split === 'calibration'), results, j), held: L.detectionItems(its.filter((i) => i.split === 'heldout'), results, j) });
  const sens = L.duplicateSensitivity(its, results, j); // inputs are deep-frozen: any mutation would throw
  assert.equal(sens.label, 'POST HOC, not preregistered');
  assert.deepEqual(sens.exclusions.excluded, AUTHORIZED_EXCLUSIONS);
  // sample sizes before and after
  assert.equal(Object.values(sens.itemsBefore).reduce((a, b) => a + b, 0), 50); assert.equal(Object.values(sens.itemsAfter).reduce((a, b) => a + b, 0), 40);
  assert.deepEqual(sens.itemsAfter, { 'heldout/positive': 15, 'calibration/positive': 11, 'calibration/cross': 4, 'heldout/cross': 3, 'calibration/nearmiss': 3, 'heldout/absence': 2, 'heldout/nearmiss': 2 });
  // the rule is exactly what the preregistered selectRule gives on the remaining calibration items
  const gone = new Set(AUTHORIZED_EXCLUSIONS); const kept = its.filter((i) => !gone.has(i.itemId));
  assert.deepEqual(sens.rule, L.selectRule(L.detectionItems(kept.filter((i) => i.split === 'calibration'), results, j)));
  assert.equal(sens.rule.status, 'selected'); assert.equal(sens.heldOutDetection.falseAcceptance.of, 7); assert.equal(sens.heldOutDetection.falseRejection.of, 15);
  assert.equal(sens.heldOutRanking.scenes, 15); assert.equal(sens.heldOutRanking.eligible, 15);
  // the primary analysis computed afterwards is identical
  const primaryAfter = JSON.stringify({ cal: L.detectionItems(its.filter((i) => i.split === 'calibration'), results, j), held: L.detectionItems(its.filter((i) => i.split === 'heldout'), results, j) });
  assert.equal(primaryAfter, primaryBefore);
  assert.equal(L.detectionItems(its.filter((i) => i.split === 'heldout'), results, j).unsuitable.length + L.detectionItems(its.filter((i) => i.split === 'heldout'), results, j).suitable.length, 28, 'primary held-out keeps all 28 items');
});

test('duplicateSensitivity: when too few items remain it reports no usable rule instead of inventing one (synthetic)', () => {
  const split = L.buildItems(realScenes(), realNeg(), candDoc());
  const calId = split.find((i) => i.kind === 'positive' && i.split === 'calibration').itemId; const heldId = split.find((i) => i.kind === 'positive' && i.split === 'heldout').itemId;
  const its = synthItemsWithShared(calId, heldId); // a real split-crossing duplicate, so the exclusion step is exercised too
  assert.ok(L.duplicateExclusions(its).excluded.length >= 2);
  const { results, j } = syntheticScored(its);
  for (const id of Object.keys(j.items)) if (id.startsWith('NM') || id.startsWith('XN')) j.items[id] = { relevant: [], best: [], noneSuitable: false }; // no unsuitable class remains
  const sens = L.duplicateSensitivity(its, results, j);
  assert.equal(sens.rule.status, 'none'); assert.match(sens.rule.reason, /need >= 3 of each/); assert.equal(sens.heldOutDetection, null);
});

test('report source: the sensitivity section is labelled post hoc, sits beside the primary result, and records vs distinct images are worded apart', () => {
  const src = fs.readFileSync(script('report'), 'utf8');
  assert.match(src, /Post hoc sensitivity: duplicate-image overlap \(POST HOC, not preregistered\)/);
  assert.match(src, /shown beside, never instead of, the primary result above, which is unchanged/);
  assert.match(src, /candidate records, \$\{dupSummary\.distinctImageHashes\} distinct image hashes/);
  assert.match(src, /records re-hashed against the frozen record: \$\{frozen\.manifest\.candidateIntegrity\.imageCount\} records, of which/);
  assert.ok(src.indexOf('## Post hoc sensitivity') > src.indexOf('## Unsuitable-image detection') && src.indexOf('## Post hoc sensitivity') < src.indexOf("'## Integrity'"));
  assert.match(src, /evaluatedImages: frozen\.manifest\.candidateIntegrity\.imageCount/, 'the existing count key is unchanged');
});

test('preregistration addendum: states the 19 groups, 20 extra records, 13 crossing, the deliberate XN reuse, and that it was added after the original', () => {
  const md = fs.readFileSync(path.join(REAL, 'PREREGISTRATION.md'), 'utf8'); const i = md.indexOf('## 14. Duplicate-image overlap');
  assert.ok(i > 0); const sec = md.slice(i);
  for (const re of [/320 candidate records but 300 distinct image hashes/, /19 duplicate groups \(20 extra records\)/, /Thirteen of the 19 groups cross/, /every cross-category item \(XN01 to XN10\)/, /not part of the original\s+preregistration/, /post hoc\s+sensitivity analysis/, /C03, D01, E01, F04, NM04, NM06, NM09, XN05, XN07, XN10/]) assert.match(sec, re);
});

// ---- review follow-up: synthetic duplicate-split logic and empty-sample safety
const POST_HOC_SENTENCE = 'This is a post hoc analysis of the retained subset. It is not a causal estimate of duplicate-induced bias, and its rule is recomputed at report time, not frozen.';
function synthItemsWithShared(a, b) { // synthetic candidates (unique hashes) except that scenes a and b share one image hash
  const cd = candDoc(); const ha = cd.scenes[a].candidates[0].sha256; cd.scenes[b].candidates[0].sha256 = ha;
  return L.buildItems(realScenes(), realNeg(), cd);
}
test('synthetic: a same-split duplicate excludes nothing; a split-crossing accidental duplicate excludes both scenes and inheriting cross items', () => {
  const base = L.buildItems(realScenes(), realNeg(), candDoc());
  const cal = base.filter((i) => i.kind === 'positive' && i.split === 'calibration').map((i) => i.itemId);
  const held = base.filter((i) => i.kind === 'positive' && i.split === 'heldout').map((i) => i.itemId);
  const same = synthItemsWithShared(cal[0], cal[1]);
  assert.equal(L.duplicateGroups(same).length, 1); assert.equal(L.duplicateGroups(same)[0].crossesSplit, false);
  assert.deepEqual(L.duplicateExclusions(same).excluded, [], 'same-split duplicates alone exclude nothing');
  const sameHeld = synthItemsWithShared(held[0], held[1]);
  assert.deepEqual(L.duplicateExclusions(sameHeld).excluded, []);
  const crossing = synthItemsWithShared(cal[0], held[0]);
  const g = L.duplicateGroups(crossing); assert.equal(g.length, 1); assert.equal(g[0].crossesSplit, true);
  const ex = L.duplicateExclusions(crossing);
  assert.deepEqual(ex.direct, [cal[0], held[0]].sort());
  const inheriting = crossing.filter((i) => i.kind === 'cross' && [cal[0], held[0]].includes(i.candidateScene)).map((i) => i.itemId).sort();
  assert.deepEqual(ex.inherited, inheriting); assert.deepEqual(ex.excluded, [...ex.direct, ...ex.inherited].sort());
  // nothing else is excluded
  for (const id of ex.excluded) assert.ok(ex.direct.includes(id) || crossing.find((i) => i.itemId === id).kind === 'cross');
});

test('duplicateSensitivity with an empty held-out set or an empty calibration set: no exception, no invalid percentages, no-usable-rule / n/a output', () => {
  const all = L.buildItems(realScenes(), realNeg(), candDoc()); // synthetic: unique hashes, same split structure as the real items
  // (a) empty held-out: calibration alone still selects a rule; held-out figures are empty, never NaN
  const calOnly = all.filter((i) => i.split === 'calibration'); const a = syntheticScored(calOnly);
  const sa = L.duplicateSensitivity(calOnly, a.results, a.j);
  assert.equal(sa.rule.status, 'selected');
  assert.equal(sa.heldOutRanking.scenes, 0); assert.equal(sa.heldOutRanking.eligible, 0);
  assert.equal(L.pct(sa.heldOutRanking.top1, sa.heldOutRanking.eligible), 'n/a'); assert.equal(L.pct(sa.heldOutRanking.pairHalves / 2, sa.heldOutRanking.pairTotal), 'n/a');
  assert.equal(sa.heldOutDetection.auroc, null); assert.deepEqual(sa.heldOutDetection.falseRejection, { count: 0, of: 0 }); assert.deepEqual(sa.heldOutDetection.falseAcceptance, { count: 0, of: 0 });
  assert.deepEqual(sa.heldOutCounts, { suitable: 0, unsuitable: 0, contaminated: 0, modelFailed: 0 });
  // (b) empty calibration: no usable rule, no held-out detection, ranking still reported on its own denominators
  const heldOnly = all.filter((i) => i.split === 'heldout'); const b = syntheticScored(heldOnly);
  const sb = L.duplicateSensitivity(heldOnly, b.results, b.j);
  assert.equal(sb.rule.status, 'none'); assert.match(sb.rule.reason, /0 suitable and 0 unsuitable items \(need >= 3 of each\)/);
  assert.equal(sb.heldOutDetection, null); assert.equal(sb.heldOutRanking.scenes, 18);
  // (c) both empty
  const sc = L.duplicateSensitivity([], { items: [] }, { items: {} });
  assert.equal(sc.rule.status, 'none'); assert.equal(sc.heldOutDetection, null); assert.equal(sc.heldOutRanking.scenes, 0);
  assert.equal(L.pct(sc.heldOutRanking.top1, sc.heldOutRanking.eligible), 'n/a');
  assert.ok(!JSON.stringify([sa, sb, sc]).includes('NaN'));
});

test('interpretation sentence is present in the report limitations and in section 14', () => {
  assert.ok(fs.readFileSync(script('report'), 'utf8').includes(POST_HOC_SENTENCE));
  const md = fs.readFileSync(path.join(REAL, 'PREREGISTRATION.md'), 'utf8'); assert.ok(md.slice(md.indexOf('## 14. Duplicate-image overlap')).includes(POST_HOC_SENTENCE));
});

// ---- frozen candidateIntegrity schema: keys are distinct SHA-256 hashes, entries are candidate records
test('candidateIntegrity.images (real manifest): keys are distinct hashes, entries are candidate records, counts agree with the item-level summary', realOnly, () => {
  // real manifest hashes, built exactly as buildCandidateIntegrity builds the record (no image files needed)
  const its = realItems(); const images = {}; let n = 0;
  for (const c of [...L.uniqueCandidates(its).values()].sort((a, b) => (a.candidateId < b.candidateId ? -1 : 1))) { (images[c.sha256] ||= []).push({ candidateId: c.candidateId, sceneId: L.sceneIdOfCandidate(c.candidateId) }); n++; }
  const ci = { candidatesSha256: L.sha256File(path.join(REAL, 'candidates.json')), imageCount: n, images };
  L.validateCandidateIntegrity(ci);
  const s = L.duplicateOverlapSummary(its);
  assert.equal(ci.imageCount, 320); assert.equal(Object.keys(ci.images).length, 300);
  assert.equal(Object.values(ci.images).reduce((a, l) => a + l.length, 0), 320, 'entries are candidate records');
  assert.ok(Object.keys(ci.images).every((h) => /^[0-9a-f]{64}$/.test(h)), 'keys are SHA-256 digests');
  assert.equal(ci.imageCount, s.candidateRecords); assert.equal(Object.keys(ci.images).length, s.distinctImageHashes);
});

test('candidateIntegrity.images (synthetic): the real builder and verifier on disk, with one deliberate cross-scene collision', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scene-rel-v2-ci-'));
  const cd = candDoc(); const a = cd.scenes.A01.candidates[0]; const b = cd.scenes.A02.candidates[0];
  for (const e of Object.values(cd.scenes)) for (const c of e.candidates) {
    const bytes = (c === a || c === b) ? 'identical-bytes' : c.candidateId; c.sha256 = L.sha256Hex(bytes);
    fs.mkdirSync(path.dirname(path.join(dir, c.localPath)), { recursive: true }); fs.writeFileSync(path.join(dir, c.localPath), bytes);
  }
  fs.writeFileSync(path.join(dir, 'candidates.json'), L.stableStringify(cd));
  const its2 = L.buildItems(realScenes(), realNeg(), cd); const built = L.buildCandidateIntegrity(dir, its2, L.sha256File(path.join(dir, 'candidates.json')));
  L.validateCandidateIntegrity(built); assert.equal(L.verifyCandidateIntegrity(dir, its2, built), true);
  const s2 = L.duplicateOverlapSummary(its2);
  assert.equal(built.imageCount, 320); assert.equal(Object.keys(built.images).length, 319);
  assert.equal(built.imageCount, s2.candidateRecords); assert.equal(Object.keys(built.images).length, s2.distinctImageHashes); assert.equal(s2.extraRecords, 1);
  // a record that files a candidate under another candidate's hash is refused (verification itself is unchanged)
  const bad = structuredClone(built); const [k1, k2] = Object.keys(bad.images).filter((k) => bad.images[k].length === 1); bad.images[k2].push(bad.images[k1].pop()); delete bad.images[k1];
  assert.throws(() => L.verifyCandidateIntegrity(dir, its2, bad), /differs from the frozen image record/);
  fs.rmSync(dir, { recursive: true, force: true });
});
