import { REGISTRY } from './candidates.js';
import { config } from '../../config/index.js';

/**
 * LLMRouter selects a usable provider from config.llmProviderPriority,
 * in order. This is the ONLY place provider selection logic lives —
 * business services call router.complete(...) and never see individual
 * provider adapters.
 *
 * Hard rule (Owner constraint): if no free/R0 provider in the priority
 * list is currently usable, the router does NOT silently fall back to a
 * paid provider. A paid provider is only ever tried if:
 *   (a) config.allowPaidProviders === true, AND
 *   (b) it is explicitly present in the priority list.
 */
export class LLMRouter {
  constructor({ priority = config.llmProviderPriority, allowPaidProviders = config.allowPaidProviders, registry = REGISTRY } = {}) {
    this.priority = priority;
    this.allowPaidProviders = allowPaidProviders;
    this.registry = registry;
  }

  _instantiate(id) {
    const factory = this.registry[id];
    if (!factory) throw new Error(`Unknown LLM provider id in priority list: ${id}`);
    return factory();
  }

  async _selectProvider() {
    const attempted = [];
    for (const id of this.priority) {
      const provider = this._instantiate(id);
      if (provider.isPaid && !this.allowPaidProviders) {
        attempted.push({ id, skipped: 'paid provider not enabled (ALLOW_PAID_PROVIDERS=false)' });
        continue;
      }
      const healthy = await provider.healthCheck();
      if (healthy) return { provider, attempted };
      attempted.push({ id, skipped: 'failed health check (missing key or quota exhausted)' });
    }
    return { provider: null, attempted };
  }

  /**
   * Returns { result, providerUsed, attempted } where result matches the
   * shape defined by LLMProvider#complete, or throws if no provider in
   * the priority list is currently usable under current configuration.
   */
  async complete(request) {
    const { provider, attempted } = await this._selectProvider();
    if (!provider) {
      const detail = attempted.map((a) => `${a.id}: ${a.skipped}`).join('; ');
      throw new Error(
        `No usable LLM provider available under current configuration. Attempted: ${detail || '(empty priority list)'}`
      );
    }
    const result = await provider.complete(request);
    return { result, providerUsed: provider.id, attempted };
  }
}

export default LLMRouter;
