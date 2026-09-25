// Runtime diagnostics for Discovery dedup L2/L3 workload and LLM rate-limit
// delays. DIAGNOSTICS ONLY: nothing here influences any decision, budget,
// provider selection, retry policy, timeout or pipeline ordering, and
// nothing in this module is persisted (no schema, no decision-log entries).
//
// Only numeric counters are held. No prompt, source content, API key or
// other secret is ever passed to, stored by, or emitted from this module.
//
// Scope: one autonomous run == one process invocation. The collector is a
// process-wide singleton because LLM providers are instantiated per
// router call (see candidates.js), so run state cannot live on a provider
// instance. runAutonomousEntrypoint() resets it at the start of every run.

function freshState() {
  return {
    l2Comparisons: 0,
    l3SemanticCalls: 0,
    l3ElapsedMs: 0,
    l3Unresolved: 0,
    llm429Count: 0,
    retrySleepMs: 0,
    discoveryElapsedMs: 0
  };
}

let state = freshState();

const sanitizeMs = (ms) => (Number.isFinite(ms) && ms > 0 ? ms : 0);

export function nowMs() {
  return performance.now();
}

export function resetRunDiagnostics() {
  state = freshState();
}

/** Plain-object copy; elapsed/sleep values rounded to whole milliseconds. */
export function snapshotRunDiagnostics() {
  return {
    l2Comparisons: state.l2Comparisons,
    l3SemanticCalls: state.l3SemanticCalls,
    l3ElapsedMs: Math.round(state.l3ElapsedMs),
    l3Unresolved: state.l3Unresolved,
    llm429Count: state.llm429Count,
    retrySleepMs: Math.round(state.retrySleepMs),
    discoveryElapsedMs: Math.round(state.discoveryElapsedMs)
  };
}

/** A Layer-2 similarity comparison was actually computed. */
export function recordL2Comparison() {
  state.l2Comparisons += 1;
}

/** A Layer-3 semantic call finished (or threw); elapsed covers the whole call. */
export function recordL3Call(elapsedMs) {
  state.l3SemanticCalls += 1;
  state.l3ElapsedMs += sanitizeMs(elapsedMs);
}

/** A pair was left UNRESOLVED because the L3 semantic-call ceiling was reached. */
export function recordL3Unresolved() {
  state.l3Unresolved += 1;
}

/** An LLM provider received an HTTP 429 (including a final, non-retried one). */
export function recordLlm429() {
  state.llm429Count += 1;
}

/** Milliseconds a provider is about to sleep before a 429 retry. */
export function recordRetrySleep(ms) {
  state.retrySleepMs += sanitizeMs(ms);
}

/** Wraps the Discovery pipeline call; records elapsed even if it throws. */
export async function timeDiscovery(fn) {
  const startedAt = nowMs();
  try {
    return await fn();
  } finally {
    state.discoveryElapsedMs += sanitizeMs(nowMs() - startedAt);
  }
}

/** One greppable line of numeric-only counters. */
export function formatRunDiagnostics() {
  return '[discovery-workload-diagnostic] ' + JSON.stringify(snapshotRunDiagnostics());
}
