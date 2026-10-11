// EVALUATION ONLY (v2). OFFLINE (reads local files only).
//
// Step 1:  node scripts/eval-scene-relevance-v2-report.js --select-rule
//   Uses CALIBRATION items only to apply the preregistered rule-selection
//   procedure and writes frozen-rule.json (bound to the results and manifest
//   hashes). Refuses to overwrite it. "No usable rule" is a valid, recorded outcome.
// Step 2:  node scripts/eval-scene-relevance-v2-report.js
//   Verifies the frozen manifest and rule, then writes metrics.json and REPORT.md.
//   The verdict uses HELD-OUT results only. Any structural problem (changed
//   hash, malformed judgments or scores, missing baseline, non-default worker,
//   non-blind judgments, rule mismatch) produces INVALID with the reason; it never
//   produces a favourable verdict from missing data.
import fs from 'node:fs';
import path from 'node:path';
import {
  DEFAULT_EVAL_DIR, CRITERIA, candidateIntegritySha256, readJsonStrict, buildItems, loadFrozen, validateResults, sha256File, stableStringify,
  sceneOutcome, aggregatePositives, decide, detectionItems, detectionGroupOf, designedCounts, partitionDetection, auroc, selectRule, evaluateRule, agreementBetween, estimateLoadVsInference, median, mean, pct
} from './eval-scene-relevance-v2-lib.js';

const EVAL_DIR = path.resolve(process.env.EVAL_DIR || DEFAULT_EVAL_DIR);
const selectMode = process.argv.includes('--select-rule');
const rulePath = path.join(EVAL_DIR, 'frozen-rule.json');
const f1 = (x) => (x === null || x === undefined ? 'n/a' : x.toFixed(3));

function load() {
  const scenesDoc = readJsonStrict(path.join(EVAL_DIR, 'scenes.json'));
  const negDoc = readJsonStrict(path.join(EVAL_DIR, 'negatives.json'));
  const candDoc = readJsonStrict(path.join(EVAL_DIR, 'candidates.json'));
  const items = buildItems(scenesDoc, negDoc, candDoc);
  const frozen = loadFrozen(EVAL_DIR, items);
  const resultsPath = path.join(EVAL_DIR, 'results.json');
  if (!fs.existsSync(resultsPath)) throw new Error('results.json is missing: run the model script first');
  const results = validateResults(readJsonStrict(resultsPath), items);
  const m = results.meta;
  if (m.manifestSha256 !== frozen.manifestSha256) throw new Error('results.json was produced under a different manifest than the one on disk');
  if (!String(m.workerPath).startsWith('default')) throw new Error(`a non-default worker was used (${m.workerPath}); this is not a real-model run`);
  for (const [f, h] of Object.entries(frozen.manifest.judgmentFiles)) if (m.judgmentFiles?.[f] !== h) throw new Error(`results.json recorded a different hash for ${f}`);
  // loadFrozen already re-hashed candidates.json and every image on disk; here the results must also have been produced under those exact inputs.
  if (m.candidatesSha256 !== frozen.manifest.candidateIntegrity.candidatesSha256) throw new Error('results.json was produced with a different candidates.json than the frozen one');
  if (m.candidateIntegritySha256 !== candidateIntegritySha256(frozen.manifest.candidateIntegrity)) throw new Error('results.json was produced under a different frozen image record than the one on disk');
  const primary = frozen.judgments[frozen.manifest.primaryReviewer];
  if (primary.sawModelScoresFirst) throw new Error('primary reviewer saw model scores first; judgments are not blind');
  return { scenesDoc, negDoc, candDoc, items, frozen, results, primary, resultsSha256: sha256File(resultsPath) };
}

function calibrationRule(ctx) {
  const det = detectionItems(ctx.items.filter((i) => i.split === 'calibration'), ctx.results, ctx.primary);
  return { det, rule: selectRule(det) };
}

function invalid(reason) {
  const body = `# SigLIP scene-relevance evaluation v2 report\n\n## Verdict: INVALID\n\nReason: ${reason}\n\nNo metric-based recommendation was produced. Nothing was repaired or re-hashed.\n`;
  fs.writeFileSync(path.join(EVAL_DIR, 'REPORT.md'), body);
  console.error(`Verdict: INVALID - ${reason}`);
  process.exit(2);
}

let ctx;
try { ctx = load(); } catch (e) { invalid(e.message); }

