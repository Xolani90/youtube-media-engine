import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FallbackResearchSourceProvider } from '../../src/providers/research/FallbackResearchSourceProvider.js';

function stubProvider(id, discoverCandidates, healthy = true) {
  return {
    id,
    healthCheck: async () => healthy,
    discoverCandidates
  };
}

test('returns primary result untouched when primary produces candidates', async () => {
  let fallbackCalled = false;
  const primary = stubProvider('primary', async () => ({
    candidates: [{ url: 'https://example.com/p', title: 'P', snippet: 'p' }],
    failures: []
  }));
  const fallback = stubProvider('fallback', async () => {
    fallbackCalled = true;
    return { candidates: [], failures: [] };
  });

  const provider = new FallbackResearchSourceProvider({ primary, fallback });
  const result = await provider.discoverCandidates({ query: 'q', maxResults: 5 });

  assert.equal(fallbackCalled, false);
  assert.deepEqual(result.candidates, [{ url: 'https://example.com/p', title: 'P', snippet: 'p' }]);
});

test('falls back when primary produces a provider-level failure (empty candidates)', async () => {
  const primary = stubProvider('primary', async () => ({
    candidates: [],
    failures: [{ error: 'primary down' }]
  }));
  const fallback = stubProvider('fallback', async () => ({
    candidates: [{ url: 'https://example.com/f', title: 'F', snippet: 'f' }],
    failures: []
  }));

  const provider = new FallbackResearchSourceProvider({ primary, fallback });
  const result = await provider.discoverCandidates({ query: 'q', maxResults: 5 });

  assert.deepEqual(result.candidates, [{ url: 'https://example.com/f', title: 'F', snippet: 'f' }]);
  assert.deepEqual(result.failures, [{ error: 'primary down' }]);
});

test('falls back when primary resolves with an unusable (empty, no-error) result', async () => {
  const primary = stubProvider('primary', async () => ({ candidates: [], failures: [] }));
  const fallback = stubProvider('fallback', async () => ({
    candidates: [{ url: 'https://example.com/f', title: 'F', snippet: 'f' }],
    failures: []
  }));

  const provider = new FallbackResearchSourceProvider({ primary, fallback });
  const result = await provider.discoverCandidates({ query: 'q', maxResults: 5 });

  assert.deepEqual(result.candidates, [{ url: 'https://example.com/f', title: 'F', snippet: 'f' }]);
});

test('when both primary and fallback fail, failures from both are concatenated and it never throws', async () => {
  const primary = stubProvider('primary', async () => ({
    candidates: [],
    failures: [{ error: 'primary down' }]
  }));
  const fallback = stubProvider('fallback', async () => ({
    candidates: [],
    failures: [{ error: 'fallback down' }]
  }));

  const provider = new FallbackResearchSourceProvider({ primary, fallback });
  const result = await provider.discoverCandidates({ query: 'q', maxResults: 5 });

  assert.deepEqual(result.candidates, []);
  assert.deepEqual(result.failures, [{ error: 'primary down' }, { error: 'fallback down' }]);
});

test('a hanging primary is bounded: fallback is invoked and its candidates are returned once primaryTimeoutMs elapses', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });

  let fallbackCalled = false;
  const primary = stubProvider('primary', () => new Promise(() => {})); // never settles
  const fallback = stubProvider('fallback', async () => {
    fallbackCalled = true;
    return { candidates: [{ url: 'https://example.com/f', title: 'F', snippet: 'f' }], failures: [] };
  });

  const provider = new FallbackResearchSourceProvider({ primary, fallback, primaryTimeoutMs: 5000 });
  const pending = provider.discoverCandidates({ query: 'q', maxResults: 5 });

  // Let the timer this test is about actually get registered before ticking.
  await Promise.resolve();
  await Promise.resolve();
  t.mock.timers.tick(5000);

  const result = await pending;

  assert.equal(fallbackCalled, true, 'fallback must be attempted once the primary is treated as timed out');
  assert.deepEqual(result.candidates, [{ url: 'https://example.com/f', title: 'F', snippet: 'f' }]);
});

test('a hanging primary\'s timeout is recorded as a distinct failure', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });

  const primary = stubProvider('tavily', () => new Promise(() => {})); // never settles
  const fallback = stubProvider('duckduckgo', async () => ({ candidates: [], failures: [] }));

  const provider = new FallbackResearchSourceProvider({ primary, fallback, primaryTimeoutMs: 5000 });
  const pending = provider.discoverCandidates({ query: 'q', maxResults: 5 });

  await Promise.resolve();
  await Promise.resolve();
  t.mock.timers.tick(5000);

  const result = await pending;

  assert.equal(result.failures.length, 1);
  assert.match(result.failures[0].error, /timed out/i);
  assert.equal(result.failures[0].timeout, true, 'the timeout failure must be distinguishable from an ordinary provider failure');
});

test('a primary that resolves before the timeout wins the race: its result is used and fallback is never invoked', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });

  let fallbackCalled = false;
  const primary = stubProvider('primary', async () => ({
    candidates: [{ url: 'https://example.com/p', title: 'P', snippet: 'p' }],
    failures: []
  }));
  const fallback = stubProvider('fallback', async () => {
    fallbackCalled = true;
    return { candidates: [], failures: [] };
  });

  const provider = new FallbackResearchSourceProvider({ primary, fallback, primaryTimeoutMs: 5000 });
  const result = await provider.discoverCandidates({ query: 'q', maxResults: 5 });

  assert.equal(fallbackCalled, false, 'fallback must not run when the primary settles before its timeout');
  assert.deepEqual(result.candidates, [{ url: 'https://example.com/p', title: 'P', snippet: 'p' }]);
});

test('id composes both wrapped providers\' ids', () => {
  const primary = stubProvider('tavily', async () => ({}));
  const fallback = stubProvider('duckduckgo', async () => ({}));
  const provider = new FallbackResearchSourceProvider({ primary, fallback });
  assert.equal(provider.id, 'tavily+duckduckgo-fallback');
});