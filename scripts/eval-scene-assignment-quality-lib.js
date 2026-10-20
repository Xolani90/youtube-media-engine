// Independent scene-assignment QUALITY evaluation (not the frozen V2 evaluation).
// Pure: takes a manifest of scenes + expectations and a score matrix, runs the
// REAL assignment functions from src/media/sceneAssignment.js against that
// matrix, and measures semantic relevance, not ranking equivalence.
//
// Manifest (written independently of the scorer):
//   images: [{ id, file, license, source, kind? }]  kind: 'corrupt' | 'missing' for unusable fixtures
//   scenes: [{ id, text, relevant: [imageId...], hardNegatives: [imageId...] }]
//     relevant = acceptable images for the scene ([] = no image in the set is acceptable)
//     hardNegatives = plausible-looking but wrong images that must never be chosen
import crypto from 'node:crypto';
import { rankEntries } from '../src/media/sceneRelevance.js';
import { orderAssetsForSlots, orderAssetsForSlotsBatch, orderAssetsForSlotsBatchAll, orderAssetsForSlotsGlobal } from '../src/media/sceneAssignment.js';

export const MODES = Object.freeze(['on', 'batch', 'batch-all', 'global']);
export const TOP_K = 3;

export function validateManifest(m) {
  const fail = (msg) => { throw new Error(`manifest invalid: ${msg}`); };
  if (!m || !Array.isArray(m.images) || !Array.isArray(m.scenes)) fail('images and scenes arrays are required');
  if (m.images.length < 2) fail('at least 2 images');
  const ids = new Set();
  for (const im of m.images) {
    if (!im.id || !im.file || ids.has(im.id)) fail(`image needs a unique id and file (${im.id})`);
    ids.add(im.id);
    if (!['corrupt', 'missing'].includes(im.kind) && (!im.license || !im.source)) fail(`image ${im.id} needs license and source (provenance)`);
  }
  const texts = new Set();
  for (const s of m.scenes) {
    if (!s.id || typeof s.text !== 'string' || !s.text.trim() || texts.has(s.text)) fail(`scene needs an id and a unique non-empty text (${s.id})`);
    texts.add(s.text);
    if (!Array.isArray(s.relevant) || !Array.isArray(s.hardNegatives ?? [])) fail(`scene ${s.id} needs relevant[] (hardNegatives[] optional)`);
    for (const x of [...s.relevant, ...(s.hardNegatives ?? [])]) if (!ids.has(x)) fail(`scene ${s.id} references unknown image ${x}`);
    if (s.relevant.some((x) => (s.hardNegatives ?? []).includes(x))) fail(`scene ${s.id}: an image cannot be relevant and a hard negative`);
  }
  return m;
}

export function manifestHash(m) { return crypto.createHash('sha256').update(JSON.stringify(m)).digest('hex'); }

export function wilson(k, n, z = 1.96) {
  if (n === 0) return null;
  const p = k / n, d = 1 + (z * z) / n;
  const c = p + (z * z) / (2 * n), h = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return [Math.max(0, (c - h) / d), Math.min(1, (c + h) / d)].map((x) => Math.round(x * 1000) / 1000);
}

/** Per-scene raw ranking quality from the score matrix (scores[scene][image], null = unusable). */
export function rankingMetrics(manifest, scores) {
  const imgs = manifest.images;
  return manifest.scenes.map((s, si) => {
    const ranked = rankEntries(imgs.map((im, ii) => ({ path: im.id, score: scores[si][ii] })).filter((e) => Number.isFinite(e.score)));
    const rel = new Set(s.relevant), hard = new Set(s.hardNegatives ?? []);
    const top = ranked[0];
    const bestRelRank = ranked.findIndex((r) => rel.has(r.path));
    const bestRel = ranked.find((r) => rel.has(r.path));
    const bestOther = ranked.find((r) => !rel.has(r.path));
    return {
      scene: s.id, hasRelevant: rel.size > 0,
      top1: top?.path ?? null, top1Score: top?.score ?? null,
      top1Relevant: !!top && rel.has(top.path),
      topKRelevant: ranked.slice(0, TOP_K).some((r) => rel.has(r.path)),
      top1HardNegative: !!top && hard.has(top.path),
      reciprocalRank: bestRelRank >= 0 ? 1 / (bestRelRank + 1) : 0,
      margin: ranked.length > 1 ? Math.round((ranked[0].score - ranked[1].score) * 1e6) / 1e6 : null,
      bestRelevantMinusBestOther: bestRel && bestOther ? Math.round((bestRel.score - bestOther.score) * 1e6) / 1e6 : null
    };
  });
}

function matrixRankers(manifest, scores) {
  const idx = new Map(manifest.images.map((im, i) => [im.id, i]));
  const rowOf = new Map(manifest.scenes.map((s, i) => [s.text, scores[i]]));
  const rank = ({ text, images }) => {
    const row = rowOf.get(text);
    const scored = images.map((p) => ({ path: p, score: row[idx.get(p)] })).filter((e) => Number.isFinite(e.score));
    if (scored.length === 0) return { ok: false, fallback: true, ranking: [] };
    const ranked = rankEntries(scored);
    const rest = images.filter((p) => !scored.some((e) => e.path === p)).map((p, i) => ({ path: p, score: null, rank: ranked.length + i }));
    return { ok: true, fallback: false, ranking: [...ranked, ...rest] };
  };
  const rankBatch = ({ texts, images }) => ({
    ok: true, fallback: false, texts, images,
    scores: texts.map((t) => { const row = rowOf.get(t); return images.map((p) => row[idx.get(p)]); })
  });
  return { rank, rankBatch };
}

