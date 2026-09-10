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