if (selectMode) {
  if (fs.existsSync(rulePath)) { console.error('frozen-rule.json already exists; it is never overwritten.'); process.exit(1); }
  const { det, rule } = calibrationRule(ctx);
  const doc = { schema: 'scene-relevance-v2-frozen-rule', selectedFrom: 'calibration-only', manifestSha256: ctx.frozen.manifestSha256, resultsSha256: ctx.resultsSha256, calibrationItems: { suitable: det.suitable.map((x) => x.itemId), unsuitable: det.unsuitable.map((x) => x.itemId), contaminated: det.contaminated, modelFailed: det.modelFailed }, rule };
  fs.writeFileSync(rulePath, stableStringify(doc));
  console.log(rule.status === 'selected' ? `Frozen rule: ${rule.statistic} >= ${rule.threshold} (calibration AUROC ${f1(rule.calibrationAuroc)})` : `No usable rule established: ${rule.reason}`);
  console.log(`Wrote ${rulePath}. Now run the report without --select-rule.`);
  process.exit(0);
}

// ---- full report (held-out verdict) ----
if (!fs.existsSync(rulePath)) invalid('frozen-rule.json is missing: run --select-rule (calibration only) before the held-out evaluation');
const frozenRule = readJsonStrict(rulePath);
if (frozenRule.manifestSha256 !== ctx.frozen.manifestSha256 || frozenRule.resultsSha256 !== ctx.resultsSha256) invalid('frozen-rule.json is bound to different results or judgments than those on disk');
const recomputed = calibrationRule(ctx).rule;
if (stableStringify(recomputed) !== stableStringify(frozenRule.rule)) invalid('frozen-rule.json does not equal the rule recomputed from calibration data');

const { items, results, primary, scenesDoc, candDoc, frozen } = ctx;
const recById = new Map(results.items.map((r) => [r.itemId, r]));
const positives = items.filter((i) => i.kind === 'positive');
const outcomes = (split) => positives.filter((i) => i.split === split).map((i) => sceneOutcome(i, recById.get(i.itemId), primary.items[i.itemId]));
const aggFor = (split) => aggregatePositives(outcomes(split), positives.filter((i) => i.split === split));
const cal = aggFor('calibration'); const held = aggFor('heldout');
const { verdict, why } = decide(held);
const det = (split) => detectionItems(items.filter((i) => i.split === split), results, primary);
const heldDet = det('heldout');
const heldItems = items.filter((i) => i.split === 'heldout');
const heldParts = partitionDetection(heldDet, heldItems); // diagnostic split only: the inclusive result below keeps absence items IN
const groupOf = new Map(items.map((i) => [i.itemId, detectionGroupOf(i)]));
const designed = designedCounts(items);
const rule = frozenRule.rule;
const stat = rule.status === 'selected' ? rule.statistic : null;
const ruleEvalInclusive = rule.status === 'selected' ? evaluateRule(rule, heldDet) : null; // overall result: every eligible held-out item, absence/negation included
const ruleEvalExclAbsence = rule.status === 'selected' ? evaluateRule(rule, heldParts.headline) : null; // diagnostic only
const rejectedIn = (g) => heldDet.unsuitable.filter((x) => groupOf.get(x.itemId) === g && x.stats[stat] < rule.threshold).length;
const byGroup = (g) => ({
  designedCalibration: designed[g].calibration, designedHeldOut: designed[g].heldout,
  heldOutEvaluated: heldDet.unsuitable.filter((x) => groupOf.get(x.itemId) === g).length,
  contaminated: heldDet.contaminated.filter((id) => groupOf.get(id) === g), modelFailed: heldDet.modelFailed.filter((id) => groupOf.get(id) === g),
  unsuitableRejected: rule.status !== 'selected' ? null : rejectedIn(g),
  aurocVsSuitable: rule.status !== 'selected' ? null : auroc(heldDet.suitable.map((x) => x.stats[stat]), heldDet.unsuitable.filter((x) => groupOf.get(x.itemId) === g).map((x) => x.stats[stat]))
});
const groups = { cross: byGroup('cross'), nearmiss: byGroup('nearmiss'), absence: byGroup('absence'), naturalNoneSuitable: byGroup('positive') };
const absenceAuroc = groups.absence.aurocVsSuitable;
const heldIneligible = outcomes('heldout').filter((o) => !o.eligible).map((o) => o.itemId);

