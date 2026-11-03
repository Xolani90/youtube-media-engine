import fs from 'node:fs';
import { FEED_FAILURE, MAX_FEED_BYTES } from './constants.js';
import { classifyRetrievalFailure } from './failureClass.js';
import { parseFeedStrict } from './feedValidate.js';
import { parsePublisherUrl } from './urlMatch.js';

const CONFIG_URL = new URL('../../config/publisher_feeds.json', import.meta.url);

/**
 * Reads and shape-validates the feed config. Throws an Error whose message
 * starts with `publisher feed config` on ANY problem (unreadable, not JSON,
 * wrong shape); callers turn that into a controlled failure. It does not
 * change which feeds are authorized, it only refuses a malformed config.
 */
export function loadPublisherFeedConfig(path = CONFIG_URL) {
  let config;
  try {
    config = JSON.parse(fs.readFileSync(path, 'utf8'));
  } catch (e) {
    throw new Error(`publisher feed config unreadable or not valid JSON: ${e.message}`);
  }
  if (!config || typeof config !== 'object' || !Array.isArray(config.feeds)) throw new Error('publisher feed config invalid: "feeds" must be an array');
  config.feeds.forEach((f, i) => {
    const bad = (why) => { throw new Error(`publisher feed config invalid: feeds[${i}] ${why}`); };
    if (!f || typeof f !== 'object') bad('must be an object');
    if (typeof f.id !== 'string' || f.id === '') bad('needs a non-empty string "id"');
    if (typeof f.feedUrl !== 'string' || parsePublisherUrl(f.feedUrl) === null) bad('needs a valid http(s) "feedUrl" without userinfo or a non-default port');
    if (!Array.isArray(f.hosts) || f.hosts.length === 0 || f.hosts.some((h) => typeof h !== 'string' || h === '')) bad('needs a non-empty "hosts" array of strings');
  });
  return config;
}

/** Only feeds named in config/publisher_feeds.json may be fetched. */
export function findAuthorizedFeed(config, { feedId = null, feedUrl = null } = {}) {
  const feeds = Array.isArray(config?.feeds) ? config.feeds : [];
  return feeds.find((f) => (feedId ? f.id === feedId : true) && (feedUrl ? f.feedUrl === feedUrl : true)) ?? null;
}

const fail = (reason, extra = {}) => ({ ok: false, reason, ...extra });

class FeedReadError extends Error {
  constructor(reason, extra = {}) { super(reason); this.reason = reason; this.extra = extra; }
}

/**
 * Reads a response body with a hard cap on ACTUAL BYTES, never buffering more
 * than maxBytes (+ one chunk). Order of defences:
 *   1. a declared Content-Length above the cap is refused before any read
 *      (the body is cancelled, not read);
 *   2. regardless of the header (missing, wrong or lying), bytes are counted
 *      per chunk and the body is cancelled the moment the cap is exceeded;
 *   3. the timeout signal covers the body read: on abort the reader is
 *      cancelled and the read rejects with an AbortError;
 *   4. decoding is strict, streaming UTF-8 (multibyte characters split
 *      across chunks are reassembled; invalid UTF-8 is an error).
 * No fallback to res.text()/arrayBuffer(): a response without a readable
 * stream body is an error.
 */
