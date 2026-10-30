import fs from 'node:fs';
import { rankSceneImages, MAX_TEXT_CHARS } from '../media/sceneRelevance.js';

/**
 * Optional, REJECT-ONLY scene relevance check for Asset Provisioning (SCENE_RELEVANCE=on).
 *
 * It looks at the pixels of a candidate the provider has already returned (after the provider's own tag
 * screen, validateAcquiredAsset and the duplicate check) and BEFORE anything is recorded. It can turn an
 * acceptance into a rejection; it can never accept something earlier checks refused, and a rejected
 * asset is never written to the database, so it never reaches rights verification.
 *
 * Scores are cosine similarities from the local SigLIP worker. There is deliberately NO default
 * threshold: SCENE_RELEVANCE_MIN_SCORE must come from scripts/calibrate-scene-relevance.js.
 */
export const RELEVANCE_REASON = Object.freeze({
  LOW: 'low_scene_relevance',
  UNAVAILABLE: 'relevance_unavailable',
  UNSCORABLE: 'relevance_unscorable'
});

const OFF = new Set(['', 'off', '0', 'false']);
const ON = new Set(['on', '1', 'true']);

/** Throws a clear error for any invalid configuration when the flag is on: no silent fallback. */
export function resolveSceneRelevance(env = process.env) {
  const flag = String(env.SCENE_RELEVANCE ?? 'off').trim().toLowerCase();
  if (OFF.has(flag)) return Object.freeze({ enabled: false });
  if (!ON.has(flag)) throw new Error(`SCENE_RELEVANCE must be "on" or "off", got "${flag}"`);
  if (!env.SCENE_RELEVANCE_MODEL_DIR) throw new Error('SCENE_RELEVANCE=on requires SCENE_RELEVANCE_MODEL_DIR (local SigLIP model directory)');
  const raw = env.SCENE_RELEVANCE_MIN_SCORE;
  if (raw === undefined || String(raw).trim() === '') {
    throw new Error('SCENE_RELEVANCE=on requires SCENE_RELEVANCE_MIN_SCORE; calibrate it with scripts/calibrate-scene-relevance.js');
  }
  const minScore = Number(raw);
  if (!Number.isFinite(minScore)) throw new Error(`SCENE_RELEVANCE_MIN_SCORE must be a number, got "${raw}"`);
  return Object.freeze({ enabled: true, minScore });
}

/**
 * @returns {{applied: boolean, accept: boolean, reason?: string, score?: number, note?: string}}
 *   applied=false means the check did not look at the image (flag off, or not an image) and says why in `note`.
 */
export function assessAssetRelevance({ sceneText, query = '', asset, relevance, ranker = rankSceneImages }) {
  if (!relevance?.enabled) return { applied: false, accept: true };
  if (asset?.assetType !== 'image') return { applied: false, accept: true, note: 'relevance_not_applied_non_image' };
  const text = String(sceneText || query || '').trim().slice(0, MAX_TEXT_CHARS);
  if (!text) return { applied: true, accept: false, reason: RELEVANCE_REASON.UNAVAILABLE };
  let ranked;
  try {
    ranked = ranker({ text, images: [asset.location] });
  } catch {
    return { applied: true, accept: false, reason: RELEVANCE_REASON.UNAVAILABLE };
  }
  if (!ranked || ranked.ok !== true || ranked.fallback) return { applied: true, accept: false, reason: RELEVANCE_REASON.UNAVAILABLE };
  const score = ranked.ranking?.[0]?.score;
  if (!Number.isFinite(score)) return { applied: true, accept: false, reason: RELEVANCE_REASON.UNSCORABLE };
  if (score < relevance.minScore) return { applied: true, accept: false, reason: RELEVANCE_REASON.LOW, score };
  return { applied: true, accept: true, score };
}

/** Appends the score to the provider's `;`-separated provenance notes (accepted assets only). */
export function withRelevanceNote(provenanceNotes, verdict, relevance) {
  if (!verdict?.applied || !Number.isFinite(verdict.score)) return provenanceNotes ?? null;
  const add = `sceneRelevance=${verdict.score.toFixed(4)}; sceneRelevanceMin=${relevance.minScore}`;
  return provenanceNotes ? `${provenanceNotes}; ${add}` : add;
}

/** Deletes a rejected download, but never a file that is already attached to something else. */
export function discardRejectedFile(asset, isAttachedFile) {
  try {
    if (asset?.location && !isAttachedFile(asset)) fs.rmSync(asset.location, { force: true });
  } catch { /* best-effort cleanup */ }
}
