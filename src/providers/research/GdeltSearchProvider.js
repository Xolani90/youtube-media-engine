import { ResearchSourceProvider } from '../../research/ResearchSourceProvider.js';

/**
 * Concrete 'gdelt' ResearchSourceProvider. Turns a Research `core_question`
 * into candidate URLs/metadata via the public, unauthenticated GDELT DOC 2.0
 * API, in the exact shape `ResearchSourceProvider.discoverCandidates()`
 * requires. Mirrors TavilySearchProvider's injectable-`fetchImpl` pattern so
 * tests never need the real network.
 *
 * Scope discipline, per ResearchSourceProvider.js's own docstring: this
 * class does candidate DISCOVERY only. It never fetches page content itself
 * -- content retrieval remains entirely owned by src/research/retrieval.js,
 * unchanged.
 *
 * Verified against GDELT's current public documentation at implementation
 * time:
 *   - Endpoint: GET https://api.gdeltproject.org/api/v2/doc/doc
 *   - Auth: none. Fully public, unauthenticated endpoint -- no key, no
 *     signup, no billing surface. This is what makes it R0: unlike Tavily
 *     (a free *allocation* on a paid product) there is no plan to exceed
 *     and no account to be suspended.
 *   - Query params used here: `query`, `mode=ArtList`, `format=json`,
 *     `maxrecords` (clamped into GDELT's documented 1-250 range).
 *   - Response shape: `{ articles: [ { url, title, domain, seendate,
 *     language, sourcecountry, ... } ] }`. GDELT returns headline-level
 *     metadata only -- there is no query-aware excerpt/snippet field like
 *     Tavily's `content`. Per the Research pipeline trace that authorized
 *     this provider, `snippet` is never consumed downstream (Research
 *     always re-fetches and re-extracts the real page via retrieveSource()),
 *     so `snippet` is mapped to `null` here rather than synthesized.
 *   - `seendate` is GDELT's own crawl timestamp (format `YYYYMMDDTHHMMSSZ`,
 *     not ISO-8601) and is mapped to `publishedAt` verbatim when present,
 *     exactly as Tavily's optional `published_date` is passed through
 *     verbatim -- Research does not parse or rely on this field either
 *     (isSourceFreshness uses the retrieval-time `retrieved_at`, not
 *     discovery-time metadata).
 *   - Rate limit: no metered/billed quota -- GDELT enforces a soft
 *     per-IP request rate rather than a monthly credit allocation. This
 *     provider makes exactly one request per `discoverCandidates()` call,
 *     the same call shape as Tavily, so it never needs internal
 *     rate-limiting logic of its own.
 *   - GDELT can return HTTP 200 with a plain-text error body (not JSON) for
 *     malformed queries -- handled the same defensive way as Tavily's
 *     non-JSON-response case below: `res.json()` failure is caught and
 *     reported as a structured failure, never thrown.
 *
 * Per ResearchSourceProvider.js's documented contract, a failed discovery
 * attempt is isolated: this method NEVER throws. It always resolves to
 * `{ candidates, failures }`, with `failures` describing what went wrong
 * (HTTP status, malformed response, network error) and `candidates` being
 * `[]` when nothing could be discovered.
 */
export class GdeltSearchProvider extends ResearchSourceProvider {
  /**
   * @param {object} [opts]
   * @param {typeof fetch} [opts.fetchImpl] - injectable for tests; defaults to global fetch.
   * @param {string} [opts.baseUrl] - defaults to GDELT's documented DOC 2.0 endpoint; overridable for tests.
   */
  constructor({
    fetchImpl = fetch,
    baseUrl = 'https://api.gdeltproject.org/api/v2/doc/doc'
  } = {}) {
    super();
    this._fetch = fetchImpl;
    this._baseUrl = baseUrl;
  }

  get id() {
    return 'gdelt';
  }

  /**
   * No credential to check -- the endpoint is unauthenticated, so
   * "healthy" degenerates to "provider is configured at all", which is
   * always true. Never makes a network call, matching Tavily's
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
    url.searchParams.set('query', query);
    url.searchParams.set('mode', 'ArtList');
    url.searchParams.set('format', 'json');
    url.searchParams.set('maxrecords', String(boundedMaxResults));

    let res;
    try {
      res = await this._fetch(url.toString());
    } catch (err) {
      // Network-level failure reaching GDELT.
      return { candidates: [], failures: [{ error: `network error contacting GDELT: ${err.message}` }] };
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
        failures: [{ error: `GDELT HTTP ${res.status}${detail ? `: ${detail}` : ''}` }]
      };
    }

    let data;
    try {
      data = await res.json();
    } catch (err) {
      // Covers both genuinely malformed JSON and GDELT's documented
      // behavior of returning HTTP 200 with a plain-text error body for
      // malformed queries.
      return { candidates: [], failures: [{ error: `malformed GDELT response: ${err.message}` }] };
    }

    if (!data || !Array.isArray(data.articles)) {
      return { candidates: [], failures: [{ error: 'GDELT response missing articles array' }] };
    }

    const alreadySeen = new Set(alreadyAcquiredUrls ?? []);
    const candidates = [];
    for (const item of data.articles) {
      if (candidates.length >= boundedMaxResults) break;
      if (!item || typeof item.url !== 'string' || !item.url) continue;
      if (alreadySeen.has(item.url)) continue;

      const candidate = {
        url: item.url,
        title: typeof item.title === 'string' ? item.title : null,
        // GDELT returns headline-level metadata only -- no query-aware
        // excerpt field like Tavily's `content`. Never synthesized here:
        // the Research pipeline never consumes discovery-time snippet
        // text (it always re-fetches and re-extracts real page content).
        snippet: null
      };
      if (typeof item.seendate === 'string' && item.seendate) {
        candidate.publishedAt = item.seendate;
      }
      candidates.push(candidate);
    }

    return { candidates, failures: [] };
  }
}

/**
 * GDELT's documented maxrecords range is 1-250. This provider clamps
 * whatever Research's own `maxResults` (policy-driven, e.g.
 * max_sources_per_research_project) resolves to into that range rather
 * than sending an out-of-range value GDELT would reject or clamp silently
 * itself.
 */
function clampMaxResults(maxResults) {
  const n = Number.isFinite(maxResults) ? Math.floor(maxResults) : 5;
  return Math.min(250, Math.max(1, n));
}

export default GdeltSearchProvider;
