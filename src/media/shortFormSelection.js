/**
 * Short-form derivative production — deterministic segment selection.
 *
 * Selects a bounded-duration prefix of an already-rendered long-form
 * artifact's narration, using ONLY the visual/caption segment boundaries
 * that Media Production already computed and persisted on the source
 * `media_artifacts.render_spec_json` row (see renderSpec.js). No LLM, no
 * Whisper, no new external input, no "viral clip" heuristic — this is
 * infrastructure, not content intelligence.
 *
 * v1 always starts at 0: selecting from an arbitrary offset would
 * require re-trimming the narration audio from that offset too (a
 * second FFmpeg/audio-handling concern render.js's existing
 * `-shortest` muxNarration behavior does not give us for free). Ending
 * at the nearest existing segment boundary at or before the configured
 * maximum keeps a cut aligned with where the narration itself already
 * changes sentence/scene, exactly the same discipline
 * visualSequencing.js already uses for its own cut points.
 */

function round3(n) {
  return Math.round(n * 1000) / 1000;
}

/**
 * @param {object} args
 * @param {Array} args.visualTiming - the source render_spec's visual_timing array
 * @param {Array} args.captionTiming - the source render_spec's captions array
 * @param {number} args.narrationDurationSeconds - the source render_spec's full narration duration
 * @param {number} args.maxDurationSeconds - the short-form duration ceiling (e.g. SHORT_FORM_RENDER_DEFAULTS.MAX_DURATION_SECONDS)
 * @returns {{selected: true, startSeconds: number, endSeconds: number} | {selected: false, reason: string}}
 */
export function selectShortFormSegment({ visualTiming, captionTiming, narrationDurationSeconds, maxDurationSeconds }) {
  if (!(narrationDurationSeconds > 0)) {
    return { selected: false, reason: 'NO_NARRATION_DURATION' };
  }
  if (!(maxDurationSeconds > 0)) {
    return { selected: false, reason: 'INVALID_MAX_DURATION' };
  }

  // The source is already short enough — the whole thing is the segment.
  if (narrationDurationSeconds <= maxDurationSeconds) {
    return { selected: true, startSeconds: 0, endSeconds: round3(narrationDurationSeconds) };
  }

  // Candidate cut points: existing caption + visual segment END boundaries
  // only (never an arbitrary timestamp) that fall within the duration cap.
  const boundaries = new Set();
  for (const c of captionTiming ?? []) {
    const end = round3(c.start_seconds + c.duration_seconds);
    if (end > 0 && end <= maxDurationSeconds) boundaries.add(end);
  }
  for (const v of visualTiming ?? []) {
    const end = round3(v.start_seconds + v.duration_seconds);
    if (end > 0 && end <= maxDurationSeconds) boundaries.add(end);
  }

  if (boundaries.size === 0) {
    // No valid segment boundary exists within the cap (e.g. the very
    // first caption/visual segment already exceeds it) — fail safely
    // rather than cutting mid-sentence at an arbitrary timestamp.
    return { selected: false, reason: 'NO_VALID_SEGMENT' };
  }

  const endSeconds = Math.max(...boundaries);
  return { selected: true, startSeconds: 0, endSeconds };
}

/** Clips an ordered, gap-free visual timing array to end at endSeconds. Drops any segment that starts at/after the cut. */
export function trimVisualTiming(visualTiming, endSeconds) {
  const trimmed = [];
  for (const seg of visualTiming ?? []) {
    if (seg.start_seconds >= endSeconds) break;
    const segEnd = round3(seg.start_seconds + seg.duration_seconds);
    const clippedEnd = Math.min(segEnd, endSeconds);
    const duration = round3(clippedEnd - seg.start_seconds);
    if (duration <= 0) break;
    trimmed.push({ ...seg, duration_seconds: duration });
  }
  return trimmed;
}

/** Same clipping discipline as trimVisualTiming, applied to caption timing for the short-form .srt. */
export function trimCaptionTiming(captionTiming, endSeconds) {
  const trimmed = [];
  for (const c of captionTiming ?? []) {
    if (c.start_seconds >= endSeconds) break;
    const segEnd = round3(c.start_seconds + c.duration_seconds);
    const clippedEnd = Math.min(segEnd, endSeconds);
    const duration = round3(clippedEnd - c.start_seconds);
    if (duration <= 0) break;
    trimmed.push({ ...c, duration_seconds: duration });
  }
  return trimmed;
}