import { ANALYTICS_RESULT_STATUS } from '../constants.js';

/**
 * YouTube Analytics API v2 adapter (Phase 3). Every YouTube-analytics
 * concept (endpoint, dimensions/metrics query shape, response-row
 * mapping) lives in this file only -- the collector (../collector.js)
 * never imports anything from this module except the class itself, and
 * knows nothing about any of the constants below. Mirrors
 * ../../publication/youtube/YouTubeAdapter.js's own file-scoped
 * "provider specifics never leak into the core" discipline exactly.
 *
 * Verified against the current YouTube Analytics API documentation
 * (developers.google.com/youtube/analytics/reference/reports/query) at
 * implementation time:
 *   - Endpoint: GET https://youtubeanalytics.googleapis.com/v2/reports
 *   - Required params for a per-channel, per-video report: ids=channel==MINE,
 *     startDate, endDate (YYYY-MM-DD), metrics (comma-separated),
 *     dimensions=video, filters=video==<id1>,<id2>,... (batches multiple
 *     videos into one request instead of one request per video -- Phase 3
 *     spec §11/§24).
 *   - Required OAuth 2.0 scope: https://www.googleapis.com/auth/yt-analytics.readonly
 *     -- DISTINCT from the youtube.upload scope
 *     ../../publication/youtube/YouTubeAdapter.js's refresh token was
 *     granted. See the Phase 3 report's OAuth-scope note (spec §18):
 *     this adapter cannot return real data against a refresh token that
 *     was never granted yt-analytics.readonly at consent time -- that is
 *     an Owner-side one-time re-authorization, not a code change.
 *   - Response shape: { columnHeaders: [{name, columnType, dataType}, ...],
 *     rows: [[<dimension/metric values in columnHeaders order>], ...] }.
 *     A metric YouTube did not report for a video is simply absent from
 *     that video's row/columnHeaders -- never fabricated as 0 (see
 *     _normalizeRow below).
 *
 * CREDENTIALS: reuses the exact same refresh-token-exchange mechanism,
 * the same three env vars, and the same "never cache a token across
 * calls" discipline as YouTubeAdapter._getAccessToken -- deliberately
 * NOT imported from that file (it is a private, unexported method) so
 * that file is never touched by Phase 3 (Owner rule: do not modify
 * existing provider behavior). This is the same OAuth mechanism (one
 * Google OAuth app, refresh-token grant), not a second OAuth
 * implementation -- see the class-level credentialsProvider injection
 * point, identical in shape to YouTubeAdapter's.
 *
 * Bounded retry (Phase 3 spec §12): a RATE_LIMITED (429) or
 * TRANSIENT_FAILURE (5xx/network) response is retried up to
 * MAX_RETRIES additional times with a fixed backoff, never unbounded.
 * Every other outcome (including AUTH_FAILURE, UNAVAILABLE, and any
 * 4xx other than 429) returns immediately without retrying.
 */

const ANALYTICS_ENDPOINT = 'https://youtubeanalytics.googleapis.com/v2/reports';
const MAX_RETRIES = 2; // bounded: at most 2 retries (3 attempts total) per request
const RETRY_DELAY_MS = 500;

// Response columnHeaders name -> our normalized metric key. Only
// columns present in this map are ever copied into a result; any other
// column YouTube might return is ignored, never surfaced as an
// unexpected field. Kept in one place so adding a metric later means
// adding one map entry, not touching the query-building or
// row-parsing logic.
const METRIC_COLUMN_MAP = Object.freeze({
  views: 'views',
  likes: 'likes',
  comments: 'comments',
  shares: 'shares',
  estimatedMinutesWatched: 'estimatedWatchTimeMinutes',
  averageViewDuration: 'averageViewDurationSeconds',
  averageViewPercentage: 'averageViewPercentage',
  impressions: 'impressions',
  impressionsClickThroughRate: 'impressionsCtr'
});

const REQUESTED_METRICS = Object.keys(METRIC_COLUMN_MAP);

