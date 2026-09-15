import { SEQUENCING_DEFAULTS } from './constants.js';
import { computeVisualTiming } from './visualTiming.js';

/**
 * Media Production v1.2 — deterministic, script-aware visual sequencing.
 *
 * v1's `computeVisualTiming` divides the narration duration into N
 * equal, asset-ordered shares and knows nothing about the script itself.
 * This module improves on that by using the deterministic caption
 * segmentation/timing Media Production v1.1 already computes (see
 * captionTiming.js) as the only available proxy for "script structure" —
 * no LLM, no semantic understanding, no new input the pipeline doesn't
 * already have.
 *
 * The heuristic, in order:
 *   1. Caption segment boundaries (start/end seconds) become candidate
 *      visual scene-cut points — a visual change lines up with where the
 *      narration moves to its next sentence/chunk, rather than an
 *      arbitrary equal-share cut mid-sentence.
 *   2. Any resulting segment shorter than MIN_VISUAL_DURATION_SECONDS is
 *      merged into its neighbor (forward, or backward for a too-short
 *      final segment) rather than shown as a flash — this can cascade,
 *      e.g. several short segments in a row collapse into one.
 *   3. Visual assets are assigned to the merged segments in their
 *      existing stable input order. More segments than assets ->
 *      assets are reused cyclically. More assets than segments -> the
 *      trailing, unused assets are simply not shown this render
 *      (consolidation, per Owner constraint §D), not force-fit into
 *      shorter-than-minimum slots.
 *
 * Falls back to the plain equal-division `computeVisualTiming` exactly
 * (byte-for-byte, not just "equivalent") when there is no caption
 * structure to key off of, or when there's only one visual asset and so
 * nothing for sequencing to decide — preserving v1's original behavior
 * unchanged in both cases.
 *
 * Deterministic: given identical visualAssets, captionTiming, and
 * narrationDurationSeconds, the output is always identical. No
 * Math.random, no timestamps, no external state, no reliance on object
 * key/iteration order (arrays only).
 */
export function computeVisualSequencing(
  visualAssets,
  captionTiming,
  narrationDurationSeconds,
  { minVisualDurationSeconds = SEQUENCING_DEFAULTS.MIN_VISUAL_DURATION_SECONDS } = {}
) {
  const n = (visualAssets ?? []).length;
  if (n === 0) return [];
  if (!(narrationDurationSeconds > 0)) {
    throw new Error(`computeVisualSequencing requires a positive narrationDurationSeconds, got ${narrationDurationSeconds}`);
  }

  // Nothing to sequence against, or nothing for sequencing to decide
  // (a single asset spans the whole duration either way) -> defer to
  // the existing equal-division timeline unchanged.
  if (n === 1 || !captionTiming || captionTiming.length === 0) {
    return computeVisualTiming(visualAssets, narrationDurationSeconds);
  }

  const segments = mergeShortSegments(
    captionBoundariesToSegments(captionTiming),
    minVisualDurationSeconds
  );
  if (segments.length === 0) {
    return computeVisualTiming(visualAssets, narrationDurationSeconds);
  }

  const timing = segments.map((seg, i) => {
    const asset = visualAssets[i % n];
    return {
      asset_id: asset.id,
      asset_type: asset.asset_type,
      location: asset.location,
      start_seconds: seg.start,
      duration_seconds: round3(seg.end - seg.start)
    };
  });

  // Deterministic-rounding safety net (mirrors the "last segment absorbs
  // the remainder" convention used throughout this codebase): force the
  // final segment to end at exactly narrationDurationSeconds, the one
  // value every other computation here is ultimately derived from and
  // measured against, rather than trusting accumulated per-segment
  // rounding to land there on its own.
  const last = timing[timing.length - 1];
  last.duration_seconds = round3(narrationDurationSeconds - last.start_seconds);

  return timing;
}

/** Turns caption timing (already gap-free, ordered, and duration-exact — see captionTiming.js) into visual scene-cut candidate segments at the same boundaries. */
function captionBoundariesToSegments(captionTiming) {
  const boundaries = [round3(captionTiming[0].start_seconds)];
  for (const c of captionTiming) {
    boundaries.push(round3(c.start_seconds + c.duration_seconds));
  }
  const segments = [];
  for (let i = 0; i < boundaries.length - 1; i++) {
    const start = boundaries[i];
    const end = boundaries[i + 1];
    if (end > start) segments.push({ start, end });
  }
  return segments;
}

/**
 * Merges any segment shorter than minVisualDurationSeconds into its
 * successor (a too-short segment is folded forward into whatever comes
 * next); a too-short final segment, having no successor, is folded
 * backward into its predecessor instead. Merges cascade naturally: each
 * new segment is checked against the *current* (possibly already-merged)
 * length of the last kept segment.
 */
function mergeShortSegments(rawSegments, minVisualDurationSeconds) {
  const merged = [];
  for (const seg of rawSegments) {
    const prev = merged[merged.length - 1];
    if (prev && prev.end - prev.start < minVisualDurationSeconds) {
      prev.end = seg.end;
    } else {
      merged.push({ start: seg.start, end: seg.end });
    }
  }
  if (merged.length > 1) {
    const lastIdx = merged.length - 1;
    if (merged[lastIdx].end - merged[lastIdx].start < minVisualDurationSeconds) {
      merged[lastIdx - 1].end = merged[lastIdx].end;
      merged.pop();
    }
  }
  return merged;
}

function round3(n) {
  return Math.round(n * 1000) / 1000;
}
