import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { AssetSourceProvider, ASSET_FAILURE_KIND, assetAcquisitionFailure } from './AssetSourceProvider.js';

// The engine derives visual queries of at most 100 characters
// (SCRIPT_FALLBACK_QUERY_MAX_LENGTH); Pexels documents no query-length limit,
// so this is the engine's own bound, not a measured Pexels limit.
export const PEXELS_MAX_QUERY_LENGTH = 100;

// Hard ceilings so a hostile or broken response cannot make one acquisition
// unbounded in time or memory. All are overridable for tests.
const DEFAULT_SEARCH_TIMEOUT_MS = 15_000;
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 60_000;
const MAX_DOWNLOAD_BYTES = 150 * 1024 * 1024;

// Hits examined per search. Pexels allows up to 80 per page; a small page is
// enough to find one well-formed candidate and keeps the response small.
const SEARCH_PER_PAGE = 5;

// The only hosts a download URL may point at. Pexels serves photos from
// images.pexels.com and video files from player.vimeo.com (documented example
// responses). A search response naming any other host is treated as malformed
// rather than fetched, so a tampered response cannot redirect the downloader.
const ALLOWED_DOWNLOAD_HOST_SUFFIXES = Object.freeze(['.pexels.com', '.vimeo.com']);

const PEXELS_PHOTO_SEARCH_URL = 'https://api.pexels.com/v1/search';
const PEXELS_VIDEO_SEARCH_URL = 'https://api.pexels.com/v1/videos/search';

const PEXELS_LICENSE_NAME = 'Pexels License';
const PEXELS_HOME_URL = 'https://www.pexels.com';

/** Collapses whitespace and bounds the query at a word boundary. Pure and deterministic. */
export function boundPexelsQuery(query) {
  const q = String(query).replace(/\s+/g, ' ').trim();
  if (q.length <= PEXELS_MAX_QUERY_LENGTH) return q;
  const head = q.slice(0, PEXELS_MAX_QUERY_LENGTH);
  if (q[PEXELS_MAX_QUERY_LENGTH] === ' ') return head.trim();
  const lastSpace = head.lastIndexOf(' ');
  return (lastSpace > 0 ? head.slice(0, lastSpace) : head).trim();
}

/**
 * Free text from the provider that is written into the `key=value; ...`
 * provenance_notes line. Rights Verification resolves a policy by searching
 * that line for `provider=<id>`, so a creator name containing `provider=...`
 * must not be able to impersonate another provider. Delimiters and control
 * characters are neutralised and the value is bounded.
 */
