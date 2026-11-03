/**
 * Publisher RSS metadata (Phase 1, Owner-approved 2026-10-31).
 *
 * ISOLATION CONTRACT: nothing in this directory may be imported by
 * src/research/**, and nothing here writes to `sources`, `claims`,
 * `claim_sources` or `decision_log`. Feed items are NON-EVIDENTIARY audit
 * annotations only: never claim extraction input, never verifier input,
 * never corroboration, completeness or quote-validation material.
 */
export const FEED_ORIGIN = 'rss_feed_metadata';
export const FEED_LABEL = 'non_evidentiary_publisher_metadata';

export const FAILURE_CLASS = Object.freeze({
  HOST_ACCESS_DENIED: 'host_access_denied',
  HOST_RATE_LIMITED: 'host_rate_limited',
  HOST_HTTP_ERROR: 'host_http_error',
  INTERNAL_RETRIEVAL_FAILURE: 'internal_retrieval_failure'
});

// Neutral outcome for a failed retrieval whose recorded error is absent or not positively recognised.
// It is deliberately NOT in FAILURE_CLASS: only established classes may be persisted in
// publisher_feed_items (migration 0032 CHECK), so an unclassified failure is reported but never annotated.
export const FAILURE_UNCLASSIFIED = 'unclassified';

// Stable machine reasons for a feed that could not be used. Any of these
// means ZERO rows are written (fail closed).
export const FEED_FAILURE = Object.freeze({
  NOT_AUTHORIZED: 'feed_not_authorized',
  NETWORK_ERROR: 'feed_network_error',
  TIMEOUT: 'feed_timeout',
  HTTP_ERROR: 'feed_http_error',
  REDIRECT_NOT_FOLLOWED: 'feed_redirect_not_followed',
  TOO_LARGE: 'feed_too_large',
  NOT_A_FEED: 'feed_not_a_feed',
  NO_ITEMS: 'feed_no_items',
  MALFORMED_FEED: 'feed_malformed'
});

export const MAX_FEED_BYTES = 8 * 1024 * 1024;
export const MAX_SUMMARY_CHARS = 20000;
