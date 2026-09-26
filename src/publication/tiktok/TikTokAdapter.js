import fs from 'node:fs';
import { PublicationProvider } from '../PublicationProvider.js';
import { PUBLICATION_RESULT_STATUS } from '../constants.js';

// The only privacy_level values this adapter will ever send (TikTok
// Content Posting API's post_info.privacy_level). Anything else fails
// closed before any network call -- same discipline as YouTubeAdapter's
// SUPPORTED_PRIVACY_STATUSES. TikTok's exact allowed set is queried
// per-creator (creator_info/query) and varies by account; this is the
// conservative subset every account supports.
const SUPPORTED_PRIVACY_LEVELS = Object.freeze(['SELF_ONLY', 'PUBLIC_TO_EVERYONE']);

/**
 * TikTok Content Posting API (Direct Post) adapter — publishes an
 * already-rendered short-form artifact directly to a creator's TikTok
 * account. Every TikTok-specific concept (endpoints, chunked-upload
 * protocol, OAuth, post_info/source_info field mapping, async
 * publish-status polling) lives in this file only — the publication
 * core (../pipeline.js) never imports anything from this module except
 * the class itself.
 *
 * Verified against the current TikTok for Developers Content Posting
 * API documentation (developers.tiktok.com/doc/content-posting-api-
 * reference-direct-post) at implementation time:
 *   - Init endpoint: POST https://open.tiktokapis.com/v2/post/publish/video/init/
 *     with source.FILE_UPLOAD (video_size/chunk_size/total_chunk_count)
 *     and post_info (title/privacy_level/etc), returns { data: {
 *     publish_id, upload_url } }.
 *   - The file bytes are then PUT to the returned upload_url with
 *     Content-Range/Content-Type/Content-Length headers (whole-file
 *     single chunk for the artifact sizes this engine produces --
 *     short-form derivatives are capped at
 *     SHORT_FORM_RENDER_DEFAULTS.MAX_DURATION_SECONDS and are small
 *     enough that TikTok's single-request "whole upload" path applies;
 *     no multi-chunk loop is implemented since nothing in this engine
 *     produces a file large enough to require one).
 *   - Publication is asynchronous: TikTok returns only a publish_id at
 *     init time, never a confirmed post id. The actual post id
 *     (publicaly_available_post_id) is only available later via the
 *     Fetch Status endpoint (POST .../v2/post/publish/status/fetch/),
 *     and only once TikTok's moderation completes (documented as
 *     "usually within one minute," but "in some cases... a few hours").
 *   - Unaudited API clients are restricted to SELF_ONLY (private)
 *     regardless of the requested privacy_level -- this adapter never
 *     assumes a requested PUBLIC visibility is actually honored; it
 *     reports back exactly what TikTok's status check confirms.
 *
 * ASYNC PUBLISH DISCIPLINE: because a confirmed public post id is not
 * available synchronously, this adapter polls the Fetch Status endpoint
 * a small, bounded number of times immediately after upload (never an
 * unbounded/backgrounded loop -- this call must still return in a
 * single publish() invocation, per the PublicationProvider contract).
 * If PUBLISH_COMPLETE is observed within that bounded window, SUCCESS
 * is returned with the confirmed post id. If the window elapses with
 * the post still processing, the result is AMBIGUOUS with the
 * publish_id carried in reconciliationInfo -- never a fabricated
 * SUCCESS, and never a FAILURE for what may simply still be moderating.
 * A confirmed FAILED status from TikTok is reported as EXPLICIT_FAILURE.
 *
 * CREDENTIALS: mirrors YouTubeAdapter exactly -- no interactive OAuth
 * performed here; expects a long-lived refresh token already present in
 * runtime configuration, exchanged for a short-lived access token on
 * every publish() call, never cached across calls. No secret is ever
 * logged.
 */
export class TikTokAdapter extends PublicationProvider {
  /**
   * @param {object} [opts]
   * @param {typeof fetch} [opts.fetchImpl] - injectable for tests; defaults to global fetch.
   * @param {() => {clientKey: string, clientSecret: string, refreshToken: string}} [opts.credentialsProvider]
   *   Defaults to reading TIKTOK_CLIENT_KEY / TIKTOK_CLIENT_SECRET /
   *   TIKTOK_REFRESH_TOKEN from process.env.
   * @param {string} [opts.defaultPrivacyLevel] - one of SUPPORTED_PRIVACY_LEVELS; defaults to 'SELF_ONLY' (the safe default).
   * @param {number} [opts.statusPollAttempts] - bounded status-check attempts after upload; defaults to 3.
   * @param {number} [opts.statusPollDelayMs] - delay between status-check attempts; defaults to 2000.
   * @param {(ms: number) => Promise<void>} [opts.sleepImpl] - injectable for tests.
   */
  constructor({
    fetchImpl = fetch,
    credentialsProvider = defaultCredentialsProvider,
    defaultPrivacyLevel = 'SELF_ONLY',
    statusPollAttempts = 3,
    statusPollDelayMs = 2000,
    sleepImpl = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  } = {}) {
    super();
    this._fetch = fetchImpl;
    this._credentialsProvider = credentialsProvider;
    this._defaultPrivacyLevel = defaultPrivacyLevel;
    this._statusPollAttempts = statusPollAttempts;
    this._statusPollDelayMs = statusPollDelayMs;
    this._sleep = sleepImpl;
  }

