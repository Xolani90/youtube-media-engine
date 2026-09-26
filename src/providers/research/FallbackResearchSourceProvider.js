import { ResearchSourceProvider } from '../../research/ResearchSourceProvider.js';

/**
 * Minimal two-provider fallback wrapper -- deliberately NOT a generic
 * routing/registry framework. Wraps exactly one primary and one fallback
 * ResearchSourceProvider so that acquisition.js/pipeline.js see a single
 * ResearchSourceProvider and their existing contract (a provider never
 * throws; it always resolves to `{ candidates, failures }`) is completely
 * unchanged.
 *
 * Fallback trigger: `primary.discoverCandidates()` produced zero
 * candidates. This covers a provider-level failure (primary's own
 * `failures` array populated, `candidates: []`), an "unusable" discovery
 * result (primary resolved with no error but also no candidates), AND
 * -- per the follow-up audit -- a primary that never settles at all
 * within `primaryTimeoutMs` (see below). All three are indistinguishable
 * from the caller's perspective and all three are exactly the cases this
 * change's authorization named.
 *
 * PRIMARY TIMEOUT: bounds only this wrapper's *wait* on the primary via
 * `Promise.race` against a `setTimeout`-backed timer. It does NOT cancel
 * the underlying primary request -- if `primary.discoverCandidates()` is
 * itself a bare `fetch()` with no `AbortSignal` (as TavilySearchProvider
 * currently is), that request keeps running in the background after this
 * wrapper has already moved on to the fallback. This is a deliberate,
 * honestly-scoped fix for the wrapper's own hang, not a claim of upstream
 * cancellation.
 *
 * The fallback is attempted at most once per `discoverCandidates()` call.
 * If it also yields zero candidates, both providers' failures are
 * concatenated and returned together so nothing is silently swallowed.
 */
export class FallbackResearchSourceProvider extends ResearchSourceProvider {
  /**
   * @param {object} opts
   * @param {ResearchSourceProvider} opts.primary
   * @param {ResearchSourceProvider} opts.fallback
   * @param {number} [opts.primaryTimeoutMs] - bounded wait on the primary
   *   provider before treating it as an unusable/timed-out result and
   *   proceeding to the fallback. Defaults to 15000 (15s): comfortably
   *   above Tavily's typical 'basic'-depth response time (low seconds),
   *   while still bounding the wrapper's total worst-case wait to a
   *   predictable order of magnitude alongside DuckDuckGoSearchProvider's
   *   own 10s default timeout, rather than leaving it unbounded.
   */
  constructor({ primary, fallback, primaryTimeoutMs = 15000 }) {
    super();
    this._primary = primary;
    this._fallback = fallback;
    this._primaryTimeoutMs = primaryTimeoutMs;
  }

  get id() {
    return `${this._primary.id}+${this._fallback.id}-fallback`;
  }

  async healthCheck() {
    return (await this._primary.healthCheck()) || (await this._fallback.healthCheck());
  }

  /**
   * Races `primary.discoverCandidates(args)` against a bounded timer.
   * Whichever settles first wins; the timer is always cleared so it never
   * outlives this call. If the timer wins, this resolves (never rejects)
   * to an empty-candidates result carrying a distinct timeout failure --
   * this method itself never throws, preserving the provider contract
   * even in the timeout case.
   */
  async _discoverFromPrimaryWithTimeout(args) {
    let timer;
    const timeoutResult = new Promise((resolve) => {
      timer = setTimeout(() => {
        resolve({
          candidates: [],
          failures: [{
            error: `primary provider "${this._primary.id}" timed out after ${this._primaryTimeoutMs}ms`,
            timeout: true
          }]
        });
      }, this._primaryTimeoutMs);
    });

    try {
      return await Promise.race([this._primary.discoverCandidates(args), timeoutResult]);
    } finally {
      clearTimeout(timer);
    }
  }

  async discoverCandidates(args) {
    const primaryResult = await this._discoverFromPrimaryWithTimeout(args);
    if (Array.isArray(primaryResult?.candidates) && primaryResult.candidates.length > 0) {
      return primaryResult;
    }

    const fallbackResult = await this._fallback.discoverCandidates(args);
    return {
      candidates: Array.isArray(fallbackResult?.candidates) ? fallbackResult.candidates : [],
      failures: [
        ...(Array.isArray(primaryResult?.failures) ? primaryResult.failures : []),
        ...(Array.isArray(fallbackResult?.failures) ? fallbackResult.failures : [])
      ]
    };
  }
}

export default FallbackResearchSourceProvider;