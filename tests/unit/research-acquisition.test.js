import { test } from 'node:test';
import assert from 'node:assert/strict';
import { acquireSources } from '../../src/research/acquisition.js';
import { ResearchSourceProvider } from '../../src/research/ResearchSourceProvider.js';

function policyWith(overrides) {
  return {
    acquisition: { max_sources_per_research_project: 8, max_acquisition_attempts: 12 },
    retry: { max_retries_per_source: 2 },
    ...overrides
  };
}

class StubProvider extends ResearchSourceProvider {
  constructor(candidates, { failDiscovery = false } = {}) {
    super();
    this.candidates = candidates;
    this.failDiscovery = failDiscovery;
  }
  get id() { return 'stub'; }
  async healthCheck() { return true; }
  async discoverCandidates() {
    if (this.failDiscovery) throw new Error('discovery unreachable');
    return { candidates: this.candidates };
  }
}

function candidates(n) {
  return Array.from({ length: n }, (_, i) => ({ url: `https://example.com/${i}`, title: `t${i}`, snippet: 's' }));
}

test('acquisition never exceeds max_sources_per_research_project even with more candidates available', async () => {
  const provider = new StubProvider(candidates(20));
  let calls = 0;
  const retrieveImpl = async () => { calls++; return { status: 'SUCCESS', content: 'ok', error: null }; };
  const result = await acquireSources({ provider, query: 'q', policy: policyWith({ acquisition: { max_sources_per_research_project: 3, max_acquisition_attempts: 100 } }), retrieveImpl });
  assert.equal(result.acquired.length, 3);
  assert.equal(calls, 3);
});

test('max_acquisition_attempts caps ACTUAL retrieval invocations, not merely candidates considered', async () => {
  const provider = new StubProvider(candidates(20));
  let calls = 0;
  // Every attempt fails, forcing retries, to prove the cap governs actual calls.
  const retrieveImpl = async () => { calls++; return { status: 'FAILED', content: null, error: 'boom' }; };
  const policy = policyWith({ acquisition: { max_sources_per_research_project: 8, max_acquisition_attempts: 12 }, retry: { max_retries_per_source: 2 } });
  const result = await acquireSources({ provider, query: 'q', policy, retrieveImpl });

  assert.equal(calls, 12, 'actual retrieval calls must be capped exactly at max_acquisition_attempts');
  assert.equal(result.attemptsUsed, 12);
  assert.ok(result.candidatesConsidered === 20, 'candidates considered is reported separately from attempts used');
  assert.ok(result.acquired.length <= 4, 'far fewer sources acquired than candidates, since every attempt fails and consumes 3 tries each');
});

test('a source gets its initial attempt plus up to max_retries_per_source retries, then moves on', async () => {
  const provider = new StubProvider(candidates(2));
  const callsPerUrl = {};
  const retrieveImpl = async (url) => {
    callsPerUrl[url] = (callsPerUrl[url] || 0) + 1;
    return { status: 'FAILED', content: null, error: 'boom' };
  };
  const policy = policyWith({ acquisition: { max_sources_per_research_project: 8, max_acquisition_attempts: 100 }, retry: { max_retries_per_source: 2 } });
  await acquireSources({ provider, query: 'q', policy, retrieveImpl });

  for (const url of Object.keys(callsPerUrl)) {
    assert.equal(callsPerUrl[url], 3, `expected 1 initial + 2 retries = 3 attempts for ${url}`);
  }
});

test('CONTENT_UNPARSEABLE does not trigger a retry (unlike FAILED)', async () => {
  const provider = new StubProvider(candidates(1));
  let calls = 0;
  const retrieveImpl = async () => { calls++; return { status: 'CONTENT_UNPARSEABLE', content: null, error: 'binary' }; };
  const policy = policyWith({ acquisition: { max_sources_per_research_project: 8, max_acquisition_attempts: 100 }, retry: { max_retries_per_source: 2 } });
  await acquireSources({ provider, query: 'q', policy, retrieveImpl });
  assert.equal(calls, 1, 'CONTENT_UNPARSEABLE should consume exactly one attempt, no retries');
});

test('a SUCCESS on retry stops further attempts for that source', async () => {
  const provider = new StubProvider(candidates(1));
  let attempt = 0;
  const retrieveImpl = async () => {
    attempt++;
    if (attempt < 2) return { status: 'FAILED', content: null, error: 'transient' };
    return { status: 'SUCCESS', content: 'recovered', error: null };
  };
  const policy = policyWith({ acquisition: { max_sources_per_research_project: 8, max_acquisition_attempts: 100 }, retry: { max_retries_per_source: 2 } });
  const result = await acquireSources({ provider, query: 'q', policy, retrieveImpl });
  assert.equal(attempt, 2);
  assert.equal(result.acquired[0].status, 'SUCCESS');
  assert.equal(result.acquired[0].content, 'recovered');
});

