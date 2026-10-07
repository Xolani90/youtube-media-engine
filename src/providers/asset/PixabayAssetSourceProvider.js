import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { AssetSourceProvider, ASSET_FAILURE_KIND, assetAcquisitionFailure } from './AssetSourceProvider.js';

// Pixabay rejects a search term longer than 100 characters with HTTP 400
// (measured live: 100 chars -> 200, 101 chars -> 400). The provider returns
// null on any non-OK response, so an over-long query would otherwise surface
// only as a silent "no asset" (it is now reported as a BAD_REQUEST failure).
export const PIXABAY_MAX_QUERY_LENGTH = 100;

/**
 * Collapses whitespace and bounds the query to PIXABAY_MAX_QUERY_LENGTH,
 * cutting at the last word boundary that fits (hard cut only when a single
 * token exceeds the limit). Pure and deterministic.
 */
export function boundPixabayQuery(query) {
  const q = query.replace(/\s+/g, ' ').trim();
  if (q.length <= PIXABAY_MAX_QUERY_LENGTH) return q;
  const head = q.slice(0, PIXABAY_MAX_QUERY_LENGTH);
  if (q[PIXABAY_MAX_QUERY_LENGTH] === ' ') return head.trim();
  const lastSpace = head.lastIndexOf(' ');
  return (lastSpace > 0 ? head.slice(0, lastSpace) : head).trim();
}

/**
 * Concrete 'pixabay' AssetSourceProvider (Milestone C). One provider,
 * one job: acquire ONE real visual asset (image or video_clip) from the
 * Pixabay REST API and return it in the shape AssetSourceProvider
 * defines, mirroring the fetchImpl-injection pattern already used by
 * GeminiProvider (src/providers/llm/GeminiProvider.js) and YouTubeAdapter
 * (src/publication/youtube/YouTubeAdapter.js) so tests never need a
 * real key or the network.
 *
 * Scope discipline: this class does asset ACQUISITION only. It never
 * calls AssetProvenanceRepository.recordAsset()/recordUsage() itself --
 * persistence is a later provisioning stage's job (see
 * AssetSourceProvider's own docstring). It is not wired into the
 * runner, Media Production, or Quality Gate.
 *
 * Verified against Pixabay's current primary documentation at
 * implementation time (pixabay.com/api/docs/ and the Content License
 * summary/full text, pixabay.com/service/license-summary/ and
 * pixabay.com/service/license/):
 *   - Search endpoints: GET https://pixabay.com/api/ (images) and
 *     GET https://pixabay.com/api/videos/ (video). Both require `key`.
 *   - Rate limit: 100 requests / 60s per key, enforced by Pixabay
 *     (X-RateLimit-* response headers; HTTP 429 "API rate limit
 *     exceeded" once exceeded). Results must be cached 24h by the
 *     consumer; systematic mass downloads are explicitly disallowed.
 *     This provider makes exactly one search request per
 *     acquireVisualAsset() call, performs no internal retry loop, and
 *     is a single-content acquisition provider, not a bulk downloader
 *     -- caching/dedup across calls is left to the (not-yet-built)
 *     provisioning stage, per this milestone's boundary.
 *   - Hotlinking: permanent hotlinking of Pixabay image/video URLs is
 *     not allowed; content intended for use must be downloaded to the
 *     consumer's own server. This provider always downloads the asset
 *     to a local file and returns that local path as `location` --
 *     never a Pixabay URL.
 *   - Full-resolution fields (fullHDURL/imageURL/vectorURL) are only
 *     present for accounts approved for "full API access"; this
 *     provider does not assume that approval and instead prefers
 *     largeImageURL (uncapped by that approval, standard on every
 *     account) for images, and videos.medium (falling back down
 *     through small/tiny, then up to large) for video, so acquisition
 *     works on a plain, unapproved API key.
 *   - License: the current Pixabay Content License is a single,
 *     royalty-free license for commercial and non-commercial use;
 *     attribution is NOT required (merely appreciated), but resale or
 *     distribution of Content "as is" on a standalone basis is
 *     prohibited, as is depicting identifiable people in specific
 *     prohibited ways. This provider records that current license text
 *     verbatim in `usageRestrictions`/`provenanceNotes` rather than
 *     assuming any older CC0-era Pixabay licensing history, and sets
 *     `attributionRequired: false` to match the current terms -- but
 *     see VERIFICATION below.
 *
 * VERIFICATION: per this milestone's explicit instruction, this
 * provider NEVER sets verificationStatus to VERIFIED. There is no
 * established AME policy yet confirming that "Pixabay's stated license
 * terms, read programmatically off their docs" is sufficient for an
 * asset to be marked VERIFIED across this system. Every asset this
 * provider returns is `verificationStatus: 'UNVERIFIED'`, with the
 * license information it found preserved in the other provenance
 * fields for a human or a later, explicitly authorized policy to act
 * on.
 */
