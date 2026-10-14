import { test } from 'node:test';
import assert from 'node:assert/strict';
import { acquireSources } from '../../src/research/acquisition.js';

const policy = {
  acquisition: { max_sources_per_research_project: 3, max_acquisition_attempts: 6 },
  retry: { max_retries_per_source: 1 }
};

test('ZC1. zero candidates with provider failures: failures are surfaced, discovery is not marked failed', async () => {
  const provider = { id: 'fake', async discoverCandidates() { return { candidates: [], failures: [{ error: 'Tavily HTTP 429' }, { error: 'network error' }] }; } };
  const r = await acquireSources({ provider, query: 'q', policy });
  assert.equal(r.candidatesConsidered, 0);
  assert.equal(r.discoveryFailed, false);
  assert.deepEqual(r.discoveryFailures, ['Tavily HTTP 429', 'network error']);
});

test('ZC2. zero candidates and no failures: empty discoveryFailures', async () => {
  const provider = { id: 'fake', async discoverCandidates() { return { candidates: [], failures: [] }; } };
  const r = await acquireSources({ provider, query: 'q', policy });
  assert.equal(r.candidatesConsidered, 0);
  assert.deepEqual(r.discoveryFailures, []);
});

test('ZC3. at most 5 failure messages are kept', async () => {
  const provider = { id: 'fake', async discoverCandidates() { return { candidates: [], failures: Array.from({ length: 9 }, (_, i) => ({ error: 'e' + i })) }; } };
  const r = await acquireSources({ provider, query: 'q', policy });
  assert.equal(r.discoveryFailures.length, 5);
});