const failures = {
  downloads: Object.values(candDoc.scenes).reduce((n, s) => n + (s.failures?.length || 0), 0),
  inferenceImageErrors: results.items.reduce((n, r) => n + (r.imageErrors?.length || 0), 0),
  unscoredCandidates: results.items.reduce((n, r) => n + r.ranking.filter((x) => x.score === null).length, 0),
  workerFallbacks: results.items.filter((r) => !r.ok).map((r) => `${r.itemId}: ${r.reason}`)
};
const times = results.items.map((r) => r.ms);
const loadEst = estimateLoadVsInference(results.timing.filter((t) => t.allCallsOk));
const second = frozen.manifest.secondReviewer ? frozen.judgments[frozen.manifest.secondReviewer] : null;
const agreement = second ? agreementBetween(items, primary, second) : null;

const metrics = {
  verdict, verdictBasis: why, criteria: CRITERIA, heldOut: held, calibrationDescriptiveOnly: cal,
  provisionalSafeguards: { minEligibleHeldOut: CRITERIA.minEligibleHeldOut, calibrationMinPerClass: CRITERIA.rule.minPerClass, calibrationMinAuroc: CRITERIA.rule.minAuroc, note: 'chosen in Stage A; not statistically validated thresholds' },
  heldOutIneligibleScenes: heldIneligible,
  integrity: { candidatesSha256: frozen.manifest.candidateIntegrity.candidatesSha256, evaluatedImages: frozen.manifest.candidateIntegrity.imageCount, verifiedAgainstDisk: true },
  detection: { rule, inclusive: true, heldOutInclusive: ruleEvalInclusive, heldOutExcludingAbsenceDiagnostic: ruleEvalExclAbsence, heldOutCounts: { suitable: heldDet.suitable.length, unsuitable: heldDet.unsuitable.length, contaminated: heldDet.contaminated, modelFailed: heldDet.modelFailed, unsuitableExcludingAbsence: heldParts.headline.unsuitable.length, absenceUnsuitable: heldParts.absence.unsuitable.length }, groups, absenceVsSuitableAuroc: absenceAuroc, designedItems: designed },
  failures, latencyMs: { calls: times.length, median: median(times), mean: mean(times), max: Math.max(...times) }, loadVsInference: loadEst,
  reviewers: { primary: primary.reviewerId, second: second?.reviewerId ?? null, aiSuggestedLabels: primary.aiSuggestedLabels, agreement }
};
fs.writeFileSync(path.join(EVAL_DIR, 'metrics.json'), stableStringify(metrics));

