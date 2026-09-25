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
 * @param {unknown} description
 * @returns {string}
 */
export function normalizeDescription(description) {
  if (typeof description !== 'string') {
    throw new InvalidPublicationMetadataError('description_not_a_string');
  }
  return description.length > DESCRIPTION_MAX_LENGTH ? description.slice(0, DESCRIPTION_MAX_LENGTH) : description;
}
