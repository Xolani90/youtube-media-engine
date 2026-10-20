// Opt-in scene-relevance asset ordering. Pure: the ranker is injected.
// Default OFF (SCENE_RELEVANCE_ASSIGN unset/off) -> pipeline output unchanged.
// Ranking is a signal only; it is not a rights, factual or safety check.
import { rankSceneImages, rankEntries, MAX_IMAGES, MAX_TEXT_CHARS } from './sceneRelevance.js';
import { rankSceneBatch, MAX_TEXTS } from './sceneRelevanceBatch.js';

export function resolveSceneAssignmentEnabled(env = process.env) {
  const v = (env.SCENE_RELEVANCE_ASSIGN ?? 'off').trim().toLowerCase();
  if (v === '' || v === 'off' || v === '0' || v === 'false') return false;
  if (v === 'on' || v === '1' || v === 'true') return true;
  throw new Error(`SCENE_RELEVANCE_ASSIGN must be one of on, off (got "${v}")`);
}

/**
 * Returns a re-ordered copy of visualAssets (same length, same members) such
 * that computeVisualSequencing's `assets[i % n]` gives slot i its best unused
 * asset; slots beyond n reuse cyclically; unranked/failed slots keep the
 * current order. Never throws for ranker problems; returns the input order.
 * rank(request) -> { ok, ranking: [{ path, rank }] } (rankSceneImages shape).
 */
export function orderAssetsForSlots(visualAssets, slotTexts, { rank = rankSceneImages } = {}) {
  const assets = [...(visualAssets ?? [])];
  const n = assets.length;
  if (n < 2 || !Array.isArray(slotTexts) || slotTexts.length === 0) return assets;
  if (assets.some((a) => a.asset_type !== 'image' || typeof a.location !== 'string')) return assets;
  if (new Set(assets.map((a) => a.location)).size !== n) return assets;

  const used = new Set();
  const out = [];
  const slots = Math.min(slotTexts.length, n);
  for (let i = 0; i < slots; i++) {
    const remaining = assets.filter((a) => !used.has(a.id));
    let pick = remaining[0]; // fallback: current order
    const text = slotTexts[i];
    if (remaining.length > 1 && typeof text === 'string' && text.trim()) {
      try {
        const res = rank({ text, images: remaining.map((a) => a.location) });
        const top = res && res.ok === true && Array.isArray(res.ranking)
          ? [...res.ranking].sort((x, y) => x.rank - y.rank).find((r) => r.score !== null && remaining.some((a) => a.location === r.path))
          : null;
        if (top) pick = remaining.find((a) => a.location === top.path);
      } catch { /* keep current order */ }
    }
    used.add(pick.id);
    out.push(pick);
  }
  for (const a of assets) if (!used.has(a.id)) out.push(a);
  return out;
}

/** 'off' (default) | 'on' (one worker call per slot, existing) | 'batch' (one worker call per video) | 'batch-all' (batch + relevance for slots beyond the asset count) | 'global' (batch scoring + score-maximising one-to-one assignment). */
export function resolveSceneAssignmentMode(env = process.env) {
  const v = (env.SCENE_RELEVANCE_ASSIGN ?? 'off').trim().toLowerCase();
  if (v === 'batch') return 'batch';
  if (v === 'global') return 'global';
  if (v === 'batch-all') return 'batch-all';
  return resolveSceneAssignmentEnabled(env) ? 'on' : 'off';
}

/**
 * Batched variant: ONE rankBatch call for the whole video, then the SAME
 * greedy assignment as orderAssetsForSlots, reading scores from the matrix.
 * Any batch failure/invalid result => current order (slots fall back).
 * rankBatch({ texts, images }) -> { ok, texts, images, scores } (rankSceneBatch shape).
 */