  get id() {
    return 'tiktok';
  }

  async publish(request) {
    // ADR-0030-equivalent visibility discipline (mirrors YouTubeAdapter):
    // resolved and validated BEFORE any network activity. `null`/absent
    // means the adapter default applies.
    const privacyLevel = request.requestedVisibility ?? this._defaultPrivacyLevel;
    if (!SUPPORTED_PRIVACY_LEVELS.includes(privacyLevel)) {
      return {
        status: PUBLICATION_RESULT_STATUS.EXPLICIT_FAILURE,
        provider: this.id,
        errorClass: 'INVALID_VISIBILITY',
        retryable: false
      };
    }

    let accessToken;
    try {
      accessToken = await this._getAccessToken();
    } catch (err) {
      return {
        status: PUBLICATION_RESULT_STATUS.EXPLICIT_FAILURE,
        provider: this.id,
        errorClass: 'CREDENTIALS_UNAVAILABLE',
        retryable: false
      };
    }

    if (!fs.existsSync(request.mediaFilePath)) {
      return {
        status: PUBLICATION_RESULT_STATUS.EXPLICIT_FAILURE,
        provider: this.id,
        errorClass: 'MEDIA_FILE_MISSING',
        retryable: false
      };
    }

    const fileStat = fs.statSync(request.mediaFilePath);

    let initData;
    try {
      initData = await this._initUpload({ accessToken, request, privacyLevel, videoSize: fileStat.size });
    } catch (err) {
      return this._classifyNetworkError(err, { phase: 'INIT' });
    }

    if (!initData?.publish_id || !initData?.upload_url) {
      return {
        status: PUBLICATION_RESULT_STATUS.AMBIGUOUS,
        provider: this.id,
        reconciliationInfo: { phase: 'INIT', note: 'no_publish_id_or_upload_url_returned' }
      };
    }

    try {
      await this._putFile({ uploadUrl: initData.upload_url, filePath: request.mediaFilePath, fileSize: fileStat.size });
    } catch (err) {
      return this._classifyNetworkError(err, { phase: 'UPLOAD_BODY', publishId: initData.publish_id });
    }

    return this._pollUntilConfirmedOrAmbiguous({ accessToken, publishId: initData.publish_id });
  }

  // --- Internal helpers (all TikTok-specific; never referenced outside this file) ---