test('failure isolation: one source failing does not prevent others from being acquired', async () => {
  const provider = new StubProvider(candidates(3));
  const retrieveImpl = async (url) => {
    if (url.endsWith('/1')) return { status: 'FAILED', content: null, error: 'boom' };
    return { status: 'SUCCESS', content: 'ok', error: null };
  };
  const policy = policyWith({ retry: { max_retries_per_source: 0 } });
  const result = await acquireSources({ provider, query: 'q', policy, retrieveImpl });
  const succeeded = result.acquired.filter((a) => a.status === 'SUCCESS');
  assert.equal(succeeded.length, 2);
});

test('a discovery failure is isolated: reports zero acquired sources rather than throwing', async () => {
  const provider = new StubProvider([], { failDiscovery: true });
  const retrieveImpl = async () => ({ status: 'SUCCESS', content: 'ok', error: null });
  const result = await acquireSources({ provider, query: 'q', policy: policyWith({}), retrieveImpl });
  assert.equal(result.discoveryFailed, true);
  assert.equal(result.acquired.length, 0);
  assert.match(result.discoveryError, /unreachable/);
});

test('the acquisition loop always terminates deterministically even with unlimited candidates', async () => {
  // 1000 candidates, everything succeeds instantly — should stop at max_sources, not iterate all 1000.
  const provider = new StubProvider(candidates(1000));
  let calls = 0;
  const retrieveImpl = async () => { calls++; return { status: 'SUCCESS', content: 'ok', error: null }; };
  const result = await acquireSources({ provider, query: 'q', policy: policyWith({}), retrieveImpl });
  assert.equal(result.acquired.length, 8);
  assert.equal(calls, 8);
});

// --- candidatesExhausted (Owner decision: stopping-condition contract) ---

test('candidatesExhausted is true when every discovered candidate is visited before either cap fires', async () => {
  const provider = new StubProvider(candidates(3));
  const retrieveImpl = async () => ({ status: 'SUCCESS', content: 'ok', error: null });
  const policy = policyWith({ acquisition: { max_sources_per_research_project: 8, max_acquisition_attempts: 100 } });
  const result = await acquireSources({ provider, query: 'q', policy, retrieveImpl });
  assert.equal(result.acquired.length, 3);
  assert.equal(result.candidatesExhausted, true);
});

test('candidatesExhausted is true when the source cap is reached exactly as the last candidate is visited', async () => {
  const provider = new StubProvider(candidates(3));
  const retrieveImpl = async () => ({ status: 'SUCCESS', content: 'ok', error: null });
  const policy = policyWith({ acquisition: { max_sources_per_research_project: 3, max_acquisition_attempts: 100 } });
  const result = await acquireSources({ provider, query: 'q', policy, retrieveImpl });
  assert.equal(result.acquired.length, 3);
  assert.equal(result.candidatesExhausted, true);
});

test('candidatesExhausted is false when the source cap is reached with candidates still remaining', async () => {
  const provider = new StubProvider(candidates(20));
  const retrieveImpl = async () => ({ status: 'SUCCESS', content: 'ok', error: null });
  const policy = policyWith({ acquisition: { max_sources_per_research_project: 3, max_acquisition_attempts: 100 } });
  const result = await acquireSources({ provider, query: 'q', policy, retrieveImpl });
  assert.equal(result.acquired.length, 3);
  assert.equal(result.candidatesExhausted, false);
});

test('candidatesExhausted is false when max_acquisition_attempts is reached with candidates still remaining and the source cap not reached', async () => {
  const provider = new StubProvider(candidates(20));
  let calls = 0;
  // Every attempt fails, forcing retries, so the attempt cap fires well
  // before all 20 candidates (or the generous source cap) are reached.
  const retrieveImpl = async () => { calls++; return { status: 'FAILED', content: null, error: 'boom' }; };
  const policy = policyWith({ acquisition: { max_sources_per_research_project: 8, max_acquisition_attempts: 12 }, retry: { max_retries_per_source: 2 } });
  const result = await acquireSources({ provider, query: 'q', policy, retrieveImpl });
  assert.equal(result.attemptsUsed, 12);
  assert.ok(result.acquired.length < 8, 'source cap must not have been reached');
  assert.equal(result.candidatesExhausted, false);
});