export function orderAssetsForSlotsBatch(visualAssets, slotTexts, { rankBatch = rankSceneBatch } = {}) {
  const assets = [...(visualAssets ?? [])];
  const n = assets.length;
  if (n < 2 || !Array.isArray(slotTexts) || slotTexts.length === 0) return assets;
  if (n > MAX_IMAGES) return assets;
  if (assets.some((a) => a.asset_type !== 'image' || typeof a.location !== 'string')) return assets;
  if (new Set(assets.map((a) => a.location)).size !== n) return assets;

  const usable = (t) => typeof t === 'string' && t.trim() && t.length <= MAX_TEXT_CHARS;
  const needed = slotTexts.slice(0, Math.min(slotTexts.length, n)).filter(usable);
  const texts = [...new Set(needed)].slice(0, MAX_TEXTS);
  if (texts.length === 0) return assets;

  let res = null;
  try { res = rankBatch({ texts, images: assets.map((a) => a.location) }); } catch { res = null; }
  const good = res && res.ok === true && Array.isArray(res.scores) && res.scores.length === texts.length
    && res.scores.every((r) => Array.isArray(r) && r.length === n);
  if (!good) return assets;

  const row = new Map(texts.map((t, i) => [t, res.scores[i]]));
  const rank = ({ text, images }) => {
    const r = row.get(text);
    if (!r) return { ok: false, fallback: true, ranking: [] };
    const scored = images.map((p) => ({ path: p, score: r[assets.findIndex((a) => a.location === p)] }))
      .filter((e) => Number.isFinite(e.score));
    if (scored.length === 0) return { ok: false, fallback: true, ranking: [] };
    const ranked = rankEntries(scored);
    const rest = images.filter((p) => !scored.some((e) => e.path === p)).map((p, i) => ({ path: p, score: null, rank: ranked.length + i }));
    return { ok: true, fallback: false, ranking: [...ranked, ...rest] };
  };
  return orderAssetsForSlots(assets, slotTexts, { rank });
}

/**
 * 'batch-all': like batch, but slots beyond the asset count are ALSO ranked
 * instead of cycling blindly. Slots 0..n-1 get exactly the batch permutation
 * (every asset still appears once). Each later slot takes its best-scoring
 * asset subject to: not the previous slot's asset, and no asset used more than
 * ceil(slots/n) times. Returns an array of length == slot count (reuse
 * allowed), which computeVisualSequencing consumes unchanged (assets[i % len]).
 * Any problem (batch failure, >MAX_TEXTS distinct texts for a slot, unscored
 * slot) falls back per slot to the cyclic order. Ranking is a signal only.
 */