  async _getAccessToken() {
    const { clientKey, clientSecret, refreshToken } = this._credentialsProvider();
    if (!clientKey || !clientSecret || !refreshToken) {
      throw new Error('TikTok credentials are not configured.');
    }
    const res = await this._fetch('https://open.tiktokapis.com/v2/oauth/token/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Cache-Control': 'no-cache' },
      body: new URLSearchParams({
        client_key: clientKey,
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

  async _initUpload({ accessToken, request, privacyLevel, videoSize }) {
    const res = await this._fetch('https://open.tiktokapis.com/v2/post/publish/video/init/', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json; charset=UTF-8'
      },
      body: JSON.stringify({
        post_info: {
          title: request.title,
          privacy_level: privacyLevel,
          disable_duet: false,
          disable_comment: false,
          disable_stitch: false
        },
        source_info: {
          source: 'FILE_UPLOAD',
          video_size: videoSize,
          chunk_size: videoSize,
          total_chunk_count: 1
        }
      })
    });

    if (res.status >= 500) {
      throw new ProviderNetworkError(`init_server_error_${res.status}`);
    }
    if (!res.ok) {
      let errorBody = null;
      try {
        errorBody = await res.json();
      } catch {
        // ignore unparseable error body
      }
      throw new ProviderExplicitError(`init_rejected_${res.status}`, { httpStatus: res.status, errorBody });
    }
    const body = await res.json();
    // TikTok reports API-level errors inside a 200 response's `error`
    // object (error.code !== 'ok') as well as via HTTP status -- never
    // trust a 2xx alone.
    if (body?.error && body.error.code && body.error.code !== 'ok') {
      throw new ProviderExplicitError(`init_rejected_${body.error.code}`, { errorBody: body.error });
    }
    return body?.data ?? null;
  }

  async _putFile({ uploadUrl, filePath, fileSize }) {
    const body = fs.readFileSync(filePath);
    const res = await this._fetch(uploadUrl, {
      method: 'PUT',
      headers: {
        'Content-Type': 'video/mp4',
        'Content-Length': String(fileSize),
        'Content-Range': `bytes 0-${fileSize - 1}/${fileSize}`
      },
      body
    });

    if (res.status >= 500) {
      throw new ProviderNetworkError(`upload_server_error_${res.status}`);
    }
    // TikTok's chunked-upload PUT returns 201 (whole file) or 206
    // (partial chunk accepted) on success -- neither is `res.ok` under
    // the 200-299 definition for 206, so both are checked explicitly.
    if (res.status !== 201 && res.status !== 206) {
      let errorBody = null;
      try {
        errorBody = await res.json();
      } catch {
        // ignore unparseable error body
      }
      throw new ProviderExplicitError(`upload_rejected_${res.status}`, { httpStatus: res.status, errorBody });
    }
  }

  async _pollUntilConfirmedOrAmbiguous({ accessToken, publishId }) {
    for (let attempt = 0; attempt < this._statusPollAttempts; attempt++) {
      if (attempt > 0) {
        await this._sleep(this._statusPollDelayMs);
      }
      let statusBody;
      try {
        statusBody = await this._fetchStatus({ accessToken, publishId });
      } catch (err) {
        // A transient failure to even check status is ambiguous, not a
        // failure of the underlying publish itself -- the upload was
        // already confirmed accepted (PUT succeeded above).
        return {
          status: PUBLICATION_RESULT_STATUS.AMBIGUOUS,
          provider: this.id,
          reconciliationInfo: { phase: 'STATUS_CHECK', publishId, note: err?.message ?? 'status_check_failed' }
        };
      }
      const data = statusBody?.data;
      if (data?.status === 'FAILED') {
        return {
          status: PUBLICATION_RESULT_STATUS.EXPLICIT_FAILURE,
          provider: this.id,
          errorClass: `publish_failed_${data.fail_reason ?? 'unknown'}`,
          retryable: false,
          raw: data
        };
      }
      if (data?.status === 'PUBLISH_COMPLETE') {
        const postIds = Array.isArray(data.publicaly_available_post_id) ? data.publicaly_available_post_id : [];
        const postId = postIds[0];
        if (!postId) {
          // Complete with no confirmed public id (e.g. sent to the
          // creator's inbox rather than directly posted) -- never
          // fabricate one.
          return {
            status: PUBLICATION_RESULT_STATUS.AMBIGUOUS,
            provider: this.id,
            reconciliationInfo: { phase: 'STATUS_CHECK', publishId, note: 'publish_complete_no_post_id' }
          };
        }
        return {
          status: PUBLICATION_RESULT_STATUS.SUCCESS,
          provider: this.id,
          providerItemId: postId,
          providerUrl: `https://www.tiktok.com/@_/video/${postId}`,
          // TikTok's status response does not echo back a privacy
          // level; unaudited-client restriction to SELF_ONLY is a
          // documented platform behavior, not something this adapter
          // can confirm per-post, so confirmedVisibility is left null
          // rather than assumed.
          confirmedVisibility: null,
          raw: data
        };
      }
      // PROCESSING_UPLOAD / PROCESSING_DOWNLOAD / SEND_TO_USER_INBOX --
      // keep polling within the bounded window.
    }
    return {
      status: PUBLICATION_RESULT_STATUS.AMBIGUOUS,
      provider: this.id,
      reconciliationInfo: { phase: 'STATUS_CHECK', publishId, note: 'still_processing_after_bounded_poll' }
    };
  }

  async _fetchStatus({ accessToken, publishId }) {
    const res = await this._fetch('https://open.tiktokapis.com/v2/post/publish/status/fetch/', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json; charset=UTF-8'
      },
      body: JSON.stringify({ publish_id: publishId })
    });
    if (!res.ok) {
      throw new Error(`status_fetch_failed_${res.status}`);
    }
    return res.json();
  }

  _classifyNetworkError(err, context) {
    if (err instanceof ProviderExplicitError) {
      return {
        status: PUBLICATION_RESULT_STATUS.EXPLICIT_FAILURE,
        provider: this.id,
        errorClass: err.message,
        retryable: false
      };
    }
    return {
      status: PUBLICATION_RESULT_STATUS.AMBIGUOUS,
      provider: this.id,
      reconciliationInfo: { ...context, note: err?.message ?? 'network_error' }
    };
  }
}

function defaultCredentialsProvider() {
  return {
    clientKey: process.env.TIKTOK_CLIENT_KEY,
    clientSecret: process.env.TIKTOK_CLIENT_SECRET,
    refreshToken: process.env.TIKTOK_REFRESH_TOKEN
  };
}

class ProviderExplicitError extends Error {
  constructor(message, details) {
    super(message);
    this.details = details;
  }
}

class ProviderNetworkError extends Error {}

export default TikTokAdapter;