export class YouTubeAnalyticsAdapter {
  /**
   * @param {object} [opts]
   * @param {typeof fetch} [opts.fetchImpl] - injectable for tests; defaults to global fetch.
   * @param {() => {clientId: string, clientSecret: string, refreshToken: string}} [opts.credentialsProvider]
   *   Defaults to reading YOUTUBE_CLIENT_ID / YOUTUBE_CLIENT_SECRET /
   *   YOUTUBE_REFRESH_TOKEN from process.env -- the SAME env vars
   *   YouTubeAdapter reads (Phase 3 spec §6: no second OAuth
   *   implementation, no new credential surface). The refresh token
   *   itself must have been granted yt-analytics.readonly at Google
   *   consent time for real calls to succeed; this adapter does not,
   *   and cannot, change what scope a refresh token carries.
   * @param {(ms: number) => Promise<void>} [opts.sleepImpl] - injectable for tests so bounded-retry tests never actually wait.
   */
  constructor({
    fetchImpl = fetch,
    credentialsProvider = defaultCredentialsProvider,
    sleepImpl = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  } = {}) {
    this._fetch = fetchImpl;
    this._credentialsProvider = credentialsProvider;
    this._sleep = sleepImpl;
  }

  get id() {
    return 'youtube';
  }

  /**
   * Collects a single batched analytics report covering every
   * `videoIds` entry for the given [periodStart, periodEnd] (both
   * UTC date strings, YYYY-MM-DD, inclusive). Never throws for an
   * ordinary provider-side outcome -- mirrors
   * PublicationProvider#publish's contract exactly, with its own
   * six-way ANALYTICS_RESULT_STATUS vocabulary (constants.js) in place
   * of publication's three-way one.
   *
   * @param {object} args
   * @param {string[]} args.videoIds - confirmed provider video ids (the collector reads these from already-PUBLISHED publications rows; never invented here)
   * @param {string} args.periodStart - UTC date, YYYY-MM-DD
   * @param {string} args.periodEnd - UTC date, YYYY-MM-DD
   * @returns {Promise<{status: string, provider: string, byVideoId?: object, [key: string]: any}>}
   *   On SUCCESS, `byVideoId` maps each requested video id to either a
   *   normalized metrics object (only keys YouTube actually returned
   *   for that video are present -- never a fabricated 0) or `null` if
   *   that specific video had no row in the response (e.g. genuinely
   *   no data for the period) -- the collector persists that as
   *   UNAVAILABLE for that one video, never as zeros.
   */
  async collect({ videoIds, periodStart, periodEnd }) {
    if (!Array.isArray(videoIds) || videoIds.length === 0) {
      return { status: ANALYTICS_RESULT_STATUS.PERMANENT_FAILURE, provider: this.id, errorClass: 'NO_VIDEO_IDS' };
    }

    let accessToken;
    try {
      accessToken = await this._getAccessToken();
    } catch (err) {
      return { status: ANALYTICS_RESULT_STATUS.AUTH_FAILURE, provider: this.id, errorClass: err.message };
    }

    const url = new URL(ANALYTICS_ENDPOINT);
    url.searchParams.set('ids', 'channel==MINE');
    url.searchParams.set('startDate', periodStart);
    url.searchParams.set('endDate', periodEnd);
    url.searchParams.set('metrics', REQUESTED_METRICS.join(','));
    url.searchParams.set('dimensions', 'video');
    url.searchParams.set('filters', `video==${videoIds.join(',')}`);

    let res;
    let attempt = 0;
    for (;;) {
      try {
        res = await this._fetch(url.toString(), {
          headers: { Authorization: `Bearer ${accessToken}` }
        });
      } catch (err) {
        // Thrown fetch/network error: same treatment as a 5xx below --
        // bounded-retry, then TRANSIENT_FAILURE.
        if (attempt < MAX_RETRIES) {
          attempt += 1;
          await this._sleep(RETRY_DELAY_MS);
          continue;
        }
        return { status: ANALYTICS_RESULT_STATUS.TRANSIENT_FAILURE, provider: this.id, errorClass: `network_error_${err.message}` };
      }

      if (res.status === 429) {
        if (attempt < MAX_RETRIES) {
          attempt += 1;
          await this._sleep(RETRY_DELAY_MS);
          continue;
        }
        return { status: ANALYTICS_RESULT_STATUS.RATE_LIMITED, provider: this.id, errorClass: 'RATE_LIMIT_RETRIES_EXHAUSTED' };
      }
      if (res.status >= 500) {
        if (attempt < MAX_RETRIES) {
          attempt += 1;
          await this._sleep(RETRY_DELAY_MS);
          continue;
        }
        return { status: ANALYTICS_RESULT_STATUS.TRANSIENT_FAILURE, provider: this.id, errorClass: `server_error_${res.status}` };
      }
      break;
    }

    if (res.status === 401 || res.status === 403) {
      // 403 on this endpoint is ambiguous between "token lacks
      // yt-analytics.readonly" and "Analytics not available for this
      // account/API disabled" -- both are non-retryable and both mean
      // "we did not get analytics," so both classify the same way here
      // (AUTH_FAILURE); the raw body is preserved in errorClass for
      // manual reconciliation, never guessed at further.
      let errorBody = null;
      try { errorBody = await res.text(); } catch { /* ignore unparseable error body */ }
      return { status: ANALYTICS_RESULT_STATUS.AUTH_FAILURE, provider: this.id, errorClass: `http_${res.status}`, raw: errorBody };
    }
    if (!res.ok) {
      // Any other 4xx: a confirmed, non-retryable rejection of the
      // request itself (malformed query, unsupported dimension
      // combination, etc.) -- Phase 3 spec §12F.
      let errorBody = null;
      try { errorBody = await res.text(); } catch { /* ignore unparseable error body */ }
      return { status: ANALYTICS_RESULT_STATUS.PERMANENT_FAILURE, provider: this.id, errorClass: `http_${res.status}`, raw: errorBody };
    }

    let body;
    try {
      body = await res.json();
    } catch (err) {
      // A 2xx with an unparseable body is not evidence analytics is
      // unavailable OR that it succeeded -- never fabricate either.
      return { status: ANALYTICS_RESULT_STATUS.TRANSIENT_FAILURE, provider: this.id, errorClass: `unparseable_response_${err.message}` };
    }

    return this._interpretReport(body, { videoIds });
  }

