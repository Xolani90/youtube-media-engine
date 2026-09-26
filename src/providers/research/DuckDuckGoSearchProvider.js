import { ResearchSourceProvider } from '../../research/ResearchSourceProvider.js';
import * as DDG from 'duck-duck-scrape';
import asyncRetry from 'async-retry';

/**
 * Concrete 'duckduckgo' ResearchSourceProvider. Genuinely $0/no-key R0
 * discovery fallback (audit finding: DuckDuckGo via `duck-duck-scrape`,
 * MIT-licensed, no signup, no monthly cap) -- adapted from the verified
 * implementation pattern in yokingma/one-search-mcp's
 * `src/search/duckduckgo.ts` (MIT), NOT copied verbatim and NOT importing
 * that project's MCP-server framework. Only the retry-wrapped-search /
 * bounded-timeout shape is reused; the discovery-only scope, the
 * never-throw `{candidates, failures}` contract, and the candidate
 * normalization all follow this repo's existing ResearchSourceProvider
 * conventions (see TavilySearchProvider.js), not the source project's.
 *
 * Scope discipline, per ResearchSourceProvider.js's own docstring: this
 * class does candidate DISCOVERY only. It never fetches page content
 * itself -- content retrieval remains entirely owned by
 * src/research/retrieval.js, unchanged.
 *
 * TIMEOUT: real and bounded. duck-duck-scrape's `search()` forwards its
 * third argument straight through to `needle` (verified by inspecting
 * node_modules/duck-duck-scrape/lib/search/search.js and
 * node_modules/needle/lib/needle.js at implementation time -- needle
 * genuinely implements both `response_timeout` as a socket-level timer
 * and `signal` as a real AbortSignal that destroys the in-flight request,
 * not a decorative passthrough). This provider supplies its own
 * AbortController tied to a setTimeout so the operation cannot hang
 * indefinitely even if `response_timeout` alone were ever insufficient,
 * and passes `response_timeout` as a second, redundant safety net.
 *
 * RETRY: `async-retry`, bounded (default 2 retries = 3 attempts total,
 * matching the verified reference's retry count), wraps only the network
 * search call. The empty-query validation check happens before entering
 * the retry block, so a permanent input error is never retried.
 *
 * Per ResearchSourceProvider.js's documented contract, a failed discovery
 * attempt is isolated: this method NEVER throws. It always resolves to
 * `{ candidates, failures }`.
 */
export class DuckDuckGoSearchProvider extends ResearchSourceProvider {
  /**
   * @param {object} [opts]
   * @param {typeof DDG.search} [opts.searchImpl] - injectable for tests; defaults to duck-duck-scrape's search().
   * @param {number} [opts.timeoutMs] - bounded timeout for the search call. Defaults to 10000.
   * @param {number} [opts.retries] - bounded retry count (excludes the initial attempt). Defaults to 2.
   * @param {typeof asyncRetry} [opts.retryImpl] - injectable for tests; defaults to async-retry.
   */
  constructor({
    searchImpl = DDG.search,
    timeoutMs = 10000,
    retries = 2,
    retryImpl = asyncRetry
  } = {}) {
    super();
    this._search = searchImpl;
    this._timeoutMs = timeoutMs;
    this._retries = retries;
    this._retry = retryImpl;
  }

  get id() {
    return 'duckduckgo';
  }

  /** No API key required, so this provider is always potentially usable. Never makes a network call. */
  async healthCheck() {
    return true;
  }

  /**
   * @returns {Promise<{ candidates: Array<{url, title, snippet}>, failures: Array<{error}> }>}
   */
  async discoverCandidates({ query, maxResults, alreadyAcquiredUrls = [] } = {}) {
    if (!query || typeof query !== 'string' || !query.trim()) {
      // Permanent input error: not retried, matches TavilySearchProvider's
      // equivalent validation-failure behavior.
      return { candidates: [], failures: [{ error: 'discoverCandidates requires a non-empty query' }] };
    }

    let result;
    try {
      result = await this._retry(
        async (bail) => {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), this._timeoutMs);
          try {
            return await this._search(
              query,
              { safeSearch: DDG.SafeSearchType.OFF },
              { response_timeout: this._timeoutMs, signal: controller.signal }
            );
          } finally {
            clearTimeout(timer);
          }
        },
        { retries: this._retries }
      );
    } catch (err) {
      // Retries exhausted (or a non-retryable error surfaced through the
      // retry wrapper) -- isolated here, never thrown to the caller.
      return { candidates: [], failures: [{ error: `DuckDuckGo search failed: ${err.message}` }] };
    }

    const rawResults = Array.isArray(result?.results) ? result.results : [];
    const boundedMaxResults = Number.isFinite(maxResults) ? Math.max(1, Math.floor(maxResults)) : 5;
    const alreadySeen = new Set(alreadyAcquiredUrls ?? []);

    const candidates = [];
    for (const item of rawResults) {
      if (candidates.length >= boundedMaxResults) break;
      if (!item || typeof item.url !== 'string' || !item.url) continue; // no usable URL: excluded safely, not fabricated
      if (alreadySeen.has(item.url)) continue;

      candidates.push({
        url: item.url,
        title: typeof item.title === 'string' ? item.title : null,
        snippet: typeof item.description === 'string' ? item.description : null
        // No publishedAt: DDG's result shape does not provide one, and it
        // is never fabricated here.
      });
    }

    return { candidates, failures: [] };
  }
}

export default DuckDuckGoSearchProvider;