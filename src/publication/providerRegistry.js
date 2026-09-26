import { YouTubeAdapter } from './youtube/YouTubeAdapter.js';

/**
 * Provider id -> adapter factory. Mirrors
 * src/providers/llm/candidates.js's REGISTRY exactly in spirit: a flat
 * map, no plugin discovery, no dynamic loading. Adding a second
 * provider that publishes the long-form artifact means adding one more
 * entry here and one more adapter file under src/publication/<provider>/
 * — never a change to ./pipeline.js's own adapter.publish(request) call
 * against the PublicationProvider interface. (A provider id that
 * publishes the SHORT_FORM derivative instead, like `youtube_shorts`
 * below, additionally needs one entry in ./constants.js's
 * PUBLICATION_TARGET_BY_PROVIDER — the adapter contract itself is
 * unchanged either way.)
 */
export const PROVIDER_REGISTRY = {
  youtube: () => new YouTubeAdapter(),
  // YouTube Shorts is NOT a separate provider integration -- it is the
  // same YouTube Data API v3 endpoint the long-form adapter already
  // uses (YouTube auto-classifies an upload as a Short once it's
  // vertical and under the platform's Shorts duration ceiling; there is
  // no distinct "Shorts upload" API to integrate against). Registered
  // as its own provider id purely so Publication's existing
  // one-row-per-(content_version, provider) idempotency/authorization
  // model (0010_publication.sql, D-C2 action ids) gives long-form and
  // short-form publication attempts fully independent tracking, with
  // zero YouTube-specific code duplicated or changed.
  youtube_shorts: () => new YouTubeAdapter()
};

export function resolveProvider(providerId) {
  const factory = PROVIDER_REGISTRY[providerId];
  if (!factory) {
    throw new Error(`Unknown publication provider: ${providerId}`);
  }
  return factory();
}

export default resolveProvider;