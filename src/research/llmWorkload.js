/**
 * Run/project-local Research LLM workload guard (WS7).
 *
 * Donor concepts (genesis-router, research_agent), kept deliberately small:
 * a shared call budget, failure classification (transient vs non-transient)
 * and a run-local circuit breaker (CLOSED -> OPEN; no HALF_OPEN because a
 * Research project is bounded and the router already owns the cross-call
 * rate-limit cooldown in providerHealth.js).
 *
 * One guard instance is created per Research project and wraps the router
 * handed to claim extraction, contradiction detection and evidence
 * verification, so all three draw on ONE budget and none can bypass it.
 * It touches no provider, key, priority or model, creates no table and holds
 * no module-level state. It can never produce VERIFIED: it only decides
 * whether another model call may be attempted.
 */

export const WORKLOAD_FAILURE = Object.freeze({
  TRANSIENT: 'TRANSIENT',
  RATE_LIMIT: 'RATE_LIMIT',
  DEPLETED_CREDITS: 'DEPLETED_CREDITS',
  AUTH_CONFIG: 'AUTH_CONFIG',
  EMPTY_OR_MALFORMED: 'EMPTY_OR_MALFORMED'
});

export const BREAKER_STATE = Object.freeze({ CLOSED: 'CLOSED', OPEN: 'OPEN' });

export const WORKLOAD_ERROR_CODE = Object.freeze({
  BUDGET_EXHAUSTED: 'LLM_WORKLOAD_BUDGET_EXHAUSTED',
  BREAKER_OPEN: 'LLM_WORKLOAD_BREAKER_OPEN'
});

// Matches Research's structure: <=8 sources x 2 extraction attempts (16)
// + C(8,2) contradiction pairs (28) + 12 verifier calls = 56.
export const DEFAULT_WORKLOAD_LIMITS = Object.freeze({
  max_calls_per_project: 56,
  max_consecutive_transient_failures: 3,
  max_consecutive_rate_limit_failures: 2
});

export class LlmWorkloadError extends Error {
  constructor(code, message, failureClass = null) {
    super(message);
    this.name = 'LlmWorkloadError';
    this.code = code;
    this.failureClass = failureClass;
  }
}

const RE_DEPLETED = /\b402\b|payment required|prepay|credits? (?:are |is )?(?:depleted|exhausted)|insufficient (?:credits?|funds|balance)|billing/i;
const RE_AUTH = /\b40[13]\b|unauthori[sz]ed|forbidden|permission denied|api key|invalid.?key|authentication|not configured|missing key/i;
const RE_RATE = /\b429\b|rate.?limit|quota|resource_exhausted|too many requests|cooling down/i;

/** Classifies a thrown router/provider error. Looks at every provider failure the router aggregated. */
export function classifyLlmFailure(err) {
  const details = Array.isArray(err?.failures) && err.failures.length > 0 ? err.failures : [err];
  const has = (pred) => details.some((d) => pred(d ?? {}));
  const text = (d) => String(d?.error ?? d?.message ?? '');
  if (has((d) => d.status === 402 || RE_DEPLETED.test(text(d)))) return WORKLOAD_FAILURE.DEPLETED_CREDITS;
  if (has((d) => d.status === 401 || d.status === 403 || RE_AUTH.test(text(d)))) return WORKLOAD_FAILURE.AUTH_CONFIG;
  if (has((d) => d.status === 429 || RE_RATE.test(text(d)))) return WORKLOAD_FAILURE.RATE_LIMIT;
  if (has((d) => d.code === 'EMPTY_COMPLETION')) return WORKLOAD_FAILURE.EMPTY_OR_MALFORMED;
  return WORKLOAD_FAILURE.TRANSIENT;
}

export function createLlmWorkload(limits = {}) {
  const cfg = { ...DEFAULT_WORKLOAD_LIMITS, ...(limits ?? {}) };
  const max = Number.isInteger(cfg.max_calls_per_project) && cfg.max_calls_per_project > 0
    ? cfg.max_calls_per_project : DEFAULT_WORKLOAD_LIMITS.max_calls_per_project;
  let used = 0;
  let state = BREAKER_STATE.CLOSED;
  let openReason = null;
  let consecutiveTransient = 0;
  let consecutiveRateLimit = 0;
  const failures = { TRANSIENT: 0, RATE_LIMIT: 0, DEPLETED_CREDITS: 0, AUTH_CONFIG: 0, EMPTY_OR_MALFORMED: 0 };

  const open = (reason) => { if (state === BREAKER_STATE.CLOSED) { state = BREAKER_STATE.OPEN; openReason = reason; } };

  return {
    remaining: () => Math.max(0, max - used),
    canConsume: () => state === BREAKER_STATE.CLOSED && used < max,
    consume() {
      if (!this.canConsume()) return false;
      used += 1;
      return true;
    },
    recordSuccess() { consecutiveTransient = 0; consecutiveRateLimit = 0; },
    recordFailure(err) {
      const cls = classifyLlmFailure(err);
      failures[cls] += 1;
      if (cls === WORKLOAD_FAILURE.DEPLETED_CREDITS || cls === WORKLOAD_FAILURE.AUTH_CONFIG) {
        open(cls); // fail closed for the rest of this project
      } else if (cls === WORKLOAD_FAILURE.RATE_LIMIT) {
        consecutiveRateLimit += 1;
        if (consecutiveRateLimit >= cfg.max_consecutive_rate_limit_failures) open(cls);
      } else if (cls === WORKLOAD_FAILURE.TRANSIENT) {
        consecutiveTransient += 1;
        if (consecutiveTransient >= cfg.max_consecutive_transient_failures) open('CONSECUTIVE_TRANSIENT_FAILURES');
      } // EMPTY_OR_MALFORMED: model-output problem; the stage's own bounded retry handles it
      return cls;
    },
    snapshot: () => ({ maxCalls: max, used, remaining: Math.max(0, max - used), breaker: state, openReason, failures: { ...failures } })
  };
}

/**
 * Wraps an LLM router so every complete() call is accounted against the
 * shared workload. Provider errors are re-thrown UNCHANGED (callers such as
 * claim extraction still read err.failures / code to classify empty vs
 * truncated output); only budget/breaker refusals throw LlmWorkloadError,
 * and those never reach a provider.
 */
export function guardRouter(llmRouter, workload) {
  if (!llmRouter || typeof llmRouter.complete !== 'function') return llmRouter;
  return {
    workload,
    async complete(request, context) {
      const snap = workload.snapshot();
      if (snap.breaker === BREAKER_STATE.OPEN) {
        throw new LlmWorkloadError(WORKLOAD_ERROR_CODE.BREAKER_OPEN, `Research LLM workload stopped: ${snap.openReason}`, snap.openReason);
      }
      if (!workload.consume()) {
        throw new LlmWorkloadError(WORKLOAD_ERROR_CODE.BUDGET_EXHAUSTED, `Research LLM workload budget exhausted (${snap.maxCalls} calls)`);
      }
      let out;
      try {
        out = await llmRouter.complete(request, context);
      } catch (err) {
        workload.recordFailure(err);
        throw err;
      }
      workload.recordSuccess();
      return out;
    }
  };
}

export function isWorkloadHalt(err) {
  return err instanceof LlmWorkloadError;
}
