import { OpportunitySource } from './OpportunitySource.js';
import { parseFeed } from '../../discovery/rssParser.js';
import { RSS_ADMISSION } from '../../discovery/constants.js';
import { traceAsync, safeUrl } from '../../diagnostics/trace.js';

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
   * { candidates: [...raw items with feedUrl attached], failures: [{feedUrl, error}],
   *   ceilings: { perFeedCapReached: [feedUrl, ...], globalCapReached: boolean } }
   * A feed that fails does not prevent others from being processed.
   *
   * ADR-0038: RSS admission workload bounds. Per-feed cap (50) and global cap
   * (100), applied in configured feed order and within-feed parser/document
   * order; unused per-feed capacity is never redistributed to other feeds.
   * A cap only reports "reached" when it actually excluded an item (an
   * exact-fit feed, or a run that ends exactly at a cap with nothing left,
   * reports no ceiling event for that cap).
   */
  async fetchCandidates() {
    const candidates = [];
    const failures = [];
    const perFeedCapReached = [];
    let globalCapReached = false;
    let globalAdmitted = 0;

    for (const feedUrl of this.feedUrls) {
      if (globalAdmitted >= RSS_ADMISSION.GLOBAL_CAP) {
        // The global cap was already reached by an earlier configured feed:
        // this and every remaining configured feed must never be processed.
        globalCapReached = true;
        break;
      }
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.timeoutMs);
        let text;
        try {
          const res = await traceAsync('discovery.rss.http.request', { feed: safeUrl(feedUrl) }, () => this.fetchImpl(feedUrl, { signal: controller.signal }), (r) => ({ status: r?.status }));
          if (!res.ok) {
            throw new Error(`HTTP ${res.status} fetching ${feedUrl}`);
          }
          text = await traceAsync('discovery.rss.http.body', { feed: safeUrl(feedUrl) }, () => res.text());
        } finally {
          clearTimeout(timer);
        }
        const items = parseFeed(text);
        let feedAdmitted = 0;
        for (const item of items) {
          if (feedAdmitted >= RSS_ADMISSION.PER_FEED_CAP) {
            perFeedCapReached.push(feedUrl);
            break;
          }
          if (globalAdmitted >= RSS_ADMISSION.GLOBAL_CAP) {
            globalCapReached = true;
            break;
          }
          candidates.push({ ...item, feedUrl, retrievedAt: new Date().toISOString() });
          feedAdmitted++;
          globalAdmitted++;
        }
      } catch (err) {
        failures.push({ feedUrl, error: err.message });
      }
    }

    return { candidates, failures, ceilings: { perFeedCapReached, globalCapReached } };
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
