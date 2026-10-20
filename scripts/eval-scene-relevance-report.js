// EVALUATION ONLY. Step 4 of 4. Combines candidates.json + results.json +
// judgments.json into metrics.json and REPORT.md. It refuses to run without
// human judgments, and only counts scenes the human marked "reviewed".
//
// usage: node scripts/eval-scene-relevance-report.js
import fs from 'node:fs';
import path from 'node:path';

const EVAL_DIR = path.resolve(process.env.EVAL_DIR || path.join('eval', 'scene-relevance'));
const readJson = (f) => JSON.parse(fs.readFileSync(path.join(EVAL_DIR, f), 'utf8'));
for (const f of ['candidates.json', 'results.json', 'judgments.json']) {
  if (!fs.existsSync(path.join(EVAL_DIR, f))) {
    console.error(`Missing ${f}. ${f === 'judgments.json' ? 'Human judgments are required: use the contact sheet and export them.' : 'Run the earlier steps first.'}`);
    process.exit(1);
  }
}
const scenesDoc = readJson('scenes.json');
const cand = readJson('candidates.json');
const results = readJson('results.json');
const judg = readJson('judgments.json');

// Recommendation rule, fixed BEFORE any results existed. Heuristic, not statistics.
const RULE = {
  minScenes: 8,
  promising: { top1: 0.7, pairwise: 0.75 },
  notPromising: { top1AtMost: 0.4, pairwiseAtMost: 0.55 }
};

const P = (x) => Math.round(x * 100);
const pct = (n, d) => (d === 0 ? 'n/a' : `${n}/${d} (${Math.round((100 * n) / d)}%)`);
const median = (a) => { const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length ? (s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2) : null; };
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const fix = (x, d = 0) => (x === null ? 'n/a' : x.toFixed(d));

const rows = [];
const excluded = [];
let totalCandidates = 0, scoredCandidates = 0;
const preprocessFailures = [], rankingFailures = [];

for (const scene of scenesDoc.scenes) {
  const c = cand.scenes[scene.id];
  const r = results.scenes.find((s) => s.sceneId === scene.id);
  const j = judg.scenes?.[scene.id];
  if (!c || !r) { excluded.push(`${scene.id}: no candidates or no result`); continue; }
  totalCandidates += c.candidates.length;
  scoredCandidates += r.ranking.filter((x) => x.score !== null).length;
  for (const e of r.imageErrors) preprocessFailures.push(`${e.candidateId}: ${e.error}`);
  if (!r.ok) { rankingFailures.push(`${scene.id}: ${r.reason}`); excluded.push(`${scene.id}: worker fell back (${r.reason})`); continue; }
  if (!j || j.reviewed !== true) { excluded.push(`${scene.id}: not human-reviewed`); continue; }
  const ids = new Set(c.candidates.map((x) => x.candidateId));
  const bad = [...j.relevant, ...j.best].filter((x) => !ids.has(x));
  if (bad.length || j.best.some((b) => !j.relevant.includes(b)) || (j.noneSuitable && j.relevant.length)) {
    console.error(`${scene.id}: judgments are inconsistent (unknown ids, best not in relevant, or noneSuitable with relevant). Fix and re-export.`);
    process.exit(1);
  }
  rows.push({ scene, r, j, cands: c.candidates });
}

