import { RETRIEVAL_STATUS } from './constants.js';

/**
 * Deterministic HTTP retrieval + text extraction (Research Subsystem
 * Specification v0.3 S3). Deliberately NOT a pluggable provider — a plain
 * function, conceptually similar to RssSource's existing HTTP-fetch-with-
 * timeout pattern, reused rather than reinvented. No browser automation,
 * no JS rendering, no general-purpose crawling: a source that genuinely
 * requires JS rendering is CONTENT_UNPARSEABLE, not a trigger to build
 * rendering infrastructure.
 *
 * @returns {Promise<{status: 'SUCCESS'|'FAILED'|'CONTENT_UNPARSEABLE', content: string|null, error: string|null}>}
 */
export async function retrieveSource(url, { fetchImpl = fetch, timeoutMs = 10000 } = {}) {
  let res;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      res = await fetchImpl(url, { signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    return { status: RETRIEVAL_STATUS.FAILED, content: null, error: err.message };
  }

  if (!res.ok) {
    return { status: RETRIEVAL_STATUS.FAILED, content: null, error: `HTTP ${res.status}` };
  }

  let raw;
  try {
    raw = await res.text();
  } catch (err) {
    return { status: RETRIEVAL_STATUS.FAILED, content: null, error: err.message };
  }

  const contentType = typeof res.headers?.get === 'function' ? res.headers.get('content-type') : null;
  const extracted = extractText(raw, contentType);
  if (extracted === null) {
    return { status: RETRIEVAL_STATUS.CONTENT_UNPARSEABLE, content: null, error: 'content could not be parsed into usable text' };
  }

  return { status: RETRIEVAL_STATUS.SUCCESS, content: extracted, error: null };
}

/**
 * Minimal, dependency-free HTML/text extraction — same targeted-not-full-
 * spec-parser spirit as rssParser.js. Returns null (=> CONTENT_UNPARSEABLE)
 * for binary/non-text content types or content that reduces to nothing.
 */
export function extractText(raw, contentType) {
  if (typeof raw !== 'string') return null;
  if (contentType && !/text|html|xml|json/i.test(contentType)) return null;

  const stripped = raw
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!stripped) return null;
  return stripped;
}