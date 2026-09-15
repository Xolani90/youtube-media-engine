import { YouTubeAdapter } from './youtube/YouTubeAdapter.js';

/**
 * Provider id -> adapter factory. Mirrors
 * src/providers/llm/candidates.js's REGISTRY exactly in spirit: a flat
 * map, no plugin discovery, no dynamic loading. Adding a second
 * provider later means adding one more entry here and one more adapter
 * file under src/publication/<provider>/ — never a change to
 * ./pipeline.js, which only ever calls `adapter.publish(request)`
 * against the PublicationProvider interface.
 */
export const PROVIDER_REGISTRY = {
  youtube: () => new YouTubeAdapter()
};

export function resolveProvider(providerId) {
  const factory = PROVIDER_REGISTRY[providerId];
  if (!factory) {
    throw new Error(`Unknown publication provider: ${providerId}`);
  }
  return factory();
}

export default resolveProvider;
