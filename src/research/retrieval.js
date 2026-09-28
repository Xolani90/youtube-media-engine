import { RETRIEVAL_STATUS } from './constants.js';
import { traceAsync, safeHost } from '../diagnostics/trace.js';

// Sent on every article retrieval. Many publishers reject Node's default
// (header-less) fetch with HTTP 403; a descriptive, browser-compatible
// request identity and a normal document Accept header avoid that class of
// deterministic rejection. No browser automation or rendering is involved.
export const RETRIEVAL_REQUEST_HEADERS = Object.freeze({
  'User-Agent': 'Mozilla/5.0 (compatible; MediaEngineResearchBot/1.0; +https://github.com/Xolani90/youtube-media-engine)',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.5'
});

// HTTP statuses that are access denials, not transient failures. Repeating
// the identical request cannot recover, so the result is flagged
// `retryable: false` (status stays FAILED; acquisition.js skips retries).
const NON_RETRYABLE_HTTP_STATUSES = Object.freeze([401, 403]);

/**
 * Deterministic HTTP retrieval + text extraction (Research Subsystem
 * Specification v0.3 S3). Deliberately NOT a pluggable provider — a plain
 * function, conceptually similar to RssSource's existing HTTP-fetch-with-
 * timeout pattern, reused rather than reinvented. No browser automation,
 * no JS rendering, no general-purpose crawling: a source that genuinely
 * requires JS rendering is CONTENT_UNPARSEABLE, not a trigger to build
 * rendering infrastructure.
 *
 * @returns {Promise<{status: 'SUCCESS'|'FAILED'|'CONTENT_UNPARSEABLE', content: string|null, error: string|null, retryable?: false}>}
 *   `retryable: false` is present only on HTTP 401/403 FAILED results.
 */
export async function retrieveSource(url, { fetchImpl = fetch, timeoutMs = 10000 } = {}) {
  let res;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      res = await traceAsync('research.retrieve.http.request', { host: safeHost(url) }, () => fetchImpl(url, { signal: controller.signal, headers: RETRIEVAL_REQUEST_HEADERS }), (r) => ({ status: r?.status }));
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    return { status: RETRIEVAL_STATUS.FAILED, content: null, error: err.message };
  }

  if (!res.ok) {
    const failure = { status: RETRIEVAL_STATUS.FAILED, content: null, error: `HTTP ${res.status}` };
    if (NON_RETRYABLE_HTTP_STATUSES.includes(res.status)) failure.retryable = false;
    return failure;
  }

  let raw;
  try {
    raw = await traceAsync('research.retrieve.http.body', { host: safeHost(url) }, () => res.text());
  } catch (err) {
    return { status: RETRIEVAL_STATUS.FAILED, content: null, error: err.message };
  }

  const contentType = typeof res.headers?.get === 'function' ? res.headers.get('content-type') : null;
  const extracted = extractText(raw, contentType);
  if (extracted === null) {
    return { status: RETRIEVAL_STATUS.CONTENT_UNPARSEABLE, content: null, error: 'content could not be parsed into usable text' };
  }

  if (isGoogleNewsRssWrapperPage({ url, res, raw })) {
    return {
      status: RETRIEVAL_STATUS.CONTENT_UNPARSEABLE,
      content: null,
      error: 'Google News RSS article URL resolved to an unresolved wrapper/interstitial page, not publisher article content'
    };
  }

  return { status: RETRIEVAL_STATUS.SUCCESS, content: extracted, error: null };
}

/**
 * Confirmed-reproduced failure mode: a Google News RSS `<link>`
 * (`https://news.google.com/rss/articles/...`) does not always resolve to
 * publisher article content. It can return an HTTP 200 Google-hosted
 * wrapper/interstitial page whose only static content is the site chrome
 * (observed: `<title>Google News</title>`, no `<article>` element, and
 * `extractText()` collapsing the whole page to the 11-character string
 * "Google News"). No general JS rendering or URL-resolution
 * infrastructure exists (or is being added) to recover the real article
 * from this page — see the "no browser automation, no JS rendering"
 * constraint above. This function only recognizes that specific,
 * demonstrated wrapper shape so it isn't misclassified as SUCCESS and fed
 * to claim extraction as if it were article text.
 *
 * Deliberately NOT a generic content-length/word-count check (that would
 * also reject genuinely short real articles) and NOT a blanket rejection
 * of every `news.google.com` response (a Google News URL that somehow did
 * return substantive publisher content — e.g. an `<article>` element, or a
 * `<title>` that isn't the bare wrapper chrome title — is left as SUCCESS).
 * Both the URL shape (host + `/rss/articles/` path) AND the wrapper
 * content signature (bare "Google News" title, no `<article>` element)
 * must match.
 */
export function isGoogleNewsRssWrapperPage({ url, res, raw }) {
  if (typeof raw !== 'string' || !raw) return false;

  const effectiveUrl = (typeof res?.url === 'string' && res.url) || url;
  let parsed;
  try {
    parsed = new URL(effectiveUrl);
  } catch {
    return false;
  }

  if (parsed.hostname !== 'news.google.com') return false;
  if (!parsed.pathname.startsWith('/rss/articles/')) return false;

  const titleMatch = raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? titleMatch[1].replace(/\s+/g, ' ').trim() : null;
  if (title === null || title.toLowerCase() !== 'google news') return false;

  if (/<article[\s>]/i.test(raw)) return false;

  return true;
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