const L = [];
const catTable = (agg) => ['| Category | Scenes | Top-1 successes |', '|---|---|---|', ...Object.entries(agg.categories).map(([c, v]) => `| ${c} | ${v.scenes} | ${v.successes}/${v.scenes} |`)];
const block = (agg) => [
  `- Eligible scenes (at least one relevant candidate): ${agg.eligible} of ${agg.scenes}; scenes judged "none suitable": ${agg.noneSuitable}`,
  `- Top-1 relevant: ${pct(agg.top1, agg.eligible)} (scenes with a tie at the top counted against the model; ties at top: ${agg.tiedAtTop})`,
  `- Top-3 relevant: ${pct(agg.top3, agg.eligible)}`,
  `- Best-ranked-first (ties among human "best" allowed): ${pct(agg.bestFirst, agg.bestDen)}`,
  `- Pairwise accuracy (relevant above non-relevant, ties 0.5, unscored pairs 0): ${pct(agg.pairHalves / 2, agg.pairTotal)}`,
  `- Pixabay-first-result baseline top-1: ${pct(agg.baselineTop1, agg.eligible)}`,
  `- Eligible scenes where the model run failed (counted as top-1 failures, not excluded): ${agg.modelFailedEligible}`
];
L.push('# SigLIP scene-relevance evaluation v2 report', '');
L.push(`Run: ${results.meta.startedAt} | repo HEAD: ${results.meta.gitHead ?? 'unknown'} | node ${results.meta.node} on ${results.meta.platform} | model dir: ${results.meta.modelDirName} | dtype: ${results.meta.dtype}`, '');
L.push(`## Verdict (held-out only): ${verdict}`, '', `Basis: ${why.join('; ')}.`, '');
L.push(`Provisional safeguards (chosen in Stage A, not statistically validated): at least ${CRITERIA.minEligibleHeldOut} eligible held-out scenes (otherwise INCONCLUSIVE, unless a structural error makes the run INVALID), and for the detection rule at least ${CRITERIA.rule.minPerClass} suitable and ${CRITERIA.rule.minPerClass} unsuitable calibration items with AUROC >= ${CRITERIA.rule.minAuroc}. Eligible held-out scenes: ${held.eligible} of ${held.scenes}. Held-out scenes with no relevant candidate (excluded from rates, listed here): ${heldIneligible.length ? heldIneligible.join(', ') : 'none'}. Held-out scenes whose model run failed (counted against the model): ${held.modelFailedAll}.`, '');
L.push('Criteria were preregistered before any score existed (PREREGISTRATION.md). Calibration performance is shown separately and is NOT used to claim success. The held-out sample is small (18 scenes, 3 per category): exploratory, not statistical proof of general performance.', '');
L.push('## Held-out results (18 scenes: 3 per category)', '', ...block(held), '');
L.push('### Category coverage criterion (exploratory coverage safeguard)', '', 'Every category must have at least one successful top-1 result among its three held-out scenes. With three scenes per category this is a coverage safeguard only, not strong evidence of category-level performance.', '', ...catTable(held), '');
L.push('## Calibration results (12 scenes; descriptive only)', '', ...block(cal), '', ...catTable(cal), '');
L.push('## Unsuitable-image detection (separate from ranking quality; does not affect the verdict)', '');
L.push(`Rule frozen from calibration data only: ${rule.status === 'selected' ? `${rule.statistic} >= ${rule.threshold} accepts a set (calibration AUROC ${f1(rule.calibrationAuroc)}, balanced accuracy ${f1(rule.calibrationBalancedAccuracy)})` : `NO USABLE RULE ESTABLISHED: ${rule.reason}`}.`);
L.push(`Calibration class counts: ${rule.counts.suitable} suitable, ${rule.counts.unsuitable} unsuitable (provisional floor: ${CRITERIA.rule.minPerClass} each, AUROC >= ${CRITERIA.rule.minAuroc}).`, '');
L.push('How to read the negative sets:', '- Cross-category items are a supplementary gross-mismatch sanity check. They are mostly easy negatives (unrelated subjects) and are NOT evidence of fine-grained visual discrimination.', '- Ordinary near-misses (same scene, opposite or unaffected visual condition) are the closest thing here to a hard negative, and are provisional.', '- Absence/negation cases (NM02, NM04, NM06, NM08: "empty", "no one") test negation handling. They stay INSIDE the inclusive result below and are also shown as their own diagnostic subgroup, so a negation weakness is visible and is never used to support a claim about ordinary scene relevance.', '');
if (ruleEvalInclusive) {
  L.push(`Held-out inclusive result (every eligible held-out item: cross-category + ordinary near-miss + absence/negation + naturally none-suitable scenes; nothing difficult removed):`,
    `- AUROC: ${f1(ruleEvalInclusive.auroc)} (suitable ${heldDet.suitable.length}, unsuitable ${heldDet.unsuitable.length}; contaminated excluded: ${heldDet.contaminated.length}; model failed excluded: ${heldDet.modelFailed.length})`,
    `- False rejection (suitable set rejected): ${pct(ruleEvalInclusive.falseRejection.count, ruleEvalInclusive.falseRejection.of)}`,
    `- False acceptance (unsuitable set accepted): ${pct(ruleEvalInclusive.falseAcceptance.count, ruleEvalInclusive.falseAcceptance.of)}`,
    `- Diagnostic only, absence/negation items left out: AUROC ${f1(ruleEvalExclAbsence.auroc)}, false acceptance ${pct(ruleEvalExclAbsence.falseAcceptance.count, ruleEvalExclAbsence.falseAcceptance.of)}. This view is not the result and must not replace the inclusive one.`, '');
}
L.push('| Group (diagnostic subgroup) | Designed (calibration / held-out) | Held-out evaluated | Unsuitable rejected by rule | AUROC vs suitable sets | Contaminated (excluded) | Model failed (excluded) |', '|---|---|---|---|---|---|---|');
for (const [name, g] of [['Cross-category (gross-mismatch sanity check)', groups.cross], ['Ordinary near-miss', groups.nearmiss], ['Absence / negation (reported separately)', groups.absence], ['Naturally none-suitable scenes', groups.naturalNoneSuitable]]) {
  L.push(`| ${name} | ${g.designedCalibration} / ${g.designedHeldOut} | ${g.heldOutEvaluated} | ${g.unsuitableRejected === null ? 'n/a (no rule)' : `${g.unsuitableRejected}/${g.heldOutEvaluated}`} | ${f1(g.aurocVsSuitable)} | ${g.contaminated.length}${g.contaminated.length ? ' (' + g.contaminated.join(', ') + ')' : ''} | ${g.modelFailed.length}${g.modelFailed.length ? ' (' + g.modelFailed.join(', ') + ')' : ''} |`);
}
L.push('');
L.push(`Designed split (frozen before any score): ordinary near-miss ${groups.nearmiss.designedCalibration} calibration / ${groups.nearmiss.designedHeldOut} held-out; absence ${groups.absence.designedCalibration} calibration / ${groups.absence.designedHeldOut} held-out; cross-category ${groups.cross.designedCalibration} / ${groups.cross.designedHeldOut}. Every subgroup denominator is small, so read each row as exploratory.`, '');
if (rule.status === 'selected') L.push(`- Absence cases, AUROC against held-out suitable sets: ${f1(absenceAuroc)} (exploratory; ${groups.absence.heldOutEvaluated} evaluated of ${groups.absence.designedHeldOut} designed).`, '');
L.push('- Nothing here is adopted for production. Cosine scores depend on the exact text prompt, so a threshold may not transfer to other scenes or prompt wording.', '');
L.push('## Integrity', '', `- candidates.json SHA-256 (frozen, re-verified): ${frozen.manifest.candidateIntegrity.candidatesSha256}`, `- Evaluated candidate images re-hashed against the frozen record: ${frozen.manifest.candidateIntegrity.imageCount} (a changed, missing or unlisted image, or a changed candidates.json, makes this report INVALID)`, '');
L.push('## Failures', '', `- Download failures recorded at fetch time: ${failures.downloads}`, `- Image decode/inference failures: ${failures.inferenceImageErrors}`, `- Candidates with no score (counted as unscored, not dropped): ${failures.unscoredCandidates}`, `- Worker/model-loading fallbacks: ${failures.workerFallbacks.length}${failures.workerFallbacks.length ? ' - ' + failures.workerFallbacks.join('; ') : ''}`, '');
L.push('## Latency', '', `- Calls: ${times.length}; median ${f1(median(times))} ms; mean ${f1(mean(times))} ms; max ${Math.max(...times)} ms (each call reloads the models)`,
  loadEst ? `- Load vs inference (timing scenes ${loadEst.scenes.join(', ')}): fixed load ~${loadEst.fixedLoadMs} ms per call, ~${loadEst.perImageMs} ms per image` : '- Load vs inference: not measured', '');
