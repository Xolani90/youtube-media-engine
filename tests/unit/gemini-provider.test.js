import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { GeminiProvider } from '../../src/providers/llm/GeminiProvider.js';
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

  const withKey = new GeminiProvider({ fetchImpl, apiKeyProvider: () => 'key123' });
  assert.equal(await withKey.healthCheck(), true);

  const withoutKey = new GeminiProvider({ fetchImpl, apiKeyProvider: () => undefined });
  assert.equal(await withoutKey.healthCheck(), false);

  assert.equal(fetchCalls, 0, 'healthCheck must never perform a network call');
});

test('complete(): missing API key fails safely and explicitly, no network call', async () => {
  let fetchCalls = 0;
  const fetchImpl = async () => { fetchCalls++; throw new Error('should not be called'); };
  const provider = new GeminiProvider({ fetchImpl, apiKeyProvider: () => undefined });

  await assert.rejects(
    () => provider.complete({ prompt: 'hi' }),
    /GEMINI_FREE_API_KEY/
  );
  assert.equal(fetchCalls, 0);
});

test('complete(): constructs a well-formed request and maps a real-shaped response into the LLMProvider contract', async () => {
  let capturedUrl, capturedInit;
  const fetchImpl = async (url, init) => {
    capturedUrl = url;
    capturedInit = init;
    return jsonResponse(200, {
      responseId: 'req-abc',
      modelVersion: 'gemini-3.5-flash-lite',
      candidates: [{ content: { parts: [{ text: 'Hello from Gemini.' }] } }],
      usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 4 }
    });
  };
  const provider = new GeminiProvider({ fetchImpl, apiKeyProvider: () => 'key123' });

  const result = await provider.complete({ prompt: 'hi', system: 'be terse', maxTokens: 50 });

  assert.equal(capturedUrl, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent');
  assert.equal(capturedInit.headers['x-goog-api-key'], 'key123');
  const sentBody = JSON.parse(capturedInit.body);
  assert.deepEqual(sentBody.contents, [{ role: 'user', parts: [{ text: 'hi' }] }]);
  assert.deepEqual(sentBody.system_instruction, { parts: [{ text: 'be terse' }] });
  assert.equal(sentBody.generationConfig.maxOutputTokens, 50);

  assert.deepEqual(result, {
    text: 'Hello from Gemini.',
    model: 'gemini-3.5-flash-lite',
    requestId: 'req-abc',
    inputTokens: 5,
    outputTokens: 4,
    estimatedCost: 0,
    isPaid: false
  });
});

test('complete(): a non-OK, non-429 HTTP response is an explicit failure after exactly one attempt, never retried', async () => {
  let fetchCalls = 0;
  const fetchImpl = async () => { fetchCalls++; return jsonResponse(401, { error: { message: 'API key not valid' } }); };
  const provider = new GeminiProvider({ fetchImpl, apiKeyProvider: () => 'bad-key' });

  await assert.rejects(() => provider.complete({ prompt: 'hi' }), /HTTP 401/);
  assert.equal(fetchCalls, 1, '401 must not be retried');
});

test('complete(): a persistent 429 is retried exactly once, then throws with diagnostics from the final attempt', async () => {
  let fetchCalls = 0;
  const fetchImpl = async () => {
    fetchCalls++;
    return jsonResponse(
      429,
      { error: { code: 429, message: 'Resource has been exhausted', status: 'RESOURCE_EXHAUSTED' } },
      { 'retry-after': '12' }
    );
  };
  const sleepCalls = [];
  const sleepImpl = async (ms) => { sleepCalls.push(ms); };
  const provider = new GeminiProvider({ fetchImpl, apiKeyProvider: () => 'key123', sleepImpl });

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
  assert.match(caught.message, /Resource has been exhausted/);
  assert.equal(caught.status, 429);
  assert.equal(caught.retryAfter, '12');
  assert.deepEqual(caught.providerBody, {
    error: { code: 429, message: 'Resource has been exhausted', status: 'RESOURCE_EXHAUSTED' }
  });
});

