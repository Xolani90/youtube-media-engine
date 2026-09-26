import fs from 'node:fs';
import { PublicationProvider } from '../PublicationProvider.js';
import { PUBLICATION_RESULT_STATUS } from '../constants.js';

// The only video_state values this adapter will ever send (Graph API
// video_reels `video_state`). Anything else fails closed before any
// network call, same discipline as the other adapters' visibility
// allowlists.
const SUPPORTED_VIDEO_STATES = Object.freeze(['DRAFT', 'PUBLISHED']);

const GRAPH_API_VERSION = 'v21.0';

/**
 * Facebook Reels (Graph API) adapter — publishes an already-rendered
 * short-form artifact as a Reel on a Facebook Page. Every Facebook-
 * specific concept (endpoints, three-phase upload protocol, access
 * token, video_state/description field mapping, processing-status
 * polling) lives in this file only — the publication core
 * (../pipeline.js) never imports anything from this module except the
 * class itself.
 *
 * Verified against the current Meta for Developers Reels Publishing API
 * documentation (developers.facebook.com/docs/video-api/guides/reels-
 * publishing) at implementation time -- a three-phase flow, all against
 * POST https://graph.facebook.com/{version}/{page_id}/video_reels:
 *   1. upload_phase=start -> returns { video_id, upload_url }.
 *   2. The file bytes are POSTed to the returned upload_url (rupload
 *      host) with an `Authorization: OAuth {page_access_token}` header
 *      and `file_url`/offset semantics per Meta's resumable upload
 *      protocol; this engine's artifacts are always sent as a single,
 *      whole-file transfer (no resume/offset loop -- nothing this
 *      engine produces is large enough to require chunking).
 *   3. upload_phase=finish with video_id + video_state=PUBLISHED (plus
 *      description/title) -> `{"success": true}` confirms the publish
 *      request itself was accepted. The video_id returned at step 1 is
 *      the Page-scoped identifier Meta itself assigned to this upload
 *      session; it is never invented by this adapter.
 *   Video processing/moderation (encoding, thumbnail generation) is
 *   asynchronous even after a successful `finish` call — status is
 *   checked via GET /{video_id}?fields=status, with video_status values
 *   including 'processing', 'ready', 'error', 'upload_failed'.
 *
 * ASYNC PUBLISH DISCIPLINE: mirrors TikTokAdapter's bounded-poll
 * approach. A successful `finish` response confirms the publish request
 * was accepted with a real, provider-assigned video_id, so this adapter
 * treats that as SUCCESS immediately (unlike TikTok, Facebook's `finish`
 * step itself is the confirmed publish action, not merely an upload
 * acknowledgement) -- but it first does ONE bounded status check to
 * catch an immediate/fast processing failure before reporting SUCCESS,
 * since `finish` returning `{"success": true}` does not itself
 * guarantee the video ultimately reaches 'ready'. If that check shows
 * 'error' or 'upload_failed', this is reported as EXPLICIT_FAILURE
 * (Meta returned a definite failure for a real, identified upload). If
 * the check cannot be completed or still shows 'processing', this is
 * reported as SUCCESS -- `finish` already confirmed acceptance with a
 * real id, and 'processing' is Meta's normal, expected steady state for
 * a freshly-published Reel, not evidence of failure. This deliberately
 * differs from TikTok's "still processing => AMBIGUOUS": TikTok's
 * PUBLISH_COMPLETE (the actual public post id) only arrives later, so
 * "still processing" there really does mean "not yet confirmed
 * published"; here, `finish` succeeding IS the provider's confirmation
 * that publication happened.
 *
 * CREDENTIALS: mirrors YouTubeAdapter/TikTokAdapter -- a long-lived Page
 * access token is expected to already exist in runtime configuration
 * (Meta Page access tokens are typically long-lived/non-expiring once
 * issued via a server-side token exchange, so no refresh-token dance is
 * performed here, unlike the OAuth-refresh adapters). No secret is ever
 * logged.
 */
