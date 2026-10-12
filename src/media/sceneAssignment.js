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

/** 'off' (default) | 'on' (one worker call per slot, existing) | 'batch' (one worker call per video). */
export function resolveSceneAssignmentMode(env = process.env) {
  const v = (env.SCENE_RELEVANCE_ASSIGN ?? 'off').trim().toLowerCase();
  if (v === 'batch') return 'batch';
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

/** Mode dispatcher used by the pipeline. 'off' returns the input array itself (byte-identical default). */
export function assignAssetsForSlots(visualAssets, slotTexts, { env = process.env, rank, rankBatch } = {}) {
  const mode = resolveSceneAssignmentMode(env);
  if (mode === 'off') return visualAssets;
  if (mode === 'batch') return orderAssetsForSlotsBatch(visualAssets, slotTexts, rankBatch ? { rankBatch } : {});
  return orderAssetsForSlots(visualAssets, slotTexts, rank ? { rank } : {});
}
