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
  averageViewPercentage: 'averageViewPercentage'
  // NOT requested: `impressions` / `impressionsClickThroughRate` are not metrics of the YouTube Analytics API
  // (metrics reference, updated 2026-09-10: `impressions` was renamed `adImpressions`, which is ad impressions, not
  // thumbnail impressions; no thumbnail-CTR metric is listed). Requesting an undocumented metric risks a 400 that
  // PERMANENT_FAILUREs the whole batch. The impressions columns stay NULL, so the CTR recommendation rule
  // (needsImpressions) excludes itself rather than reading a fabricated value.
});

const REQUESTED_METRICS = Object.keys(METRIC_COLUMN_MAP);

// --- Audience reports (retention curve, traffic sources) ---------------------
//
// Report shapes, verified against the YouTube Analytics API channel-report
// documentation (developers.google.com/youtube/analytics/channel_reports) and
// the field-type listings that mirror it, at implementation time:
//   - Audience retention: dimensions=elapsedVideoTimeRatio, metrics
//     audienceWatchRatio (float) and relativeRetentionPerformance (float, 0..1:
//     Google's metrics page defines 0 = worse than every similar-length video,
//     0.5 = median, 1 = better than every one; NO negative values are documented),
//     filters=video==<ONE id> (the video filter is REQUIRED and takes a single
//     video here). The API returns up to 100 points, ratios 0.01..1.0.
//     elapsedVideoTimeRatio is typed STRING: rows arrive as ["0.01", 1, 0.42],
//     not [0.01, 1, 0.42]. It is NOT assumed numeric. YouTube withholds
//     retention for videos below a volume threshold: the report then has no
//     rows, which is UNAVAILABLE here, never a flat curve.
//     audienceWatchRatio may legitimately exceed 1 (re-watches).
//   - Traffic sources: dimensions=insightTrafficSourceType, metrics
//     views,estimatedMinutesWatched, optional video filter, sort=-views.
//     A source with no views is simply absent from the rows.
// Not verified live: no credentials were available. Fixtures in
// tests/unit/youtube-analytics-retention.test.js are API-shaped, not recorded.
const RETENTION_METRIC_COLUMNS = Object.freeze(['audienceWatchRatio', 'relativeRetentionPerformance']);
const TRAFFIC_METRIC_COLUMNS = Object.freeze(['views', 'estimatedMinutesWatched']);
// Per-column validity. A value outside its range is MALFORMED and becomes null
// (unavailable); it is never clamped, defaulted or coerced to 0.
const METRIC_RULES = Object.freeze({
  audienceWatchRatio: { min: 0 },
  relativeRetentionPerformance: { min: 0, max: 1 },
  views: { min: 0 },
  estimatedMinutesWatched: { min: 0 }
});
const RETENTION_SUMMARY_POINTS = Object.freeze({ at10: 0.1, at25: 0.25, at50: 0.5, at75: 0.75 });
const RATIO_MATCH_EPSILON = 1e-6;
// The API samples retention on a 0.01 grid; a drop is only attributed across
// ADJACENT grid points, never across a gap left by a dropped/malformed row.
const MAX_ADJACENT_RATIO_GAP = 0.011;
const VIDEO_ID_RE = /^[A-Za-z0-9_-]{6,32}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * True only for a real calendar date written YYYY-MM-DD. Round-trips through
 * Date.UTC so 2026-02-30, 2026-13-01, 2027-02-29 (not a leap year) and
 * 2026-00-10 are rejected, while 2028-02-29 (a leap year) is accepted.
 */
