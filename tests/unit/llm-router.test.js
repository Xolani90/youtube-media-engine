import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LLMRouter } from '../../src/providers/llm/router.js';
import { LLMProvider } from '../../src/providers/llm/LLMProvider.js';
import { REGISTRY } from '../../src/providers/llm/candidates.js';

class FakeHealthyFree extends LLMProvider {
  get id() { return 'fake-free'; }
  get isPaid() { return false; }
  async healthCheck() { return true; }
  async complete() {
    return { text: 'ok', model: 'fake', requestId: null, inputTokens: 1, outputTokens: 1, estimatedCost: 0, isPaid: false };
  }
}

class FakeUnhealthyFree extends LLMProvider {
  get id() { return 'fake-unhealthy'; }
  get isPaid() { return false; }
  async healthCheck() { return false; }
  async complete() { throw new Error('should not be called'); }
}

class FakePaid extends LLMProvider {
  get id() { return 'fake-paid'; }
  get isPaid() { return true; }
  async healthCheck() { return true; }
  async complete() {
    return { text: 'paid-ok', model: 'fake-paid-model', requestId: null, inputTokens: 1, outputTokens: 1, estimatedCost: 1.5, isPaid: true };
  }
}

test('selects first healthy free provider in priority order', async () => {
  const router = new LLMRouter({
    priority: ['fake-unhealthy', 'fake-free'],
    allowPaidProviders: false,
    registry: {
      'fake-unhealthy': () => new FakeUnhealthyFree(),
      'fake-free': () => new FakeHealthyFree()
    }
  });
  const { providerUsed } = await router.complete({ prompt: 'hi' });
  assert.equal(providerUsed, 'fake-free');
});

test('never uses a paid provider unless allowPaidProviders is true', async () => {
  const router = new LLMRouter({
    priority: ['fake-paid'],
    allowPaidProviders: false,
    registry: { 'fake-paid': () => new FakePaid() }
  });
  await assert.rejects(() => router.complete({ prompt: 'hi' }), /No usable LLM provider/);
});

test('uses paid provider only when explicitly allowed', async () => {
  const router = new LLMRouter({
    priority: ['fake-paid'],
    allowPaidProviders: true,
    registry: { 'fake-paid': () => new FakePaid() }
  });
  const { providerUsed } = await router.complete({ prompt: 'hi' });
  assert.equal(providerUsed, 'fake-paid');
});

test('does not silently fall through to paid when free options are exhausted', async () => {
  const router = new LLMRouter({
    priority: ['fake-unhealthy', 'fake-paid'],
    allowPaidProviders: false,
    registry: {
      'fake-unhealthy': () => new FakeUnhealthyFree(),
      'fake-paid': () => new FakePaid()
    }
  });
  await assert.rejects(() => router.complete({ prompt: 'hi' }), /No usable LLM provider/);
});

// F2-L1 regression: an UnconfiguredProvider (gemini-free/openrouter-free/
// deepseek-paid via the real REGISTRY) must never be selected just because
// its *_API_KEY env var happens to be set -- it has no live implementation,
// so complete() always throws. Before the fix, a present env var made
// healthCheck() return true, so the router would select it and then hard-
// fail instead of falling through to a genuinely usable provider.
test('F2-L1: an unimplemented provider with its API key env var set is NOT selected, and the router falls through to the next eligible provider', async () => {
  const envKey = 'GEMINI_FREE_API_KEY';
  const hadKey = Object.prototype.hasOwnProperty.call(process.env, envKey);
  const previousValue = process.env[envKey];
  process.env[envKey] = 'sk-not-a-real-key-just-present';

  try {
    const { providerUsed, attempted } = await new LLMRouter({
      priority: ['gemini-free', 'fake-free'],
      allowPaidProviders: false,
      registry: {
        'gemini-free': REGISTRY['gemini-free'],
        'fake-free': () => new FakeHealthyFree()
      }
    }).complete({ prompt: 'hi' });

    // The real, unimplemented gemini-free stub was skipped despite its key
    // being present, and the router moved on to the next eligible provider.
    assert.equal(providerUsed, 'fake-free');
    assert.deepEqual(attempted, [
      { id: 'gemini-free', skipped: 'failed health check (missing key or quota exhausted)' }
    ]);
  } finally {
    if (hadKey) {
      process.env[envKey] = previousValue;
    } else {
      delete process.env[envKey];
    }
  }
});

test('F2-L1: with no fallback provider available, an unimplemented provider with its API key set correctly produces "no usable provider" rather than selecting it and throwing from complete()', async () => {
  const envKey = 'OPENROUTER_FREE_API_KEY';
  const hadKey = Object.prototype.hasOwnProperty.call(process.env, envKey);
  const previousValue = process.env[envKey];
  process.env[envKey] = 'sk-not-a-real-key-just-present';

  try {
    await assert.rejects(
      () => new LLMRouter({
        priority: ['openrouter-free'],
        allowPaidProviders: false,
        registry: { 'openrouter-free': REGISTRY['openrouter-free'] }
      }).complete({ prompt: 'hi' }),
      /No usable LLM provider/
    );
  } finally {
    if (hadKey) {
      process.env[envKey] = previousValue;
    } else {
      delete process.env[envKey];
    }
  }
});