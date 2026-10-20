const DEFAULT_MAX_LENGTH = 80;
// Sentence boundary: whitespace that follows terminal punctuation (plus optional closing
// quotes/brackets). A "." inside a token (51.3, GPT-4.5, blog.google) is never a boundary.
const SENTENCE_BOUNDARY = /(?<=[.!?\u2026]+["'\u201d\u2019)\]]*)\s+/;
const MIN_CAPTION_DURATION_SECONDS = 0.001;

/**
 * Deterministically segments script text into an ordered list of caption
 * strings. Sentence-aware first (splits on ./!/? followed by whitespace
 * or end-of-string), then, for any sentence still longer than maxLength,
 * splits further at word boundaries so no caption exceeds maxLength. A
 * single word longer than maxLength is kept whole, never split mid-word.
 * Pure and deterministic — no LLM, no paraphrasing, no external service.
 */
export function segmentCaptions(text, maxLength = DEFAULT_MAX_LENGTH) {
  if (!text || !text.trim()) return [];

  const normalized = text.trim().replace(/\s+/g, ' ');
  const sentenceMatches = normalized.split(SENTENCE_BOUNDARY);
  const sentences = (sentenceMatches ?? [normalized]).map((s) => s.trim()).filter(Boolean);

  const captions = [];
  for (const sentence of sentences) {
    if (sentence.length <= maxLength) {
      captions.push(sentence);
      continue;
    }
    const startIndex = captions.length;
    const words = sentence.split(' ');
    let current = '';
    for (const word of words) {
      const candidate = current ? `${current} ${word}` : word;
      if (candidate.length > maxLength && current) {
        captions.push(current);
        current = word;
      } else {
        current = candidate;
      }
    }
    if (current) captions.push(current);
    avoidOrphanTail(captions, startIndex, maxLength);
  }
  return captions;
}

/**
 * A sentence only a few characters over maxLength is split greedily, which
 * can strand its final word as a one-word caption ("... a harder" / "target.").
 * Rebalance by moving the previous chunk's last word down so the tail has two
 * words. Applies only to a sentence that was split into 2+ chunks whose last
 * chunk is a single word; never exceeds maxLength; whole-sentence captions
 * and every other split are untouched.
 */
function avoidOrphanTail(captions, startIndex, maxLength) {
  const last = captions.length - 1;
  if (last - startIndex < 1) return;
  const tail = captions[last];
  if (tail.includes(' ')) return;
  const prev = captions[last - 1];
  const cut = prev.lastIndexOf(' ');
  if (cut === -1) return;
  const moved = `${prev.slice(cut + 1)} ${tail}`;
  if (moved.length > maxLength) return;
  captions[last - 1] = prev.slice(0, cut);
  captions[last] = moved;
}

/**
 * Computes deterministic, text-weighted caption timing: each caption's
 * duration is proportional to its share of the total caption character
 * count, applied against narrationDurationSeconds. The last caption
 * absorbs the exact rounding remainder so segments sum exactly to the
 * input duration, with no gaps/overlaps, first start = 0, and final end
 * = narrationDurationSeconds exactly.
 */
export function computeCaptionTiming(captions, narrationDurationSeconds) {
  const n = captions.length;
  if (n === 0) return [];
  if (!(narrationDurationSeconds > 0)) {
    throw new Error(`computeCaptionTiming requires a positive narrationDurationSeconds, got ${narrationDurationSeconds}`);
  }

  const totalChars = captions.reduce((sum, c) => sum + c.length, 0);
  if (totalChars === 0) {
    throw new Error('computeCaptionTiming requires non-empty caption text');
  }

  let elapsed = 0;
  const timing = captions.map((text, i) => {
    const isLast = i === n - 1;
    const start = round3(elapsed);
    let duration;
    if (isLast) {
      duration = round3(narrationDurationSeconds - elapsed);
    } else {
      const share = text.length / totalChars;
      duration = Math.max(MIN_CAPTION_DURATION_SECONDS, round3(narrationDurationSeconds * share));
    }
    elapsed = round3(elapsed + duration);
    return { text, start_seconds: start, duration_seconds: duration };
  });
  return timing;
}

function round3(n) {
  return Math.round(n * 1000) / 1000;
}
