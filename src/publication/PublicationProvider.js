import { PUBLICATION_RESULT_STATUS } from './constants.js';

/**
 * PublicationProvider is the abstract interface every publication
 * provider adapter must implement — mirrors
 * src/providers/llm/LLMProvider.js's role and shape exactly for the
 * publication boundary. The provider-agnostic publication core (see
 * ./pipeline.js) must depend ONLY on this interface, never on a
 * specific provider's SDK, API shape, auth mechanism, or metadata
 * fields.
 */
export class PublicationProvider {
  /** Unique id, e.g. 'youtube'. Referenced in the `publications.provider` column and in D-C2 action ids (see constants.js#publicationActionId). */
  get id() {
    throw new Error('not implemented');
  }

  /**
   * Publishes the given provider-neutral request (see
   * ./PublicationRequest.js) and returns a normalized result — one of
   * the three shapes below. Must never throw for an ordinary
   * provider-side outcome (rejection, timeout, malformed response);
   * throwing is reserved for programmer error (e.g. a missing required
   * field the adapter cannot proceed without at all). The publication
   * core interprets only `status` and the fields documented per shape —
   * it does not depend on any additional provider-specific field beyond
   * these.
   *
   * SUCCESS:
   *   { status: 'SUCCESS', provider, providerItemId, providerUrl, raw? }
   *   `providerItemId` must be evidence the provider actually confirmed
   *   the publication (e.g. a returned video id) — never something the
   *   adapter constructs itself as a stand-in for confirmation.
   *
   * EXPLICIT_FAILURE:
   *   { status: 'EXPLICIT_FAILURE', provider, errorClass, retryable, raw? }
   *   A definite, confirmed provider-side rejection (e.g. malformed
   *   request, quota exceeded, rejected content). Safe to treat as "no
   *   external side effect occurred."
   *
   * AMBIGUOUS:
   *   { status: 'AMBIGUOUS', provider, reconciliationInfo, raw? }
   *   The provider's actual outcome could not be confirmed (timeout,
   *   dropped connection, 5xx with no confirmed body, etc.).
   *   `reconciliationInfo` should carry whatever the adapter has that
   *   might later help a human or a future reconciliation mechanism
   *   determine what actually happened (e.g. an upload session URL) —
   *   never a guess dressed up as a confirmed id.
   *
   * @param {object} request - see ./PublicationRequest.js
   * @returns {Promise<{status: string, provider: string, [key: string]: any}>}
   */
  async publish(request) {
    throw new Error('not implemented');
  }
}

/** Convenience re-export so adapters/tests can build normalized results without importing constants.js separately. */
export { PUBLICATION_RESULT_STATUS };

export default PublicationProvider;
