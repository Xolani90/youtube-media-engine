import { ResearchSourceProvider } from '../../research/ResearchSourceProvider.js';

/**
 * Concrete 'tavily' ResearchSourceProvider (ADR-0015). One provider, one
 * job: turn a Research `core_question` into candidate URLs/metadata via
 * Tavily's Search API, in the exact shape
 * `ResearchSourceProvider.discoverCandidates()` requires. Mirrors the
 * injectable-`fetchImpl`/credential-provider pattern already used by
 * PixabayAssetSourceProvider (src/providers/asset/PixabayAssetSourceProvider.js)
 * and RssSource (src/providers/opportunity/RssSource.js), so tests never
 * need a real key or the network.
 *
 * Scope discipline, per ResearchSourceProvider.js's own docstring: this
 * class does candidate DISCOVERY only. It never fetches page content
 * itself, performs browser automation, or crawls -- content retrieval
 * remains entirely owned by src/research/retrieval.js, unchanged.
 *
 * Verified against Tavily's current official documentation
 * (docs.tavily.com) at implementation time:
 *   - Endpoint: POST https://api.tavily.com/search
 *   - Auth: Authorization: Bearer <api_key> (or an `api_key` body field;
 *     this provider uses the Bearer header, matching Tavily's documented
 *     preferred form).
 *   - Request body used here: { query, search_depth: 'basic', max_results }.
 *     `search_depth` is always explicitly set to 'basic' (1 credit/request)
 *     rather than left to `auto_parameters`, which can silently upgrade a
 *     request to 'advanced' (2 credits) -- explicit, predictable cost is
 *     required by the R0 authorization in ADR-0015 §4.
 *   - Response shape: `{ results: [ { url, title, content, published_date? } ], ... }`.
 *     `content` is Tavily's query-aware extracted snippet field (not full
 *     page content) and is mapped to this contract's `snippet`.
 *     `published_date` is only populated for some queries/topics and is
 *     mapped to `publishedAt` when present, else omitted.
 *   - Free allocation: the Researcher plan grants 1,000 API credits/month
 *     for $0, no credit card required (ADR-0015 §4). Exceeding it returns
 *     HTTP 432 ("Plan Limit Exceeded") -- the request is blocked, not
 *     charged. A separate Pay-As-You-Go tier exists but requires the
 *     account holder to explicitly enable it via the Tavily dashboard; no
 *     request this provider makes can enable it, so no automatic
 *     transition from free to paid usage is possible from this code.
 *   - HTTP 433 ("Pay-As-You-Go Limit Exceeded") only applies once PAYGO has
 *     been manually enabled; this provider treats it exactly like every
 *     other discovery failure below -- it never retries into a paid path
 *     or falls back to another provider.
 *
 * Per ResearchSourceProvider.js's documented contract, a failed discovery
 * attempt is isolated: this method NEVER throws. It always resolves to
 * `{ candidates, failures }`, with `failures` describing what went wrong
 * (missing credentials, HTTP status, malformed response, network error)
 * and `candidates` being `[]` when nothing could be discovered.
 */
export class TavilySearchProvider extends ResearchSourceProvider {
  /**
   * @param {object} [opts]
   * @param {typeof fetch} [opts.fetchImpl] - injectable for tests; defaults to global fetch.
   * @param {() => string|undefined} [opts.apiKeyProvider] - defaults to reading TAVILY_API_KEY from process.env.
   * @param {string} [opts.baseUrl] - defaults to Tavily's documented Search endpoint; overridable for tests.
   */
  constructor({
    fetchImpl = fetch,
    apiKeyProvider = () => process.env.TAVILY_API_KEY,
    baseUrl = 'https://api.tavily.com/search'
  } = {}) {
    super();
    this._fetch = fetchImpl;
    this._apiKeyProvider = apiKeyProvider;
    this._baseUrl = baseUrl;
  }

  get id() {
    return 'tavily';
  }

  /** True only when an API key is configured. Never makes a network call. */
  async healthCheck() {
    return Boolean(this._apiKeyProvider());
  }

  /**
   * @returns {Promise<{ candidates: Array<{url, title, snippet, publishedAt?}>, failures: Array<{error}> }>}
   */
  async discoverCandidates({ query, maxResults, alreadyAcquiredUrls = [] } = {}) {
    const apiKey = this._apiKeyProvider();
    if (!apiKey) {
      // Predictable, non-throwing behavior when no key is configured -- an
      // absent key is an expected "can't discover right now" outcome, not
      // a programmer error, matching PixabayAssetSourceProvider's pattern.
      return { candidates: [], failures: [{ error: 'TAVILY_API_KEY is not configured' }] };
    }

    if (!query || typeof query !== 'string' || !query.trim()) {
      return { candidates: [], failures: [{ error: 'discoverCandidates requires a non-empty query' }] };
    }

    const boundedMaxResults = clampMaxResults(maxResults);

    let res;
    try {
      res = await this._fetch(this._baseUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          query,
          search_depth: 'basic',
          max_results: boundedMaxResults
        })
      });
    } catch (err) {
      // Network-level failure reaching Tavily.
      return { candidates: [], failures: [{ error: `network error contacting Tavily: ${err.message}` }] };
    }

    if (!res.ok) {
      // Covers 400/401/422/429, and the documented plan/PAYGO limit codes
      // 432/433 -- every non-2xx response is treated uniformly as a
      // discovery failure. Never retried here, never triggers a fallback
      // provider or a paid path.
      let detail = '';
      try {
        detail = await res.text();
      } catch {
        // Best-effort only; an unreadable body doesn't change the outcome.
      }
      return {
        candidates: [],
        failures: [{ error: `Tavily HTTP ${res.status}${detail ? `: ${detail}` : ''}` }]
      };
    }

    let data;
    try {
      data = await res.json();
    } catch (err) {
      return { candidates: [], failures: [{ error: `malformed Tavily response: ${err.message}` }] };
    }

    if (!data || !Array.isArray(data.results)) {
      return { candidates: [], failures: [{ error: 'Tavily response missing results array' }] };
    }

    const alreadySeen = new Set(alreadyAcquiredUrls ?? []);
    const candidates = [];
    for (const item of data.results) {
      if (candidates.length >= boundedMaxResults) break;
      if (!item || typeof item.url !== 'string' || !item.url) continue;
      if (alreadySeen.has(item.url)) continue;

      const candidate = {
        url: item.url,
        title: typeof item.title === 'string' ? item.title : null,
        snippet: typeof item.content === 'string' ? item.content : null
      };
      if (typeof item.published_date === 'string' && item.published_date) {
        candidate.publishedAt = item.published_date;
      }
      candidates.push(candidate);
    }

    return { candidates, failures: [] };
  }
}

/**
 * Tavily's documented max_results range is 0-20. This provider clamps
 * whatever Research's own `maxResults` (policy-driven, e.g.
 * max_sources_per_research_project) resolves to into that range rather
 * than sending an out-of-range value Tavily would reject with a 400.
 */
function clampMaxResults(maxResults) {
  const n = Number.isFinite(maxResults) ? Math.floor(maxResults) : 5;
  return Math.min(20, Math.max(1, n));
}

export default TavilySearchProvider;
