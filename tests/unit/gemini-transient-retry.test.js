import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { GeminiProvider } from '../../src/providers/llm/GeminiProvider.js';
import { createVirtualClock } from '../helpers/virtualClock.js';
import { resetProviderHealth } from '../../src/providers/llm/providerHealth.js';

beforeEach(() => resetProviderHealth());

function jsonResponse(status, body, headers = {}) {
  const text = JSON.stringify(body);
  return { ok: status >= 200 && status < 300, status, headers: new Headers(headers), json: async () => body, text: async () => text };
}
const ok = (text = 'hello') => jsonResponse(200, {
  responseId: 'r', modelVersion: 'm',
  candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }],
  usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 }
});
const err = (status, headers) => jsonResponse(status, { error: { code: status, message: `boom ${status}` } }, headers);

function make(responses) {
  const sleeps = [];
  let calls = 0;
  const fetchImpl = async () => {
    const r = responses[Math.min(calls, responses.length - 1)];
    calls++;
    if (r instanceof Error) throw r;
    return r;
  };
  // Retry delays are recorded via sleepImpl; pacing waits go through their own
  // seam on a virtual clock, so `sleeps` still holds ONLY retry delays.
  const clock = createVirtualClock();
  const provider = new GeminiProvider({
    fetchImpl, apiKeyProvider: () => 'k', sleepImpl: async (ms) => { sleeps.push(ms); },
    nowImpl: clock.now, pacingSleepImpl: clock.sleep
  });
  return { provider, sleeps, calls: () => calls };
}

for (const status of [500, 502, 503, 504]) {
  test(`HTTP ${status} then 200 succeeds after one backoff retry`, async () => {
    const { provider, sleeps, calls } = make([err(status), ok('fine')]);
    const out = await provider.complete({ prompt: 'p' });
    assert.equal(out.text, 'fine');
    assert.equal(calls(), 2);
    assert.deepEqual(sleeps, [1000]);
  });
}

test('persistent 503 is retried exactly twice (3 attempts) with 1s then 2s backoff, then throws', async () => {
  const { provider, sleeps, calls } = make([err(503)]);
  await assert.rejects(() => provider.complete({ prompt: 'p' }), (e) => e.status === 503);
  assert.equal(calls(), 3);
  assert.deepEqual(sleeps, [1000, 2000]);
});

test('Retry-After on a 503 is honored; one larger than the 30s cap is not waited on', async () => {
  const a = make([err(503, { 'retry-after': '7' }), ok()]);
  await a.provider.complete({ prompt: 'p' });
  assert.deepEqual(a.sleeps, [7000]);

  const b = make([err(503, { 'retry-after': '120' }), ok()]);
  await assert.rejects(() => b.provider.complete({ prompt: 'p' }), (e) => e.status === 503);
  assert.equal(b.calls(), 1, 'no impractically long wait; the request fails instead');
  assert.deepEqual(b.sleeps, []);
});

test('abort / timeout / network failure is retried exactly once, then the error surfaces', async () => {
  const abort = Object.assign(new Error('This operation was aborted'), { name: 'AbortError' });
  const first = make([abort, ok('recovered')]);
  assert.equal((await first.provider.complete({ prompt: 'p' })).text, 'recovered');
  assert.equal(first.calls(), 2);

  const netErr = new TypeError('fetch failed');
  const second = make([netErr]);
  await assert.rejects(() => second.provider.complete({ prompt: 'p' }), /fetch failed/);
  assert.equal(second.calls(), 2, 'one retry only');
  assert.deepEqual(second.sleeps, [1000]);
});

test('deterministic client errors are never retried', async () => {
  for (const status of [400, 401, 403, 404]) {
    const { provider, calls, sleeps } = make([err(status)]);
    await assert.rejects(() => provider.complete({ prompt: 'p' }), (e) => e.status === status);
    assert.equal(calls(), 1, `HTTP ${status} must not be retried`);
    assert.deepEqual(sleeps, []);
  }
});

test('non-network programming errors from fetch are not retried', async () => {
  const { provider, calls } = make([new RangeError('bad')]);
  await assert.rejects(() => provider.complete({ prompt: 'p' }), /bad/);
  assert.equal(calls(), 1);
});

test('429 behavior is unchanged: exactly one retry, independent of the transient budgets', async () => {
  const { provider, calls } = make([err(429, { 'retry-after': '1' })]);
  await assert.rejects(() => provider.complete({ prompt: 'p' }), (e) => e.status === 429);
  assert.equal(calls(), 2);
});

test('an empty completion throws a machine-readable EMPTY_COMPLETION error carrying finishReason', async () => {
  const empty = jsonResponse(200, { candidates: [{ content: { parts: [] }, finishReason: 'MAX_TOKENS' }] });
  const { provider } = make([empty]);
  await assert.rejects(() => provider.complete({ prompt: 'p' }), (e) => e.code === 'EMPTY_COMPLETION' && e.finishReason === 'MAX_TOKENS');
});
