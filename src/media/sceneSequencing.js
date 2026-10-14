import { SEQUENCING_DEFAULTS } from './constants.js';
import { parseSceneUsageContext, tileSpans } from '../asset-provisioning/scenePlan.js';

/**
 * Scene-aware sequencing: when EVERY visual asset carries a valid scene span in
 * its usage_context (written by multi-scene Asset Provisioning), each asset is
 * shown where its scene's narration span is, instead of cyclically.
 *
 * Span fractions are script-character fractions; they are converted to seconds
 * and snapped to the nearest caption boundary so cuts land on sentence/chunk
 * ends. A scene whose slot would be shorter than the minimum (or collapse onto
 * the previous cut) is folded into the previous scene, never shown as a flash.
 *
 * Returns null (caller keeps computeVisualSequencing unchanged) when any asset
 * lacks a span, there are fewer than 2 assets, or the spans are inconsistent.
 * Deterministic and pure.
 */
export function computeSceneSequencing(
  visualAssets,
  captionTiming,
  narrationDurationSeconds,
  { minVisualDurationSeconds = SEQUENCING_DEFAULTS.MIN_VISUAL_DURATION_SECONDS } = {}
) {
  if (!Array.isArray(visualAssets) || visualAssets.length < 2 || !(narrationDurationSeconds > 0)) return null;
  const scenes = [];
  for (const asset of visualAssets) {
    const parsed = parseSceneUsageContext(asset.usage_context);
    if (!parsed) return null;
    scenes.push({ asset, index: parsed.order - 1, span: parsed.span });
  }
  if (new Set(scenes.map((s) => s.index)).size !== scenes.length) return null; // two assets claiming one scene

  const cuts = (captionTiming ?? []).map((c) => round3(c.start_seconds)).filter((t) => t > 0);
  const snap = (t) => (cuts.length === 0 ? t : cuts.reduce((best, c) => (Math.abs(c - t) < Math.abs(best - t) ? c : best)));

  const slots = [];
  for (const sc of tileSpans(scenes)) {
    const start = slots.length === 0 ? 0 : round3(snap(sc.span.start * narrationDurationSeconds));
    const prev = slots[slots.length - 1];
    if (prev && (start - prev.start < minVisualDurationSeconds || narrationDurationSeconds - start < minVisualDurationSeconds)) continue;
    slots.push({ asset: sc.asset, start });
  }
  if (slots.length < 2) return null;

  return slots.map((slot, i) => {
    const end = i === slots.length - 1 ? round3(narrationDurationSeconds) : slots[i + 1].start;
    return {
      asset_id: slot.asset.id,
      asset_type: slot.asset.asset_type,
      location: slot.asset.location,
      start_seconds: slot.start,
      duration_seconds: round3(end - slot.start)
    };
  });
}

function round3(n) {
  return Math.round(n * 1000) / 1000;
}