export class PixabayAssetSourceProvider extends AssetSourceProvider {
  /**
   * @param {object} [opts]
   * @param {typeof fetch} [opts.fetchImpl] - injectable for tests; defaults to global fetch. Used for both the search request and the asset download.
   * @param {() => string|undefined} [opts.apiKeyProvider] - defaults to reading PIXABAY_API_KEY from process.env.
   * @param {string} [opts.downloadDir] - local directory downloaded assets are written to. Defaults to a subdirectory of os.tmpdir().
   * @param {typeof fs} [opts.fsImpl] - injectable filesystem module for tests; defaults to node:fs.
   */
  constructor({
    fetchImpl = fetch,
    apiKeyProvider = () => process.env.PIXABAY_API_KEY,
    downloadDir = path.join(os.tmpdir(), 'ame-pixabay-assets'),
    fsImpl = fs
  } = {}) {
    super();
    this._fetch = fetchImpl;
    this._apiKeyProvider = apiKeyProvider;
    this._downloadDir = downloadDir;
    this._fs = fsImpl;
  }

  get id() {
    return 'pixabay';
  }

  /** True only when an API key is configured. Never makes a network call. */
  async healthCheck() {
    return Boolean(this._apiKeyProvider());
  }

  /**
   * Returns the acquired asset, or a structured failure
   * ({ failure: { kind, provider, query, status, hitCount, retryable, cause } },
   * see assetAcquisitionFailure) -- never a bare null. In particular a
   * successful search with zero hits (EMPTY_RESULT) is distinct from every
   * way Pixabay could fail to answer (HTTP 400/401/403/429/5xx, transport
   * failure, malformed body) and from a download failure after a good
   * search. The API key is never placed in a failure.
   */
  async acquireVisualAsset({ query, assetTypes } = {}) {
    if (!query || typeof query !== 'string' || !query.trim()) {
      throw new Error('PixabayAssetSourceProvider.acquireVisualAsset requires a non-empty query');
    }

    const apiKey = this._apiKeyProvider();
    const secrets = [apiKey];
    const boundedQuery = boundPixabayQuery(query);
    const fail = (kind, extra = {}) =>
      assetAcquisitionFailure({ kind, provider: this.id, query: boundedQuery, secrets, ...extra });

    const requestedTypes =
      Array.isArray(assetTypes) && assetTypes.length > 0 ? assetTypes : ['image', 'video_clip'];
    const assetType = requestedTypes.find((t) => t === 'image' || t === 'video_clip');
    if (!assetType) {
      // Neither requested type is something Pixabay can provide.
      return fail(ASSET_FAILURE_KIND.UNSUPPORTED_ASSET_TYPE, { cause: `requested=${requestedTypes.join(',')}` });
    }

    if (!apiKey) {
      // An absent key is a configuration failure, not "no results". Nothing
      // is sent to Pixabay.
      return fail(ASSET_FAILURE_KIND.MISSING_API_KEY);
    }

    const searchUrl =
      assetType === 'image'
        ? this._buildImageSearchUrl(apiKey, boundedQuery)
        : this._buildVideoSearchUrl(apiKey, boundedQuery);

    let res;
    try {
      res = await this._fetch(searchUrl);
    } catch (err) {
      // Transport-level failure reaching Pixabay (timeout, DNS, connection).
      return fail(ASSET_FAILURE_KIND.NETWORK_FAILURE, { cause: `${err?.name ?? 'Error'}: ${err?.message ?? String(err)}` });
    }

    if (!res.ok) {
      // HTTP error: never a fabricated result, never retried here, and never
      // an empty result.
      const status = res.status;
      let kind;
      if (status === 401 || status === 403) kind = ASSET_FAILURE_KIND.AUTH_FAILURE;
      else if (status === 429) kind = ASSET_FAILURE_KIND.RATE_LIMIT;
      else if (status >= 500) kind = ASSET_FAILURE_KIND.PROVIDER_SERVER_FAILURE;
      else kind = ASSET_FAILURE_KIND.BAD_REQUEST; // 400 and any other 4xx
      return fail(kind, { status, providerMessage: await this._readErrorBody(res) });
    }

    let data;
    try {
      data = await res.json();
    } catch (err) {
      return fail(ASSET_FAILURE_KIND.MALFORMED_RESPONSE, { status: res.status, cause: 'response body is not valid JSON' });
    }

    if (!data || !Array.isArray(data.hits)) {
      return fail(ASSET_FAILURE_KIND.MALFORMED_RESPONSE, { status: res.status, cause: 'response has no hits array' });
    }

    if (data.hits.length === 0) {
      // The ONLY case that means "Pixabay answered and has nothing".
      return fail(ASSET_FAILURE_KIND.EMPTY_RESULT, { status: res.status, hitCount: 0 });
    }

    const hit = data.hits[0];
    const candidate =
      assetType === 'image' ? this._selectImageCandidate(hit) : this._selectVideoCandidate(hit);
    if (!candidate) {
      // Hits exist but the selected one carries no usable download URL.
      return fail(ASSET_FAILURE_KIND.EMPTY_RESULT, {
        status: res.status,
        hitCount: data.hits.length,
        cause: 'first hit has no usable download URL'
      });
    }

    const download = await this._downloadAsset(candidate.url, assetType);
    if (download.failure) {
      return fail(ASSET_FAILURE_KIND.DOWNLOAD_FAILURE, {
        status: download.status ?? null,
        hitCount: data.hits.length,
        cause: download.failure
      });
    }

    return {
      assetType,
      location: download.location,
      checksum: download.checksum,
      origin: candidate.pageURL ?? null,
      license: PIXABAY_LICENSE_NAME,
      attributionRequired: false,
      attributionText: hit.user ? `Image/video by ${hit.user} on Pixabay` : null,
      usageRestrictions: PIXABAY_USAGE_RESTRICTIONS,
      provenanceNotes: this._buildProvenanceNotes({ hit, assetType, candidate }),
      verificationStatus: 'UNVERIFIED'
    };
  }