const scored = (row) => row.r.ranking.filter((x) => x.score !== null);
let top1Rel = 0, top1Best = 0, bestDenom = 0, top3Rel = 0, obviousFail = [], clearlyBetter = [], noneSuit = 0;
let pairOk = 0, pairTot = 0, randomExp = 0, pixabayTop1 = 0;
const withRel = rows.filter((x) => x.j.relevant.length > 0);
const perScene = [];
for (const row of rows) {
  const rk = scored(row);
  const top = rk[0]?.candidateId;
  const rel = new Set(row.j.relevant), best = new Set(row.j.best);
  if (row.j.noneSuitable) noneSuit++;
  const topRel = rel.has(top);
  if (topRel) top1Rel++;
  if (best.size) { bestDenom++; if (best.has(top)) top1Best++; }
  if (rel.size && rk.slice(0, 3).some((x) => rel.has(x.candidateId))) top3Rel++;
  if (rel.size && !topRel) obviousFail.push(row.scene.id);
  if (topRel && best.size && !best.has(top)) clearlyBetter.push(row.scene.id);
  if (rel.size) {
    randomExp += rel.size / rk.length;
    if (rel.has(row.cands[0].candidateId)) pixabayTop1++;
    for (const a of rk) for (const b of rk) {
      if (rel.has(a.candidateId) && !rel.has(b.candidateId)) { pairTot++; pairOk += a.score > b.score ? 1 : a.score === b.score ? 0.5 : 0; }
    }
  }
  perScene.push({
    sceneId: row.scene.id, top, topRelevant: topRel, relevant: [...rel], best: [...best], noneSuitable: row.j.noneSuitable,
    notes: row.j.notes || '', ranking: rk.map((x) => `${x.candidateId.split('-')[1]} ${x.score.toFixed(4)}`).join(' > ')
  });
}
const n = rows.length, nRel = withRel.length;
const pairwise = pairTot ? pairOk / pairTot : null;
const times = results.scenes.map((s) => s.ms);
const calib = results.calibration;

let rec = 'INCONCLUSIVE', why = [];
if (n < RULE.minScenes) why.push(`only ${n} usable scenes (< ${RULE.minScenes})`);
else {
  const t1 = top1Rel / n;
  if (t1 >= RULE.promising.top1 && pairwise !== null && pairwise >= RULE.promising.pairwise) { rec = 'PROMISING'; why.push(`top-1 relevant ${pct(top1Rel, n)} and pairwise accuracy ${fix(pairwise * 100)}% meet the pre-set thresholds (>= ${P(RULE.promising.top1)}% / >= ${P(RULE.promising.pairwise)}%)`); }
  else if (t1 <= RULE.notPromising.top1AtMost || (pairwise !== null && pairwise <= RULE.notPromising.pairwiseAtMost)) { rec = 'NOT PROMISING'; why.push(`top-1 relevant ${pct(top1Rel, n)} / pairwise ${pairwise === null ? 'n/a' : fix(pairwise * 100) + '%'} hit the pre-set floor (<= ${P(RULE.notPromising.top1AtMost)}% top-1 or <= ${P(RULE.notPromising.pairwiseAtMost)}% pairwise)`); }
  else why.push(`results fall between the pre-set thresholds (top-1 ${pct(top1Rel, n)}, pairwise ${pairwise === null ? 'n/a' : fix(pairwise * 100) + '%'})`);
}

const metrics = {
  scenesInDataset: scenesDoc.scenes.length, scenesEvaluated: n, excluded,
  candidates: { total: totalCandidates, scored: scoredCandidates, preprocessFailures, rankingFailures },
  top1Relevant: { count: top1Rel, of: n }, top1RelevantAmongScenesWithAnyRelevant: { count: withRel.filter((x) => perScene.find((p) => p.sceneId === x.scene.id).topRelevant).length, of: nRel },
  top3Relevant: { count: top3Rel, of: nRel }, bestRankedFirst: { count: top1Best, of: bestDenom },
  obviousFailures: obviousFail, topRelevantButClearlyBetterExists: clearlyBetter, noSuitableCandidate: noneSuit,
  pairwiseAccuracy: pairwise, context: { randomOrderExpectedTop1: nRel ? randomExp / nRel : null, pixabaySearchOrderTop1: { count: pixabayTop1, of: nRel } },
  latencyMs: { perCall: times, mean: mean(times), median: median(times), min: Math.min(...times), max: Math.max(...times), total: times.reduce((a, b) => a + b, 0) },
  calibration: calib, recommendation: rec, recommendationBasis: why, rule: RULE
};
fs.writeFileSync(path.join(EVAL_DIR, 'metrics.json'), JSON.stringify(metrics, null, 2));

