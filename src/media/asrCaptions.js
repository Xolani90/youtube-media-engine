import { segmentCaptions } from './captionTiming.js';
import { CAPTION_DEFAULTS } from './constants.js';

/**
 * Caption worker: validated ASR segments (whisper.cpp, see asrWorker.js)
 * -> caption timing in the SAME shape the existing path produces
 * ({ text, start_seconds, duration_seconds }), so render spec, SRT burn-in,
 * visual sequencing and short-form trimming consume it unchanged.
 *
 * Timing comes from the real ASR segment windows. Caption TEXT is the
 * narration script when opts.narrationText is given (default), so misheard
 * words never reach the subtitles; with opts.textSource === 'asr' (or no
 * narrationText) the text is whisper's own. Script chunks are assigned to
 * windows by character position and tiled inside each window by character
 * share -- the only estimated part, and only inside one real segment.
 * Silence between segments stays a gap, it is never papered over.
 *
 * Pure and deterministic. Throws CaptionWorkerError on any integrity
 * problem; the pipeline then keeps the text-estimated fallback.
 */

const DURATION_TOLERANCE_SECONDS = 1.0;
// Minimum share of narration words that must appear in the transcript.
const MIN_TEXT_CORRESPONDENCE = 0.6;
const MIN_CAPTION_DURATION_SECONDS = 0.001;

export class CaptionWorkerError extends Error {
  constructor(reason, message) {
    super(message ? `${reason}: ${message}` : reason);
    this.name = 'CaptionWorkerError';
    this.reason = reason;
  }
}

const round3 = (n) => Math.round(n * 1000) / 1000;