export function isValidIsoDate(value) {
  if (typeof value !== 'string' || !DATE_RE.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  if (y < 1970) return false;
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}
const TRAFFIC_SOURCE_RE = /^[A-Z][A-Z0-9_]{1,63}$/;

/**
 * Strict numeric parse for API values that may arrive as a number OR a numeric
 * string. Returns a finite number or null. Rejects '', whitespace, 'NaN',
 * 'Infinity', hex/octal forms, trailing junk, booleans, objects and arrays.
 * null/undefined are unavailable (null), never 0.
 */
export function parseApiNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const s = value.trim();
  if (s === '' || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function parseMetric(name, value) {
  const n = parseApiNumber(value);
  if (n === null) return null;
  const rule = METRIC_RULES[name];
  if (rule && ((rule.min !== undefined && n < rule.min) || (rule.max !== undefined && n > rule.max))) return null;
  return n;
}

/**
 * Reads a columnHeaders/rows report into dimension + metric values by COLUMN
 * NAME (never by position). Returns { error } when the shape cannot be trusted,
 * else { rows: [{ dimension, metrics: {name: number|null} }], dropped }.
 * A row whose dimension fails parseDimension is dropped and counted; a metric
 * that is missing, null or malformed is null in that row.
 */
function readTable(body, { dimension, metrics, parseDimension, requiredMetrics }) {
  const headers = Array.isArray(body?.columnHeaders) ? body.columnHeaders : [];
  if (headers.length === 0) return { error: 'NO_COLUMN_HEADERS' };
  const col = (name) => headers.findIndex((h) => h?.name === name);
  const dimCol = col(dimension);
  if (dimCol === -1) return { error: `NO_${dimension}_DIMENSION_IN_RESPONSE` };
  const metricCols = Object.fromEntries(metrics.map((m) => [m, col(m)]));
  for (const m of requiredMetrics) {
    if (metricCols[m] === -1) return { error: `METRIC_COLUMN_MISSING_${m}` };
  }
  if (body.rows !== undefined && body.rows !== null && !Array.isArray(body.rows)) return { error: 'ROWS_NOT_AN_ARRAY' };
  const rows = [];
  const dropped = { malformedRow: 0, badDimension: 0 };
  for (const raw of body.rows ?? []) {
    if (!Array.isArray(raw)) { dropped.malformedRow += 1; continue; }
    const dim = parseDimension(raw[dimCol]);
    if (dim === null) { dropped.badDimension += 1; continue; }
    const values = {};
    for (const m of metrics) values[m] = metricCols[m] === -1 ? null : parseMetric(m, raw[metricCols[m]]);
    rows.push({ dimension: dim, metrics: values });
  }
  return { rows, dropped };
}

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
    // Docs (sample-requests) state that dimensions=video top-N reports require `sort` and maxResults (<=10 in those
    // examples). Not verified live for filtered multi-id requests: maxResults is set to the batch size so no requested
    // video is truncated (collector batches are <= 50).
    url.searchParams.set('sort', '-views');
    url.searchParams.set('maxResults', String(videoIds.length));

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

  /**
   * Audience-retention curve for ONE video over [periodStart, periodEnd].
   * Same never-throws / six-status contract as collect(). On SUCCESS:
   * { points: [{ ratio, audienceWatchRatio, relativeRetentionPerformance }]
   *   (ascending by ratio, nulls preserved), summary: { at10, at25, at50,
   *   at75, steepestDrop, pointCount, dropped } }. summary.atNN is the
   * audienceWatchRatio at exactly NN% of the video, or null when that point
   * is absent/unavailable -- never interpolated, never 0.
   * No rows / no usable points => UNAVAILABLE (YouTube withholds retention
   * for low-volume videos), never an empty or flat curve reported as SUCCESS.
   */
  async collectRetentionCurve({ videoId, periodStart, periodEnd }) {
    const invalid = this._validateAudienceArgs({ videoId, periodStart, periodEnd });
    if (invalid) return invalid;
    const q = await this._runQuery({
      ids: 'channel==MINE', startDate: periodStart, endDate: periodEnd,
      metrics: RETENTION_METRIC_COLUMNS.join(','), dimensions: 'elapsedVideoTimeRatio', filters: `video==${videoId}`
    });
    if (!q.ok) return q.result;
    return this._interpretRetention(q.body, { videoId });
  }

  /**
   * Traffic-source breakdown for ONE video over [periodStart, periodEnd].
   * On SUCCESS: { sources: [{ source, views, estimatedMinutesWatched,
   * viewsShare }] (descending by views), totalViews, totalViewsComplete,
   * zeroViews }. viewsShare is a 0..1 fraction of totalViews, or null when
   * it cannot be computed honestly (zero total views, or any source's views
   * unavailable) -- never NaN, never a fabricated 0. No rows => UNAVAILABLE.
   */
  async collectTrafficSources({ videoId, periodStart, periodEnd }) {
    const invalid = this._validateAudienceArgs({ videoId, periodStart, periodEnd });
    if (invalid) return invalid;
    const q = await this._runQuery({
      ids: 'channel==MINE', startDate: periodStart, endDate: periodEnd,
      metrics: TRAFFIC_METRIC_COLUMNS.join(','), dimensions: 'insightTrafficSourceType', filters: `video==${videoId}`, sort: '-views'
    });
    if (!q.ok) return q.result;
    return this._interpretTraffic(q.body, { videoId });
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

  _validateAudienceArgs({ videoId, periodStart, periodEnd }) {
    const bad = (errorClass) => ({ status: ANALYTICS_RESULT_STATUS.PERMANENT_FAILURE, provider: this.id, errorClass });
    if (typeof videoId !== 'string' || !VIDEO_ID_RE.test(videoId)) return bad('INVALID_VIDEO_ID');
    if (!isValidIsoDate(periodStart) || !isValidIsoDate(periodEnd)) return bad('INVALID_PERIOD');
    // YYYY-MM-DD compares chronologically as a string; a single-day period (start == end) is allowed.
    if (periodStart > periodEnd) return bad('INVALID_PERIOD');
    return null;
  }

  /**
   * One authenticated, bounded-retry report request (same token exchange,
   * same MAX_RETRIES/RETRY_DELAY_MS and the same status classification as
   * collect()). Returns { ok: true, body } or { ok: false, result }.
   * Deliberately a parallel of collect()'s request loop rather than a
   * refactor of it: collect()'s behaviour and tests are left untouched.
   */
  async _runQuery(params) {
    let accessToken;
    try {
      accessToken = await this._getAccessToken();
    } catch (err) {
      return { ok: false, result: { status: ANALYTICS_RESULT_STATUS.AUTH_FAILURE, provider: this.id, errorClass: err.message } };
    }
    const url = new URL(ANALYTICS_ENDPOINT);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

    let res;
    let attempt = 0;
    const fail = (status, errorClass, extra = {}) => ({ ok: false, result: { status, provider: this.id, errorClass, ...extra } });
    for (;;) {
      try {
        res = await this._fetch(url.toString(), { headers: { Authorization: `Bearer ${accessToken}` } });
      } catch (err) {
        if (attempt < MAX_RETRIES) { attempt += 1; await this._sleep(RETRY_DELAY_MS); continue; }
        return fail(ANALYTICS_RESULT_STATUS.TRANSIENT_FAILURE, `network_error_${err.message}`);
      }
      if (res.status === 429) {
        if (attempt < MAX_RETRIES) { attempt += 1; await this._sleep(RETRY_DELAY_MS); continue; }
        return fail(ANALYTICS_RESULT_STATUS.RATE_LIMITED, 'RATE_LIMIT_RETRIES_EXHAUSTED');
      }
      if (res.status >= 500) {
        if (attempt < MAX_RETRIES) { attempt += 1; await this._sleep(RETRY_DELAY_MS); continue; }
        return fail(ANALYTICS_RESULT_STATUS.TRANSIENT_FAILURE, `server_error_${res.status}`);
      }
      break;
    }
    if (res.status === 401 || res.status === 403) {
      let raw = null;
      try { raw = await res.text(); } catch { /* ignore unparseable error body */ }
      return fail(ANALYTICS_RESULT_STATUS.AUTH_FAILURE, `http_${res.status}`, { raw });
    }
    if (!res.ok) {
      let raw = null;
      try { raw = await res.text(); } catch { /* ignore unparseable error body */ }
      return fail(ANALYTICS_RESULT_STATUS.PERMANENT_FAILURE, `http_${res.status}`, { raw });
    }
    try {
      return { ok: true, body: await res.json() };
    } catch (err) {
      return fail(ANALYTICS_RESULT_STATUS.TRANSIENT_FAILURE, `unparseable_response_${err.message}`);
    }
  }

  _interpretRetention(body, { videoId }) {
    const table = readTable(body, {
      dimension: 'elapsedVideoTimeRatio', metrics: RETENTION_METRIC_COLUMNS, requiredMetrics: ['audienceWatchRatio'],
      parseDimension: (v) => { const n = parseApiNumber(v); return n !== null && n > 0 && n <= 1 ? n : null; }
    });
    if (table.error) return { status: ANALYTICS_RESULT_STATUS.UNAVAILABLE, provider: this.id, videoId, errorClass: table.error };

    const byRatio = new Map();
    let duplicates = 0;
    for (const r of table.rows) {
      if (byRatio.has(r.dimension)) { duplicates += 1; continue; } // first occurrence wins; never averaged or summed
      byRatio.set(r.dimension, { ratio: r.dimension, audienceWatchRatio: r.metrics.audienceWatchRatio, relativeRetentionPerformance: r.metrics.relativeRetentionPerformance });
    }
    const points = [...byRatio.values()].sort((a, b) => a.ratio - b.ratio);
    const dropped = { ...table.dropped, duplicateRatio: duplicates };
    if (!points.some((p) => p.audienceWatchRatio !== null)) {
      return { status: ANALYTICS_RESULT_STATUS.UNAVAILABLE, provider: this.id, videoId, errorClass: 'NO_USABLE_RETENTION_POINTS', dropped };
    }

    const summary = { pointCount: points.length, dropped };
    for (const [key, target] of Object.entries(RETENTION_SUMMARY_POINTS)) {
      const hit = points.find((p) => Math.abs(p.ratio - target) < RATIO_MATCH_EPSILON);
      summary[key] = hit ? hit.audienceWatchRatio : null;
    }
    let steepest = null;
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1];
      const b = points[i];
      if (a.audienceWatchRatio === null || b.audienceWatchRatio === null) continue;
      if (b.ratio - a.ratio > MAX_ADJACENT_RATIO_GAP) continue;
      const drop = a.audienceWatchRatio - b.audienceWatchRatio;
      if (drop > 0 && (steepest === null || drop > steepest.drop)) steepest = { fromRatio: a.ratio, toRatio: b.ratio, drop };
    }
    summary.steepestDrop = steepest; // null = no measurable drop, not "0"
    return { status: ANALYTICS_RESULT_STATUS.SUCCESS, provider: this.id, videoId, points, summary };
  }

  _interpretTraffic(body, { videoId }) {
    const table = readTable(body, {
      dimension: 'insightTrafficSourceType', metrics: TRAFFIC_METRIC_COLUMNS, requiredMetrics: ['views'],
      parseDimension: (v) => (typeof v === 'string' && TRAFFIC_SOURCE_RE.test(v) ? v : null)
    });
    if (table.error) return { status: ANALYTICS_RESULT_STATUS.UNAVAILABLE, provider: this.id, videoId, errorClass: table.error };

    const seen = new Set();
    const sources = [];
    let duplicates = 0;
    for (const r of table.rows) {
      if (seen.has(r.dimension)) { duplicates += 1; continue; }
      seen.add(r.dimension);
      sources.push({ source: r.dimension, views: r.metrics.views, estimatedMinutesWatched: r.metrics.estimatedMinutesWatched, viewsShare: null });
    }
    const dropped = { ...table.dropped, duplicateSource: duplicates };
    if (sources.length === 0) {
      return { status: ANALYTICS_RESULT_STATUS.UNAVAILABLE, provider: this.id, videoId, errorClass: 'NO_TRAFFIC_ROWS', dropped };
    }
    const complete = sources.every((s) => s.views !== null);
    const totalViews = sources.reduce((sum, s) => sum + (s.views ?? 0), 0);
    if (complete && totalViews > 0) for (const s of sources) s.viewsShare = s.views / totalViews;
    sources.sort((a, b) => (b.views ?? -1) - (a.views ?? -1) || a.source.localeCompare(b.source));
    return {
      status: ANALYTICS_RESULT_STATUS.SUCCESS, provider: this.id, videoId, sources,
      totalViews: complete ? totalViews : null, totalViewsComplete: complete,
      zeroViews: complete && totalViews === 0, dropped
    };
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