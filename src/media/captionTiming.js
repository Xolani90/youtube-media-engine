const DEFAULT_MAX_LENGTH = 80;
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
  const sentenceMatches = normalized.match(/[^.!?]+[.!?]*/g);
  const sentences = (sentenceMatches ?? [normalized]).map((s) => s.trim()).filter(Boolean);

  const captions = [];
  for (const sentence of sentences) {
    if (sentence.length <= maxLength) {
      captions.push(sentence);
      continue;
    }
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
  }
  return captions;
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
