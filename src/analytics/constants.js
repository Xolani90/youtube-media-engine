// Phase 3 -- YouTube Analytics Collection. This module owns its own
// vocabulary, entirely separate from ../publication/constants.js
// (mirrors that module's own "this stage owns this vocabulary, not
// shared with an earlier stage" convention). Analytics collection is
// observational only: nothing here transitions content_versions.state,
// touches D-C2, or is consulted by the publication pipeline.

export const ANALYTICS_STAGE = 'ANALYTICS';

// Normalized result shape an analytics provider adapter returns from
// collect() (see ./youtube/YouTubeAnalyticsAdapter.js). The collector
// interprets only these six -- never a provider-specific shape.
export const ANALYTICS_RESULT_STATUS = Object.freeze({
  SUCCESS: 'SUCCESS',
  // Analytics genuinely not available (API disabled for the account,
  // insufficient data for the video, requested metric/dimension not
  // available) -- never represented as zero performance (Phase 3
  // spec §7/§12/§8).
  UNAVAILABLE: 'UNAVAILABLE',
  AUTH_FAILURE: 'AUTH_FAILURE',
  RATE_LIMITED: 'RATE_LIMITED',
  TRANSIENT_FAILURE: 'TRANSIENT_FAILURE',
  PERMANENT_FAILURE: 'PERMANENT_FAILURE'
});

// Durable `analytics_snapshots.status` vocabulary -- identical value
// set to ANALYTICS_RESULT_STATUS by design (unlike Publication's
// PUBLICATION_STATUS/PUBLICATION_RESULT_STATUS split, there is no
// separate "claimed but not yet confirmed" durable state here: a
// snapshot row is only ever written once its collection attempt has
// already concluded -- see collector.js, which never pre-inserts a
// PENDING row the way runPublication() does for an external side
// effect. Analytics is a read, not a side effect, so there is nothing
// to durably claim before calling the provider).
export const ANALYTICS_SNAPSHOT_STATUS = ANALYTICS_RESULT_STATUS;

export const DECISION_LOG_DECISION = Object.freeze({
  ANALYTICS_SUCCESS: 'ANALYTICS_SUCCESS',
  ANALYTICS_UNAVAILABLE: 'ANALYTICS_UNAVAILABLE',
  ANALYTICS_AUTH_FAILURE: 'ANALYTICS_AUTH_FAILURE',
  ANALYTICS_RATE_LIMITED: 'ANALYTICS_RATE_LIMITED',
  ANALYTICS_TRANSIENT_FAILURE: 'ANALYTICS_TRANSIENT_FAILURE',
  ANALYTICS_PERMANENT_FAILURE: 'ANALYTICS_PERMANENT_FAILURE',
  ANALYTICS_RUN_ABORTED: 'ANALYTICS_RUN_ABORTED'
});

// The full set of core performance metrics Phase 3 collects, where
// available (Phase 3 spec §7). Order here is documentation only; the
// adapter reads each by name from whatever YouTube actually returned,
// never by position.
export const CORE_METRICS = Object.freeze([
  'views',
  'likes',
  'comments',
  'shares',
  'estimatedWatchTimeMinutes',
  'averageViewDurationSeconds',
  'averageViewPercentage',
  'impressions',
  'impressionsCtr'
]);