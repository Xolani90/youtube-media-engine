import fs from 'node:fs';
import { PublicationProvider } from '../PublicationProvider.js';
import { PUBLICATION_RESULT_STATUS } from '../constants.js';

// The only privacyStatus values this adapter will ever send (YouTube Data
// API v3 status.privacyStatus). Anything else fails closed before any
// network call (ADR-0030 open item 3).
const SUPPORTED_PRIVACY_STATUSES = Object.freeze(['private', 'unlisted', 'public']);

/**
 * YouTube Data API v3 first concrete publication provider adapter.
 * Every YouTube-specific concept (endpoints, resumable-upload protocol,
 * OAuth, snippet/status field mapping, privacy defaults) lives in this
 * file only — the publication core (../pipeline.js) never imports
 * anything from this module except the class itself, and knows nothing
 * about any of the constants below.
 *
 * Verified against the current YouTube Data API v3 documentation
 * (developers.google.com/youtube/v3/docs/videos/insert) at
 * implementation time:
 *   - Upload endpoint: POST https://www.googleapis.com/upload/youtube/v3/videos
 *     with uploadType=resumable, part=snippet,status.
 *   - Required OAuth 2.0 scope: https://www.googleapis.com/auth/youtube.upload
 *     (https://www.googleapis.com/auth/youtube or .../youtubepartner also work).
 *   - Resumable upload protocol: an initial POST with the JSON metadata
 *     body and X-Upload-Content-Type/-Length headers returns a session
 *     URL in the `Location` response header; the file bytes are then
 *     PUT to that session URL.
 *   - Videos uploaded via unverified API projects are restricted to
 *     private viewing until the project passes an audit — this adapter
 *     therefore never assumes a caller-requested "public"/"unlisted"
 *     privacyStatus is actually honored by YouTube; it reports back
 *     exactly what the provider returns.
 *
 * CREDENTIALS: this adapter never performs interactive OAuth itself
 * (Publication v1 spec §7 — that is an Owner setup operation, not
 * something the engine can do autonomously). It expects a long-lived
 * refresh token to already exist in runtime configuration/environment,
 * and exchanges it for a short-lived access token itself on every
 * publish() call (tokens are not cached across calls — mirrors D-C2's
 * own "never assume a prior check/credential persists" discipline).
 * No secret is ever logged: catch blocks below log only structured
 * error classifications, never raw response bodies or headers, which
 * could otherwise carry tokens.
 */
export class YouTubeAdapter extends PublicationProvider {
  /**
   * @param {object} [opts]
   * @param {typeof fetch} [opts.fetchImpl] - injectable for tests; defaults to global fetch.
   * @param {() => {clientId: string, clientSecret: string, refreshToken: string}} [opts.credentialsProvider]
   *   Defaults to reading YOUTUBE_CLIENT_ID / YOUTUBE_CLIENT_SECRET /
   *   YOUTUBE_REFRESH_TOKEN from process.env. Injectable so tests never
   *   need real credentials or environment mutation.
   * @param {string} [opts.defaultPrivacyStatus] - one of 'private' | 'unlisted' | 'public'; defaults to 'private' (the safe default — see class docstring).
   */
  constructor({
    fetchImpl = fetch,
    credentialsProvider = defaultCredentialsProvider,
    defaultPrivacyStatus = 'private'
  } = {}) {
    super();
    this._fetch = fetchImpl;
    this._credentialsProvider = credentialsProvider;
    this._defaultPrivacyStatus = defaultPrivacyStatus;
  }

  get id() {
    return 'youtube';
  }

