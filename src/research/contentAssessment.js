/**
 * Deterministic, inspectable assessment of extracted page text (Pass 46).
 *
 * This is NOT a generic word-count rejection: genuinely short sources exist.
 * Text is classified by structure:
 *  - SUBSTANTIVE: contains at least one complete sentence (>= MIN_SENTENCE_WORDS
 *    words ending in terminal punctuation) and is not a recognised wrapper.
 *  - BOILERPLATE: a recognised wrapper/interstitial phrase (cookie wall,
 *    JS-required, bot check, access denied, paywall, redirect) on a short page,
 *    or bare site chrome of a few words.
 *  - WEAK: no complete sentence (e.g. a navigation strip), too weak for research.
 */

export const CONTENT_VERDICT = Object.freeze({
  SUBSTANTIVE: 'substantive',
  BOILERPLATE: 'boilerplate',
  WEAK: 'weak'
});

export const MIN_SENTENCE_WORDS = 5;
export const BOILERPLATE_MAX_WORDS = 150;
export const BARE_CHROME_MAX_WORDS = 4;

const WRAPPER_PATTERNS = Object.freeze([
  ['cookie_wall', /\b(we use cookies|accept (all )?cookies|cookie (policy|settings|preferences)|manage cookies)\b/i],
  ['javascript_required', /\b(enable javascript|javascript (is )?(required|disabled)|requires javascript|turn on javascript)\b/i],
  ['bot_check', /\b(verify (that )?you are (a )?human|are you a robot|captcha|checking your browser|unusual traffic|just a moment)\b/i],
  ['access_denied', /\b(access denied|403 forbidden|request blocked|you have been blocked)\b/i],
  ['paywall', /\b(subscribe to (continue|read)|sign in to (continue|read)|create a free account to (continue|read)|subscribers only)\b/i],
  ['redirect', /\b(redirecting|click here if you are not redirected|you are being redirected)\b/i]
]);

function words(text) {
  return text.split(/\s+/).filter(Boolean);
}

function countCompleteSentences(text) {
  const parts = text.match(/[^.!?]+[.!?]+(?=\s|$)/g) ?? [];
  return parts.filter((p) => words(p.trim()).length >= MIN_SENTENCE_WORDS).length;
}

/**
 * @returns {{verdict: string, reasons: string[], wordCount: number, sentenceCount: number}}
 */
export function assessContent(text) {
  const clean = typeof text === 'string' ? text.replace(/\s+/g, ' ').trim() : '';
  const wordCount = clean ? words(clean).length : 0;
  const sentenceCount = clean ? countCompleteSentences(clean) : 0;
  const base = { wordCount, sentenceCount };

  if (wordCount === 0) {
    return { ...base, verdict: CONTENT_VERDICT.WEAK, reasons: ['empty'] };
  }
  const wrapperHits = WRAPPER_PATTERNS.filter(([, re]) => re.test(clean)).map(([name]) => name);
  if (wrapperHits.length > 0 && wordCount < BOILERPLATE_MAX_WORDS) {
    return { ...base, verdict: CONTENT_VERDICT.BOILERPLATE, reasons: wrapperHits.map((h) => `wrapper:${h}`) };
  }
  if (sentenceCount === 0 && wordCount <= BARE_CHROME_MAX_WORDS) {
    return { ...base, verdict: CONTENT_VERDICT.BOILERPLATE, reasons: ['bare_chrome'] };
  }
  if (sentenceCount === 0) {
    return { ...base, verdict: CONTENT_VERDICT.WEAK, reasons: ['no_complete_sentence'] };
  }
  return { ...base, verdict: CONTENT_VERDICT.SUBSTANTIVE, reasons: ['complete_sentence_present'] };
}

export function isSubstantive(text) {
  return assessContent(text).verdict === CONTENT_VERDICT.SUBSTANTIVE;
}