  // --- Internal helpers (all YouTube-Analytics-specific) ---

  async _getAccessToken() {
    const { clientId, clientSecret, refreshToken } = this._credentialsProvider();
    if (!clientId || !clientSecret || !refreshToken) {
      throw new Error('YouTube credentials are not configured.');
    }
    const res = await this._fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
        grant_type: 'refresh_token'
      }).toString()
    });
    if (!res.ok) {
      throw new Error(`token_refresh_failed_${res.status}`);
    }
    const body = await res.json();
    if (!body.access_token) {
      throw new Error('token_refresh_missing_access_token');
    }
    return body.access_token;
  }

  /**
   * Maps the report's columnHeaders/rows shape into one normalized
   * metrics object per requested video id. A video with no row at all
   * in the response (e.g. genuinely no data for the period) maps to
   * `null` -- the collector persists that as UNAVAILABLE, never as an
   * all-zero row. Within a present row, only columns YouTube actually
   * included are copied; an omitted column is simply absent from the
   * normalized object (the collector/schema layer treats "absent" and
   * "explicit null" identically -- both persist as SQL NULL).
   */
  _interpretReport(body, { videoIds }) {
    const headers = Array.isArray(body?.columnHeaders) ? body.columnHeaders : [];
    const rows = Array.isArray(body?.rows) ? body.rows : [];
    if (headers.length === 0) {
      // No columnHeaders at all is not evidence of anything -- treat as
      // unavailable rather than guessing a shape.
      return { status: ANALYTICS_RESULT_STATUS.UNAVAILABLE, provider: this.id, errorClass: 'NO_COLUMN_HEADERS', raw: body };
    }
    const videoIdColumn = headers.findIndex((h) => h.name === 'video');
    if (videoIdColumn === -1) {
      return { status: ANALYTICS_RESULT_STATUS.UNAVAILABLE, provider: this.id, errorClass: 'NO_VIDEO_DIMENSION_IN_RESPONSE', raw: body };
    }

    const byVideoId = Object.fromEntries(videoIds.map((id) => [id, null]));
    for (const row of rows) {
      const videoId = row[videoIdColumn];
      if (!Object.prototype.hasOwnProperty.call(byVideoId, videoId)) continue; // defensive: ignore any row for a video we did not request
      const metrics = {};
      headers.forEach((header, i) => {
        const key = METRIC_COLUMN_MAP[header.name];
        if (!key) return; // not one of our requested metrics (e.g. the 'video' dimension column itself) -- ignored
        const value = row[i];
        if (value === null || value === undefined) return; // never fabricate a value YouTube did not report
        metrics[key] = value;
      });
      byVideoId[videoId] = metrics;
    }

    return { status: ANALYTICS_RESULT_STATUS.SUCCESS, provider: this.id, byVideoId, raw: body };
  }
}

function defaultCredentialsProvider() {
  return {
    clientId: process.env.YOUTUBE_CLIENT_ID,
    clientSecret: process.env.YOUTUBE_CLIENT_SECRET,
    refreshToken: process.env.YOUTUBE_REFRESH_TOKEN
  };
}

export default YouTubeAnalyticsAdapter;