  async publish(request) {
    // ADR-0030: resolve and validate the visibility to be requested BEFORE
    // any network activity (including the OAuth token refresh). The
    // authorization-derived `request.requestedVisibility` (set only by the
    // publication pipeline from the grant that authorized this action)
    // takes precedence; `null`/absent means the adapter default applies,
    // exactly as at baseline. A value outside private/unlisted/public is a
    // confirmed local rejection: no external side effect occurred.
    const privacyStatus = request.requestedVisibility ?? this._defaultPrivacyStatus;
    if (!SUPPORTED_PRIVACY_STATUSES.includes(privacyStatus)) {
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
      // No live network call was made with content -- this is a
      // confirmed, local, explicit failure: no external side effect
      // occurred.
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

    const metadata = this._buildMetadata(request, privacyStatus);
    const fileStat = fs.statSync(request.mediaFilePath);

    let sessionUrl;
    try {
      sessionUrl = await this._initiateResumableUpload({
        accessToken,
        metadata,
        contentLength: fileStat.size
      });
    } catch (err) {
      return this._classifyNetworkError(err, { phase: 'INITIATE_SESSION' });
    }

    if (!sessionUrl) {
      // The provider accepted the initiate request but did not return a
      // session URL to upload to -- we cannot know whether it intends
      // to accept the upload. Treat as ambiguous rather than assuming
      // either outcome.
      return {
        status: PUBLICATION_RESULT_STATUS.AMBIGUOUS,
        provider: this.id,
        reconciliationInfo: { phase: 'INITIATE_SESSION', note: 'no_session_url_returned' }
      };
    }

    let uploadResult;
    try {
      uploadResult = await this._putFile({ sessionUrl, filePath: request.mediaFilePath, fileSize: fileStat.size });
    } catch (err) {
      return this._classifyNetworkError(err, { phase: 'UPLOAD_BODY', sessionUrl });
    }

    return this._interpretUploadResult(uploadResult, { sessionUrl });
  }

  /**
   * Phase 2B: uploads a thumbnail image for an already-uploaded video.
   * Distinct from publish() -- this is a second, independently
   * observable external action against a video that already has a
   * confirmed provider id (the caller, ../pipeline.js, never calls this
   * before publish() has returned a confirmed SUCCESS). Reuses the same
   * credential/token-refresh path as publish() (never a second OAuth
   * implementation) and returns the identical normalized
   * SUCCESS/EXPLICIT_FAILURE/AMBIGUOUS contract as publish() (see
   * ../PublicationProvider.js) so the publication core never needs a
   * second result vocabulary.
   *
   * Verified against the current YouTube Data API v3 documentation
   * (developers.google.com/youtube/v3/docs/thumbnails/set) at
   * implementation time: POST
   * https://www.googleapis.com/upload/youtube/v3/thumbnails/set?videoId=<id>
   * with the raw image bytes as the request body (uploadType=media,
   * simple upload -- thumbnails are small enough that the resumable
   * protocol publish() uses for video is unnecessary here).
   *
   * @param {object} args
   * @param {string} args.videoId - confirmed provider video id (PublicationRequest never supplies this; the caller reads it from the already-PUBLISHED publications row)
   * @param {string} args.thumbnailFilePath - local path to the generated thumbnail image
   * @returns {Promise<{status: string, provider: string, [key: string]: any}>}
   */
  async publishThumbnail({ videoId, thumbnailFilePath }) {
    if (!videoId) {
      return {
        status: PUBLICATION_RESULT_STATUS.EXPLICIT_FAILURE,
        provider: this.id,
        errorClass: 'MISSING_VIDEO_ID',
        retryable: false
      };
    }
    if (!fs.existsSync(thumbnailFilePath)) {
      return {
        status: PUBLICATION_RESULT_STATUS.EXPLICIT_FAILURE,
        provider: this.id,
        errorClass: 'THUMBNAIL_FILE_MISSING',
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

    const body = fs.readFileSync(thumbnailFilePath);
    let res;
    try {
      res = await this._fetch(
        `https://www.googleapis.com/upload/youtube/v3/thumbnails/set?videoId=${encodeURIComponent(videoId)}&uploadType=media`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'image/png',
            'Content-Length': String(body.length)
          },
          body
        }
      );
    } catch (err) {
      // Thrown fetch/network error: identical undetermined-outcome
      // discipline as _classifyNetworkError below -- never guess.
      return {
        status: PUBLICATION_RESULT_STATUS.AMBIGUOUS,
        provider: this.id,
        reconciliationInfo: { phase: 'THUMBNAIL_UPLOAD', note: err?.message ?? 'network_error' }
      };
    }

    if (res.status >= 500) {
      return {
        status: PUBLICATION_RESULT_STATUS.AMBIGUOUS,
        provider: this.id,
        reconciliationInfo: { phase: 'THUMBNAIL_UPLOAD', note: `thumbnail_server_error_${res.status}` }
      };
    }
    if (!res.ok) {
      let errorBody = null;
      try {
        errorBody = await res.json();
      } catch {
        // ignore unparseable error body
      }
      return {
        status: PUBLICATION_RESULT_STATUS.EXPLICIT_FAILURE,
        provider: this.id,
        errorClass: `thumbnail_upload_rejected_${res.status}`,
        retryable: false,
        raw: { httpStatus: res.status, errorBody }
      };
    }

    let json = null;
    try {
      json = await res.json();
    } catch {
      // 2xx with an unparseable body -- still ambiguous, never fabricated.
    }
    // The Data API's thumbnails.set response echoes back the set of
    // thumbnail sizes YouTube now has for the video (items[0].default,
    // etc.). Any 2xx body is evidence the request was accepted; a
    // completely empty/unparseable 2xx body is treated as ambiguous
    // rather than a fabricated success, matching publish()'s own
    // no-id-in-response handling.
    if (!json) {
      return {
        status: PUBLICATION_RESULT_STATUS.AMBIGUOUS,
        provider: this.id,
        reconciliationInfo: { phase: 'THUMBNAIL_UPLOAD', note: 'no_body_in_2xx_response' }
      };
    }

    return {
      status: PUBLICATION_RESULT_STATUS.SUCCESS,
      provider: this.id,
      raw: json
    };
  }

  // --- Internal helpers (all YouTube-specific; never referenced outside this file) ---

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

  _buildMetadata(request, privacyStatus = this._defaultPrivacyStatus) {
    return {
      snippet: {
        title: request.title,
        description: request.description
      },
      status: {
        privacyStatus,
        // Scheduling (Publication v1 spec §15): YouTube only honors
        // `publishAt` when privacyStatus is 'private' at upload time.
        // The adapter passes the core's requestedPublishAt through
        // verbatim if present; it does not invent or default one.
        ...(request.requestedPublishAt ? { publishAt: request.requestedPublishAt } : {})
      }
    };
  }

  async _initiateResumableUpload({ accessToken, metadata, contentLength }) {
    const res = await this._fetch(
      'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json; charset=UTF-8',
          'X-Upload-Content-Type': 'video/mp4',
          'X-Upload-Content-Length': String(contentLength)
        },
        body: JSON.stringify(metadata)
      }
    );

