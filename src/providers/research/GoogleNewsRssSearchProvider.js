import { ResearchSourceProvider } from '../../research/ResearchSourceProvider.js';
import { parseFeed } from '../../discovery/rssParser.js';

/**
 * Concrete 'google-news-rss' ResearchSourceProvider. Turns a Research
 * `core_question` into candidate URLs/metadata via Google News' public,
 * unauthenticated RSS search feed, in the exact shape
 * `ResearchSourceProvider.discoverCandidates()` requires. Mirrors
 * GdeltSearchProvider's/TavilySearchProvider's injectable-`fetchImpl`
 * pattern so tests never need the real network.
 *
 * Scope discipline, per ResearchSourceProvider.js's own docstring: this
 * class does candidate DISCOVERY only. It never fetches page content itself
 * -- content retrieval remains entirely owned by src/research/retrieval.js,
 * unchanged.
 *
 *   - Endpoint: GET https://news.google.com/rss/search
 *   - Auth: none. Fully public, unauthenticated search-feed endpoint -- no
 *     key, no signup, no billing surface.
 *   - Query params used here: `q` (the Research query), plus the standard
 *     `hl`/`gl`/`ceid` locale params Google's own feed documentation uses
 *     (`en-US`/`US`/`US:en`), fixed rather than configurable -- there is no
 *     demonstrated need yet for locale selection.
 *   - Response shape: RSS 2.0 (`<item><title><link><description><pubDate>`).
 *     Parsed with the EXISTING `rssParser.js` used by Discovery's
 *     `RssSource` -- no second XML parser. `<link>` is the real article URL
 *     `retrieveSource()` fetches.
 *   - `pubDate` is RSS's standard RFC-822 string and is mapped to
 *     `publishedAt` verbatim when present, exactly as GDELT's `seendate` and
 *     Tavily's `published_date` are passed through verbatim -- Research does
 *     not parse or rely on this field (isSourceFreshness uses the
 *     retrieval-time `retrieved_at`, not discovery-time metadata).
 *   - `description` is mapped to `snippet` verbatim when present. Unlike
 *     GDELT (which has no excerpt field), Google News RSS does provide one;
 *     it is passed through as-is, unmodified -- Research always re-fetches
 *     and re-extracts the real page via retrieveSource() regardless.
 *   - No metered/billed quota -- this is a public search-feed endpoint, not
 *     a rate-limited API product. This provider makes exactly one request
 *     per `discoverCandidates()` call, the same call shape as GDELT/Tavily,
 *     so it never needs internal rate-limiting logic of its own.
 *
 * Per ResearchSourceProvider.js's documented contract, a failed discovery
 * attempt is isolated: this method NEVER throws. It always resolves to
 * `{ candidates, failures }`, with `failures` describing what went wrong
 * (HTTP status, network error, unparseable feed) and `candidates` being
 * `[]` when nothing could be discovered.
 */
export class GoogleNewsRssSearchProvider extends ResearchSourceProvider {
  /**
   * @param {object} [opts]
   * @param {typeof fetch} [opts.fetchImpl] - injectable for tests; defaults to global fetch.
   * @param {string} [opts.baseUrl] - defaults to Google News' documented RSS search endpoint; overridable for tests.
   */
  constructor({
    fetchImpl = fetch,
    baseUrl = 'https://news.google.com/rss/search'
  } = {}) {
    super();
    this._fetch = fetchImpl;
    this._baseUrl = baseUrl;
  }

  get id() {
    return 'google-news-rss';
  }

  /**
   * No credential to check -- the endpoint is unauthenticated, so
   * "healthy" degenerates to "provider is configured at all", which is
   * always true. Never makes a network call, matching GDELT's/Tavily's
   * credential-only healthCheck contract.
   */
  async healthCheck() {
    return true;
  }

  /**
   * @returns {Promise<{ candidates: Array<{url, title, snippet, publishedAt?}>, failures: Array<{error}> }>}
   */
  async discoverCandidates({ query, maxResults, alreadyAcquiredUrls = [] } = {}) {
    if (!query || typeof query !== 'string' || !query.trim()) {
      return { candidates: [], failures: [{ error: 'discoverCandidates requires a non-empty query' }] };
    }

    const boundedMaxResults = clampMaxResults(maxResults);

    const url = new URL(this._baseUrl);
    url.searchParams.set('q', query);
    url.searchParams.set('hl', 'en-US');
    url.searchParams.set('gl', 'US');
    url.searchParams.set('ceid', 'US:en');

    let res;
    try {
      res = await this._fetch(url.toString());
    } catch (err) {
      // Network-level failure reaching Google News.
      return { candidates: [], failures: [{ error: `network error contacting Google News RSS: ${err.message}` }] };
    }

    if (!res.ok) {
      let detail = '';
      try {
        detail = await res.text();
      } catch {
        // Best-effort only; an unreadable body doesn't change the outcome.
      }
      return {
        candidates: [],
        failures: [{ error: `Google News RSS HTTP ${res.status}${detail ? `: ${detail}` : ''}` }]
      };
    }

    let xml;
    try {
      xml = await res.text();
    } catch (err) {
      return { candidates: [], failures: [{ error: `unreadable Google News RSS response: ${err.message}` }] };
    }

    let items;
    try {
      items = parseFeed(xml);
    } catch (err) {
      // parseFeed is a targeted regex parser, not a full-spec XML parser --
      // isolate any unexpected failure the same way a malformed/non-JSON
      // GDELT body is isolated, rather than letting it throw out of
      // discoverCandidates.
      return { candidates: [], failures: [{ error: `malformed Google News RSS feed: ${err.message}` }] };
    }

    if (!Array.isArray(items) || items.length === 0) {
      return { candidates: [], failures: [] };
    }

    const alreadySeen = new Set(alreadyAcquiredUrls ?? []);
    const candidates = [];
    for (const item of items) {
      if (candidates.length >= boundedMaxResults) break;
      if (!item || typeof item.link !== 'string' || !item.link) continue;
      if (alreadySeen.has(item.link)) continue;

      const candidate = {
        url: item.link,
        title: typeof item.title === 'string' ? item.title : null,
        snippet: typeof item.description === 'string' && item.description ? item.description : null
      };
      if (typeof item.pubDate === 'string' && item.pubDate) {
        candidate.publishedAt = item.pubDate;
      }
      candidates.push(candidate);
    }

    return { candidates, failures: [] };
  }
}

/**
 * Google News RSS has no documented result-count parameter -- the feed
 * simply returns whatever it returns. `maxResults` is therefore enforced
 * client-side (a slice of the parsed items), the same "policy value drives
 * a client-side bound" shape GDELT uses server-side via `maxrecords`, just
 * applied after fetch instead of in the request. Floors/ceilings guard
 * against a degenerate policy value (e.g. 0, negative, non-finite).
 */
function clampMaxResults(maxResults) {
  const n = Number.isFinite(maxResults) ? Math.floor(maxResults) : 5;
  return Math.max(1, n);
}

export default GoogleNewsRssSearchProvider;
