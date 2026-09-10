/**
 * OpportunitySource is the abstract interface for content-discovery
 * providers (RSS, YouTube, news, etc.). Discovery/scoring business logic
 * depends only on this interface.
 */
export class OpportunitySource {
  get id() {
    throw new Error('not implemented');
  }

  async healthCheck() {
    throw new Error('not implemented');
  }

  /** Returns an array of raw candidate objects, source-specific shape. */
  async fetchCandidates() {
    throw new Error('not implemented');
  }

  /** Normalizes a raw candidate into the shared Opportunity shape (see migrations/0001_init.sql). */
  normalize(raw) {
    throw new Error('not implemented');
  }
}

export default OpportunitySource;
