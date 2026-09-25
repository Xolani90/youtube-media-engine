import { REGISTRY } from './candidates.js';
import { config } from '../../config/index.js';
import { traceAsync } from '../../diagnostics/trace.js';

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

  /**
   * Walks the full priority list once, applying the existing paid/health
   * eligibility checks, and returns every eligible provider in priority
   * order (not just the first). `attempted` carries the skip reasons for
   * providers that were ruled out (paid-not-allowed / failed health
   * check), in the same shape as before this method existed.
   */
  async _selectEligibleProviders() {
    const eligible = [];
    const attempted = [];
    for (const id of this.priority) {
      const provider = this._instantiate(id);
      if (provider.isPaid && !this.allowPaidProviders) {
        attempted.push({ id, skipped: 'paid provider not enabled (ALLOW_PAID_PROVIDERS=false)' });
        continue;
      }
      const healthy = await provider.healthCheck();
      if (!healthy) {
        attempted.push({ id, skipped: 'failed health check (missing key or quota exhausted)' });
        continue;
      }
      eligible.push({ id, provider });
    }
    return { eligible, attempted };
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
   *
   * Failover: if the selected provider's own `complete()` throws (e.g. a
   * transient 429 that its internal retry logic didn't absorb), the
   * router moves on to the next eligible provider in priority order and
   * tries that one instead. Each eligible provider is tried at most once
   * per call — there is no retrying the same provider. If every eligible
   * provider fails, the router throws a single error summarizing every
   * failure encountered.
   */
  async complete(request, context = {}) {
    const { eligible, attempted } = await this._selectEligibleProviders();
    if (eligible.length === 0) {
      const detail = attempted.map((a) => `${a.id}: ${a.skipped}`).join('; ');
      throw new Error(
        `No usable LLM provider available under current configuration. Attempted: ${detail || '(empty priority list)'}`
      );
    }

    const failures = [];
    for (const { id, provider } of eligible) {
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

      try {
        const result = await traceAsync(
          'llm.complete',
          { provider: provider.id, maxTokens: request?.maxTokens, promptChars: request?.prompt?.length },
          () => provider.complete(request),
          (r) => ({ model: r?.model, inTokens: r?.inputTokens, outTokens: r?.outputTokens })
        );
        return { result, providerUsed: provider.id, attempted };
      } catch (err) {
        failures.push({ id, error: err?.message ?? String(err) });
      }
    }

    const detail = failures.map((f) => `${f.id}: ${f.error}`).join('; ');
    throw new Error(`All eligible LLM providers failed. Failures: ${detail}`);
  }
}

export default LLMRouter;
