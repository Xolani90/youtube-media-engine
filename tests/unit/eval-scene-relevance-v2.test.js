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
  for (const e of Object.values(cd.scenes)) for (const c of e.candidates) { fs.mkdirSync(path.dirname(path.join(dir, c.localPath)), { recursive: true }); fs.writeFileSync(path.join(dir, c.localPath), 'img'); }
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

// Synthetic results whose scores follow the judgments (relevant high, others low).
function syntheticResults(dir, its, manifest, { tamper } = {}) {
  const j = L.readJsonStrict(path.join(dir, 'judgments-owner.json'));
  const out = { schema: 'scene-relevance-v2-results', meta: { startedAt: 'x', node: 'v', platform: 'p', gitHead: null, modelDirName: 'm', dtype: 'q8', preprocessorConfig: null, workerPath: 'default (src/media/sceneRelevanceWorker.js)', manifestSha256: L.sha256File(path.join(dir, 'judgments-manifest.json')), frozenFiles: manifest.frozenFiles, judgmentFiles: manifest.judgmentFiles }, items: [], timing: [{ sceneId: 'A02', images: 8, oneImageMs: [1000, 1000], allImagesMs: [2400, 2400], allCallsOk: true }] };
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

test('run script (fake worker, offline) writes valid results; report then marks the non-default worker INVALID', () => {
  const { dir, its } = makeFixture(); assert.equal(freeze(dir).status, 0);
  const env = { EVAL_DIR: dir, SCENE_RELEVANCE_MODEL_DIR: dir, EVAL_WORKER_PATH: FAKE_WORKER, FAKE_MODE: 'ok' };
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
  // headline detection excludes the 4 absence items: 5 cross + 1 ordinary near-miss (NM10) + 1 natural none-suitable (A05)
  assert.equal(m.detection.headlineExcludesAbsence, true);
  assert.deepEqual(m.detection.heldOutHeadline.falseAcceptance, { count: 0, of: 7 });
  assert.deepEqual(m.detection.heldOutHeadline.falseRejection, { count: 0, of: 17 });
  const g = m.detection.groups;
  assert.deepEqual([g.cross.designedHeldOut, g.cross.heldOutEvaluated, g.cross.unsuitableRejected], [5, 5, 5]);
  assert.deepEqual([g.nearmiss.designedCalibration, g.nearmiss.designedHeldOut, g.nearmiss.heldOutEvaluated], [5, 1, 1]);
  assert.deepEqual([g.absence.designedCalibration, g.absence.designedHeldOut, g.absence.heldOutEvaluated, g.absence.unsuitableRejected], [0, 4, 4, 4]);
  assert.deepEqual(m.provisionalSafeguards, { minEligibleHeldOut: 12, calibrationMinPerClass: 3, calibrationMinAuroc: 0.7, note: 'chosen in Stage A; not statistically validated thresholds' });
  assert.deepEqual(m.heldOutIneligibleScenes, ['A05']);
  const md = fs.readFileSync(path.join(dir, 'REPORT.md'), 'utf8');
  assert.match(md, /Verdict \(held-out only\): PROMISING/); assert.match(md, /exploratory coverage safeguard/); assert.match(md, /Licensing gate/);
  assert.match(md, /Provisional safeguards \(chosen in Stage A, not statistically validated\)/);
  assert.match(md, /Cross-category \(gross-mismatch sanity check\) \| 5 \/ 5 \| 5 \| 5\/5/);
  assert.match(md, /Ordinary near-miss \| 5 \/ 1 \| 1 \| 1\/1/);
  assert.match(md, /Absence \/ negation \(reported separately\) \| 0 \/ 4 \| 4 \| 4\/4/);
  assert.match(md, /NOT evidence of fine-grained visual discrimination/); assert.match(md, /NOT included in the headline figures/);
  assert.match(md, /Design note: .*0 absence items in calibration, and 1 ordinary near-miss and 4 absence items in held-out/);
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
  assert.equal(m.detection.heldOutHeadline, null);
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
  assert.deepEqual(d.nearmiss, { calibration: 5, heldout: 1 });
  assert.deepEqual(d.absence, { calibration: 0, heldout: 4 });
  const bad = structuredClone(realNeg()); delete bad.nearMiss.items[1].conditionType;
  assert.throws(() => L.validateNegativesDoc(bad, realScenes()), /conditionType/);
  const bad2 = structuredClone(realNeg()); bad2.nearMiss.items[0].conditionType = 'negation';
  assert.throws(() => L.validateNegativesDoc(bad2, realScenes()), /conditionType/);
});

test('partitionDetection keeps absence items out of the headline and discloses their exclusions per group', () => {
  const held = items().filter((i) => i.split === 'heldout' && ['A01', 'XN06', 'NM10', 'NM02', 'NM04', 'NM06'].includes(i.itemId));
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

test('report: a contaminated absence item is excluded from its own group and disclosed; the headline is unaffected', () => {
  const { dir, its } = makeFixture({ judg: { relevantNeg: ['NM04'] } }); assert.equal(freeze(dir).status, 0);
  syntheticResults(dir, its, L.readJsonStrict(path.join(dir, 'judgments-manifest.json')));
  assert.equal(run('report', ['--select-rule'], { EVAL_DIR: dir }).status, 0);
  assert.equal(run('report', [], { EVAL_DIR: dir }).status, 0);
  const m = L.readJsonStrict(path.join(dir, 'metrics.json')); const g = m.detection.groups;
  assert.deepEqual([g.absence.designedHeldOut, g.absence.heldOutEvaluated, g.absence.contaminated], [4, 3, ['NM04']]);
  assert.deepEqual(m.detection.heldOutHeadline.falseAcceptance, { count: 0, of: 7 });
  assert.match(fs.readFileSync(path.join(dir, 'REPORT.md'), 'utf8'), /Absence \/ negation \(reported separately\) \| 0 \/ 4 \| 3 \| 3\/3 \| 1 \(NM04\)/);
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
  for (const id of ['NM02', 'NM04', 'NM06', 'NM08']) assert.match(pre, new RegExp(`\\| ${id} \\|[^|]*\\|[^|]*\\| heldout \\| absence \\|`));
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