test('candidatesExhausted is true (vacuously) when discovery returns zero candidates without a discovery failure', async () => {
  const provider = new StubProvider([]);
  const retrieveImpl = async () => ({ status: 'SUCCESS', content: 'ok', error: null });
  const result = await acquireSources({ provider, query: 'q', policy: policyWith({}), retrieveImpl });
  assert.equal(result.acquired.length, 0);
  assert.equal(result.discoveryFailed, false);
  assert.equal(result.candidatesExhausted, true);
});

for (const status of [401, 403]) {
  test(`HTTP ${status} (retryable:false) is attempted once, not retried, and consumes one attempt slot`, async () => {
    const provider = new StubProvider(candidates(2));
    const callsPerUrl = {};
    const retrieveImpl = async (url) => {
      callsPerUrl[url] = (callsPerUrl[url] || 0) + 1;
      return { status: 'FAILED', content: null, error: `HTTP ${status}`, retryable: false };
    };
    const policy = policyWith({ acquisition: { max_sources_per_research_project: 8, max_acquisition_attempts: 100 }, retry: { max_retries_per_source: 2 } });
    const out = await acquireSources({ provider, query: 'q', policy, retrieveImpl });

    for (const url of Object.keys(callsPerUrl)) assert.equal(callsPerUrl[url], 1, `no retries for ${url}`);
    assert.equal(out.attemptsUsed, 2);
    assert.ok(out.acquired.every((a) => a.status === 'FAILED' && a.attemptCount === 1));
  });
}

test('a transient FAILED without retryable:false still retries and can succeed on retry', async () => {
  const provider = new StubProvider(candidates(1));
  let calls = 0;
  const retrieveImpl = async () => {
    calls++;
    return calls < 3
      ? { status: 'FAILED', content: null, error: 'HTTP 503' }
      : { status: 'SUCCESS', content: 'ok', error: null };
  };
  const out = await acquireSources({ provider, query: 'q', policy: policyWith({}), retrieveImpl });
  assert.equal(calls, 3);
  assert.equal(out.acquired[0].status, 'SUCCESS');
});


// ---------------------------------------------------------------------------
// Discovery diagnostics (additive, read-only). These tests pin that the new
// `discoveryDiagnostics` field never changes retries, counters, candidate
// exhaustion, or admissibility-relevant output, and that no provider output --
// however malformed -- can turn a diagnostics problem into a research failure.
// ---------------------------------------------------------------------------

class ScriptedProvider extends ResearchSourceProvider {
  constructor(result) { super(); this.result = result; }
  get id() { return 'scripted'; }
  async healthCheck() { return true; }
  async discoverCandidates() {
    if (this.result instanceof Error) throw this.result;
    return this.result;
  }
}
const LEGACY_KEYS = ['acquired', 'attemptsUsed', 'candidatesConsidered', 'candidatesExhausted', 'discoveryFailed', 'discoveryError'];
const withoutDiagnostics = ({ discoveryDiagnostics, ...rest }) => rest;
const okRetrieve = async () => ({ status: 'SUCCESS', content: 'ok', error: null });

test('diagnostics: every legacy result key is still present with its legacy value; discoveryDiagnostics is purely additive', async () => {
  const result = await acquireSources({ provider: new StubProvider(candidates(2)), query: 'q', policy: policyWith(), retrieveImpl: okRetrieve });
  for (const k of LEGACY_KEYS) assert.ok(k in result, k);
  assert.deepEqual(Object.keys(result).sort(), [...LEGACY_KEYS, 'discoveryDiagnostics'].sort());
  assert.equal(result.acquired.length, 2);
  assert.equal(result.attemptsUsed, 2);
  assert.equal(result.candidatesConsidered, 2);
  assert.equal(result.candidatesExhausted, true);
  assert.equal(result.discoveryFailed, false);
  assert.equal(result.discoveryError, null);
  assert.equal(result.discoveryDiagnostics.outcome, 'candidates_returned');
  assert.equal(result.discoveryDiagnostics.provider, 'stub');
  assert.equal(result.discoveryDiagnostics.candidateCount, 2);
});

test('diagnostics: zero candidates WITH a provider failure is distinguishable from a genuinely empty result, and acquisition is unchanged', async () => {
  const failing = await acquireSources({ provider: new ScriptedProvider({ candidates: [], failures: [{ error: 'Tavily HTTP 401: nope' }] }), query: 'q', policy: policyWith(), retrieveImpl: okRetrieve });
  const empty = await acquireSources({ provider: new ScriptedProvider({ candidates: [], failures: [] }), query: 'q', policy: policyWith(), retrieveImpl: okRetrieve });
  assert.equal(failing.discoveryDiagnostics.outcome, 'provider_reported_failure');
  assert.equal(failing.discoveryDiagnostics.failures[0].error, 'Tavily HTTP 401 (response body omitted)');
  assert.equal(empty.discoveryDiagnostics.outcome, 'empty_result');
  // Same observable acquisition result either way (including the legacy vacuous candidatesExhausted=true).
  assert.deepEqual(withoutDiagnostics(failing), withoutDiagnostics(empty));
  assert.equal(failing.discoveryFailed, false);
  assert.equal(failing.candidatesExhausted, true);
});

