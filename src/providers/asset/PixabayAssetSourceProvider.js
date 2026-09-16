import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { AssetSourceProvider } from './AssetSourceProvider.js';

/**
 * Concrete 'pixabay' AssetSourceProvider (Milestone C). One provider,
 * one job: acquire ONE real visual asset (image or video_clip) from the
 * Pixabay REST API and return it in the shape AssetSourceProvider
 * defines, mirroring the fetchImpl-injection pattern already used by
 * GroqProvider (src/providers/llm/GroqProvider.js) and YouTubeAdapter
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

  async acquireVisualAsset({ query, assetTypes } = {}) {
    if (!query || typeof query !== 'string' || !query.trim()) {
      throw new Error('PixabayAssetSourceProvider.acquireVisualAsset requires a non-empty query');
    }

    const requestedTypes =
      Array.isArray(assetTypes) && assetTypes.length > 0 ? assetTypes : ['image', 'video_clip'];
    const assetType = requestedTypes.find((t) => t === 'image' || t === 'video_clip');
    if (!assetType) {
      // Neither requested type is something Pixabay can provide.
      return null;
    }

    const apiKey = this._apiKeyProvider();
    if (!apiKey) {
      // Predictable, non-throwing behavior when no key is configured --
      // an absent key is an expected "can't acquire right now" outcome,
      // not a programmer error.
      return null;
    }

    const searchUrl =
      assetType === 'image'
        ? this._buildImageSearchUrl(apiKey, query)
        : this._buildVideoSearchUrl(apiKey, query);

    let res;
    try {
      res = await this._fetch(searchUrl);
    } catch {
      // Network-level failure reaching Pixabay -- treat as "could not acquire".
      return null;
    }

    if (!res.ok) {
      // HTTP error (including 429 rate-limit) -- explicit non-acquisition,
      // never a fabricated result, and never retried here.
      return null;
    }

    let data;
    try {
      data = await res.json();
    } catch {
      // Malformed API response.
      return null;
    }

    if (!data || !Array.isArray(data.hits) || data.hits.length === 0) {
      return null;
    }

    const hit = data.hits[0];
    const candidate =
      assetType === 'image' ? this._selectImageCandidate(hit) : this._selectVideoCandidate(hit);
    if (!candidate) {
      return null;
    }

    const download = await this._downloadAsset(candidate.url, assetType);
    if (!download) {
      return null;
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

  async _downloadAsset(url, assetType) {
    let res;
    try {
      res = await this._fetch(url);
    } catch {
      return null;
    }
    if (!res.ok) {
      return null;
    }

    let buffer;
    try {
      const arrayBuffer = await res.arrayBuffer();
      buffer = Buffer.from(arrayBuffer);
    } catch {
      return null;
    }

    if (!buffer || buffer.length === 0) {
      // Never leave an empty/corrupt file behind, and never return one.
      return null;
    }

    this._fs.mkdirSync(this._downloadDir, { recursive: true });
    const ext = assetType === 'image' ? 'jpg' : 'mp4';
    const filePath = path.join(
      this._downloadDir,
      `pixabay-${crypto.randomUUID()}.${ext}`
    );

    try {
      this._fs.writeFileSync(filePath, buffer);
    } catch {
      this._safeCleanup(filePath);
      return null;
    }

    let stat;
    try {
      stat = this._fs.statSync(filePath);
    } catch {
      this._safeCleanup(filePath);
      return null;
    }
    if (!stat || stat.size === 0) {
      this._safeCleanup(filePath);
      return null;
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
