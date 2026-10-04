import { extractText } from './retrieval.js';

/**
 * Optional clean-reader fallback adapter (donor pattern: jina-ai/reader,
 * "reader base URL + target URL returns clean text"). Disabled unless
 * RESEARCH_READER_FALLBACK_URL is an https URL, so no third party sees a
 * candidate URL by default. No API key, SDK or default endpoint.
 *
 * Single deterministic adapter; never throws; returns
 * { ok, content, error }.
 */
export function readerFallbackBaseUrl(env = process.env) {
  const raw = env.RESEARCH_READER_FALLBACK_URL;
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  try {
    const u = new URL(raw.trim());
    return u.protocol === 'https:' ? u.href : null;
  } catch {
    return null;
  }
}

export async function fetchViaReader(url, { baseUrl, fetchImpl = fetch, timeoutMs = 15000 } = {}) {
  if (!baseUrl) return { ok: false, content: null, error: 'reader fallback not configured' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(baseUrl.replace(/\/?$/, '/') + url, {
      signal: controller.signal,
      headers: { Accept: 'text/plain' }
    });
    if (!res.ok) return { ok: false, content: null, error: `reader HTTP ${res.status}` };
    const text = extractText(await res.text(), null);
    if (text === null) return { ok: false, content: null, error: 'reader returned no text' };
    return { ok: true, content: text, error: null };
  } catch (err) {
    return { ok: false, content: null, error: `reader failed: ${err.message}` };
  } finally {
    clearTimeout(timer);
  }
}
