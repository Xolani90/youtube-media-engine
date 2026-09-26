import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { GroqProvider } from '../../src/providers/llm/GroqProvider.js';
import { resetProviderHealth, isProviderCoolingDown, providerCooldownRemainingMs } from '../../src/providers/llm/providerHealth.js';

// Phase 1 (provider cooldown/health-memory) shares process-wide state with
// every other test file's provider/router tests (module-level singleton).
// Reset before each test in this file so a cooldown recorded by one test
// never leaks into the next.
beforeEach(() => {
  resetProviderHealth();
});

function jsonResponse(status, body, headers = {}) {
  const text = JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers),
    json: async () => body,
    text: async () => text
  };
}

// M3-B: a non-2xx response whose body is plain text, not JSON -- exercises
// GroqProvider's bounded-text fallback in buildGroqRequestError().
function textResponse(status, text, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers),
    text: async () => text
  };
}

test('healthCheck: true when an API key is configured, false when missing -- never calls the network', async () => {
  let fetchCalls = 0;
  const fetchImpl = async () => { fetchCalls++; throw new Error('should not be called'); };

  const withKey = new GroqProvider({ fetchImpl, apiKeyProvider: () => 'key123' });
  assert.equal(await withKey.healthCheck(), true);

  const withoutKey = new GroqProvider({ fetchImpl, apiKeyProvider: () => undefined });
  assert.equal(await withoutKey.healthCheck(), false);

  assert.equal(fetchCalls, 0, 'healthCheck must never perform a network call');
});

test('complete(): missing API key fails safely and explicitly, no network call', async () => {
  let fetchCalls = 0;
  const fetchImpl = async () => { fetchCalls++; throw new Error('should not be called'); };
  const provider = new GroqProvider({ fetchImpl, apiKeyProvider: () => undefined });

  await assert.rejects(
    () => provider.complete({ prompt: 'hi' }),
    /GROQ_FREE_API_KEY/
  );
  assert.equal(fetchCalls, 0);
});

test('complete(): constructs a well-formed request and maps a real-shaped response into the LLMProvider contract', async () => {
  let capturedUrl, capturedInit;
  const fetchImpl = async (url, init) => {
    capturedUrl = url;
    capturedInit = init;
    return jsonResponse(200, {
      id: 'req-abc',
      model: 'llama-3.1-8b-instant',
      choices: [{ message: { content: 'Hello from Groq.' } }],
      usage: { prompt_tokens: 5, completion_tokens: 4 }
    });
  };
  const provider = new GroqProvider({ fetchImpl, apiKeyProvider: () => 'key123' });

  const result = await provider.complete({ prompt: 'hi', system: 'be terse', maxTokens: 50 });

  assert.equal(capturedUrl, 'https://api.groq.com/openai/v1/chat/completions');
  assert.equal(capturedInit.headers.Authorization, 'Bearer key123');
  const sentBody = JSON.parse(capturedInit.body);
  assert.deepEqual(sentBody.messages, [
    { role: 'system', content: 'be terse' },
    { role: 'user', content: 'hi' }
  ]);
  assert.equal(sentBody.max_tokens, 50);

  assert.deepEqual(result, {
    text: 'Hello from Groq.',
    model: 'llama-3.1-8b-instant',
    requestId: 'req-abc',
    inputTokens: 5,
    outputTokens: 4,
    estimatedCost: 0,
    isPaid: false
  });
});

test('complete(): a non-OK, non-429 HTTP response is an explicit failure after exactly one attempt, never retried', async () => {
  let fetchCalls = 0;
  const fetchImpl = async () => { fetchCalls++; return jsonResponse(401, { error: 'invalid_api_key' }); };
  const provider = new GroqProvider({ fetchImpl, apiKeyProvider: () => 'bad-key' });

  await assert.rejects(() => provider.complete({ prompt: 'hi' }), /HTTP 401/);
  assert.equal(fetchCalls, 1, '401 must not be retried');
});

