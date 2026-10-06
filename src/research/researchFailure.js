// ADR-0039: classification of provider/transport failures that interrupt a
// Research attempt. Pure; no I/O. It reads ONLY structured fields that the
// LLM router/providers already expose (status, code, name, causeCode) and
// never the error message text.
//
// Natures reuse the repository's existing evidence vocabulary
// (FailureClassification.EVIDENCE_NATURE / StageRetryPolicy.FAILURE_NATURE):
//   TRANSIENT       item-level, bounded RESEARCH retry (consumes an attempt)
//   INFRASTRUCTURE  configuration / provider-wide / scheduler-level: never
//                   consumes the item's retry budget
//   UNCLASSIFIED    fails closed: no retry, no attempt
// ISOLATE is not a failure nature: it marks a per-source condition that the
// pipeline has always handled by skipping that source (output-quality
// problems and the local workload budget).

import { LlmWorkloadError, WORKLOAD_ERROR_CODE, WORKLOAD_FAILURE } from './llmWorkload.js';
import { EXTRACTION_PARSE_OUTCOME } from './claims.js';

export const RESEARCH_FAILURE_NATURE = Object.freeze({
  TRANSIENT: 'TRANSIENT',
  INFRASTRUCTURE: 'INFRASTRUCTURE',
  UNCLASSIFIED: 'UNCLASSIFIED'
});
export const ISOLATE = 'ISOLATE';

export const RESEARCH_STOP_REASON = Object.freeze({
  TRANSIENT_FAILURE: 'RESEARCH_TRANSIENT_FAILURE',
  INFRASTRUCTURE_FAILURE: 'RESEARCH_INFRASTRUCTURE_FAILURE',
  UNCLASSIFIED_FAILURE: 'RESEARCH_UNCLASSIFIED_FAILURE'
});

const TRANSIENT_STATUSES = new Set([429, 500, 502, 503, 504]);
const INFRASTRUCTURE_STATUSES = new Set([401, 402, 403]);
// Same family the Gemini adapter itself treats as a transport failure.
const NETWORK_CODE = /^(ECONNRESET|ECONNREFUSED|ECONNABORTED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|EPIPE|UND_ERR_)/;
const NEUTRAL = 'NEUTRAL';

/** Classifies ONE structured provider failure detail. */
export function classifyFailureDetail(detail) {
  const d = detail ?? {};
  if (d.code === 'NO_USABLE_PROVIDER') return RESEARCH_FAILURE_NATURE.INFRASTRUCTURE;
  if (Number.isInteger(d.status)) {
    if (INFRASTRUCTURE_STATUSES.has(d.status)) return RESEARCH_FAILURE_NATURE.INFRASTRUCTURE;
    if (TRANSIENT_STATUSES.has(d.status)) return RESEARCH_FAILURE_NATURE.TRANSIENT;
    return RESEARCH_FAILURE_NATURE.UNCLASSIFIED;
  }
  if (d.name === 'AbortError' || d.name === 'TimeoutError') return RESEARCH_FAILURE_NATURE.TRANSIENT;
  const net = d.code ?? d.causeCode ?? d.cause?.code;
  if (typeof net === 'string' && NETWORK_CODE.test(net)) return RESEARCH_FAILURE_NATURE.TRANSIENT;
  if (typeof d.causeCode === 'string' && NETWORK_CODE.test(d.causeCode)) return RESEARCH_FAILURE_NATURE.TRANSIENT;
  if (d.name === 'BudgetExceededError') return RESEARCH_FAILURE_NATURE.INFRASTRUCTURE;
  // An empty completion is an output-quality condition, not a transport one.
  if (d.code === 'EMPTY_COMPLETION') return NEUTRAL;
  return RESEARCH_FAILURE_NATURE.UNCLASSIFIED;
}

// Most conservative wins: a failure set that is not wholly transient never
// consumes item retry budget, and anything unknown fails closed.
function aggregate(natures) {
  const real = natures.filter((n) => n !== NEUTRAL);
  if (real.length === 0) return RESEARCH_FAILURE_NATURE.UNCLASSIFIED;
  if (real.includes(RESEARCH_FAILURE_NATURE.UNCLASSIFIED)) return RESEARCH_FAILURE_NATURE.UNCLASSIFIED;
  if (real.includes(RESEARCH_FAILURE_NATURE.INFRASTRUCTURE)) return RESEARCH_FAILURE_NATURE.INFRASTRUCTURE;
  return RESEARCH_FAILURE_NATURE.TRANSIENT;
}

/** Classifies a thrown router/provider error (any shape the router can produce). */
export function classifyProviderError(err) {
  if (err instanceof LlmWorkloadError) {
    if (err.code === WORKLOAD_ERROR_CODE.BUDGET_EXHAUSTED) return ISOLATE;
    // The run-local breaker opens after consecutive transient failures; that is a transient condition.
    if (err.failureClass === WORKLOAD_FAILURE.TRANSIENT || err.failureClass === WORKLOAD_FAILURE.RATE_LIMIT ||
        err.failureClass === 'CONSECUTIVE_TRANSIENT_FAILURES') {
      return RESEARCH_FAILURE_NATURE.TRANSIENT;
    }
    if (err.failureClass === WORKLOAD_FAILURE.AUTH_CONFIG || err.failureClass === WORKLOAD_FAILURE.DEPLETED_CREDITS) {
      return RESEARCH_FAILURE_NATURE.INFRASTRUCTURE;
    }
    return RESEARCH_FAILURE_NATURE.UNCLASSIFIED;
  }
  const details = Array.isArray(err?.failures) && err.failures.length > 0
    ? err.failures
    : [{ code: err?.code, status: err?.status, name: err?.name, causeCode: err?.cause?.code }];
  return aggregate(details.map(classifyFailureDetail));
}

/**
 * Decides what the pipeline does with an ExtractionFailureError.
 *   ISOLATE                       skip that source (unchanged behaviour)
 *   TRANSIENT/INFRASTRUCTURE/...  fail the whole attempt
 */
export function classifyExtractionFailure(err) {
  if (err?.parseOutcome !== EXTRACTION_PARSE_OUTCOME.PROVIDER_FAILED) return ISOLATE;
  return classifyProviderError(err.cause ?? err);
}

/**
 * Thrown inside runResearchProject to abandon the current attempt. It is
 * always caught by runResearchProject itself and converted to a normal,
 * structured result; it never escapes to the runner.
 */
export class ResearchAttemptFailure extends Error {
  constructor({ nature, basis, cause = null, projectId = null }) {
    super(`Research attempt failed (${nature}): ${basis}`);
    this.name = 'ResearchAttemptFailure';
    this.nature = nature;
    this.basis = basis;
    this.projectId = projectId;
    if (cause) this.cause = cause;
  }
}

/** Short machine-readable basis for a failed attempt (no message text). */
export function failureBasis(err, prefix) {
  const details = Array.isArray(err?.failures) && err.failures.length > 0 ? err.failures : [err ?? {}];
  const tags = details.map((d) => d?.status ?? d?.code ?? d?.causeCode ?? d?.cause?.code ?? d?.name ?? 'unknown');
  return `${prefix}:${[...new Set(tags.map(String))].join(',')}`.slice(0, 120);
}