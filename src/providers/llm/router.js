import { REGISTRY } from './candidates.js';
import { config } from '../../config/index.js';
import { traceAsync, traceEvent } from '../../diagnostics/trace.js';
import { isProviderCoolingDown, providerCooldownRemainingMs } from './providerHealth.js';

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
/**
 * Classifies a single provider.complete() failure into the narrow
 * "temporary inability to obtain an LLM response" class the pipeline is
 * allowed to treat as a per-candidate skip (LLM_PROVIDER_UNAVAILABLE),
 * versus everything else (which must propagate/fail normally).
 *
 * Transient (returns true):
 *   - AbortError (the existing per-attempt request timeout in
 *     GroqProvider/GeminiProvider rejects with this DOMException/Error
 *     shape; timeout value itself is untouched).
 *   - An exhausted 429: GroqProvider/GeminiProvider only let a 429 reach
 *     the router after their own existing bounded retry gives up, so any
 *     `err.status === 429` seen here is already "exhausted" -- existing
 *     retry count, Retry-After handling, and cooldown recording are all
 *     unchanged (they run inside the provider, before this point).
 *
 * Non-transient (returns false) -- and therefore NOT eligible for
 * LLM_PROVIDER_UNAVAILABLE:
 *   - Any other explicit HTTP status (400/401/403/404/5xx/etc.) --
 *     GroqProvider/GeminiProvider already attach `err.status` for every
 *     non-2xx response, so this is a reliable structured signal, not
 *     string matching.
 *   - Anything else: missing API key configuration errors, JSON parsing
 *     failures, or an arbitrary unexpected exception (TypeError,
 *     ReferenceError, a raw network/transport failure, etc.). None of
 *     these carry a structured, reliable "this was transient" signal in
 *     the current provider error shapes, so -- per the conservative rule
 *     of never guessing here -- they are treated as non-transient rather
 *     than heuristically pattern-matched against error messages.
 */
function classifyProviderFailure(err) {
  if (err && err.name === 'AbortError') {
    return true;
  }
  if (err && typeof err.status === 'number' && err.status === 429) {
    return true;
  }
  return false;
}

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
      // Phase 1 (provider cooldown/health-memory): a provider that a prior,
      // independent complete() call already established is rate-limited is
      // skipped without a network call -- same "skip, don't select" shape
      // as the health-check case just below, so it counts the same way in
      // `attempted` and never reaches provider.complete(). Checked before
      // healthCheck() (synchronous, no network call) purely so a cooling-
      // down provider doesn't pay for an unnecessary health check.
      if (isProviderCoolingDown(id)) {
        const remainingMs = providerCooldownRemainingMs(id);
        traceEvent('llm.provider.cooldown.skip', { provider: id, remainingMs });
        attempted.push({ id, skipped: `cooling down after a recent rate limit (${remainingMs}ms remaining)` });
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
   *
   * That aggregate error additionally carries:
   *   - `providerFailures`: an array of `{ id, error, transient }` (see
   *     classifyProviderFailure for what counts as transient).
   *   - `llmProviderUnavailable`: true only when there was at least one
   *     failure AND every failure is transient. A caller (e.g. the
   *     Discovery pipeline) may use this flag to treat the aggregate
   *     failure as a temporary provider-unavailable condition safe to
   *     skip-and-retry-later, rather than a real per-candidate rejection.
   *     It is false whenever any failure is non-transient (an explicit
   *     4xx status, a config error, or an arbitrary unexpected exception)
   *     — the router never lets one transient failure among several mask
   *     a genuine, non-transient one.
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
        failures.push({ id, error: err?.message ?? String(err), transient: classifyProviderFailure(err) });
      }
    }

    const detail = failures.map((f) => `${f.id}: ${f.error}`).join('; ');
    const aggregateError = new Error(`All eligible LLM providers failed. Failures: ${detail}`);
    aggregateError.providerFailures = failures;
    aggregateError.llmProviderUnavailable = failures.length > 0 && failures.every((f) => f.transient);
    throw aggregateError;
  }
}

export default LLMRouter;