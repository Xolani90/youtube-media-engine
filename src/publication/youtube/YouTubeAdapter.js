import fs from 'node:fs';
import { PublicationProvider } from '../PublicationProvider.js';
import { PUBLICATION_RESULT_STATUS } from '../constants.js';

// The only privacyStatus values this adapter will ever send (YouTube Data
// API v3 status.privacyStatus). Anything else fails closed before any
// network call (ADR-0030 open item 3).
const SUPPORTED_PRIVACY_STATUSES = Object.freeze(['private', 'unlisted', 'public']);

const RESUMABLE_CHUNK_SIZE = 256 * 1024;
const RESUMABLE_MAX_ATTEMPTS = 3;
const RESUMABLE_TRANSIENT_STATUSES = new Set([500, 502, 503, 504]);
// A resumable session that expires mid-upload (reconciliation sees 404/410)
// is restarted on a fresh session at most this many times per publish().
const RESUMABLE_MAX_SESSION_RESTARTS = 1;

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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
    defaultPrivacyStatus = 'private',
    sleep = defaultSleep
  } = {}) {
    super();
    this._fetch = fetchImpl;
    this._credentialsProvider = credentialsProvider;
    this._defaultPrivacyStatus = defaultPrivacyStatus;
    this._sleep = sleep;
  }

  get id() {
    return 'youtube';
  }

  async publish(request, context = {}) {
    // ADR-0030: resolve and validate the visibility to be requested BEFORE
    // any network activity (including the OAuth token refresh).
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

    const providerState = context?.providerState ?? null;

    const saveProviderState =
      typeof context?.saveProviderState === 'function'
        ? context.saveProviderState
        : () => {};

    let sessionUrl = providerState?.sessionUrl ?? null;
    let uploadOffset = 0;

    try {
      // Recover a persisted resumable session by querying YouTube for the
      // bytes it has already committed before sending any further bytes.
      if (sessionUrl) {
        // Same reconciliation semantics as a mid-upload status query: a
        // rejection (400/401/403/...) of THIS request proves nothing about
        // media a crashed attempt may already have sent, so it is AMBIGUOUS
        // with the persisted session retained -- never a reclaimable failure
        // and never a fresh session. 404/410 stays `expired`, 200/201 stays
        // `completed`.
        const status = await this._reconcileMediaUpload({
          accessToken,
          sessionUrl,
          fileSize: fileStat.size
        });

        if (status.completed) {
          return this._interpretUploadResult(status.json, { sessionUrl });
        }

        if (status.expired) {
          sessionUrl = null;
          uploadOffset = 0;
        } else {
          uploadOffset = status.offset;
        }
      }

      let uploadResult;

      for (let restarts = 0; ; restarts += 1) {
        // Persist the new session URL BEFORE the first media byte is sent.
        if (!sessionUrl) {
          try {
            sessionUrl = await this._initiateResumableUpload({
              accessToken,
              metadata,
              contentLength: fileStat.size
            });
          } catch (err) {
            throw withUploadPhase(err, 'INITIATE_SESSION');
          }

          if (!sessionUrl) {
            return {
              status: PUBLICATION_RESULT_STATUS.AMBIGUOUS,
              provider: this.id,
              reconciliationInfo: {
                phase: 'INITIATE_SESSION',
                note: 'no_session_url_returned'
              }
            };
          }

          await saveProviderState({ sessionUrl });
          uploadOffset = 0;
        }

        try {
          uploadResult = await this._uploadResumable({
            accessToken,
            sessionUrl,
            filePath: request.mediaFilePath,
            fileSize: fileStat.size,
            startOffset: uploadOffset,
            saveProviderState
          });
          break;
        } catch (err) {
          // The session expired mid-upload (seen while reconciling a
          // transient media failure). _uploadResumable already cleared the
          // persisted session; restart once on a fresh session, bounded.
          if (
            err instanceof UploadSessionExpiredError &&
            restarts < RESUMABLE_MAX_SESSION_RESTARTS
          ) {
            sessionUrl = null;
            uploadOffset = 0;
            continue;
          }

          throw err;
        }
      }

      return this._interpretUploadResult(uploadResult, { sessionUrl });
    } catch (err) {
      return this._classifyNetworkError(err, {
        phase: err?.phase ?? 'RESUMABLE_UPLOAD',
        ...(sessionUrl ? { sessionUrl } : {})
      });
    }
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
    const res = await this._fetchWithTransientRetry(
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
      },
      'INITIATE_SESSION'
    );

    if (res.status >= 500) {
      throw new ProviderNetworkError(`initiate_upload_server_error_${res.status}`);
    }

    if (!res.ok) {
      let errorBody = null;

      try {
        errorBody = await res.json();
      } catch {
        // Ignore unparseable error body.
      }

      throw new ProviderExplicitError(
        `initiate_upload_rejected_${res.status}`,
        {
          httpStatus: res.status,
          errorBody
        }
      );
    }

    return res.headers.get('location');
  }

  async _queryUploadStatus({ accessToken, sessionUrl, fileSize }) {
    // _fetchWithTransientRetry only ever throws ProviderNetworkError or a raw
    // fetch failure (never ProviderExplicitError), so 404/410 are handled
    // below as response statuses.
    const res = await this._fetchWithTransientRetry(
      sessionUrl,
      {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Length': '0',
          'Content-Range': `bytes */${fileSize}`
        }
      },
      'UPLOAD_STATUS'
    );

    if (res.status === 200 || res.status === 201) {
      let json = null;

      try {
        json = await res.json();
      } catch {
        // _interpretUploadResult handles a missing video id.
      }

      return {
        expired: false,
        completed: true,
        offset: fileSize,
        json
      };
    }

    if (res.status === 308) {
      return {
        expired: false,
        completed: false,
        offset: parseUploadOffset(res.headers.get('range'))
      };
    }

    if (res.status === 404 || res.status === 410) {
      return {
        expired: true,
        completed: false,
        offset: 0
      };
    }

    if (res.status >= 500) {
      throw new ProviderNetworkError(`upload_status_server_error_${res.status}`);
    }

    let errorBody = null;

    try {
      errorBody = await res.json();
    } catch {
      // Ignore.
    }

    throw new ProviderExplicitError(
      `upload_status_rejected_${res.status}`,
      {
        httpStatus: res.status,
        errorBody
      }
    );
  }

  async _uploadResumable({
    accessToken,
    sessionUrl,
    filePath,
    fileSize,
    startOffset,
    saveProviderState
  }) {
    let offset = startOffset;
    // Media PUT attempts made for the chunk starting at the current offset.
    // Bounded by RESUMABLE_MAX_ATTEMPTS; reset only when the server-reported
    // offset advances beyond prior progress (see furthestOffset below).
    let attemptsAtOffset = 0;
    // High-water mark of server-confirmed progress. The per-chunk attempt
    // budget resets ONLY when the server reports an offset beyond it, so a
    // server that regresses/oscillates can never restart the budget forever.
    let furthestOffset = startOffset;

    while (offset < fileSize) {
      const endOffset =
        Math.min(offset + RESUMABLE_CHUNK_SIZE, fileSize) - 1;

      const chunkLength = endOffset - offset + 1;
      const buffer = Buffer.allocUnsafe(chunkLength);

      const fd = fs.openSync(filePath, 'r');

      try {
        let bytesRead = 0;

        while (bytesRead < chunkLength) {
          const read = fs.readSync(
            fd,
            buffer,
            bytesRead,
            chunkLength - bytesRead,
            offset + bytesRead
          );

          if (read === 0) {
            throw new Error('unexpected_end_of_media_file');
          }

          bytesRead += read;
        }
      } finally {
        fs.closeSync(fd);
      }

      let res;
      attemptsAtOffset += 1;

      try {
        // Single attempt: a transient 5xx on a media chunk must NOT be
        // blindly resent -- the chunk may already have reached YouTube.
        // It is reconciled against the server-reported offset below.
        res = await this._fetch(sessionUrl, {
          method: 'PUT',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'video/mp4',
            'Content-Length': String(chunkLength),
            'Content-Range': `bytes ${offset}-${endOffset}/${fileSize}`
          },
          body: buffer
        });
      } catch (err) {
        // A raw fetch failure never carries an explicit provider verdict; the
        // request may have reached YouTube, so it stays ambiguous.
        throw withUploadPhase(err);
      }

      if (RESUMABLE_TRANSIENT_STATUSES.has(res.status)) {
        if (attemptsAtOffset >= RESUMABLE_MAX_ATTEMPTS) {
          throw uploadPhaseError(`upload_body_server_error_${res.status}`);
        }

        const retryAfter = parseRetryAfter(res.headers.get('retry-after'));

        await this._sleep(retryAfter ?? attemptsAtOffset * 1000);

        const status = await this._reconcileMediaUpload({
          accessToken,
          sessionUrl,
          fileSize
        });

        if (status.completed) {
          return status.json;
        }

        if (status.expired) {
          await saveProviderState(null);
          throw new UploadSessionExpiredError('upload_session_expired', {});
        }

        // Continue from the server's offset, not from ours. The attempt
        // budget resets only if the server advanced past prior progress.
        offset = status.offset;
        if (offset > furthestOffset) {
          furthestOffset = offset;
          attemptsAtOffset = 0;
        }

        // Same offset: the chunk was not committed; the loop retries it
        // within the bounded per-chunk attempt budget.
        continue;
      }

      if (res.status === 308) {
        offset = parseUploadOffset(res.headers.get('range'));

        if (offset > furthestOffset) {
          furthestOffset = offset;
          attemptsAtOffset = 0;
        } else if (attemptsAtOffset >= RESUMABLE_MAX_ATTEMPTS) {
          // Zero-progress 308s: bounded by the same per-chunk budget.
          throw uploadPhaseError('upload_body_no_progress_308');
        }

        continue;
      }

      if (res.status === 200 || res.status === 201) {
        let json = null;

        try {
          json = await res.json();
        } catch {
          // _interpretUploadResult handles missing video ids.
        }

        return json;
      }

      if (res.status >= 500) {
        // Any other 5xx proves nothing about whether the chunk committed.
        throw uploadPhaseError(`upload_body_server_error_${res.status}`);
      }

      let errorBody = null;

      try {
        errorBody = await res.json();
      } catch {
        // Ignore.
      }

      throw new ProviderExplicitError(
        `upload_rejected_${res.status}`,
        {
          httpStatus: res.status,
          errorBody
        }
      );
    }

    const status = await this._reconcileMediaUpload({
      accessToken,
      sessionUrl,
      fileSize
    });

    return status.completed ? status.json : null;
  }

  /**
   * Zero-byte resumable status PUT after a transient media failure. An
   * explicit rejection of THIS request (400/401/403/...) proves nothing
   * about the media upload -- the preceding chunk may already have reached
   * YouTube -- so it is AMBIGUOUS (session retained), never a reclaimable
   * EXPLICIT_FAILURE. 404/410 is reported as `expired`, not thrown.
   */
  async _reconcileMediaUpload({ accessToken, sessionUrl, fileSize }) {
    try {
      return await this._queryUploadStatus({ accessToken, sessionUrl, fileSize });
    } catch (err) {
      if (err instanceof ProviderExplicitError) {
        throw uploadPhaseError(
          `upload_reconciliation_rejected_${err.details?.httpStatus ?? 'unknown'}`
        );
      }

      throw withUploadPhase(err);
    }
  }

  async _fetchWithTransientRetry(url, options, phase) {
    let lastError = null;

    for (
      let attempt = 1;
      attempt <= RESUMABLE_MAX_ATTEMPTS;
      attempt += 1
    ) {
      try {
        const res = await this._fetch(url, options);

        if (!RESUMABLE_TRANSIENT_STATUSES.has(res.status)) {
          return res;
        }

        if (attempt === RESUMABLE_MAX_ATTEMPTS) {
          throw new ProviderNetworkError(
            `${phase.toLowerCase()}_server_error_${res.status}`
          );
        }

        const retryAfter = parseRetryAfter(
          res.headers.get('retry-after')
        );

        await this._sleep(retryAfter ?? attempt * 1000);
      } catch (err) {
        lastError = err;

        if (err instanceof ProviderNetworkError) {
          if (attempt === RESUMABLE_MAX_ATTEMPTS) {
            throw err;
          }

          await this._sleep(attempt * 1000);
          continue;
        }

        // A thrown network error can mean the request reached YouTube.
        // Do not blindly retry it.
        throw err;
      }
    }

    throw (
      lastError ??
      new ProviderNetworkError(`${phase.toLowerCase()}_failed`)
    );
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

function parseUploadOffset(rangeHeader) {
  if (!rangeHeader) {
    return 0;
  }

  const match = /^bytes=\d+-(\d+)$/.exec(rangeHeader.trim());

  if (!match) {
    throw new ProviderNetworkError('invalid_upload_range_header');
  }

  return Number(match[1]) + 1;
}

function parseRetryAfter(value) {
  if (!value) {
    return null;
  }

  const seconds = Number(value);

  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1000;
  }

  const timestamp = Date.parse(value);

  if (!Number.isNaN(timestamp)) {
    return Math.max(0, timestamp - Date.now());
  }

  return null;
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

// The resumable session no longer exists (404/410 while reconciling).
// Extends ProviderExplicitError so that, if the bounded fresh-session
// restart is exhausted, it surfaces as a reclaimable EXPLICIT_FAILURE.
class UploadSessionExpiredError extends ProviderExplicitError {}

// Labels an ambiguous (non-explicit) media-upload error so that
// _classifyNetworkError reports reconciliationInfo.phase = 'UPLOAD_BODY'.
function withUploadPhase(err, phase = 'UPLOAD_BODY') {
  if (err && typeof err === 'object' && !(err instanceof ProviderExplicitError) && !err.phase) {
    err.phase = phase;
  }

  return err;
}

function uploadPhaseError(message) {
  return withUploadPhase(new ProviderNetworkError(message));
}

export default YouTubeAdapter;