export function orderAssetsForSlotsBatchAll(visualAssets, slotTexts, { rankBatch = rankSceneBatch } = {}) {
  const assets = [...(visualAssets ?? [])];
  const n = assets.length;
  if (n < 2 || !Array.isArray(slotTexts) || slotTexts.length <= n) return orderAssetsForSlotsBatch(visualAssets, slotTexts, { rankBatch });
  if (n > MAX_IMAGES) return assets;
  if (assets.some((a) => a.asset_type !== 'image' || typeof a.location !== 'string')) return assets;
  if (new Set(assets.map((a) => a.location)).size !== n) return assets;

  const usable = (t) => typeof t === 'string' && t.trim() && t.length <= MAX_TEXT_CHARS;
  const texts = [...new Set(slotTexts.filter(usable))].slice(0, MAX_TEXTS);
  if (texts.length === 0) return assets;

  let res = null;
  try { res = rankBatch({ texts, images: assets.map((a) => a.location) }); } catch { res = null; }
  const good = res && res.ok === true && Array.isArray(res.scores) && res.scores.length === texts.length
    && res.scores.every((r) => Array.isArray(r) && r.length === n);
  if (!good) return assets;
  const row = new Map(texts.map((t, i) => [t, res.scores[i]]));

  // Base permutation for the first n slots: identical to 'batch' (same matrix, same greedy).
  const matrixRank = ({ text, images }) => {
    const r = row.get(text);
    const scored = r ? images.map((p) => ({ path: p, score: r[assets.findIndex((a) => a.location === p)] })).filter((e) => Number.isFinite(e.score)) : [];
    if (scored.length === 0) return { ok: false, fallback: true, ranking: [] };
    const ranked = rankEntries(scored);
    const rest = images.filter((p) => !scored.some((e) => e.path === p)).map((p, i) => ({ path: p, score: null, rank: ranked.length + i }));
    return { ok: true, fallback: false, ranking: [...ranked, ...rest] };
  };
  const perm = orderAssetsForSlots(assets, slotTexts, { rank: matrixRank });
  const out = perm.slice(0, n);
  const uses = new Map(assets.map((a) => [a.id, 1]));
  const cap = Math.ceil(slotTexts.length / n);
  for (let i = n; i < slotTexts.length; i++) {
    const prev = out[i - 1].id;
    const r = row.get(slotTexts[i]);
    let pick = null;
    if (r) {
      let best = -Infinity;
      assets.forEach((a, j) => {
        const sc = r[j];
        if (a.id === prev || uses.get(a.id) >= cap || !Number.isFinite(sc)) return;
        if (sc > best) { best = sc; pick = a; }
      });
    }
    if (!pick) { // cyclic fallback, honouring no-immediate-repeat
      const cyc = perm[i % n];
      pick = cyc.id !== prev ? cyc : perm[(i + 1) % n];
    }
    uses.set(pick.id, (uses.get(pick.id) ?? 0) + 1);
    out.push(pick);
  }
  return out;
}

/**
 * Exact maximum-total-score assignment of rows (slots) to distinct columns
 * (assets) for a rows<=cols matrix of finite scores (Hungarian / Jonker-Volgenant
 * potentials, O(rows^2 * cols)). Returns col index per row. Deterministic: ties
 * resolve by scan order, which prefers the lowest column index at each step.
 */
export function maximizeAssignment(scores) {
  const R = scores.length;
  const C = R ? scores[0].length : 0;
  if (R === 0) return [];
  if (R > C) throw new Error('maximizeAssignment requires rows <= cols');
  const cost = (i, j) => -scores[i - 1][j - 1];
  const u = new Array(R + 1).fill(0);
  const v = new Array(C + 1).fill(0);
  const p = new Array(C + 1).fill(0); // p[j] = row matched to col j (1-based; 0 = none)
  const way = new Array(C + 1).fill(0);
  for (let i = 1; i <= R; i++) {
    p[0] = i;
    let j0 = 0;
    const minv = new Array(C + 1).fill(Infinity);
    const used = new Array(C + 1).fill(false);
    do {
      used[j0] = true;
      const i0 = p[j0];
      let delta = Infinity;
      let j1 = 0;
      for (let j = 1; j <= C; j++) {
        if (used[j]) continue;
        const cur = cost(i0, j) - u[i0] - v[j];
        if (cur < minv[j]) { minv[j] = cur; way[j] = j0; }
        if (minv[j] < delta) { delta = minv[j]; j1 = j; }
      }
      for (let j = 0; j <= C; j++) {
        if (used[j]) { u[p[j]] += delta; v[j] -= delta; } else minv[j] -= delta;
      }
      j0 = j1;
    } while (p[j0] !== 0);
    do { const j1 = way[j0]; p[j0] = p[j1]; j0 = j1; } while (j0);
  }
  const out = new Array(R).fill(-1);
  for (let j = 1; j <= C; j++) if (p[j]) out[p[j] - 1] = j - 1;
  return out;
}

