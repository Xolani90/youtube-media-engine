/**
 * Phase 2A: deterministic YouTube-compatible title/description
 * validation and normalization for publication metadata.
 *
 * This is validation/normalization only -- never generation. Nothing
 * here calls an LLM, invents content, or alters meaning; it only
 * removes characters YouTube's title field forbids and truncates to
 * YouTube's documented limits (Data API v3 `snippet.title` <= 100
 * chars, `snippet.description` <= 5000 chars). Tags are explicitly out
 * of scope for Phase 2A -- the current engine has no tags field/source/
 * column anywhere in the data model, so there is nothing to validate.
 *
 * Used by ./PublicationRequest.js, the sole existing place title/
 * description are assembled from the content model -- this keeps a
 * single canonical validation/normalization path rather than
 * duplicating checks across callers.
 */

export const TITLE_MAX_LENGTH = 100;
export const DESCRIPTION_MAX_LENGTH = 5000;

/**
 * Thrown for metadata that is fundamentally invalid (missing, empty,
 * or the wrong type) rather than merely over a length limit. This is
 * NOT a normalizable condition -- callers (see pipeline.js) must fail
 * the publication attempt through the existing structural-failure
 * contract rather than inventing replacement content.
 */
export class InvalidPublicationMetadataError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InvalidPublicationMetadataError';
  }
}

/**
 * Normalizes a video title for YouTube publication:
 *  - must be a string (throws InvalidPublicationMetadataError otherwise);
 *  - `<` and `>` are removed (YouTube rejects titles containing them);
 *  - must be non-empty after that removal (throws otherwise);
 *  - truncated to TITLE_MAX_LENGTH characters if longer;
 *  - otherwise left exactly as-is -- no rewriting, casing changes, or
 *    generated content.
 *
 * @param {unknown} title
 * @returns {string}
 */
export function normalizeTitle(title) {
  if (typeof title !== 'string') {
    throw new InvalidPublicationMetadataError('title_not_a_string');
  }
  const sanitized = title.replace(/[<>]/g, '');
  if (sanitized.length === 0) {
    throw new InvalidPublicationMetadataError('title_empty_after_normalization');
  }
  return sanitized.length > TITLE_MAX_LENGTH ? sanitized.slice(0, TITLE_MAX_LENGTH) : sanitized;
}

/**
 * Normalizes a video description for YouTube publication:
 *  - must be a string (throws InvalidPublicationMetadataError otherwise);
 *  - an empty string is valid (PublicationRequest.js's existing
 *    fallback for a missing viewer_promise) -- description emptiness
 *    is not a structural failure the way title emptiness is;
 *  - truncated to DESCRIPTION_MAX_LENGTH characters if longer, which
 *    preserves any line breaks already within that range;
 *  - otherwise left exactly as-is -- no CTAs, hashtags, links, or
 *    generated content added.
 *
 * NOTE: this truncating helper is NOT used on the publication request path.
 * buildPublicationRequest() uses buildDescriptionWithAttribution(), which
 * blocks over-limit descriptions instead of truncating them.
 *
 * @param {unknown} description
 * @returns {string}
 */
export function normalizeDescription(description) {
  if (typeof description !== 'string') {
    throw new InvalidPublicationMetadataError('description_not_a_string');
  }
  return description.length > DESCRIPTION_MAX_LENGTH ? description.slice(0, DESCRIPTION_MAX_LENGTH) : description;
}

/** Heading line placed above the mandatory credit block. */
export const ATTRIBUTION_HEADER = 'Credits:';

/**
 * Final YouTube description assembly and validation.
 *
 * This is the ONLY description builder used by buildPublicationRequest().
 * Whether or not any asset requires attribution, the COMPLETE final
 * description is validated against the YouTube limit and is NEVER truncated:
 * an over-limit result throws InvalidPublicationMetadataError (the pipeline
 * maps it to its existing STRUCTURAL_FAILURE outcome, before any publications
 * row is claimed and before the adapter), so no viewer-promise text and no
 * mandatory credit can be silently dropped to make it fit.
 *
 *  - No asset requires attribution: the description is the viewer promise,
 *    unchanged (an empty string is still valid).
 *  - One or more assets require attribution: credits are appended after the
 *    viewer promise under ATTRIBUTION_HEADER. Source of truth is the persisted
 *    `assets` row (`attribution_required`, `attribution_text`) from
 *    AssetProvenanceRepository.getAssetsForContent() for the exact
 *    content_version being published. Missing, empty, non-string or unusable
 *    required attribution throws.
 *
 * YouTube documents the description limit in bytes (UTF-8), which is what is
 * enforced. UTF-8 byte length >= UTF-16 length, so this also guarantees the
 * 5,000-character limit.
 *
 * Credit ordering is deterministic (code-point order of the credit text); only
 * credits with identical text after trimming are deduplicated, so distinct
 * required attribution is never removed.
 *
 * @param {unknown} viewerPromise
 * @param {Array<object>|null|undefined} assets
 * @returns {string}
 */
export function buildDescriptionWithAttribution(viewerPromise, assets) {
  if (typeof viewerPromise !== 'string') {
    throw new InvalidPublicationMetadataError('description_not_a_string');
  }
  const credits = collectRequiredAttributions(assets);
  let description = viewerPromise;
  if (credits.length > 0) {
    const block = `${ATTRIBUTION_HEADER}\n${credits.join('\n')}`;
    description = viewerPromise.length > 0 ? `${viewerPromise}\n\n${block}` : block;
  }
  const bytes = Buffer.byteLength(description, 'utf8');
  if (bytes > DESCRIPTION_MAX_LENGTH) {
    throw new InvalidPublicationMetadataError(
      credits.length > 0
        ? `description_with_required_attribution_exceeds_${DESCRIPTION_MAX_LENGTH}_bytes_actual_${bytes}`
        : `description_exceeds_${DESCRIPTION_MAX_LENGTH}_bytes_actual_${bytes}`
    );
  }
  return description;
}

/**
 * @param {Array<object>|null|undefined} assets
 * @returns {string[]} sorted, de-duplicated credit lines
 */
export function collectRequiredAttributions(assets) {
  if (!Array.isArray(assets)) return [];
  const seen = new Set();
  for (const a of assets) {
    if (!a || !(a.attribution_required === 1 || a.attribution_required === true)) continue;
    const text = a.attribution_text;
    if (typeof text !== 'string' || text.trim().length === 0) {
      throw new InvalidPublicationMetadataError(`asset_${a.id}_required_attribution_missing`);
    }
    const trimmed = text.trim();
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f\u007f<>]/.test(trimmed)) {
      throw new InvalidPublicationMetadataError(`asset_${a.id}_required_attribution_unusable`);
    }
    seen.add(trimmed);
  }
  return [...seen].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
}