/** Runs one REAL assignment mode on the matrix; returns the image id each scene (slot) ends up with. */
export function assignSlots(manifest, scores, mode, { rank, rankBatch } = matrixRankers(manifest, scores)) {
  const assets = manifest.images.map((im) => ({ id: im.id, asset_type: 'image', location: im.id }));
  const texts = manifest.scenes.map((s) => s.text);
  const out = mode === 'on' ? orderAssetsForSlots(assets, texts, { rank })
    : mode === 'batch' ? orderAssetsForSlotsBatch(assets, texts, { rankBatch })
    : mode === 'global' ? orderAssetsForSlotsGlobal(assets, texts, { rankBatch })
    : orderAssetsForSlotsBatchAll(assets, texts, { rankBatch });
  return texts.map((_, i) => out[i % out.length].id); // same indexing computeVisualSequencing uses
}

export function assignmentMetrics(manifest, scores, mode, opts) {
  const picks = assignSlots(manifest, scores, mode, opts);
  const imgIdx = new Map(manifest.images.map((im, i) => [im.id, i]));
  const unusable = new Set(manifest.images.filter((im) => im.kind === 'corrupt' || im.kind === 'missing').map((im) => im.id));
  const rows = manifest.scenes.map((s, si) => {
    const pick = picks[si], rel = new Set(s.relevant);
    const sc = scores[si][imgIdx.get(pick)];
    const ranked = rankEntries(manifest.images.map((im, ii) => ({ path: im.id, score: scores[si][ii] })).filter((e) => Number.isFinite(e.score)));
    return {
      scene: s.id, pick, score: Number.isFinite(sc) ? sc : null, pickRank: ranked.findIndex((r) => r.path === pick) + 1 || null,
      relevant: rel.has(pick), hardNegative: (s.hardNegatives ?? []).includes(pick), unusable: unusable.has(pick),
      forcedOffTop1: ranked.length > 0 && ranked[0].path !== pick
    };
  });
  const n = rows.length, k = (f) => rows.filter(f).length;
  return {
    mode, picks, rows,
    // Sum of the matrix scores of the picks (unscored picks add nothing). Compares allocation, not semantic quality.
    totalScore: Math.round(rows.reduce((a, r) => a + (r.score ?? 0), 0) * 1e9) / 1e9,
    relevantRate: k((r) => r.relevant) / n, relevantCI95: wilson(k((r) => r.relevant), n),
    falseSelectionRate: k((r) => !r.relevant) / n,
    hardNegativeSelected: k((r) => r.hardNegative), unusableSelected: k((r) => r.unusable),
    forcedOffTop1: k((r) => r.forcedOffTop1), noRelevantSceneFilled: manifest.scenes.filter((s, i) => s.relevant.length === 0 && picks[i]).length
  };
}

/**
 * Wall-clock cost of ONE assignment pass on an already-scored matrix (scoring excluded) and whether
 * repeated passes give identical picks. Kept out of evaluate() so evaluate() stays a pure function.
 */
export function timeAssignment(manifest, scores, mode, runs = 20) {
  const first = JSON.stringify(assignSlots(manifest, scores, mode));
  let identical = true;
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < runs; i++) if (JSON.stringify(assignSlots(manifest, scores, mode)) !== first) identical = false;
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  return { mode, runs, identicalPicks: identical, msPerRun: Math.round((ms / runs) * 1000) / 1000 };
}

/** Descriptive abstention table: precision/coverage if picks below a cosine threshold had been rejected. Not applied anywhere. */
export function thresholdTable(assignment) {
  const scored = assignment.rows.filter((r) => r.score !== null).sort((a, b) => a.score - b.score);
  const out = [];
  for (const t of [...new Set(scored.map((r) => r.score))]) {
    const kept = scored.filter((r) => r.score >= t);
    out.push({ minScore: t, kept: kept.length, coverage: kept.length / assignment.rows.length, precision: kept.filter((r) => r.relevant).length / kept.length });
  }
  return out;
}

export function evaluate(manifest, scores, { modes = MODES } = {}) {
  validateManifest(manifest);
  if (scores.length !== manifest.scenes.length || scores.some((r) => r.length !== manifest.images.length)) throw new Error('score matrix shape must be [scenes][images]');
  const ranking = rankingMetrics(manifest, scores);
  const withRel = ranking.filter((r) => r.hasRelevant);
  const top1 = withRel.filter((r) => r.top1Relevant).length;
  const assignments = Object.fromEntries(modes.map((m) => [m, assignmentMetrics(manifest, scores, m)]));
  const ref = assignments[modes[0]].picks;
  return {
    manifestSha256: manifestHash(manifest), scenes: manifest.scenes.length, images: manifest.images.length,
    ranking: {
      top1Accuracy: withRel.length ? top1 / withRel.length : null, top1CI95: wilson(top1, withRel.length),
      topKAccuracy: withRel.length ? withRel.filter((r) => r.topKRelevant).length / withRel.length : null, k: TOP_K,
      mrr: withRel.length ? withRel.reduce((a, r) => a + r.reciprocalRank, 0) / withRel.length : null,
      hardNegativeTop1: ranking.filter((r) => r.top1HardNegative).length, perScene: ranking
    },
    assignments,
    selectionEquivalence: Object.fromEntries(modes.map((m) => [m, JSON.stringify(assignments[m].picks) === JSON.stringify(ref)])),
    thresholds: thresholdTable(assignments[modes.includes('batch') ? 'batch' : modes[0]])
  };
}