const L = [];
L.push('# SigLIP scene-relevance evaluation report', '');
L.push(`Run: ${results.meta.startedAt} | repo HEAD: ${results.meta.gitHead ?? 'unknown'} | node ${results.meta.node} on ${results.meta.platform} | model dir: ${results.meta.modelDirName} | dtype: ${results.meta.dtype}`);
if (!String(results.meta.workerPath).startsWith('default')) L.push('', `**WARNING: a non-default worker was used (${results.meta.workerPath}). This is not a real-model run.**`);
L.push('', `## Recommendation: ${rec}`, '', `Basis: ${why.join('; ')}.`, '',
  `Rule fixed before the data existed: PROMISING needs >= ${RULE.minScenes} usable scenes, top-1 >= ${P(RULE.promising.top1)}% and pairwise accuracy >= ${P(RULE.promising.pairwise)}%; NOT PROMISING if top-1 <= ${P(RULE.notPromising.top1AtMost)}% or pairwise <= ${P(RULE.notPromising.pairwiseAtMost)}%; otherwise INCONCLUSIVE. This is a heuristic on a small sample, not statistical proof of general performance.`, '');
L.push('## Counts', '',
  `- Scenes evaluated (human-reviewed and ranked): ${n} of ${scenesDoc.scenes.length}`,
  `- Candidate images scored: ${scoredCandidates} of ${totalCandidates}`,
  `- Top-1 relevant: ${pct(top1Rel, n)} (among the ${nRel} scenes with any relevant candidate: ${pct(metrics.top1RelevantAmongScenesWithAnyRelevant.count, nRel)})`,
  `- Top-3 relevant: ${pct(top3Rel, nRel)} (weak signal with ~5 candidates per scene)`,
  `- Best human-judged candidate ranked first: ${pct(top1Best, bestDenom)}`,
  `- Obvious ranking failures (a relevant candidate existed, top-1 was not relevant): ${obviousFail.length}${obviousFail.length ? ' (' + obviousFail.join(', ') + ')' : ''}`,
  `- Top-1 relevant but a clearly better candidate existed: ${clearlyBetter.length}${clearlyBetter.length ? ' (' + clearlyBetter.join(', ') + ')' : ''}`,
  `- Scenes where no candidate was suitable: ${noneSuit}`,
  `- Pairwise accuracy (relevant scored above non-relevant, ties 0.5): ${pairwise === null ? 'n/a' : `${pairOk}/${pairTot} (${Math.round(pairwise * 100)}%)`}`,
  `- Preprocessing/decode failures: ${preprocessFailures.length}${preprocessFailures.length ? ' - ' + preprocessFailures.join('; ') : ''}`,
  `- Ranking (worker) failures: ${rankingFailures.length}${rankingFailures.length ? ' - ' + rankingFailures.join('; ') : ''}`,
  ...(excluded.length ? ['', 'Excluded scenes: ' + excluded.join('; ')] : []), '');
L.push('Reference points from the same data (not a comparison with another model):',
  `- Expected top-1 if the order were random: ${metrics.context.randomOrderExpectedTop1 === null ? 'n/a' : fix(metrics.context.randomOrderExpectedTop1 * 100) + '%'}`,
  `- Top-1 if the first candidate (Pixabay search rank order within the sampled set) were taken: ${pct(pixabayTop1, nRel)}`, '');