test('complete(): a transient 429 followed by a 200 succeeds on the retry, using the second response', async () => {
  let fetchCalls = 0;
  const fetchImpl = async () => {
    fetchCalls++;
    if (fetchCalls === 1) {
      return jsonResponse(429, { error: { message: 'RESOURCE_EXHAUSTED' } }, { 'retry-after': '1' });
    }
    return jsonResponse(200, {
      responseId: 'req-retry-success',
      modelVersion: 'gemini-3.5-flash-lite',
      candidates: [{ content: { parts: [{ text: 'Second attempt succeeded.' }] } }],
      usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2 }
    });
  };
  const sleepCalls = [];
  const sleepImpl = async (ms) => { sleepCalls.push(ms); };
  const provider = new GeminiProvider({ fetchImpl, apiKeyProvider: () => 'key123', sleepImpl });

  const result = await provider.complete({ prompt: 'hi' });

  assert.equal(fetchCalls, 2, 'exactly two attempts: the initial 429 and the successful retry');
  assert.equal(sleepCalls.length, 1, 'the retry delay was awaited exactly once');
  assert.equal(result.text, 'Second attempt succeeded.');
  assert.equal(result.requestId, 'req-retry-success');
});

test('complete(): the 429 retry delay is derived from a present Retry-After header, not the fallback', async () => {
  let fetchCalls = 0;
  const fetchImpl = async () => {
    fetchCalls++;
    if (fetchCalls === 1) {
      return jsonResponse(429, { error: { message: 'RESOURCE_EXHAUSTED' } }, { 'retry-after': '3' });
    }
    return jsonResponse(200, {
      candidates: [{ content: { parts: [{ text: 'ok' }] } }],
      usageMetadata: {}
    });
  };
  const sleepCalls = [];
  const sleepImpl = async (ms) => { sleepCalls.push(ms); };
  const provider = new GeminiProvider({ fetchImpl, apiKeyProvider: () => 'key123', sleepImpl });

  await provider.complete({ prompt: 'hi' });

  assert.deepEqual(sleepCalls, [3000], 'Retry-After: 3 must produce a 3000ms delay, derived from the header');
});

test('complete(): a 429 with no Retry-After header falls back to the fixed bounded delay', async () => {
  let fetchCalls = 0;
  const fetchImpl = async () => {
    fetchCalls++;
    if (fetchCalls === 1) {
      return jsonResponse(429, { error: { message: 'RESOURCE_EXHAUSTED' } });
    }
    return jsonResponse(200, {
      candidates: [{ content: { parts: [{ text: 'ok' }] } }],
      usageMetadata: {}
    });
  };
  const sleepCalls = [];
  const sleepImpl = async (ms) => { sleepCalls.push(ms); };
  const provider = new GeminiProvider({ fetchImpl, apiKeyProvider: () => 'key123', sleepImpl });

  await provider.complete({ prompt: 'hi' });

  assert.equal(sleepCalls.length, 1);
  assert.ok(sleepCalls[0] > 0, 'a fixed, positive fallback delay must be used when Retry-After is absent');
});

// Gemini does not send a Retry-After header (confirmed against a real
// scheduled-workflow 429: retryAfter came back null). Its actual retry
// guidance instead arrives as a `google.rpc.RetryInfo` detail entry in the
// JSON body -- this must be honored so the retry doesn't fire too early
// and immediately hit the same quota window again.
test('complete(): a 429 with no Retry-After header uses Gemini\'s own RetryInfo detail, not the fixed fallback', async () => {
  let fetchCalls = 0;
  const fetchImpl = async () => {
    fetchCalls++;
    if (fetchCalls === 1) {
      return jsonResponse(429, {
        error: {
          code: 429,
          message: 'You exceeded your current quota, please check your plan and billing details.\n' +
            '* Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, ' +
            'limit: 15, model: gemini-3.5-flash-lite\nPlease retry in 6.203550290s.',
          status: 'RESOURCE_EXHAUSTED',
          details: [
            { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '6.203550290s' }
          ]
        }
      });
    }
    return jsonResponse(200, {
      candidates: [{ content: { parts: [{ text: 'ok' }] } }],
      usageMetadata: {}
    });
  };
  const sleepCalls = [];
  const sleepImpl = async (ms) => { sleepCalls.push(ms); };
  const provider = new GeminiProvider({ fetchImpl, apiKeyProvider: () => 'key123', sleepImpl });

  await provider.complete({ prompt: 'hi' });

  assert.deepEqual(sleepCalls, [6203.55029], 'RetryInfo.retryDelay ("6.203550290s") must produce a ~6203ms delay');
});