L.push('## Reviewers', '', `- Primary reviewer: ${primary.reviewerId}. AI-suggested labels: ${primary.aiSuggestedLabels ? 'YES, so these are NOT fully independent human judgments' : 'no'}. Saw model scores first: no (required).`,
  agreement ? `- Second reviewer ${second.reviewerId}: Cohen's kappa ${agreement.status === 'ok' ? f1(agreement.kappa) : 'undefined (' + agreement.reason + ')'}; raw agreement ${agreement.agree ?? 'n/a'}/${agreement.n ?? 'n/a'} candidate labels` : '- Second reviewer: not available.', '');
L.push('## Limitations', '', '- Exploratory: 30 scenes, 18 held-out; percentages are not statistical proof and may not represent the engine\'s real content.',
  '- One search per scene and spaced candidate positions; difficulty depends on that fixed rule.',
  '- The tooling cannot prove the reviewer judged before seeing scores; it records the reviewer\'s declaration.',
  '- Preprocessing squashes every image to 224x224 (see results.json preprocessorConfig); this evaluation did not alter it.',
  '- No comparison with any other model was run.', '');
L.push('## Licensing gate (unchanged by this evaluation)', '', 'Evaluation authorisation is separate from production authorisation. The Xenova/siglip-base-patch16-224 ONNX conversion declares no licence; THIRD_PARTY_NOTICES.md records the decision as pending the owner. No result here clears the model for production or commercial use.', '');
fs.writeFileSync(path.join(EVAL_DIR, 'REPORT.md'), L.join('\n'));
console.log(`Verdict: ${verdict}`);
console.log(`Wrote ${path.join(EVAL_DIR, 'REPORT.md')} and metrics.json`);
