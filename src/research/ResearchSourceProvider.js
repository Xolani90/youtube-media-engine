/**
 * ResearchSourceProvider (Research Subsystem Specification v0.3 S3 / v0.4).
 *
 * Scope discipline, explicit: this is responsible for candidate URL/
 * metadata DISCOVERY only — never browser automation, never JS-rendered
 * scraping, never general-purpose crawling. Actual content retrieval is a
 * separate, plain deterministic fetch step (see retrieval.js), not part of
 * this interface, since there is no demonstrated need yet for multiple
 * interchangeable retrieval strategies (same "don't build ahead of
 * evidence" discipline Discovery already applied when declining a
 * SimilarityProvider).
 */
export class ResearchSourceProvider {
  get id() {
    throw new Error('ResearchSourceProvider.id must be implemented by subclass');
  }

  async healthCheck() {
    throw new Error('ResearchSourceProvider.healthCheck must be implemented by subclass');
  }

  /**
   * @returns {Promise<{ candidates: Array<{url, title, snippet, publishedAt?}>, failures: Array<{error}> }>}
   * Bounded by maxResults. A failed discovery attempt is isolated — it does
   * not throw, it records a failure and returns whatever candidates (if
   * any) were still obtained, same failure-isolation discipline as
   * Discovery's per-feed isolation in RssSource.
   */
  async discoverCandidates({ query, maxResults, alreadyAcquiredUrls = [] } = {}) {
    throw new Error('ResearchSourceProvider.discoverCandidates must be implemented by subclass');
  }
}

export default ResearchSourceProvider;