export async function readBoundedText(res, { maxBytes = MAX_FEED_BYTES, signal } = {}) {
  const body = res?.body;
  if (!body || typeof body.getReader !== 'function') throw new FeedReadError(FEED_FAILURE.NETWORK_ERROR, { error: 'response has no readable body stream' });
  const reader = body.getReader();
  const cancel = async () => { try { await reader.cancel(); } catch { /* already closed */ } };
  const declared = res.headers?.get?.('content-length');
  if (declared !== null && declared !== undefined && declared !== '') {
    const n = /^\d+$/.test(String(declared).trim()) ? Number(declared) : NaN;
    if (Number.isFinite(n) && n > maxBytes) { await cancel(); throw new FeedReadError(FEED_FAILURE.TOO_LARGE, { error: `content-length ${n} exceeds ${maxBytes}` }); }
  }
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let onAbort;
  const aborted = new Promise((_resolve, reject) => {
    onAbort = () => { const e = new Error('feed read aborted'); e.name = 'AbortError'; reject(e); };
    if (signal?.aborted) onAbort(); else signal?.addEventListener('abort', onAbort, { once: true });
  });
  aborted.catch(() => {});
  let total = 0;
  let text = '';
  try {
    for (;;) {
      let step;
      try { step = await Promise.race([reader.read(), aborted]); } catch (e) { await cancel(); throw e; }
      if (step.done) break;
      const chunk = step.value;
      total += chunk.byteLength;
      if (total > maxBytes) { await cancel(); throw new FeedReadError(FEED_FAILURE.TOO_LARGE, { error: `body exceeded ${maxBytes} bytes` }); }
      try { text += decoder.decode(chunk, { stream: true }); } catch { await cancel(); throw new FeedReadError(FEED_FAILURE.MALFORMED_FEED, { detail: 'invalid_utf8' }); }
    }
    try { text += decoder.decode(); } catch { throw new FeedReadError(FEED_FAILURE.MALFORMED_FEED, { detail: 'invalid_utf8' }); }
  } finally {
    signal?.removeEventListener?.('abort', onAbort);
  }
  return { text, bytes: total };
}

/**
 * Fetches and parses ONE authorized feed. Fails closed: any problem returns
 * { ok:false, reason } and the caller writes nothing.
 *
 * Request identity: exactly the plain Node `fetch` already used by the
 * Discovery RssSource and by the Owner-approved read-only probe: no custom
 * headers, no client substitution, no redirect following, no header or TLS
 * impersonation, no reader/proxy. A 3xx is reported, never followed.
 * The timeout covers the response body as well as the headers.
 */
export async function fetchPublisherFeed(feed, { fetchImpl = fetch, timeoutMs = 15000, maxBytes = MAX_FEED_BYTES, now = () => new Date().toISOString() } = {}) {
  if (!feed || typeof feed.feedUrl !== 'string') return fail(FEED_FAILURE.NOT_AUTHORIZED);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  let text;
  let bytes;
  try {
    res = await fetchImpl(feed.feedUrl, { signal: controller.signal, redirect: 'manual' });
    if (res.status >= 300 && res.status < 400) {
      try { await res.body?.cancel?.(); } catch { /* ignore */ }
      return fail(FEED_FAILURE.REDIRECT_NOT_FOLLOWED, { httpStatus: res.status });
    }
    if (!res.ok) {
      try { await res.body?.cancel?.(); } catch { /* ignore */ }
      const c = classifyRetrievalFailure(`HTTP ${res.status}`);
      return fail(FEED_FAILURE.HTTP_ERROR, { httpStatus: res.status, failureClass: c.failureClass, error: c.originalError });
    }
    ({ text, bytes } = await readBoundedText(res, { maxBytes, signal: controller.signal }));
  } catch (err) {
    if (err instanceof FeedReadError) return fail(err.reason, { httpStatus: res?.status, ...err.extra });
    const aborted = err?.name === 'AbortError' || controller.signal.aborted;
    return fail(aborted ? FEED_FAILURE.TIMEOUT : FEED_FAILURE.NETWORK_ERROR, { error: err?.message ?? String(err) });
  } finally {
    clearTimeout(timer);
  }
  // A 200 that is not a feed (challenge page, HTML shell) must not be parsed as one.
  if (!/<(rss|feed|rdf:RDF)[\s>]/i.test(text)) return fail(FEED_FAILURE.NOT_A_FEED, { httpStatus: res.status, bytes });
  // Strict, fail-closed parse of the whole document: any defect rejects everything.
  const parsed = parseFeedStrict(text);
  if (!parsed.ok) {
    // A well-formed document that exceeds the parser work bounds is too large, not malformed.
    const reason = /^too_many_(elements|items)$/.test(parsed.detail) ? FEED_FAILURE.TOO_LARGE : FEED_FAILURE.MALFORMED_FEED;
    return fail(reason, { httpStatus: res.status, bytes, detail: parsed.detail });
  }
  if (parsed.items.length === 0) return fail(FEED_FAILURE.NO_ITEMS, { httpStatus: res.status, bytes });
  return { ok: true, httpStatus: res.status, bytes, fetchedAt: now(), feedUrl: feed.feedUrl, items: parsed.items };
}