  /** Short, best-effort excerpt of a non-OK response body (Pixabay explains 400s in plain text). */
  async _readErrorBody(res) {
    try {
      if (typeof res.text === 'function') return String(await res.text()).slice(0, 200);
      if (typeof res.json === 'function') {
        const body = await res.json();
        return typeof body === 'string' ? body.slice(0, 200) : JSON.stringify(body).slice(0, 200);
      }
    } catch {
      // Body is optional diagnostic detail only.
    }
    return null;
  }

  _buildImageSearchUrl(apiKey, query) {
    const params = new URLSearchParams({
      key: apiKey,
      q: query,
      image_type: 'photo',
      safesearch: 'true',
      per_page: '3'
    });
    return `https://pixabay.com/api/?${params.toString()}`;
  }

  _buildVideoSearchUrl(apiKey, query) {
    const params = new URLSearchParams({
      key: apiKey,
      q: query,
      safesearch: 'true',
      per_page: '3'
    });
    return `https://pixabay.com/api/videos/?${params.toString()}`;
  }

  /**
   * Prefers largeImageURL (available on every account) over the
   * approval-gated fullHDURL/imageURL fields; falls back to
   * webformatURL if largeImageURL is somehow absent.
   */
  _selectImageCandidate(hit) {
    const url = hit.largeImageURL ?? hit.webformatURL ?? null;
    if (!url) return null;
    return { url, pageURL: hit.pageURL ?? null };
  }

