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
const quota429 = (retryDelay) => jsonResponse(429, {
  error: {
    code: 429,
    message: 'You exceeded your current quota.',
    status: 'RESOURCE_EXHAUSTED',
    details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay }]
  }
});

function make(responses) {
  const sleeps = [];
  let calls = 0;
  const fetchImpl = async () => responses[Math.min(calls++, responses.length - 1)];
  const clock = createVirtualClock();
  const provider = new GeminiProvider({
    fetchImpl, apiKeyProvider: () => 'k', sleepImpl: async (ms) => { sleeps.push(ms); },
    nowImpl: clock.now, pacingSleepImpl: clock.sleep
  });
  return { provider, sleeps, calls: () => calls };
}

test('429 whose retryDelay exceeds the cap (daily quota) fails fast without sleeping', async () => {
  const { provider, sleeps, calls } = make([quota429('73101s'), ok()]);
  await assert.rejects(() => provider.complete({ prompt: 'p' }), (e) => e.status === 429);
  assert.equal(calls(), 1, 'no retry is attempted');
  assert.deepEqual(sleeps, [], 'no multi-hour sleep');
});

test('429 with a short retryDelay still sleeps once and retries', async () => {
  const { provider, sleeps, calls } = make([quota429('6s'), ok('fine')]);
  const out = await provider.complete({ prompt: 'p' });
  assert.equal(out.text, 'fine');
  assert.equal(calls(), 2);
  assert.deepEqual(sleeps, [6000]);
});

test('429 exactly at the cap is still waited on', async () => {
  const { provider, sleeps } = make([quota429('30s'), ok('fine')]);
  assert.equal((await provider.complete({ prompt: 'p' })).text, 'fine');
  assert.deepEqual(sleeps, [30000]);
});
