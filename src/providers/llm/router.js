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
 *
 * D-B1 (ADR-0002): when constructed with a `costTracker`, the router is
 * also the cost-enforcement boundary — the ONE place a billable provider
 * call is gated, so callers cannot bypass cost control by invoking a
 * provider through some other path. This reuses CostTracker.record()'s
 * existing throw-before-insert behavior unchanged: `costTracker` is not
 * redesigned, `maxCostPerContent` remains the existing per-call ceiling,
 * and no cumulative/monthly budgeting is introduced here. Enforcement is
 * opt-in — a router constructed without a `costTracker` behaves exactly
 * as before.
 */
export class LLMRouter {
  constructor({
    priority = config.llmProviderPriority,
    allowPaidProviders = config.allowPaidProviders,
    registry = REGISTRY,
    costTracker = null
  } = {}) {
    this.priority = priority;
    this.allowPaidProviders = allowPaidProviders;
    this.registry = registry;
    this.costTracker = costTracker;
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
   *
   * D-B1: if this router was constructed with a `costTracker`, the cost
   * boundary is enforced here, BEFORE `provider.complete()` is invoked —
   * the selected provider is never called for a request the cost boundary
   * rejects. `context` (runId/contentId/jobStage) is passed straight
   * through to `costTracker.record()`'s existing fields; `request` may
   * carry an `estimatedCost` for the call being made (defaults to 0,
   * matching CostTracker's existing "free call has cost = 0" accounting
   * for calls that don't supply one). If a BudgetExceededError is thrown,
   * it propagates from `complete()` unchanged — the router does not catch
   * it and try another provider, preserving the existing
   * no-silent-paid-fallback rule.
   */
  async complete(request, context = {}) {
    const { provider, attempted } = await this._selectProvider();
    if (!provider) {
      const detail = attempted.map((a) => `${a.id}: ${a.skipped}`).join('; ');
      throw new Error(
        `No usable LLM provider available under current configuration. Attempted: ${detail || '(empty priority list)'}`
      );
    }

    if (this.costTracker) {
      const { runId = null, contentId = null, jobStage = null } = context;
      this.costTracker.record({
        runId,
        contentId,
        jobStage,
        provider: provider.id,
        model: null,
        requestId: null,
        inputTokens: null,
        outputTokens: null,
        estimatedCost: request?.estimatedCost ?? 0,
        actualCost: null,
        isPaid: provider.isPaid
      });
    }

    const result = await provider.complete(request);
    return { result, providerUsed: provider.id, attempted };
  }
}

export default LLMRouter;