/**
 * 'global': ONE rankBatch call, then the assignment of the first min(slots, n)
 * slots to distinct assets that maximises the SUM of their scores (exact),
 * instead of the per-slot greedy of 'batch'. Output has the same shape as
 * 'batch' (a permutation of the assets, slot i -> out[i]; remaining assets
 * follow). A slot is assignable if its text is usable and it has at least one
 * finite score; non-finite cells are never chosen while a usable asset exists.
 * Other slots are filled in current order from the assets the optimiser left free. Any batch failure/invalid result => current order.
 * Scores come from the existing ranker; this changes allocation, not scores.
 */
export function orderAssetsForSlotsGlobal(visualAssets, slotTexts, { rankBatch = rankSceneBatch } = {}) {
  const assets = [...(visualAssets ?? [])];
  const n = assets.length;
  if (n < 2 || !Array.isArray(slotTexts) || slotTexts.length === 0) return assets;
  if (n > MAX_IMAGES) return assets;
  if (assets.some((a) => a.asset_type !== 'image' || typeof a.location !== 'string')) return assets;
  if (new Set(assets.map((a) => a.location)).size !== n) return assets;

  const usable = (t) => typeof t === 'string' && t.trim() && t.length <= MAX_TEXT_CHARS;
  const slots = slotTexts.slice(0, Math.min(slotTexts.length, n));
  const texts = [...new Set(slots.filter(usable))].slice(0, MAX_TEXTS);
  if (texts.length === 0) return assets;

  let res = null;
  try { res = rankBatch({ texts, images: assets.map((a) => a.location) }); } catch { res = null; }
  const good = res && res.ok === true && Array.isArray(res.scores) && res.scores.length === texts.length
    && res.scores.every((r) => Array.isArray(r) && r.length === n);
  if (!good) return assets;
  const row = new Map(texts.map((t, i) => [t, res.scores[i]]));

  // A non-finite cell (e.g. an undecodable image's null column) is an ineligible
  // edge, not a reason to drop the slot: it gets a penalty larger than any
  // possible total of real scores, so the optimiser only uses it when a slot has
  // no usable asset left, and such a slot is then treated as unscored.
  const finite = (x) => Number.isFinite(x);
  const assignable = [];
  slots.forEach((t, i) => {
    const r = usable(t) ? row.get(t) : null;
    if (r && r.some(finite)) assignable.push(i);
  });
  if (assignable.length === 0) return assets;

  let span = 1;
  for (const i of assignable) for (const x of row.get(slots[i])) if (finite(x)) span = Math.max(span, Math.abs(x));
  const penalty = -(span * (assignable.length + 1) * 2 + 1);
  const matrix = assignable.map((i) => row.get(slots[i]).map((x) => (finite(x) ? x : penalty)));
  const cols = maximizeAssignment(matrix);
  const out = new Array(slots.length).fill(null);
  const used = new Set();
  assignable.forEach((slotIdx, k) => {
    if (!finite(row.get(slots[slotIdx])[cols[k]])) return; // forced onto an unusable cell: unscored slot
    out[slotIdx] = assets[cols[k]]; used.add(cols[k]);
  });
  const free = assets.filter((_, j) => !used.has(j));
  for (let i = 0; i < out.length; i++) if (out[i] === null) out[i] = free.shift();
  return [...out, ...free];
}

/** Mode dispatcher used by the pipeline. 'off' returns the input array itself (byte-identical default). */
export function assignAssetsForSlots(visualAssets, slotTexts, { env = process.env, rank, rankBatch } = {}) {
  const mode = resolveSceneAssignmentMode(env);
  if (mode === 'off') return visualAssets;
  if (mode === 'global') return orderAssetsForSlotsGlobal(visualAssets, slotTexts, rankBatch ? { rankBatch } : {});
  if (mode === 'batch-all') return orderAssetsForSlotsBatchAll(visualAssets, slotTexts, rankBatch ? { rankBatch } : {});
  if (mode === 'batch') return orderAssetsForSlotsBatch(visualAssets, slotTexts, rankBatch ? { rankBatch } : {});
  return orderAssetsForSlots(visualAssets, slotTexts, rank ? { rank } : {});
}