function noteSafe(value, max = 100) {
  return String(value ?? '').replace(/[;=\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

function isAllowedDownloadUrl(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:') return false;
  const host = u.hostname.toLowerCase();
  return ALLOWED_DOWNLOAD_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

function isPexelsPageUrl(raw) {
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' && (u.hostname === 'www.pexels.com' || u.hostname === 'pexels.com');
  } catch {
    return false;
  }
}

/** A header value fetch will accept: visible ASCII only. Anything else would throw inside fetch and be misread as a network fault. */
function isHeaderSafeKey(key) {
  return typeof key === 'string' && /^[\x21-\x7e]+$/.test(key);
}

/**
 * Concrete 'pexels' AssetSourceProvider. One job: acquire ONE real visual
 * asset (image or video_clip) from the official Pexels REST API and return it
 * in the shape AssetSourceProvider defines, using the same fetchImpl-injection
 * pattern as PixabayAssetSourceProvider so tests never need a key or network.
 *
 * Scope discipline (identical to the Pixabay provider): acquisition only. It
 * never writes to the assets / asset_usages tables; persistence stays with
 * Asset Provisioning. It is not selected by the runner by default.
 *
 * Terms this adapter is built against (Pexels API documentation and help
 * center, checked at implementation time; see the integration note in the
 * commit message for the exact pages):
 *   - Auth: the key is sent in a raw `Authorization` header (no scheme). It is
 *     never placed in a URL, never sent to a download host, and never put in
 *     a failure.
 *   - Endpoints: photos GET https://api.pexels.com/v1/search; videos
 *     GET https://api.pexels.com/v1/videos/search (the older /videos/ path is
 *     documented as to-be-deprecated).
 *   - Rate limit: default 200 requests/hour and 20,000/month; HTTP 429 when
 *     exceeded. This provider makes exactly one search request plus at most one
 *     download per acquireVisualAsset() call and has no internal retry loop;
 *     bounded retry across invocations is the existing A4 stage budget.
 *   - Attribution: the API guidelines ask for a prominent link to Pexels and
 *     photographer credit whenever possible. The license itself does not
 *     require credit, but this adapter sets attributionRequired: true and
 *     records the credit line and the Pexels links so the obligation is never
 *     silently dropped. (Surfacing it in published video metadata is a
 *     publication concern this adapter does not touch.)
 *   - License: the Pexels License (a small share of photos are CC0; the API
 *     does not say which, so the provider-level license is recorded and the
 *     CC0 case is not assumed). Not permitted by the license, and recorded in
 *     usageRestrictions: selling or distributing content as-is, implying
 *     endorsement by depicted people or brands, depicting identifiable people
 *     in an offensive or bad light, and redistributing on other stock or
 *     wallpaper platforms.
 *
 * VERIFICATION: like the Pixabay provider, this never sets VERIFIED. Every
 * asset is 'UNVERIFIED'. Whether it may enter production is decided only by
 * the Rights Verification stage and the existing production/media gates.
 */
export class PexelsAssetSourceProvider extends AssetSourceProvider {
  /**
   * @param {object} [opts]
   * @param {typeof fetch} [opts.fetchImpl]
   * @param {() => string|undefined} [opts.apiKeyProvider] - defaults to reading PEXELS_API_KEY from process.env.
   * @param {string} [opts.downloadDir]
   * @param {typeof fs} [opts.fsImpl]
   * @param {number} [opts.searchTimeoutMs]
   * @param {number} [opts.downloadTimeoutMs]
   */
  constructor({
    fetchImpl = fetch,
    apiKeyProvider = () => process.env.PEXELS_API_KEY,
    downloadDir = path.join(os.tmpdir(), 'ame-pexels-assets'),
    fsImpl = fs,
    searchTimeoutMs = DEFAULT_SEARCH_TIMEOUT_MS,
    downloadTimeoutMs = DEFAULT_DOWNLOAD_TIMEOUT_MS
  } = {}) {
    super();
    this._fetch = fetchImpl;
    this._apiKeyProvider = apiKeyProvider;
    this._downloadDir = downloadDir;
    this._fs = fsImpl;
    this._searchTimeoutMs = searchTimeoutMs;
    this._downloadTimeoutMs = downloadTimeoutMs;
  }

  get id() {
    return 'pexels';
  }

  /** True only when a usable-looking API key is configured. Never makes a network call. */
  async healthCheck() {
    const key = this._readKey();
    return key.state === 'ok';
  }

  _readKey() {
    const raw = this._apiKeyProvider();
    if (typeof raw !== 'string' || raw.trim() === '') return { state: 'missing', key: null };
    const key = raw.trim();
    if (!isHeaderSafeKey(key)) return { state: 'malformed', key: null, secret: raw };
    return { state: 'ok', key };
  }

  /**
   * Returns the acquired asset or a structured failure
   * ({ failure: { kind, provider, query, status, hitCount, retryable, cause } }),
   * never a bare null. EMPTY_RESULT means Pexels answered and has nothing;
   * every other kind means it could not answer or the answer was unusable.
   */
  async acquireVisualAsset({ query, assetTypes } = {}) {
    if (!query || typeof query !== 'string' || !query.trim()) {
      throw new Error('PexelsAssetSourceProvider.acquireVisualAsset requires a non-empty query');
    }

    const keyState = this._readKey();
    const secrets = [keyState.key, keyState.secret].filter(Boolean);
    const boundedQuery = boundPexelsQuery(query);
    const fail = (kind, extra = {}) =>
      assetAcquisitionFailure({ kind, provider: this.id, query: boundedQuery, secrets, ...extra });

    const requestedTypes =
      Array.isArray(assetTypes) && assetTypes.length > 0 ? assetTypes : ['image', 'video_clip'];
    const assetType = requestedTypes.find((t) => t === 'image' || t === 'video_clip');
    if (!assetType) {
      return fail(ASSET_FAILURE_KIND.UNSUPPORTED_ASSET_TYPE, { cause: `requested=${requestedTypes.join(',')}` });
    }

    if (keyState.state === 'missing') return fail(ASSET_FAILURE_KIND.MISSING_API_KEY);
    if (keyState.state === 'malformed') {
      // Sending it would make fetch throw, which would be misreported as a
      // network fault. Nothing is sent.
      return fail(ASSET_FAILURE_KIND.AUTH_FAILURE, { cause: 'api key is not a valid header value; nothing was sent' });
    }

    const searchUrl = this._buildSearchUrl(assetType, boundedQuery);

    let res;
    try {
      res = await this._fetch(searchUrl, {
        method: 'GET',
        headers: { Authorization: keyState.key },
        signal: AbortSignal.timeout(this._searchTimeoutMs)
      });
    } catch (err) {
      return fail(ASSET_FAILURE_KIND.NETWORK_FAILURE, { cause: `${err?.name ?? 'Error'}: ${err?.message ?? String(err)}` });
    }

    if (!res.ok) {
      const status = res.status;
      let kind;
      if (status === 401 || status === 403) kind = ASSET_FAILURE_KIND.AUTH_FAILURE;
      else if (status === 429) kind = ASSET_FAILURE_KIND.RATE_LIMIT;
      else if (status >= 500) kind = ASSET_FAILURE_KIND.PROVIDER_SERVER_FAILURE;
      else kind = ASSET_FAILURE_KIND.BAD_REQUEST;
      return fail(kind, { status, providerMessage: await this._readErrorBody(res) });
    }

    let data;
    try {
      data = await res.json();
    } catch {
      return fail(ASSET_FAILURE_KIND.MALFORMED_RESPONSE, { status: res.status, cause: 'response body is not valid JSON' });
    }

    const listKey = assetType === 'image' ? 'photos' : 'videos';
    if (!data || typeof data !== 'object' || !Array.isArray(data[listKey])) {
      return fail(ASSET_FAILURE_KIND.MALFORMED_RESPONSE, { status: res.status, cause: `response has no ${listKey} array` });
    }

    const hits = data[listKey];
    if (hits.length === 0) {
      return fail(ASSET_FAILURE_KIND.EMPTY_RESULT, { status: res.status, hitCount: 0 });
    }

    // First hit, in provider order, that carries every field the provenance
    // record and the download need. Nothing is invented for a hit that lacks
    // them.
    let candidate = null;
    for (const hit of hits) {
      candidate = assetType === 'image' ? this._selectImageCandidate(hit) : this._selectVideoCandidate(hit);
      if (candidate) break;
    }
    if (!candidate) {
      return fail(ASSET_FAILURE_KIND.MALFORMED_RESPONSE, {
        status: res.status,
        hitCount: hits.length,
        cause: 'no hit carried the required id, page url, creator and an allowed download url'
      });
    }

    const download = await this._downloadAsset(candidate.downloadUrl, assetType);
    if (download.failure) {
      return fail(ASSET_FAILURE_KIND.DOWNLOAD_FAILURE, {
        status: download.status ?? null,
        hitCount: hits.length,
        cause: download.failure
      });
    }

    const kindWord = assetType === 'image' ? 'Photo' : 'Video';
    return {
      assetType,
      location: download.location,
      checksum: download.checksum,
      origin: candidate.pageUrl,
      license: PEXELS_LICENSE_NAME,
      attributionRequired: true,
      attributionText:
        `${kindWord} by ${noteSafe(candidate.creator, 100)} on Pexels (${candidate.pageUrl}); ` +
        `${kindWord === 'Photo' ? 'Photos' : 'Videos'} provided by Pexels (${PEXELS_HOME_URL})`,
      usageRestrictions: PEXELS_USAGE_RESTRICTIONS,
      provenanceNotes: this._buildProvenanceNotes({ candidate, assetType }),
      verificationStatus: 'UNVERIFIED'
    };
  }

  async _readErrorBody(res) {
    try {
      if (typeof res.text === 'function') return String(await res.text()).slice(0, 200);
      if (typeof res.json === 'function') {
        const body = await res.json();
        return typeof body === 'string' ? body.slice(0, 200) : JSON.stringify(body).slice(0, 200);
      }
    } catch {
      // Diagnostic detail only.
    }
    return null;
  }

  _buildSearchUrl(assetType, query) {
    const params = new URLSearchParams({
      query,
      orientation: 'landscape',
      per_page: String(SEARCH_PER_PAGE)
    });
    const base = assetType === 'image' ? PEXELS_PHOTO_SEARCH_URL : PEXELS_VIDEO_SEARCH_URL;
    return `${base}?${params.toString()}`;
  }

  /**
   * Photo: needs integer id, a pexels.com page url, a creator name and an
   * allowed download url. Prefers large2x (about 1880 px wide, enough for a
   * 1280x720 frame with motion headroom), then large, then original, then
   * medium.
   */
  _selectImageCandidate(hit) {
    if (!hit || typeof hit !== 'object') return null;
    if (!Number.isInteger(hit.id) || hit.id <= 0) return null;
    if (typeof hit.url !== 'string' || !isPexelsPageUrl(hit.url)) return null;
    if (typeof hit.photographer !== 'string' || !hit.photographer.trim()) return null;
    const src = hit.src && typeof hit.src === 'object' ? hit.src : {};
    const downloadUrl = [src.large2x, src.large, src.original, src.medium]
      .find((u) => typeof u === 'string' && isAllowedDownloadUrl(u));
    if (!downloadUrl) return null;
    return {
      pexelsId: hit.id,
      pageUrl: hit.url,
      creator: hit.photographer.trim(),
      creatorUrl: typeof hit.photographer_url === 'string' && isPexelsPageUrl(hit.photographer_url) ? hit.photographer_url : null,
      downloadUrl
    };
  }

  /**
   * Video: only progressive video/mp4 files with real dimensions are
   * candidates (the HLS entry has null width/height and a playlist link).
   * Among them, the smallest file at least 1280 px wide and at most 1920 px
   * wide; failing that, the widest below 1280. Deterministic: ties break on
   * file id.
   */
  _selectVideoCandidate(hit) {
    if (!hit || typeof hit !== 'object') return null;
    if (!Number.isInteger(hit.id) || hit.id <= 0) return null;
    if (typeof hit.url !== 'string' || !isPexelsPageUrl(hit.url)) return null;
    const user = hit.user && typeof hit.user === 'object' ? hit.user : null;
    if (!user || typeof user.name !== 'string' || !user.name.trim()) return null;

    const files = (Array.isArray(hit.video_files) ? hit.video_files : []).filter(
      (f) =>
        f && typeof f === 'object' &&
        f.file_type === 'video/mp4' &&
        Number.isInteger(f.width) && f.width > 0 &&
        Number.isInteger(f.height) && f.height > 0 &&
        typeof f.link === 'string' && isAllowedDownloadUrl(f.link) &&
        !/\.m3u8(\?|$)/i.test(f.link)
    );
    if (files.length === 0) return null;

    const byWidthThenId = (a, b) => a.width - b.width || (a.id ?? 0) - (b.id ?? 0);
    const inRange = files.filter((f) => f.width >= 1280 && f.width <= 1920).sort(byWidthThenId);
    const below = files.filter((f) => f.width < 1280).sort((a, b) => b.width - a.width || (a.id ?? 0) - (b.id ?? 0));
    const chosen = inRange[0] ?? below[0] ?? null;
    if (!chosen) return null;

    return {
      pexelsId: hit.id,
      pageUrl: hit.url,
      creator: user.name.trim(),
      creatorUrl: typeof user.url === 'string' && isPexelsPageUrl(user.url) ? user.url : null,
      downloadUrl: chosen.link
    };
  }

  /** Returns { location, checksum } or { failure: '<reason>', status? } -- never null. The API key is never sent here. */
  async _downloadAsset(url, assetType) {
    let res;
    try {
      res = await this._fetch(url, { method: 'GET', signal: AbortSignal.timeout(this._downloadTimeoutMs) });
    } catch (err) {
      return { failure: `download request failed: ${err?.name ?? 'Error'}: ${err?.message ?? String(err)}` };
    }
    if (!res.ok) {
      return { failure: `download returned HTTP ${res.status}`, status: res.status };
    }

    let buffer;
    try {
      buffer = Buffer.from(await res.arrayBuffer());
    } catch {
      return { failure: 'download body could not be read', status: res.status };
    }
    if (!buffer || buffer.length === 0) {
      return { failure: 'downloaded body was empty', status: res.status };
    }
    if (buffer.length > MAX_DOWNLOAD_BYTES) {
      return { failure: 'downloaded body exceeds the size ceiling', status: res.status };
    }

    const ext = assetType === 'video_clip' ? 'mp4' : this._imageExtension(url);
    const filePath = path.join(this._downloadDir, `pexels-${crypto.randomUUID()}.${ext}`);

    try {
      this._fs.mkdirSync(this._downloadDir, { recursive: true });
      this._fs.writeFileSync(filePath, buffer);
    } catch {
      this._safeCleanup(filePath);
      return { failure: 'downloaded asset could not be written to disk' };
    }

    let stat;
    try {
      stat = this._fs.statSync(filePath);
    } catch {
      this._safeCleanup(filePath);
      return { failure: 'downloaded asset could not be stat-ed after write' };
    }
    if (!stat || stat.size === 0) {
      this._safeCleanup(filePath);
      return { failure: 'downloaded asset is empty on disk' };
    }

    return { location: filePath, checksum: crypto.createHash('sha256').update(buffer).digest('hex') };
  }

  _imageExtension(url) {
    try {
      const ext = path.extname(new URL(url).pathname).toLowerCase().replace('.', '');
      return ['jpg', 'jpeg', 'png', 'webp'].includes(ext) ? ext : 'jpg';
    } catch {
      return 'jpg';
    }
  }

  _safeCleanup(filePath) {
    try {
      this._fs.rmSync(filePath, { force: true });
    } catch {
      // Best effort only.
    }
  }

  _buildProvenanceNotes({ candidate, assetType }) {
    const parts = [
      'provider=pexels',
      `pexelsId=${candidate.pexelsId}`,
      `assetType=${assetType}`,
      `sourceUrl=${candidate.pageUrl}`,
      `creator=${noteSafe(candidate.creator)}`
    ];
    if (candidate.creatorUrl) parts.push(`creatorUrl=${candidate.creatorUrl}`);
    parts.push(`license=${PEXELS_LICENSE_NAME}`);
    parts.push('licenseScope=provider-level; API response carries no per-asset license field');
    parts.push(`attributionLink=${PEXELS_HOME_URL}`);
    return parts.join('; ');
  }
}

const PEXELS_USAGE_RESTRICTIONS =
  'Free for commercial and non-commercial use under the Pexels License; credit is not required by the ' +
  'license, but the Pexels API guidelines ask for photographer credit and a prominent link to Pexels. ' +
  'May NOT be sold or distributed as-is (standalone, without meaningful creative effort), redistributed ' +
  'or sold on other stock photo or wallpaper platforms, or used to imply endorsement by depicted people ' +
  'or brands; identifiable people may not be shown in a bad light or an offensive way. Must not be used ' +
  'to build a competing service or to train or evaluate ML models without Pexels permission. ' +
  'The asset has been downloaded locally; Pexels download URLs are not stored as the asset location.';

export default PexelsAssetSourceProvider;