export class FacebookReelsAdapter extends PublicationProvider {
  /**
   * @param {object} [opts]
   * @param {typeof fetch} [opts.fetchImpl] - injectable for tests; defaults to global fetch.
   * @param {() => {pageId: string, pageAccessToken: string}} [opts.credentialsProvider]
   *   Defaults to reading FACEBOOK_PAGE_ID / FACEBOOK_PAGE_ACCESS_TOKEN
   *   from process.env.
   * @param {string} [opts.defaultVideoState] - one of SUPPORTED_VIDEO_STATES; defaults to 'DRAFT' (the safe default).
   */
  constructor({
    fetchImpl = fetch,
    credentialsProvider = defaultCredentialsProvider,
    defaultVideoState = 'DRAFT'
  } = {}) {
    super();
    this._fetch = fetchImpl;
    this._credentialsProvider = credentialsProvider;
    this._defaultVideoState = defaultVideoState;
  }

  get id() {
    return 'facebook_reels';
  }

  async publish(request) {
    // ADR-0030-equivalent visibility discipline (mirrors the other
    // adapters): a requested visibility of 'public' maps to Facebook's
    // PUBLISHED state; anything else the pipeline could pass is
    // rejected before any network call. `null`/absent means the
    // adapter default (DRAFT, the safe default) applies.
    const videoState = mapRequestedVisibilityToVideoState(request.requestedVisibility, this._defaultVideoState);
    if (!videoState) {
      return {
        status: PUBLICATION_RESULT_STATUS.EXPLICIT_FAILURE,
        provider: this.id,
        errorClass: 'INVALID_VISIBILITY',
        retryable: false
      };
    }

    const { pageId, pageAccessToken } = this._credentialsProvider();
    if (!pageId || !pageAccessToken) {
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

    let videoId, uploadUrl;
    try {
      ({ videoId, uploadUrl } = await this._startUploadSession({ pageId, pageAccessToken }));
    } catch (err) {
      return this._classifyNetworkError(err, { phase: 'START' });
    }
    if (!videoId || !uploadUrl) {
      return {
        status: PUBLICATION_RESULT_STATUS.AMBIGUOUS,
        provider: this.id,
        reconciliationInfo: { phase: 'START', note: 'no_video_id_or_upload_url_returned' }
      };
    }

    try {
      await this._uploadFile({ uploadUrl, pageAccessToken, filePath: request.mediaFilePath });
    } catch (err) {
      return this._classifyNetworkError(err, { phase: 'UPLOAD_BODY', videoId });
    }

    let finishResult;
    try {
      finishResult = await this._finishUpload({ pageId, pageAccessToken, videoId, videoState, request });
    } catch (err) {
      return this._classifyNetworkError(err, { phase: 'FINISH', videoId });
    }
    if (!finishResult?.success) {
      // A 2xx with no confirmed `success: true` is not evidence the
      // publish itself completed -- never fabricate success.
      return {
        status: PUBLICATION_RESULT_STATUS.AMBIGUOUS,
        provider: this.id,
        reconciliationInfo: { phase: 'FINISH', videoId, note: 'finish_did_not_confirm_success' }
      };
    }

    // Bounded, single status check to catch an immediate failure --
    // never blocks on 'processing' reaching 'ready' (see class
    // docstring for why 'processing' here is still reported as SUCCESS).
    let statusData = null;
    try {
      statusData = await this._fetchStatus({ videoId, pageAccessToken });
    } catch {
      // Status check itself failing does not undo a confirmed `finish`
      // success -- proceed to report SUCCESS below.
    }
    if (statusData?.video_status === 'error' || statusData?.video_status === 'upload_failed') {
      return {
        status: PUBLICATION_RESULT_STATUS.EXPLICIT_FAILURE,
        provider: this.id,
        errorClass: `reel_processing_${statusData.video_status}`,
        retryable: false,
        raw: statusData
      };
    }

    return {
      status: PUBLICATION_RESULT_STATUS.SUCCESS,
      provider: this.id,
      providerItemId: videoId,
      providerUrl: `https://www.facebook.com/reel/${videoId}`,
      confirmedVisibility: videoState === 'PUBLISHED' ? 'public' : 'private',
      raw: statusData ?? { finish: finishResult }
    };
  }

  // --- Internal helpers (all Facebook-specific; never referenced outside this file) ---

  async _startUploadSession({ pageId, pageAccessToken }) {
    const res = await this._fetch(
      `https://graph.facebook.com/${GRAPH_API_VERSION}/${encodeURIComponent(pageId)}/video_reels`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ upload_phase: 'start', access_token: pageAccessToken }).toString()
      }
    );
    if (res.status >= 500) {
      throw new ProviderNetworkError(`start_server_error_${res.status}`);
    }
    if (!res.ok) {
      const errorBody = await this._safeJson(res);
      throw new ProviderExplicitError(`start_rejected_${res.status}`, { httpStatus: res.status, errorBody });
    }
    const body = await res.json();
    return { videoId: body?.video_id ?? null, uploadUrl: body?.upload_url ?? null };
  }

  async _uploadFile({ uploadUrl, pageAccessToken, filePath }) {
    const body = fs.readFileSync(filePath);
    const res = await this._fetch(uploadUrl, {
      method: 'POST',
      headers: {
        Authorization: `OAuth ${pageAccessToken}`,
        'Content-Type': 'application/octet-stream',
        file_size: String(body.length),
        offset: '0'
      },
      body
    });
    if (res.status >= 500) {
      throw new ProviderNetworkError(`upload_server_error_${res.status}`);
    }
    if (!res.ok) {
      const errorBody = await this._safeJson(res);
      throw new ProviderExplicitError(`upload_rejected_${res.status}`, { httpStatus: res.status, errorBody });
    }
  }

  async _finishUpload({ pageId, pageAccessToken, videoId, videoState, request }) {
    const res = await this._fetch(
      `https://graph.facebook.com/${GRAPH_API_VERSION}/${encodeURIComponent(pageId)}/video_reels`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          upload_phase: 'finish',
          video_id: videoId,
          video_state: videoState,
          description: request.description ?? '',
          access_token: pageAccessToken
        }).toString()
      }
    );
    if (res.status >= 500) {
      throw new ProviderNetworkError(`finish_server_error_${res.status}`);
    }
    if (!res.ok) {
      const errorBody = await this._safeJson(res);
      throw new ProviderExplicitError(`finish_rejected_${res.status}`, { httpStatus: res.status, errorBody });
    }
    return res.json();
  }

  async _fetchStatus({ videoId, pageAccessToken }) {
    const res = await this._fetch(
      `https://graph.facebook.com/${GRAPH_API_VERSION}/${encodeURIComponent(videoId)}?fields=status&access_token=${encodeURIComponent(pageAccessToken)}`,
      { method: 'GET' }
    );
    if (!res.ok) {
      throw new Error(`status_fetch_failed_${res.status}`);
    }
    const body = await res.json();
    return { video_status: body?.status?.video_status ?? null, raw: body?.status ?? null };
  }

  async _safeJson(res) {
    try {
      return await res.json();
    } catch {
      return null;
    }
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

/** null (visibility rejected before any network call) | 'DRAFT' | 'PUBLISHED'. Only 'public' and null/absent are recognized requested visibilities -- anything else is invalid input, never guessed at. */
function mapRequestedVisibilityToVideoState(requestedVisibility, defaultVideoState) {
  if (requestedVisibility == null) {
    return SUPPORTED_VIDEO_STATES.includes(defaultVideoState) ? defaultVideoState : null;
  }
  if (requestedVisibility === 'public') {
    return 'PUBLISHED';
  }
  return null;
}

function defaultCredentialsProvider() {
  return {
    pageId: process.env.FACEBOOK_PAGE_ID,
    pageAccessToken: process.env.FACEBOOK_PAGE_ACCESS_TOKEN
  };
}

class ProviderExplicitError extends Error {
  constructor(message, details) {
    super(message);
    this.details = details;
  }
}

class ProviderNetworkError extends Error {}

export default FacebookReelsAdapter;