L.push('## Per scene', '', '| Scene | Human relevant | Human best | SigLIP top | Top relevant | Ranking (score) | Notes |', '|---|---|---|---|---|---|---|');
for (const p of perScene) {
  const short = (x) => x.split('-')[1];
  L.push(`| ${p.sceneId} | ${p.noneSuitable ? 'none suitable' : p.relevant.map(short).join(',') || '-'} | ${p.best.map(short).join(',') || '-'} | ${p.top ? short(p.top) : '-'} | ${p.topRelevant ? 'yes' : 'no'} | ${p.ranking} | ${String(p.notes).replace(/\|/g, '/').replace(/\n/g, ' ')} |`);
}
L.push('', '## Latency', '',
  `- Calls: ${times.length}; mean ${fix(mean(times))} ms; median ${fix(median(times))} ms; min ${Math.min(...times)} ms; max ${Math.max(...times)} ms; total ${fix(metrics.latencyMs.total / 1000, 1)} s`);
if (calib && !calib.error) {
  L.push(`- Calibration on ${calib.sceneId}: 1-image calls ${calib.oneImageMs.join(', ')} ms; ${calib.imagesInFullCall}-image calls ${calib.allImagesMs.join(', ')} ms`,
    `- Estimated fixed load cost per call: ~${calib.estimatedFixedLoadMs} ms; estimated cost per additional image: ~${calib.estimatedPerImageMs} ms`,
    `- Identical ranking across the two repeated full calls: ${calib.sameRankingAcrossRepeats ? 'yes' : 'NO'}`);
  const fixedShare = calib.estimatedFixedLoadMs / (calib.estimatedFixedLoadMs + calib.estimatedPerImageMs * (calib.imagesInFullCall));
  L.push(`- Fixed load is about ${Math.round(fixedShare * 100)}% of a ${calib.imagesInFullCall}-image call. If scenes were batched into one worker call, ${n} scenes would pay the load once instead of ${n} times: rough saving ~${fix(((n - 1) * calib.estimatedFixedLoadMs) / 1000, 0)} s for this workload (an estimate; batching is NOT implemented and needs a separate authorized task).`);
} else L.push('- Calibration was not run or failed; load-vs-scoring split is unmeasured.');
L.push('', '## Limitations', '',
  `- Small exploratory sample: ${n} scenes, ~5 candidates each. Percentages are not statistical proof of general performance.`,
  '- One judge (the owner), with labels suggested by Claude and confirmed by the owner, so not fully independent.',
  '- Candidates are sampled from spaced positions of one Pixabay search per scene (see candidatePickRule in scenes.json); how hard the test is depends on that choice.',
  '- Scenes are the owner-supplied starting examples, not a measured sample of the engine\'s real content mix.',
  '- Judgments were made by a person looking at the contact sheet; confirm the judgments were completed before the scores were viewed (the tooling cannot prove this).',
  `- Preprocessing used by the worker: ${results.meta.preprocessorConfig ? JSON.stringify(results.meta.preprocessorConfig) : 'preprocessor_config.json not recorded'}. Check whether it resizes to a square (which would distort wide photos); the evaluation did not alter it.`,
  '- No comparison with any other model was run, so nothing here shows SigLIP is better than an alternative.', '');
L.push('## Unresolved licensing and operational concerns', '',
  '- The Xenova ONNX conversion still declares no license; the decision in THIRD_PARTY_NOTICES.md remains "pending owner decision". This evaluation does not resolve it.',
  '- Pixabay availability does not by itself settle downstream rights. Candidate photos are for this evaluation only: do not commit or redistribute eval/scene-relevance/images/, and recognisable people, brands or logos may carry extra restrictions. Provenance is recorded in candidates.json.',
  '- Pixabay terms require caching results and disallow systematic bulk downloading; this run used one search per scene and ~5 downloads each. Do not re-run needlessly.',
  '- The worker reloads all models on every call and is not wired into the pipeline; per-call cost above is the current operational baseline.',
  '- Model files were downloaded from `resolve/main` and pinned only after the fact in the notice; setup instructions should use the pinned revision.',
  '- Scores rank candidates; they are not a rights, factual or safety check.', '');
fs.writeFileSync(path.join(EVAL_DIR, 'REPORT.md'), L.join('\n'));
console.log(`Recommendation: ${rec}`);
console.log(`Wrote ${path.join(EVAL_DIR, 'REPORT.md')} and metrics.json`);