function words(text) {
  return String(text ?? '').toLowerCase().replace(/[^\p{L}\p{N}\s']/gu, ' ').split(/\s+/).filter(Boolean);
}

/** Share of expectedText's words found in transcriptText (multiset-aware). 1 when expectedText has no words. */
export function textCorrespondence(transcriptText, expectedText) {
  const expected = words(expectedText);
  if (expected.length === 0) return 1;
  const pool = new Map();
  for (const w of words(transcriptText)) pool.set(w, (pool.get(w) ?? 0) + 1);
  let hit = 0;
  for (const w of expected) {
    const n = pool.get(w) ?? 0;
    if (n > 0) { hit++; pool.set(w, n - 1); }
  }
  return hit / expected.length;
}

/**
 * @param {Array<{start:number,end:number,text:string}>} segments
 * @param {number} durationSeconds real narration duration
 * @param {object} [opts]
 * @param {string} [opts.narrationText] text the narrator was given; transcript must correspond to it, and it is the caption text unless textSource is 'asr'
 * @param {'script'|'asr'} [opts.textSource] which words to show (default 'script' when narrationText is given)
 * @param {number} [opts.maxLength]
 * @returns {Array<{text:string,start_seconds:number,duration_seconds:number}>}
 */
export function buildCaptionsFromAsr(segments, durationSeconds, opts = {}) {
  const maxLength = opts.maxLength ?? CAPTION_DEFAULTS.MAX_CAPTION_LENGTH;
  const bad = (msg) => { throw new CaptionWorkerError('CAPTION_ASR_INVALID', msg); };

  if (!(Number.isFinite(durationSeconds) && durationSeconds > 0)) bad(`invalid audio duration ${durationSeconds}`);
  if (!Array.isArray(segments) || segments.length === 0) bad('no segments');

  let prevStart = -Infinity;
  let prevEnd = -Infinity;
  segments.forEach((s, i) => {
    if (!s || typeof s.text !== 'string') bad(`segment ${i} malformed`);
    if (!Number.isFinite(s.start) || !Number.isFinite(s.end)) bad(`segment ${i} has non-numeric timestamps`);
    if (s.start < 0) bad(`segment ${i} starts before 0`);
    if (s.end < s.start) bad(`segment ${i} ends before it starts`);
    if (s.start < prevStart) bad(`segment ${i} starts before the previous segment`);
    if (s.end > durationSeconds + DURATION_TOLERANCE_SECONDS) bad(`segment ${i} ends beyond audio duration`);
    // Overlap with the previous segment would produce overlapping captions.
    if (s.start < prevEnd - 0.001) bad(`segment ${i} overlaps the previous segment`);
    prevStart = s.start;
    prevEnd = s.end;
  });

  // Segments that actually carry speech (blank ones leave a gap).
  const windows = [];
  segments.forEach((s, i) => {
    if (segmentCaptions(s.text, maxLength).length === 0) return;
    // Clamp the small rounding overshoot whisper.cpp may leave past the real end.
    const start = Math.min(s.start, durationSeconds);
    const end = Math.min(s.end, durationSeconds);
    if (!(end - start > 0)) bad(`segment ${i} has text but no duration`);
    windows.push({ start, end, weight: s.text.trim().length, asrText: s.text });
  });
  if (windows.length === 0) bad('transcript text is empty');

  // Correspondence is always judged on what whisper heard vs the script.
  if (typeof opts.narrationText === 'string') {
    const score = textCorrespondence(windows.map((w) => w.asrText).join(' '), opts.narrationText);
    if (score < MIN_TEXT_CORRESPONDENCE) {
      throw new CaptionWorkerError('CAPTION_TEXT_MISMATCH', `transcript matches only ${(score * 100).toFixed(0)}% of narration words`);
    }
  }

  // Which text to show: the script (default when given) or whisper's own words.
  const scriptChunks = typeof opts.narrationText === 'string' && opts.textSource !== 'asr'
    ? segmentCaptions(opts.narrationText, maxLength)
    : [];
  const useScript = scriptChunks.length > 0;

  // Tile one window with chunks, sharing the window by character count.
  const captions = [];
  const tile = (win, chunks) => {
    const totalChars = chunks.reduce((n, c) => n + c.length, 0);
    const span = win.end - win.start;
    let cursor = win.start;
    chunks.forEach((text, j) => {
      const isLast = j === chunks.length - 1;
      const chunkStart = round3(cursor);
      const chunkEnd = isLast ? round3(win.end) : round3(cursor + span * (text.length / totalChars));
      const dur = Math.max(MIN_CAPTION_DURATION_SECONDS, round3(chunkEnd - chunkStart));
      captions.push({ text, start_seconds: chunkStart, duration_seconds: dur });
      cursor = chunkStart + dur;
    });
  };

  if (!useScript) {
    windows.forEach((w) => tile(w, segmentCaptions(w.asrText, maxLength)));
  } else {
    // Assign each script WORD to a window by character position (word midpoint
    // in the script, scaled onto whisper's cumulative character axis). Word-level
    // assignment means a script sentence that whisper split across several
    // segments is spread over all of those windows instead of landing in one.
    // Each window's slice is re-chunked and tiled inside that real window.
    const scriptWords = opts.narrationText.split(/\s+/).filter(Boolean);
    const totalAsr = windows.reduce((n, w) => n + w.weight, 0);
    const totalScript = scriptWords.reduce((n, w) => n + w.length + 1, 0);
    const groups = windows.map(() => []);
    let before = 0;
    for (const word of scriptWords) {
      const mid = ((before + word.length / 2) / totalScript) * totalAsr;
      before += word.length + 1;
      let acc = 0;
      let idx = windows.length - 1;
      for (let k = 0; k < windows.length; k++) {
        acc += windows[k].weight;
        if (mid < acc) { idx = k; break; }
      }
      groups[idx].push(word);
    }
    windows.forEach((w, k) => {
      if (groups[k].length === 0) return;
      const chunks = segmentCaptions(groups[k].join(' '), maxLength);
      if (chunks.length) tile(w, chunks);
    });
  }

  if (captions.length === 0) bad('transcript text is empty');

  // Final integrity pass on the output itself.
  let lastEnd = 0;
  for (const c of captions) {
    const end = round3(c.start_seconds + c.duration_seconds);
    if (c.start_seconds < lastEnd - 0.001) bad('caption output overlaps');
    if (end > durationSeconds + 0.001) bad('caption output beyond audio duration');
    lastEnd = end;
  }
  return captions;
}