// Fallback within Gemini's own body: no RetryInfo detail at all, only the
// "Please retry in Ns." text inside error.message.
test('complete(): a 429 with no RetryInfo detail falls back to parsing "Please retry in Ns" from the message', async () => {
  let fetchCalls = 0;
  const fetchImpl = async () => {
    fetchCalls++;
    if (fetchCalls === 1) {
      return jsonResponse(429, {
        error: {
          message: 'You exceeded your current quota.\nPlease retry in 9.5s.',
          status: 'RESOURCE_EXHAUSTED'
        }
      });
    }
    return jsonResponse(200, {
      candidates: [{ content: { parts: [{ text: 'ok' }] } }],
      usageMetadata: {}
    });
  };
  const sleepCalls = [];
  const sleepImpl = async (ms) => { sleepCalls.push(ms); };
  const provider = new GeminiProvider({ fetchImpl, apiKeyProvider: () => 'key123', sleepImpl });

  await provider.complete({ prompt: 'hi' });

  assert.deepEqual(sleepCalls, [9500], 'the "Please retry in 9.5s" message text must produce a 9500ms delay');
});

test('complete(): a non-JSON error body is preserved as a bounded text diagnostic, never an enormous exception', async () => {
  const hugeBody = 'x'.repeat(10_000);
  const fetchImpl = async () => textResponse(503, hugeBody);
  const provider = new GeminiProvider({ fetchImpl, apiKeyProvider: () => 'key123' });

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
  assert.equal(typeof caught.providerBody, 'string');
  assert.ok(
    caught.providerBody.length < hugeBody.length,
    'a huge non-JSON body must be bounded, not attached in full'
  );
});

test('complete(): a 200 response with no completion text is an explicit failure, never fabricated', async () => {
  const fetchImpl = async () => jsonResponse(200, { candidates: [{ content: { parts: [{ text: '' }] } }] });
  const provider = new GeminiProvider({ fetchImpl, apiKeyProvider: () => 'key123' });

  await assert.rejects(() => provider.complete({ prompt: 'hi' }), /no usable completion text/);
});

test('isPaid is false and id is "gemini-free", matching config.llmProviderPriority\'s existing id', () => {
  const provider = new GeminiProvider({ apiKeyProvider: () => 'key123' });
  assert.equal(provider.id, 'gemini-free');
  assert.equal(provider.isPaid, false);
});

// --- Pacing (provider-local rate limiter, ~13 req/min, 4.5s floor) -------

function okResponse(text = 'ok') {
  return jsonResponse(200, {
    responseId: 'req-pacing',
    modelVersion: 'gemini-3.5-flash-lite',
    candidates: [{ content: { parts: [{ text }] } }],
    usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 }
  });
}

test('pacing: the first request is never delayed', async () => {
  const fetchImpl = async () => okResponse();
  const sleepCalls = [];
  const sleepImpl = async (ms) => { sleepCalls.push(ms); };
  // nowImpl is irrelevant for a first call -- fixed value just to make
  // this deterministic and avoid any dependency on the real clock.
  const provider = new GeminiProvider({
    fetchImpl, apiKeyProvider: () => 'key123', sleepImpl, nowImpl: () => 1_000_000
  });

  await provider.complete({ prompt: 'hi' });

  assert.equal(sleepCalls.length, 0, 'no pacing delay before the very first request on a fresh instance');
});

test('pacing: a second request issued immediately after the first waits out the remainder of the 4.5s floor', async () => {
  const fetchImpl = async () => okResponse();
  const sleepCalls = [];
  const sleepImpl = async (ms) => { sleepCalls.push(ms); };
  // Simulates the two complete() calls starting 1000ms apart in real time.
  let now = 1_000_000;
  const nowImpl = () => now;
  const provider = new GeminiProvider({ fetchImpl, apiKeyProvider: () => 'key123', sleepImpl, nowImpl });

  await provider.complete({ prompt: 'first' });
  now += 1000; // only 1s has elapsed before the next call starts
  await provider.complete({ prompt: 'second' });

  assert.equal(sleepCalls.length, 1, 'exactly one pacing delay before the second request');
  assert.equal(sleepCalls[0], 3500, 'waits the remaining 3.5s of the 4.5s floor (4500 - 1000 elapsed)');
});

test('pacing: a request issued after the 4.5s floor has already elapsed is not delayed', async () => {
  const fetchImpl = async () => okResponse();
  const sleepCalls = [];
  const sleepImpl = async (ms) => { sleepCalls.push(ms); };
  let now = 1_000_000;
  const nowImpl = () => now;
  const provider = new GeminiProvider({ fetchImpl, apiKeyProvider: () => 'key123', sleepImpl, nowImpl });

  await provider.complete({ prompt: 'first' });
  now += 5000; // 5s elapsed -- already past the 4.5s minimum interval
  await provider.complete({ prompt: 'second' });

  assert.equal(sleepCalls.length, 0, 'no pacing delay once the minimum interval has already passed');
});

