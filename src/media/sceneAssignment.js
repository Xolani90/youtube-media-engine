// Opt-in scene-relevance asset ordering. Pure: the ranker is injected.
// Default OFF (SCENE_RELEVANCE_ASSIGN unset/off) -> pipeline output unchanged.
// Ranking is a signal only; it is not a rights, factual or safety check.
import { rankSceneImages } from './sceneRelevance.js';

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