test('diagnostics: a thrown discovery keeps the raw legacy discoveryError and adds a sanitized summary', async () => {
  const err = new Error('discovery unreachable at https://h.example/x?api_key=SECRET5');
  const result = await acquireSources({ provider: new ScriptedProvider(err), query: 'q', policy: policyWith(), retrieveImpl: okRetrieve });
  assert.equal(result.discoveryFailed, true);
  assert.equal(result.discoveryError, err.message, 'legacy field is unchanged (raw)');
  assert.equal(result.discoveryDiagnostics.outcome, 'discovery_threw');
  assert.ok(!JSON.stringify(result.discoveryDiagnostics).includes('SECRET5'));
  assert.equal(result.attemptsUsed, 0);
  assert.equal(result.candidatesExhausted, false);
});

test('diagnostics: provider failures do not change retries, counters, exhaustion or the acquired list', async () => {
  const run = async (failures) => {
    let calls = 0;
    const provider = new ScriptedProvider({ candidates: candidates(20), ...(failures ? { failures } : {}) });
    const result = await acquireSources({
      provider, query: 'q',
      policy: policyWith({ acquisition: { max_sources_per_research_project: 8, max_acquisition_attempts: 12 }, retry: { max_retries_per_source: 2 } }),
      retrieveImpl: async () => { calls++; return { status: 'FAILED', content: null, error: 'boom' }; }
    });
    return { calls, result };
  };
  const plain = await run(null);
  const noisy = await run(Array.from({ length: 500 }, (_, i) => ({ error: `f${i}` })));
  assert.equal(noisy.calls, plain.calls);
  assert.equal(noisy.calls, 12);
  assert.deepEqual(withoutDiagnostics(noisy.result), withoutDiagnostics(plain.result));
  assert.equal(noisy.result.discoveryDiagnostics.failureCount, 500);
  assert.equal(noisy.result.discoveryDiagnostics.failures.length, 5);
});

test('diagnostics: malformed provider output cannot create a new failure -- acquisition proceeds exactly as before', async () => {
  const cases = [
    { candidates: candidates(2), failures: 'boom' },
    { candidates: candidates(2), failures: { error: 'not an array' } },
    { candidates: candidates(2), failures: [null, 5, {}, { error: { nested: true } }] }
  ];
  for (const raw of cases) {
    const result = await acquireSources({ provider: new ScriptedProvider(raw), query: 'q', policy: policyWith(), retrieveImpl: okRetrieve });
    assert.equal(result.acquired.length, 2, JSON.stringify(raw));
    assert.equal(result.discoveryFailed, false);
    assert.equal(result.discoveryDiagnostics.outcome, 'candidates_returned');
  }
  const empty = await acquireSources({ provider: new ScriptedProvider({}), query: 'q', policy: policyWith(), retrieveImpl: okRetrieve });
  assert.equal(empty.discoveryDiagnostics.outcome, 'empty_result');
  assert.equal(empty.acquired.length, 0);
  const wrongShape = await acquireSources({ provider: new ScriptedProvider('not an object'), query: 'q', policy: policyWith(), retrieveImpl: okRetrieve });
  assert.equal(wrongShape.discoveryFailed, false, 'legacy behaviour: a non-object response is treated as no candidates, not as a discovery failure');
  assert.equal(wrongShape.discoveryDiagnostics.outcome, 'malformed_provider_response');
});

test('diagnostics: a provider whose id getter throws is still a legacy discovery failure, and the summary degrades to provider=null', async () => {
  const result = await acquireSources({ provider: new ResearchSourceProvider(), query: 'q', policy: policyWith(), retrieveImpl: okRetrieve });
  assert.equal(result.discoveryFailed, true, 'legacy behaviour preserved');
  assert.equal(result.discoveryDiagnostics.outcome, 'discovery_threw');
  assert.equal(result.discoveryDiagnostics.provider, null);
});

test('diagnostics: the summary is plain JSON (safe to persist in decision_log and checkpoints)', async () => {
  const result = await acquireSources({ provider: new ScriptedProvider({ candidates: [], failures: [{ error: 'e' }] }), query: 'q', policy: policyWith(), retrieveImpl: okRetrieve });
  assert.deepEqual(JSON.parse(JSON.stringify(result.discoveryDiagnostics)), result.discoveryDiagnostics);
});