test('pacing: three consecutive requests each respect the 4.5s floor relative to the previous request', async () => {
  const fetchImpl = async () => okResponse();
  const sleepCalls = [];
  const sleepImpl = async (ms) => { sleepCalls.push(ms); };
  let now = 0;
  const nowImpl = () => now;
  const provider = new GeminiProvider({ fetchImpl, apiKeyProvider: () => 'key123', sleepImpl, nowImpl });

  await provider.complete({ prompt: 'a' }); // t=0, no wait
  now += 2000; // t=2000
  await provider.complete({ prompt: 'b' }); // must wait 2500 to reach t=4500
  now += 4500; // simulate that the wait elapsed, then more time passes -- t=9000
  await provider.complete({ prompt: 'c' }); // already past floor since t=4500, no wait

  assert.deepEqual(sleepCalls, [2500], 'only the second request needed to wait; the third was already clear of the floor');
});

test('pacing: does not interfere with the existing 429 retry -- retry delay and pacing delay are both honored', async () => {
  let fetchCalls = 0;
  const fetchImpl = async () => {
    fetchCalls++;
    // Call 1 (first complete()) succeeds outright. Call 2 (second
    // complete()'s first attempt) is a 429; call 3 (its retry) succeeds.
    if (fetchCalls === 2) {
      return jsonResponse(429, { error: { message: 'RESOURCE_EXHAUSTED' } }, { 'retry-after': '1' });
    }
    return fetchCalls === 1 ? okResponse('ok') : okResponse('Retried successfully.');
  };
  const sleepCalls = [];
  const sleepImpl = async (ms) => { sleepCalls.push(ms); };
  let now = 0;
  const nowImpl = () => now;
  const provider = new GeminiProvider({ fetchImpl, apiKeyProvider: () => 'key123', sleepImpl, nowImpl });

  const first = await provider.complete({ prompt: 'a' });
  assert.equal(first.text, 'ok', 'default okResponse() text');
  assert.equal(sleepCalls.length, 0, 'first call: no pacing wait, no retry needed');

  now += 4500; // second call starts exactly at the pacing floor -- no pacing wait needed
  const second = await provider.complete({ prompt: 'b' });

  assert.equal(fetchCalls, 3, 'first call: 1 fetch; second call: 429 then retry = 2 fetches');
  assert.equal(sleepCalls.length, 1, 'only the 429 retry delay was awaited -- pacing added no extra wait here');
  assert.equal(sleepCalls[0], 1000, 'the retry delay itself is unchanged: derived from Retry-After, not the pacing floor');
  assert.equal(second.text, 'Retried successfully.');
});

test('complete(): a request that never resolves is aborted after GEMINI_REQUEST_TIMEOUT_MS (120s), rejecting instead of hanging forever', async (t) => {
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
  const provider = new GeminiProvider({ fetchImpl, apiKeyProvider: () => 'key123' });

  const pending = assert.rejects(() => provider.complete({ prompt: 'hi' }), /aborted/i);
  // Let complete()'s pacing-slot await (a real microtask hop, since this is
  // the first call on a fresh instance) resolve before the timeout timer
  // this test is about is even registered.
  await Promise.resolve();
  await Promise.resolve();

  // A genuinely hung request must NOT have been aborted yet at the old
  // 60-second mark -- this is the exact production failure (run
  // 36221741079) this fix corrects: a still-working Gemini call was killed
  // at 60s. It must still be pending here.
  t.mock.timers.tick(60000);
  assert.equal(capturedSignal.aborted, false, 'must not abort at the old 60s timeout -- a legitimate request may still be in flight');

  // ...but a request that never resolves is still bounded: it must be
  // aborted once the full, larger timeout elapses.
  t.mock.timers.tick(60000); // total elapsed: 120000ms
  await pending;

  assert.equal(capturedSignal.aborted, true, 'the request signal must be aborted once GEMINI_REQUEST_TIMEOUT_MS elapses');
});

