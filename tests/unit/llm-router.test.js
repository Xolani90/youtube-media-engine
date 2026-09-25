import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { LLMRouter } from '../../src/providers/llm/router.js';
import { LLMProvider } from '../../src/providers/llm/LLMProvider.js';
import { REGISTRY } from '../../src/providers/llm/candidates.js';
import { resetProviderHealth, recordProviderRateLimit } from '../../src/providers/llm/providerHealth.js';

// Phase 1 (provider cooldown/health-memory) tests below share this
// process-wide cooldown state with every other test file's router tests
// (module-level singleton, same reasoning as runWorkloadDiagnostics.js).
// Reset before each test in THIS file so cooldowns recorded by one test
// never leak into the next.
beforeEach(() => {
  resetProviderHealth();
});

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

test('failover 3b: first provider times out (AbortError, the shape a stalled fetch now rejects with) -> second provider succeeds', async () => {
  const timeoutErr = new Error('The operation was aborted.');
  timeoutErr.name = 'AbortError';
  const timingOut = new FakeThrowingHealthy('groq-free', timeoutErr);
  const router = new LLMRouter({
    priority: ['groq-free', 'gemini-free'],
    allowPaidProviders: false,
    registry: {
      'groq-free': () => timingOut,
      'gemini-free': () => new FakeHealthyFree()
    }
  });

  const { providerUsed } = await router.complete({ prompt: 'hi' });
  assert.equal(providerUsed, 'fake-free');
  assert.equal(timingOut.completeCallCount, 1);
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

// Like FakeHealthyFree, but with an injectable id -- needed for the
// Phase 1 tests below, which must distinguish 'groq-free' from
// 'gemini-free' both by registry key AND by the provider.id the router
// reports back as `providerUsed` (see LLMRouter#complete's return shape).
class FakeHealthyWithId extends LLMProvider {
  constructor(id) {
    super();
    this._id = id;
    this.completeCallCount = 0;
  }
  get id() { return this._id; }
  get isPaid() { return false; }
  async healthCheck() { return true; }
  async complete() {
    this.completeCallCount += 1;
    return { text: 'ok', model: 'fake', requestId: null, inputTokens: 1, outputTokens: 1, estimatedCost: 0, isPaid: false };
  }
}

// --- Phase 1: provider cooldown / health-memory. These exercise the
// router's eligibility check against providerHealth.js directly (via
// recordProviderRateLimit), rather than through a real 429 -- GroqProvider
// and GeminiProvider's own "an exhausted 429 retry records a cooldown"
// behavior is covered in their own test files. ---

test('Phase 1 / Test B: a cooled-down provider is skipped without a network call; router selects the next eligible provider, preserving priority among the rest', async () => {
  recordProviderRateLimit('groq-free', 30000); // Groq cooling down for 30s from now
  const groq = new FakeHealthyWithId('groq-free');
  const gemini = new FakeHealthyWithId('gemini-free');
  const router = new LLMRouter({
    priority: ['groq-free', 'gemini-free'],
    allowPaidProviders: false,
    registry: {
      'groq-free': () => groq,
      'gemini-free': () => gemini
    }
  });

  const { providerUsed, attempted } = await router.complete({ prompt: 'hi' });
  assert.equal(providerUsed, 'gemini-free');
  assert.equal(groq.completeCallCount, 0, 'a cooling-down provider must never have complete() called');
  assert.equal(attempted.length, 1);
  assert.equal(attempted[0].id, 'groq-free');
  assert.match(attempted[0].skipped, /cooling down/);
});

test('Phase 1 / Test C: once a cooldown has expired, the provider is eligible again', async () => {
  const now = Date.now();
  recordProviderRateLimit('groq-free', 10, now - 1000); // cooldownUntil = now - 990, already in the past
  const groq = new FakeHealthyWithId('groq-free');
  const router = new LLMRouter({
    priority: ['groq-free'],
    allowPaidProviders: false,
    registry: { 'groq-free': () => groq }
  });

  const { providerUsed } = await router.complete({ prompt: 'hi' });
  assert.equal(providerUsed, 'groq-free');
  assert.equal(groq.completeCallCount, 1);
});

test('Phase 1 / Test D: every eligible provider cooling down fails fast with a useful error, no sleeping or retry loop', async () => {
  recordProviderRateLimit('groq-free', 30000);
  recordProviderRateLimit('gemini-free', 30000);
  const router = new LLMRouter({
    priority: ['groq-free', 'gemini-free'],
    allowPaidProviders: false,
    registry: {
      'groq-free': () => new FakeHealthyWithId('groq-free'),
      'gemini-free': () => new FakeHealthyWithId('gemini-free')
    }
  });

  const startedAt = Date.now();
  await assert.rejects(
    () => router.complete({ prompt: 'hi' }),
    /No usable LLM provider.*groq-free: cooling down.*gemini-free: cooling down/s
  );
  // Fails fast -- does not sleep until either cooldown expires.
  assert.ok(Date.now() - startedAt < 1000);
});

// --- Provider-unavailable classification (aggregate `llmProviderUnavailable`
// flag on the "all eligible providers failed" error). Only a failure set
// that is entirely transient (AbortError timeout / exhausted 429) may set
// this flag; any explicit non-transient HTTP status or arbitrary unexpected
// exception must keep it false so callers never treat those as a safe
// per-candidate skip. ---

test('provider-unavailable A: a real AbortError (timeout) failure is classified as provider-unavailable', async () => {
  const timeoutErr = new Error('The operation was aborted.');
  timeoutErr.name = 'AbortError';
  const timingOut = new FakeThrowingHealthy('groq-free', timeoutErr);
  const router = new LLMRouter({
    priority: ['groq-free'],
    allowPaidProviders: false,
    registry: { 'groq-free': () => timingOut }
  });

  try {
    await router.complete({ prompt: 'hi' });
    assert.fail('expected router.complete() to reject');
  } catch (err) {
    assert.equal(err.llmProviderUnavailable, true);
    assert.deepEqual(err.providerFailures, [
      { id: 'groq-free', error: timeoutErr.message, transient: true }
    ]);
  }
});

test('provider-unavailable B: an exhausted 429 (err.status === 429) remains eligible for provider-unavailable classification', async () => {
  const err429 = Object.assign(new Error('rate limited'), { status: 429 });
  const rateLimited = new FakeThrowingHealthy('groq-free', err429);
  const router = new LLMRouter({
    priority: ['groq-free'],
    allowPaidProviders: false,
    registry: { 'groq-free': () => rateLimited }
  });

  try {
    await router.complete({ prompt: 'hi' });
    assert.fail('expected router.complete() to reject');
  } catch (err) {
    assert.equal(err.llmProviderUnavailable, true);
    assert.equal(err.providerFailures[0].transient, true);
  }
});

test('provider-unavailable C: a real failure carrying status 401 is NOT classified as provider-unavailable and propagates', async () => {
  const err401 = Object.assign(new Error('unauthorized'), { status: 401 });
  const unauthorized = new FakeThrowingHealthy('groq-free', err401);
  const router = new LLMRouter({
    priority: ['groq-free'],
    allowPaidProviders: false,
    registry: { 'groq-free': () => unauthorized }
  });

  try {
    await router.complete({ prompt: 'hi' });
    assert.fail('expected router.complete() to reject');
  } catch (err) {
    assert.equal(err.llmProviderUnavailable, false);
    assert.equal(err.providerFailures[0].transient, false);
    assert.match(err.message, /unauthorized/);
  }
});

test('provider-unavailable D: an explicit 400/403 (or equivalent non-transient HTTP status) is NOT classified as provider-unavailable', async () => {
  const err400 = Object.assign(new Error('bad request'), { status: 400 });
  const err403 = Object.assign(new Error('forbidden'), { status: 403 });
  const badRequest = new FakeThrowingHealthy('groq-free', err400);
  const forbidden = new FakeThrowingHealthy('gemini-free', err403);
  const router = new LLMRouter({
    priority: ['groq-free', 'gemini-free'],
    allowPaidProviders: false,
    registry: {
      'groq-free': () => badRequest,
      'gemini-free': () => forbidden
    }
  });

  try {
    await router.complete({ prompt: 'hi' });
    assert.fail('expected router.complete() to reject');
  } catch (err) {
    assert.equal(err.llmProviderUnavailable, false);
    assert.equal(err.providerFailures.every((f) => f.transient === false), true);
  }
});

test('provider-unavailable E: an unexpected exception (e.g. TypeError) inside provider.complete() is NOT silently classified as provider-unavailable', async () => {
  const bug = new TypeError("Cannot read properties of undefined (reading 'foo')");
  const buggy = new FakeThrowingHealthy('groq-free', bug);
  const router = new LLMRouter({
    priority: ['groq-free'],
    allowPaidProviders: false,
    registry: { 'groq-free': () => buggy }
  });

  try {
    await router.complete({ prompt: 'hi' });
    assert.fail('expected router.complete() to reject');
  } catch (err) {
    assert.equal(err.llmProviderUnavailable, false);
    assert.equal(err.providerFailures[0].transient, false);
  }
});

test('provider-unavailable: a mix of one transient and one non-transient failure is NOT classified as provider-unavailable (a real failure must never be masked by a co-occurring transient one)', async () => {
  const timeoutErr = new Error('The operation was aborted.');
  timeoutErr.name = 'AbortError';
  const err401 = Object.assign(new Error('unauthorized'), { status: 401 });
  const timingOut = new FakeThrowingHealthy('groq-free', timeoutErr);
  const unauthorized = new FakeThrowingHealthy('gemini-free', err401);
  const router = new LLMRouter({
    priority: ['groq-free', 'gemini-free'],
    allowPaidProviders: false,
    registry: {
      'groq-free': () => timingOut,
      'gemini-free': () => unauthorized
    }
  });

  try {
    await router.complete({ prompt: 'hi' });
    assert.fail('expected router.complete() to reject');
  } catch (err) {
    assert.equal(err.llmProviderUnavailable, false);
  }
});

test('Phase 1 / Test J: with both providers healthy (no cooldown), normal priority ordering is unaffected', async () => {
  const groq = new FakeHealthyWithId('groq-free');
  const gemini = new FakeHealthyWithId('gemini-free');
  const router = new LLMRouter({
    priority: ['groq-free', 'gemini-free'],
    allowPaidProviders: false,
    registry: {
      'groq-free': () => groq,
      'gemini-free': () => gemini
    }
  });

  const { providerUsed } = await router.complete({ prompt: 'hi' });
  assert.equal(providerUsed, 'groq-free');
  assert.equal(gemini.completeCallCount, 0);
});