test('complete(): a persistent 429 is retried exactly once, then throws with diagnostics from the final attempt (M3-B)', async () => {
  let fetchCalls = 0;
  const fetchImpl = async () => {
    fetchCalls++;
    return jsonResponse(
      429,
      { error: { message: 'Rate limit reached for requests', type: 'rate_limit_exceeded' } },
      {
        'retry-after': '12',
        'x-ratelimit-limit-requests': '1000',
        'x-ratelimit-remaining-requests': '0',
        'x-ratelimit-reset-requests': '3.5s',
        'x-ratelimit-limit-tokens': '10000',
        'x-ratelimit-remaining-tokens': '9500',
        'x-ratelimit-reset-tokens': '1s'
      }
    );
  };
  const sleepCalls = [];
  const sleepImpl = async (ms) => { sleepCalls.push(ms); };
  const provider = new GroqProvider({ fetchImpl, apiKeyProvider: () => 'key123', sleepImpl });

  let caught;
  try {
    await provider.complete({ prompt: 'hi' });
  } catch (err) {
    caught = err;
  }

  assert.ok(caught, 'complete() must reject once the retry is also 429');
  assert.equal(fetchCalls, 2, 'exactly two attempts total: one retry, no third request');
  assert.equal(sleepCalls.length, 1, 'exactly one retry delay was awaited');
  assert.match(caught.message, /HTTP 429/);
  assert.match(caught.message, /Rate limit reached for requests/);
  assert.equal(caught.status, 429);
  assert.equal(caught.retryAfter, '12');
  assert.deepEqual(caught.rateLimit, {
    'x-ratelimit-limit-requests': '1000',
    'x-ratelimit-remaining-requests': '0',
    'x-ratelimit-reset-requests': '3.5s',
    'x-ratelimit-limit-tokens': '10000',
    'x-ratelimit-remaining-tokens': '9500',
    'x-ratelimit-reset-tokens': '1s'
  });
  assert.deepEqual(caught.providerBody, {
    error: { message: 'Rate limit reached for requests', type: 'rate_limit_exceeded' }
  });
});

test('complete(): a transient 429 followed by a 200 succeeds on the retry, using the second response (M3-B)', async () => {
  let fetchCalls = 0;
  const fetchImpl = async () => {
    fetchCalls++;
    if (fetchCalls === 1) {
      return jsonResponse(429, { error: 'rate_limit_exceeded' }, { 'retry-after': '1' });
    }
    return jsonResponse(200, {
      id: 'req-retry-success',
      model: 'openai/gpt-oss-20b',
      choices: [{ message: { content: 'Second attempt succeeded.' } }],
      usage: { prompt_tokens: 3, completion_tokens: 2 }
    });
  };
  const sleepCalls = [];
  const sleepImpl = async (ms) => { sleepCalls.push(ms); };
  const provider = new GroqProvider({ fetchImpl, apiKeyProvider: () => 'key123', sleepImpl });

  const result = await provider.complete({ prompt: 'hi' });

  assert.equal(fetchCalls, 2, 'exactly two attempts: the initial 429 and the successful retry');
  assert.equal(sleepCalls.length, 1, 'the retry delay was awaited exactly once');
  assert.equal(result.text, 'Second attempt succeeded.');
  assert.equal(result.requestId, 'req-retry-success');
});

test('complete(): the 429 retry delay is derived from a present Retry-After header, not the fallback (M3-B)', async () => {
  let fetchCalls = 0;
  const fetchImpl = async () => {
    fetchCalls++;
    if (fetchCalls === 1) {
      return jsonResponse(429, { error: 'rate_limit_exceeded' }, { 'retry-after': '3' });
    }
    return jsonResponse(200, {
      choices: [{ message: { content: 'ok' } }],
      usage: {}
    });
  };
  const sleepCalls = [];
  const sleepImpl = async (ms) => { sleepCalls.push(ms); };
  const provider = new GroqProvider({ fetchImpl, apiKeyProvider: () => 'key123', sleepImpl });

  await provider.complete({ prompt: 'hi' });

  assert.deepEqual(sleepCalls, [3000], 'Retry-After: 3 must produce a 3000ms delay, derived from the header');
});

test('complete(): a Retry-After below the cap is preserved unchanged', async () => {
  let fetchCalls = 0;
  const fetchImpl = async () => {
    fetchCalls++;
    if (fetchCalls === 1) {
      return jsonResponse(429, { error: 'rate_limit_exceeded' }, { 'retry-after': '5' });
    }
    return jsonResponse(200, { choices: [{ message: { content: 'ok' } }], usage: {} });
  };
  const sleepCalls = [];
  const sleepImpl = async (ms) => { sleepCalls.push(ms); };
  const provider = new GroqProvider({ fetchImpl, apiKeyProvider: () => 'key123', sleepImpl });

  await provider.complete({ prompt: 'hi' });

  assert.deepEqual(sleepCalls, [5000], 'a Retry-After of 5s (5000ms), below the cap, must be used as-is');
});