test('complete(): a request that resolves after the old 60s timeout, but before the new 120s ceiling, completes successfully without being aborted', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });

  let capturedSignal;
  let resolveFetch;
  const fetchImpl = (url, init) => {
    capturedSignal = init.signal;
    return new Promise((resolve) => { resolveFetch = resolve; });
  };
  const provider = new GeminiProvider({ fetchImpl, apiKeyProvider: () => 'key123' });

  const pending = provider.complete({ prompt: 'hi' });
  await Promise.resolve();
  await Promise.resolve();

  // Simulate a legitimate, slower Gemini response -- e.g. the 19109-char
  // research claim-extraction prompt from run 36221741079 -- that takes
  // 90s, past the old 60s timeout but under the new 120s ceiling.
  t.mock.timers.tick(90000);
  assert.equal(capturedSignal.aborted, false, 'a legitimate 90s response must not have been aborted by the old 60s timeout');

  resolveFetch(jsonResponse(200, {
    candidates: [{ content: { parts: [{ text: 'Completed after 90s.' }] } }]
  }));

  const result = await pending;
  assert.equal(result.text, 'Completed after 90s.');
  assert.equal(capturedSignal.aborted, false, 'a request that completed within the new timeout must never be aborted');
});

// --- Phase 1: provider cooldown / health-memory ---

test('Phase 1 / Test A + I: an exhausted 429 retry records a cooldown derived from Gemini\'s own RetryInfo.retryDelay', async () => {
  const fetchImpl = async () => jsonResponse(429, {
    error: {
      code: 429,
      message: 'Resource has been exhausted. Please retry in 6.203550290s.',
      status: 'RESOURCE_EXHAUSTED',
      details: [
        { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '6.203550290s' }
      ]
    }
  }); // no Retry-After header -- forces the RetryInfo-detail path, unchanged by Phase 1
  const sleepImpl = async () => {};
  const nowImpl = () => 0; // disable the pacing-floor sleep so this test is fast/deterministic
  const provider = new GeminiProvider({ fetchImpl, apiKeyProvider: () => 'key123', sleepImpl, nowImpl });

  assert.equal(isProviderCoolingDown('gemini-free'), false, 'no cooldown before the call');
  await assert.rejects(() => provider.complete({ prompt: 'hi' }));

  assert.equal(isProviderCoolingDown('gemini-free'), true, 'cooldown recorded after exhausted 429');
  // 6.20355029s -> ~6203ms, minus a little slack for time elapsed running the test.
  assert.ok(providerCooldownRemainingMs('gemini-free') > 6000, 'cooldown reflects Gemini\'s own retryDelay, unchanged from existing parsing');
});

test('Phase 1 / Test E: an ordinary (non-429) failure does not record a cooldown', async () => {
  const fetchImpl = async () => jsonResponse(403, { error: { message: 'forbidden' } });
  const provider = new GeminiProvider({ fetchImpl, apiKeyProvider: () => 'key123' });

  await assert.rejects(() => provider.complete({ prompt: 'hi' }), /HTTP 403/);
  assert.equal(isProviderCoolingDown('gemini-free'), false);
});

test('Phase 1 / Test F: a successful call does not record a cooldown', async () => {
  const fetchImpl = async () => jsonResponse(200, {
    candidates: [{ content: { parts: [{ text: 'ok' }] } }]
  });
  const provider = new GeminiProvider({ fetchImpl, apiKeyProvider: () => 'key123' });

  await provider.complete({ prompt: 'hi' });
  assert.equal(isProviderCoolingDown('gemini-free'), false);
});

test('Phase 1 / Test G: a 200 response with no usable completion text does not record a cooldown (content validation is not a rate-limit event)', async () => {
  const fetchImpl = async () => jsonResponse(200, { candidates: [] });
  const provider = new GeminiProvider({ fetchImpl, apiKeyProvider: () => 'key123' });

  await assert.rejects(() => provider.complete({ prompt: 'hi' }), /no usable completion text/);
  assert.equal(isProviderCoolingDown('gemini-free'), false);
});

test('Phase 1: existing 429 retry/retryDelay/bounded-attempt behavior is unchanged by the cooldown addition', async () => {
  let fetchCalls = 0;
  const fetchImpl = async () => {
    fetchCalls++;
    return jsonResponse(429, { error: { message: 'still limited' } }, { 'retry-after': '5' });
  };
  const sleepCalls = [];
  const sleepImpl = async (ms) => { sleepCalls.push(ms); };
  const nowImpl = () => 0;
  const provider = new GeminiProvider({ fetchImpl, apiKeyProvider: () => 'key123', sleepImpl, nowImpl });

  await assert.rejects(() => provider.complete({ prompt: 'hi' }), /HTTP 429/);
  assert.equal(fetchCalls, 2, 'still exactly two attempts (MAX_ATTEMPTS_ON_429 unchanged)');
  assert.equal(sleepCalls.length, 1, 'still exactly one retry sleep, unchanged');
  assert.deepEqual(sleepCalls, [5000], 'Retry-After parsing unchanged');
});