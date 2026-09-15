import { VISUAL_ASSET_TYPES } from './constants.js';

/**
 * Selects the subset of production-manifest assets the renderer can
 * display as a visual frame (Owner brief §7: "use the actual asset type
 * appropriately... do not attempt to display audio assets as visual
 * assets"). Order is preserved from the input array — asset ordering
 * within a content_version's D-G2 usage rows is not itself something
 * this module re-sorts or re-derives.
 */
export function selectVisualAssets(assets) {
  return (assets ?? []).filter((a) => VISUAL_ASSET_TYPES.includes(a.asset_type));
}

/**
 * Computes a deterministic visual timeline: N visual assets each receive
 * an equal portion of the narration duration, in input order (Owner
 * brief §7 — "a deterministic sequence... each asset receives a
 * deterministic portion of T"). No scene system, no timeline framework —
 * just N equal, ordered, non-overlapping segments that together sum to
 * exactly narrationDurationSeconds.
 *
 * The last segment absorbs any floating-point rounding remainder so the
 * segments always sum exactly to the input duration (required for the
 * FFmpeg concat demuxer, which expects the total of per-file `duration`
 * directives to match the audio track it will be muxed against).
 *
 * Rounded to milliseconds (3 decimal places) — sub-millisecond precision
 * has no meaningful effect on FFmpeg's concat demuxer and keeps the
 * render spec's canonical JSON representation stable.
 */
export function computeVisualTiming(visualAssets, narrationDurationSeconds) {
  const n = visualAssets.length;
  if (n === 0) return [];
  if (!(narrationDurationSeconds > 0)) {
    throw new Error(`computeVisualTiming requires a positive narrationDurationSeconds, got ${narrationDurationSeconds}`);
  }

  const each = round3(narrationDurationSeconds / n);
  let elapsed = 0;
  const timing = visualAssets.map((asset, i) => {
    const isLast = i === n - 1;
    const start = round3(elapsed);
    const duration = isLast ? round3(narrationDurationSeconds - elapsed) : each;
    elapsed += duration;
    return {
      asset_id: asset.id,
      asset_type: asset.asset_type,
      location: asset.location,
      start_seconds: start,
      duration_seconds: duration
    };
  });
  return timing;
}

function round3(n) {
  return Math.round(n * 1000) / 1000;
}