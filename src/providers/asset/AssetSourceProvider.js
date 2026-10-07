/**
 * AssetSourceProvider — Milestone A: interface/contract only.
 *
 * No concrete implementation, no runner wiring, no provider selection.
 * Modeled directly on ResearchSourceProvider's shape and scope discipline
 * (src/research/ResearchSourceProvider.js): an id, a healthCheck(), and
 * one acquisition method, each throwing until a concrete subclass
 * implements them.
 *
 * Scope discipline, explicit:
 *   - This interface is responsible for VISUAL ASSET ACQUISITION only --
 *     obtaining ONE candidate visual (image or video clip) description
 *     suitable for AssetProvenanceRepository.recordAsset()
 *     (src/state/AssetProvenance.js). It does not call recordAsset or
 *     recordUsage itself -- persistence remains the caller's
 *     responsibility, once a future provisioning stage exists.
 *   - It does not name or assume any concrete external provider (no
 *     stock library, generative model, or local library is referenced
 *     here) -- subclasses are the only place a concrete source is ever
 *     chosen.
 *   - It performs no network calls, no downloading, and no LLM-based
 *     selection itself -- those are subclass/caller concerns for a later
 *     milestone, not part of this contract.
 *   - It introduces no new lifecycle state and is not wired into
 *     src/autonomous/runner.js, Media Production, or Quality Gate.
 */
export class AssetSourceProvider {
  /**
   * Unique id for this provider, in the same spirit as
   * config.llmProviderPriority (src/providers/llm/candidates.js) --
   * useful once multiple asset sources exist and need to be prioritized
   * or selected by config. Not used by anything yet.
   */
  get id() {
    throw new Error('AssetSourceProvider.id must be implemented by subclass');
  }

  /**
   * Cheap check for whether this provider is currently usable (e.g.
   * credentials present, source reachable). This base contract makes no
   * network call itself; whether a subclass's implementation does is
   * that subclass's own concern.
   */
  async healthCheck() {
    throw new Error('AssetSourceProvider.healthCheck must be implemented by subclass');
  }

  /**
   * Attempts to obtain ONE candidate visual asset matching `query`.
   * Provider-agnostic: this method makes no assumption about where the
   * asset comes from (stock library, generative model, local library,
   * etc.) -- that is entirely a concrete subclass's responsibility.
   *
   * @param {object} params
   * @param {string} params.query - free-text description of the visual
   *   needed (e.g. derived from content_briefs.visual_ideas or a script
   *   section -- see src/db/migrations/0001_init.sql, src/brief/generate.js).
   * @param {string[]} [params.assetTypes] - acceptable asset types for
   *   this acquisition, e.g. ['image', 'video_clip']
   *   (src/media/constants.js VISUAL_ASSET_TYPES).
   * @returns {Promise<{
   *   assetType: string,
   *   location: string,
   *   checksum?: string|null,
   *   origin?: string|null,
   *   license?: string|null,
   *   attributionRequired?: boolean,
   *   attributionText?: string|null,
   *   usageRestrictions?: string|null,
   *   provenanceNotes?: string|null,
   *   verificationStatus?: string
   * } | null>}
   *   The returned shape deliberately mirrors
   *   AssetProvenanceRepository.recordAsset()'s parameter shape
   *   (src/state/AssetProvenance.js) so a future caller could pass it
   *   straight through -- this interface does not call recordAsset
   *   itself, and no caller does yet. When no asset could be obtained a
   *   provider SHOULD return a structured failure
   *   ({ failure: { kind, ... } }, see assetAcquisitionFailure below) so
   *   the caller can tell "the provider answered and had nothing"
   *   (EMPTY_RESULT) from "the provider could not answer". A bare null
   *   is still accepted from legacy providers and is treated by the
   *   caller as an unclassified "no asset" outcome.
   */
  async acquireVisualAsset({ query, assetTypes } = {}) {
    throw new Error('AssetSourceProvider.acquireVisualAsset must be implemented by subclass');
  }
}

/**
 * Why an acquisition attempt produced no asset. Deliberately small: one
 * kind per distinct operational cause, so a provider outage can never be
 * mistaken for "there are no suitable assets".
 */
export const ASSET_FAILURE_KIND = Object.freeze({
  EMPTY_RESULT: 'EMPTY_RESULT', // provider answered successfully with zero usable hits
  BAD_REQUEST: 'BAD_REQUEST', // HTTP 400 / other 4xx: provider rejected the request
  MISSING_API_KEY: 'MISSING_API_KEY', // no credential configured (nothing was sent)
  AUTH_FAILURE: 'AUTH_FAILURE', // HTTP 401 / 403
  RATE_LIMIT: 'RATE_LIMIT', // HTTP 429
  PROVIDER_SERVER_FAILURE: 'PROVIDER_SERVER_FAILURE', // HTTP 5xx
  NETWORK_FAILURE: 'NETWORK_FAILURE', // transport failure (timeout, DNS, connection)
  MALFORMED_RESPONSE: 'MALFORMED_RESPONSE', // HTTP success but unusable body shape
  DOWNLOAD_FAILURE: 'DOWNLOAD_FAILURE', // search succeeded, selected asset could not be fetched/stored
  UNSUPPORTED_ASSET_TYPE: 'UNSUPPORTED_ASSET_TYPE' // none of the requested types is offered by this provider
});

// Whether the same request could plausibly succeed later without anyone
// changing configuration or the request itself.
const RETRYABLE_KINDS = new Set([
  ASSET_FAILURE_KIND.EMPTY_RESULT,
  ASSET_FAILURE_KIND.RATE_LIMIT,
  ASSET_FAILURE_KIND.PROVIDER_SERVER_FAILURE,
  ASSET_FAILURE_KIND.NETWORK_FAILURE,
  ASSET_FAILURE_KIND.DOWNLOAD_FAILURE
]);

/** Removes a credential (and the value of any `key=` parameter) from free text before it is stored or logged. */
export function redactSecrets(text, secrets = []) {
  let out = String(text ?? '');
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret.length > 0) out = out.split(secret).join('[REDACTED]');
  }
  return out.replace(/\bkey=[^&\s"']*/gi, 'key=[REDACTED]');
}

/**
 * Builds the structured "no asset" result. Contains no credential: `cause`
 * and `providerMessage` are redacted and truncated by the caller-supplied
 * secrets, and the API key is never an input to this function.
 */
export function assetAcquisitionFailure({ kind, provider, query = null, status = null, hitCount = null, cause = null, providerMessage = null, secrets = [] }) {
  if (!Object.values(ASSET_FAILURE_KIND).includes(kind)) {
    throw new Error(`unknown asset failure kind: ${kind}`);
  }
  const clip = (v) => (v == null ? null : redactSecrets(v, secrets).slice(0, 200));
  return {
    failure: {
      kind,
      provider: provider ?? null,
      query: query == null ? null : redactSecrets(query, secrets),
      status: Number.isInteger(status) ? status : null,
      hitCount: Number.isInteger(hitCount) ? hitCount : null,
      retryable: RETRYABLE_KINDS.has(kind),
      cause: clip(cause),
      providerMessage: clip(providerMessage)
    }
  };
}

/** True for a structured failure produced by assetAcquisitionFailure (or an equivalent shape). */
export function isAssetAcquisitionFailure(result) {
  return Boolean(result) && typeof result === 'object' && result.failure != null &&
    typeof result.failure === 'object' && typeof result.failure.kind === 'string';
}

export default AssetSourceProvider;