    if (res.status >= 500) {
      throw new ProviderNetworkError(`initiate_upload_server_error_${res.status}`);
    }
    if (!res.ok) {
      // 4xx here is a confirmed, explicit rejection of the request
      // itself (bad metadata, invalid auth, quota, etc.) -- surfaced by
      // the caller as EXPLICIT_FAILURE via the thrown error's shape.
      let errorBody = null;
      try {
        errorBody = await res.json();
      } catch {
        // ignore unparseable error body
      }
      throw new ProviderExplicitError(`initiate_upload_rejected_${res.status}`, {
        httpStatus: res.status,
        errorBody
      });
    }
    return res.headers.get('location');
  }

  async _putFile({ sessionUrl, filePath, fileSize }) {
    const body = fs.readFileSync(filePath);
    const res = await this._fetch(sessionUrl, {
      method: 'PUT',
      headers: {
        'Content-Type': 'video/mp4',
        'Content-Length': String(fileSize)
      },
      body
    });

    if (res.status >= 500) {
      throw new ProviderNetworkError(`upload_server_error_${res.status}`);
    }
    if (!res.ok) {
      let errorBody = null;
      try {
        errorBody = await res.json();
      } catch {
        // ignore unparseable error body
      }
      throw new ProviderExplicitError(`upload_rejected_${res.status}`, { httpStatus: res.status, errorBody });
    }

    let json = null;
    try {
      json = await res.json();
    } catch {
      // A 2xx with an unparseable body is itself ambiguous -- handled
      // by _interpretUploadResult below via the null id check.
    }
    return json;
  }

  _interpretUploadResult(uploadResult, { sessionUrl }) {
    const videoId = uploadResult?.id;
    if (!videoId) {
      // A 2xx response with no video id is not evidence of confirmed
      // publication -- never fabricate an id or a URL.
      return {
        status: PUBLICATION_RESULT_STATUS.AMBIGUOUS,
        provider: this.id,
        reconciliationInfo: { phase: 'UPLOAD_BODY', sessionUrl, note: 'no_video_id_in_response' }
      };
    }
    return {
      status: PUBLICATION_RESULT_STATUS.SUCCESS,
      provider: this.id,
      providerItemId: videoId,
      providerUrl: `https://youtu.be/${videoId}`,
      // ADR-0030 §8: the provider-CONFIRMED visibility, exactly as YouTube
      // returned it (null when the response did not include one). The
      // provider-neutral core compares this to the requested visibility;
      // this adapter never relabels it and never issues any follow-up call
      // to change visibility.
      confirmedVisibility: uploadResult?.status?.privacyStatus ?? null,
      raw: { privacyStatus: uploadResult?.status?.privacyStatus ?? null }
    };
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
    // ProviderNetworkError (5xx), a thrown fetch/timeout error, or any
    // other unexpected failure while talking to the provider: we do not
    // know whether YouTube received/processed the request, so this is
    // ambiguous, never a blind failure or a blind success.
    return {
      status: PUBLICATION_RESULT_STATUS.AMBIGUOUS,
      provider: this.id,
      reconciliationInfo: { ...context, note: err?.message ?? 'network_error' }
    };
  }
}

function defaultCredentialsProvider() {
  return {
    clientId: process.env.YOUTUBE_CLIENT_ID,
    clientSecret: process.env.YOUTUBE_CLIENT_SECRET,
    refreshToken: process.env.YOUTUBE_REFRESH_TOKEN
  };
}

class ProviderExplicitError extends Error {
  constructor(message, details) {
    super(message);
    this.details = details;
  }
}

class ProviderNetworkError extends Error {}

export default YouTubeAdapter;