  /** Prefers medium, then falls back through small/tiny/large. */
  _selectVideoCandidate(hit) {
    const videos = hit.videos ?? {};
    const rendition =
      [videos.medium, videos.small, videos.tiny, videos.large].find((v) => v && v.url) ?? null;
    if (!rendition) return null;
    return { url: rendition.url, pageURL: hit.pageURL ?? null };
  }

  /** Returns { location, checksum } or { failure: '<reason>', status? } -- never null. */
  async _downloadAsset(url, assetType) {
    let res;
    try {
      res = await this._fetch(url);
    } catch (err) {
      return { failure: `download request failed: ${err?.name ?? 'Error'}: ${err?.message ?? String(err)}` };
    }
    if (!res.ok) {
      return { failure: `download returned HTTP ${res.status}`, status: res.status };
    }

    let buffer;
    try {
      const arrayBuffer = await res.arrayBuffer();
      buffer = Buffer.from(arrayBuffer);
    } catch {
      return { failure: 'download body could not be read', status: res.status };
    }

    if (!buffer || buffer.length === 0) {
      // Never leave an empty/corrupt file behind, and never return one.
      return { failure: 'downloaded body was empty', status: res.status };
    }

    const ext = assetType === 'image' ? 'jpg' : 'mp4';
    const filePath = path.join(
      this._downloadDir,
      `pixabay-${crypto.randomUUID()}.${ext}`
    );

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

    const checksum = crypto.createHash('sha256').update(buffer).digest('hex');
    return { location: filePath, checksum };
  }

  _safeCleanup(filePath) {
    try {
      this._fs.rmSync(filePath, { force: true });
    } catch {
      // Best-effort cleanup only; nothing further to do if this fails.
    }
  }

  _buildProvenanceNotes({ hit, assetType, candidate }) {
    const parts = [
      `provider=pixabay`,
      `pixabayId=${hit.id ?? 'unknown'}`,
      `assetType=${assetType}`
    ];
    if (candidate.pageURL) parts.push(`sourceUrl=${candidate.pageURL}`);
    parts.push(`license=${PIXABAY_LICENSE_NAME}`);
    return parts.join('; ');
  }
}

/**
 * Current Pixabay Content License name/summary, as verified against
 * pixabay.com/service/license-summary/ and pixabay.com/service/license/
 * at implementation time. Recorded as a fixed string (not inferred from
 * older CC0-era history) per this milestone's licensing instructions.
 */
const PIXABAY_LICENSE_NAME = 'Pixabay Content License';

const PIXABAY_USAGE_RESTRICTIONS =
  'Free for commercial and non-commercial use; attribution not required. ' +
  'May NOT be resold or redistributed on a standalone basis (unmodified, ' +
  'no added creative effort); may not be used to depict identifiable ' +
  'people in an offensive/pornographic/obscene/defamatory way or to ' +
  'imply an endorsement; recognisable trademarks/logos/brands in Content ' +
  'may carry additional rights Pixabay does not warrant. Permanent ' +
  'hotlinking of Pixabay URLs is not allowed -- this asset has already ' +
  'been downloaded locally in compliance with that requirement.';

export default PixabayAssetSourceProvider;
