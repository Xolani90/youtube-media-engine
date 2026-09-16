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
   *   itself, and no caller does yet. Returns null when no suitable
   *   asset could be obtained; that is an expected outcome, not an
   *   error condition by itself.
   */
  async acquireVisualAsset({ query, assetTypes } = {}) {
    throw new Error('AssetSourceProvider.acquireVisualAsset must be implemented by subclass');
  }
}

export default AssetSourceProvider;
