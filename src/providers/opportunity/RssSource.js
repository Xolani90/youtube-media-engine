import { OpportunitySource } from './OpportunitySource.js';
import { parseFeed } from '../../discovery/rssParser.js';

/**
 * RssSource is the first production OpportunitySource implementation
 * (v0.6 §5 in the original v0.1 material — RSS is the initial source
 * because it is free, simple, automatable, auditable).
 *
 * fetchCandidates() isolates failures per-feed: one broken/timing-out
 * feed URL must not prevent other configured feeds from being processed
 * (v0.6 acceptance criteria — source failure isolation).
 */
export class RssSource extends OpportunitySource {
  constructor({ feedUrls = [], fetchImpl = fetch, timeoutMs = 10000 } = {}) {
    super();
    this.feedUrls = feedUrls;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  get id() {
    return 'rss';
  }

  async healthCheck() {
    return this.feedUrls.length > 0;
  }

  /**
   * Fetches every configured feed. Returns:
   * { candidates: [...raw items with feedUrl attached], failures: [{feedUrl, error}] }
   * A feed that fails does not prevent others from being processed.
   */
  async fetchCandidates() {
    const candidates = [];
    const failures = [];

    for (const feedUrl of this.feedUrls) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.timeoutMs);
        let text;
        try {
          const res = await this.fetchImpl(feedUrl, { signal: controller.signal });
          if (!res.ok) {
            throw new Error(`HTTP ${res.status} fetching ${feedUrl}`);
          }
          text = await res.text();
        } finally {
          clearTimeout(timer);
        }
        const items = parseFeed(text);
        for (const item of items) {
          candidates.push({ ...item, feedUrl, retrievedAt: new Date().toISOString() });
        }
      } catch (err) {
        failures.push({ feedUrl, error: err.message });
      }
    }

    return { candidates, failures };
  }

  /**
   * Normalizes one raw RSS item into the shared observation shape consumed
   * by the discovery pipeline (see src/discovery/normalize.js for the
   * canonical Opportunity-candidate shape this feeds into).
   */
  normalize(raw) {
    return {
      title: raw.title || null,
      description: raw.description || null,
      sourceUrl: raw.link || null,
      sourceId: raw.guid || raw.link || null,
      sourceType: 'rss',
      feedUrl: raw.feedUrl,
      publishedAt: raw.pubDate ? new Date(raw.pubDate).toISOString() : null,
      discoveredAt: raw.retrievedAt || new Date().toISOString(),
      retrievedAt: raw.retrievedAt || new Date().toISOString()
    };
  }
}

export default RssSource;
