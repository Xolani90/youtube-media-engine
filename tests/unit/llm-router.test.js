import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LLMRouter } from '../../src/providers/llm/router.js';
import { LLMProvider } from '../../src/providers/llm/LLMProvider.js';
import { REGISTRY } from '../../src/providers/llm/candidates.js';

class FakeHealthyFree extends LLMProvider {
  constructor() {
    super();
    this.completeCallCount = 0;
  }
  get id() { return 'fake-free'; }
  get isPaid() { return false; }
  async healthCheck() { return true; }
  async complete() {
    this.completeCallCount += 1;
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

// Healthy (eligible) provider whose complete() throws -- distinct from
// FakeUnhealthyFree, which is ruled out at the health-check stage and so
// never reaches complete() at all.
class FakeThrowingHealthy extends LLMProvider {
  constructor(id, err) {
    super();
    this._id = id;
    this._err = err;
    this.completeCallCount = 0;
  }
  get id() { return this._id; }
  get isPaid() { return false; }
  async healthCheck() { return true; }
  async complete() {
    this.completeCallCount += 1;
    throw this._err;
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

// F2-L1 regression: an UnconfiguredProvider (openrouter-free/deepseek-paid
// via the real REGISTRY) must never be selected just because its
// *_API_KEY env var happens to be set -- it has no live implementation, so
// complete() always throws. Before the fix, a present env var made
// healthCheck() return true, so the router would select it and then hard-
// fail instead of falling through to a genuinely usable provider.
// (gemini-free was the UnconfiguredProvider this regression test originally
// exercised; it now has a real GeminiProvider implementation -- see
// GeminiProvider.js and gemini-provider.test.js -- so this test uses
// openrouter-free, still an UnconfiguredProvider, to keep covering the
// same router behavior.)
test('F2-L1: an unimplemented provider with its API key env var set is NOT selected, and the router falls through to the next eligible provider', async () => {
  const envKey = 'OPENROUTER_FREE_API_KEY';
  const hadKey = Object.prototype.hasOwnProperty.call(process.env, envKey);
  const previousValue = process.env[envKey];
  process.env[envKey] = 'sk-not-a-real-key-just-present';

  try {
    const { providerUsed, attempted } = await new LLMRouter({
      priority: ['openrouter-free', 'fake-free'],
      allowPaidProviders: false,
      registry: {
        'openrouter-free': REGISTRY['openrouter-free'],
        'fake-free': () => new FakeHealthyFree()
      }
    }).complete({ prompt: 'hi' });

    // The real, unimplemented openrouter-free stub was skipped despite its
    // key being present, and the router moved on to the next eligible
    // provider.
    assert.equal(providerUsed, 'fake-free');
    assert.deepEqual(attempted, [
      { id: 'openrouter-free', skipped: 'failed health check (missing key or quota exhausted)' }
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

// --- Failover: complete() throwing for a selected (healthy/eligible)
// provider should move on to the next eligible provider, rather than
// stopping at the first provider that passed its health check. ---

test('failover 1: first provider succeeds -> no fallback is attempted', async () => {
  const first = new FakeHealthyFree();
  const second = new FakeHealthyFree();
  const router = new LLMRouter({
    priority: ['fake-free', 'fake-free-2'],
    allowPaidProviders: false,
    registry: {
      'fake-free': () => first,
      'fake-free-2': () => second
    }
  });

  const { providerUsed } = await router.complete({ prompt: 'hi' });
  assert.equal(providerUsed, 'fake-free');
  // Eligibility (health-check) is evaluated for the full priority list,
  // but complete() itself must only ever be invoked on the provider
  // actually used -- the second provider's complete() is never reached.
  assert.equal(second.completeCallCount, 0);
});

test('failover 2: first provider throws a 429 -> second provider succeeds', async () => {
  const err = Object.assign(new Error('rate limited'), { status: 429 });
  const failing = new FakeThrowingHealthy('groq-free', err);
  const router = new LLMRouter({
    priority: ['groq-free', 'gemini-free'],
    allowPaidProviders: false,
    registry: {
      'groq-free': () => failing,
      'gemini-free': () => new FakeHealthyFree()
    }
  });

  const { result, providerUsed } = await router.complete({ prompt: 'hi' });
  assert.equal(providerUsed, 'fake-free');
  assert.equal(result.text, 'ok');
  assert.equal(failing.completeCallCount, 1);
});

test('failover 3: first provider throws a generic error -> second provider succeeds', async () => {
  const failing = new FakeThrowingHealthy('groq-free', new Error('boom'));
  const router = new LLMRouter({
    priority: ['groq-free', 'gemini-free'],
    allowPaidProviders: false,
    registry: {
      'groq-free': () => failing,
      'gemini-free': () => new FakeHealthyFree()
    }
  });

  const { providerUsed } = await router.complete({ prompt: 'hi' });
  assert.equal(providerUsed, 'fake-free');
  assert.equal(failing.completeCallCount, 1);
});

test('failover 4: all eligible providers fail -> failure propagates with failure detail', async () => {
  const first = new FakeThrowingHealthy('groq-free', new Error('boom-1'));
  const second = new FakeThrowingHealthy('gemini-free', new Error('boom-2'));
  const router = new LLMRouter({
    priority: ['groq-free', 'gemini-free'],
    allowPaidProviders: false,
    registry: {
      'groq-free': () => first,
      'gemini-free': () => second
    }
  });

  await assert.rejects(
    () => router.complete({ prompt: 'hi' }),
    /All eligible LLM providers failed.*groq-free: boom-1.*gemini-free: boom-2/s
  );
  assert.equal(first.completeCallCount, 1);
  assert.equal(second.completeCallCount, 1);
});

test('failover 5: providers without valid credentials (failed health check) remain skipped, never retried, and are not counted as failover attempts', async () => {
  const unhealthy = new FakeUnhealthyFree();
  const healthy = new FakeHealthyFree();
  const router = new LLMRouter({
    priority: ['fake-unhealthy', 'fake-free'],
    allowPaidProviders: false,
    registry: {
      'fake-unhealthy': () => unhealthy,
      'fake-free': () => healthy
    }
  });

  const { providerUsed, attempted } = await router.complete({ prompt: 'hi' });
  assert.equal(providerUsed, 'fake-free');
  assert.deepEqual(attempted, [
    { id: 'fake-unhealthy', skipped: 'failed health check (missing key or quota exhausted)' }
  ]);
});