test('complete(): a Retry-After above the cap is reduced to the cap, not honored verbatim', async () => {
  let fetchCalls = 0;
  const fetchImpl = async () => {
    fetchCalls++;
    // 617s, matching the magnitude of Retry-After values observed in the
    // live run that motivated this cap -- far above any reasonable ceiling.
    if (fetchCalls === 1) {
      return jsonResponse(429, { error: 'rate_limit_exceeded' }, { 'retry-after': '617' });
    }
    return jsonResponse(200, { choices: [{ message: { content: 'ok' } }], usage: {} });
  };
  const sleepCalls = [];
  const sleepImpl = async (ms) => { sleepCalls.push(ms); };
  const provider = new GroqProvider({ fetchImpl, apiKeyProvider: () => 'key123', sleepImpl });

  await provider.complete({ prompt: 'hi' });

  assert.equal(sleepCalls.length, 1);
  assert.ok(sleepCalls[0] < 617000, 'the 617s Retry-After must be reduced, not honored verbatim');
  assert.ok(sleepCalls[0] > 0, 'the capped delay must still be a real, positive wait');
});

test('complete(): a 429 with no Retry-After header falls back to the fixed bounded delay (M3-B)', async () => {
  let fetchCalls = 0;
  const fetchImpl = async () => {
    fetchCalls++;
    if (fetchCalls === 1) {
      return jsonResponse(429, { error: 'rate_limit_exceeded' }); // no retry-after header
    }
    return jsonResponse(200, {
      choices: [{ message: { content: 'ok' } }],
      usage: {}
    });
  };
  const sleepCalls = [];
  const sleepImpl = async (ms) => { sleepCalls.push(ms); };
  const provider = new GroqProvider({ fetchImpl, apiKeyProvider: () => 'key123', sleepImpl });

  await provider.complete({ prompt: 'hi' });

  assert.equal(sleepCalls.length, 1);
  assert.ok(sleepCalls[0] > 0, 'a fixed, positive fallback delay must be used when Retry-After is absent');
});

test('complete(): a non-JSON error body is preserved as a bounded text diagnostic, never an enormous exception (M3-B)', async () => {
  const hugeBody = 'x'.repeat(10_000);
  const fetchImpl = async () => textResponse(503, hugeBody);
  const provider = new GroqProvider({ fetchImpl, apiKeyProvider: () => 'key123' });

  let caught;
  try {
    await provider.complete({ prompt: 'hi' });
  } catch (err) {
    caught = err;
  }

  assert.ok(caught, 'complete() must reject on HTTP 503');
  assert.match(caught.message, /HTTP 503/);
  assert.equal(caught.status, 503);
  assert.equal(caught.retryAfter, null);
  assert.deepEqual(caught.rateLimit, {});
  assert.equal(typeof caught.providerBody, 'string');
  assert.ok(
    caught.providerBody.length < hugeBody.length,
    'a huge non-JSON body must be bounded, not attached in full'
  );
});

test('complete(): a 200 response with no completion text is an explicit failure, never fabricated', async () => {
  const fetchImpl = async () => jsonResponse(200, { choices: [{ message: {} }] });
  const provider = new GroqProvider({ fetchImpl, apiKeyProvider: () => 'key123' });

  await assert.rejects(() => provider.complete({ prompt: 'hi' }), /no usable completion text/);
});

test('complete(): a request that never resolves is aborted after LLM_REQUEST_TIMEOUT_MS, rejecting instead of hanging forever', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });

  let capturedSignal;
  const fetchImpl = (url, init) => {
    capturedSignal = init.signal;
    // Never resolves on its own -- only settles if the request is aborted.
    return new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => {
        const err = new Error('This operation was aborted');
        err.name = 'AbortError';
        reject(err);
      });
    });
  };
  const provider = new GroqProvider({ fetchImpl, apiKeyProvider: () => 'key123' });

  const pending = assert.rejects(() => provider.complete({ prompt: 'hi' }), /aborted/i);
  t.mock.timers.tick(30000);
  await pending;

  assert.equal(capturedSignal.aborted, true, 'the request signal must be aborted once the timeout elapses');
});

test('isPaid is false and id is "groq-free", matching config.llmProviderPriority\'s existing id', () => {
  const provider = new GroqProvider({ apiKeyProvider: () => 'key123' });
  assert.equal(provider.id, 'groq-free');
  assert.equal(provider.isPaid, false);
});

// --- Phase 1: provider cooldown / health-memory ---

test('Phase 1 / Test A + H: an exhausted 429 retry records a cooldown derived from Retry-After, and cooldownUntil is in the future', async () => {
  const fetchImpl = async () => jsonResponse(
    429,
    { error: 'rate_limit_exceeded' },
    { 'retry-after': '12' }
  );
  const sleepImpl = async () => {};
  const provider = new GroqProvider({ fetchImpl, apiKeyProvider: () => 'key123', sleepImpl });

  assert.equal(isProviderCoolingDown('groq-free'), false, 'no cooldown before the call');
  await assert.rejects(() => provider.complete({ prompt: 'hi' }));

  assert.equal(isProviderCoolingDown('groq-free'), true, 'cooldown recorded after exhausted 429');
  // Retry-After: 12 -> 12000ms, minus a little slack for time elapsed running the test.
  assert.ok(providerCooldownRemainingMs('groq-free') > 11000, 'cooldown reflects the server-provided 12s delay');
});

test('Phase 1 / Test E: an ordinary (non-429) failure does not record a cooldown', async () => {
  const fetchImpl = async () => jsonResponse(401, { error: 'invalid_api_key' });
  const provider = new GroqProvider({ fetchImpl, apiKeyProvider: () => 'bad-key' });

  await assert.rejects(() => provider.complete({ prompt: 'hi' }), /HTTP 401/);
  assert.equal(isProviderCoolingDown('groq-free'), false);
});

test('Phase 1 / Test F: a successful call does not record a cooldown', async () => {
  const fetchImpl = async () => jsonResponse(200, {
    choices: [{ message: { content: 'ok' } }],
    usage: {}
  });
  const provider = new GroqProvider({ fetchImpl, apiKeyProvider: () => 'key123' });

  await provider.complete({ prompt: 'hi' });
  assert.equal(isProviderCoolingDown('groq-free'), false);
});

test('Phase 1 / Test G: a 200 response with invalid/missing completion content does not record a cooldown (content validation is not a rate-limit event)', async () => {
  const fetchImpl = async () => jsonResponse(200, { choices: [{ message: {} }] });
  const provider = new GroqProvider({ fetchImpl, apiKeyProvider: () => 'key123' });

  await assert.rejects(() => provider.complete({ prompt: 'hi' }), /no usable completion text/);
  assert.equal(isProviderCoolingDown('groq-free'), false);
});

test('Phase 1: a 429 immediately followed by a successful retry does NOT record a cooldown (provider is not "still" rate-limited)', async () => {
  let fetchCalls = 0;
  const fetchImpl = async () => {
    fetchCalls++;
    if (fetchCalls === 1) return jsonResponse(429, { error: 'rate_limit_exceeded' }, { 'retry-after': '1' });
    return jsonResponse(200, { choices: [{ message: { content: 'ok' } }], usage: {} });
  };
  const sleepImpl = async () => {};
  const provider = new GroqProvider({ fetchImpl, apiKeyProvider: () => 'key123', sleepImpl });

  await provider.complete({ prompt: 'hi' });
  assert.equal(isProviderCoolingDown('groq-free'), false);
});

test('Phase 1: existing 429 retry/Retry-After/bounded-attempt behavior is unchanged by the cooldown addition', async () => {
  let fetchCalls = 0;
  const fetchImpl = async () => {
    fetchCalls++;
    return jsonResponse(429, { error: { message: 'still limited' } }, { 'retry-after': '5' });
  };
  const sleepCalls = [];
  const sleepImpl = async (ms) => { sleepCalls.push(ms); };
  const provider = new GroqProvider({ fetchImpl, apiKeyProvider: () => 'key123', sleepImpl });

  await assert.rejects(() => provider.complete({ prompt: 'hi' }), /HTTP 429/);
  assert.equal(fetchCalls, 2, 'still exactly two attempts (MAX_ATTEMPTS_ON_429 unchanged)');
  assert.equal(sleepCalls.length, 1, 'still exactly one retry sleep, unchanged');
  assert.deepEqual(sleepCalls, [5000], 'Retry-After parsing unchanged');
});