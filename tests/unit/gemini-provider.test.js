import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { GeminiProvider, createPacingState, sharedPacingState } from '../../src/providers/llm/GeminiProvider.js';
import { LLMRouter } from '../../src/providers/llm/router.js';
import { REGISTRY } from '../../src/providers/llm/candidates.js';
import { createVirtualClock, createPacingRig, gaps } from '../helpers/virtualClock.js';
import { resetProviderHealth, isProviderCoolingDown, providerCooldownRemainingMs } from '../../src/providers/llm/providerHealth.js';

// Phase 1 (provider cooldown/health-memory) shares process-wide state with
// every other test file's provider/router tests (module-level singleton).
// Reset before each test in this file so a cooldown recorded by one test
// never leaks into the next.
beforeEach(() => {
  resetProviderHealth();
});

// Pacing seam for tests that only care about retry/response behavior: a
// virtual monotonic clock that advances whenever the pacing gate waits, so
// the gate's post-wake re-check sees consistent time. Retry delays still go
// through each test's own (recording) sleepImpl.
function virtualPacing() {
  const clock = createVirtualClock();
  return { nowImpl: clock.now, pacingSleepImpl: clock.sleep };
}
// A clock that has always advanced past the pacing floor since the previous
// read: for tests about timeouts, where pacing is irrelevant.
function farClock() {
  let t = 0;
  return () => (t += 10_000);
}

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
  const provider = new GeminiProvider({ fetchImpl, apiKeyProvider: () => 'key123', sleepImpl, ...virtualPacing() });

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
  const provider = new GeminiProvider({ fetchImpl, apiKeyProvider: () => 'key123', sleepImpl, ...virtualPacing() });

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
  const provider = new GeminiProvider({ fetchImpl, apiKeyProvider: () => 'key123', sleepImpl, ...virtualPacing() });

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
  const provider = new GeminiProvider({ fetchImpl, apiKeyProvider: () => 'key123', sleepImpl, ...virtualPacing() });

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
  const provider = new GeminiProvider({ fetchImpl, apiKeyProvider: () => 'key123', sleepImpl, ...virtualPacing() });

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
  const provider = new GeminiProvider({ fetchImpl, apiKeyProvider: () => 'key123', sleepImpl, ...virtualPacing() });

  await provider.complete({ prompt: 'hi' });

  assert.deepEqual(sleepCalls, [9500], 'the "Please retry in 9.5s" message text must produce a 9500ms delay');
});

test('complete(): a non-JSON error body is preserved as a bounded text diagnostic, never an enormous exception', async () => {
  const hugeBody = 'x'.repeat(10_000);
  const fetchImpl = async () => textResponse(503, hugeBody);
  // 503 is retried; inject the sleeps (retry delay + pacing) so nothing waits in real time.
  const provider = new GeminiProvider({ fetchImpl, apiKeyProvider: () => 'key123', sleepImpl: async () => {}, ...virtualPacing() });

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
  const rig = createPacingRig();
  const provider = new GeminiProvider({ fetchImpl: rig.wrapFetch(async () => okResponse()), apiKeyProvider: () => 'key123', ...rig.opts });

  await provider.complete({ prompt: 'first' });
  await rig.clock.sleep(1000); // only 1s elapses before the next call starts
  rig.pacingCalls.length = 0;
  await provider.complete({ prompt: 'second' });

  assert.deepEqual(rig.pacingCalls, [3500], 'one pacing wait: the remaining 3.5s of the 4.5s floor (4500 - 1000 elapsed)');
  assert.deepEqual(gaps(rig.starts), [4500], 'actual request starts are exactly the floor apart');
});

test('pacing: a request issued after the 4.5s floor has already elapsed is not delayed', async () => {
  const rig = createPacingRig();
  const provider = new GeminiProvider({ fetchImpl: rig.wrapFetch(async () => okResponse()), apiKeyProvider: () => 'key123', ...rig.opts });

  await provider.complete({ prompt: 'first' });
  await rig.clock.sleep(5000); // already past the 4.5s minimum interval
  await provider.complete({ prompt: 'second' });

  assert.deepEqual(rig.pacingCalls, [], 'no pacing wait once the minimum interval has already passed');
  assert.deepEqual(gaps(rig.starts), [5000]);
});

test('pacing: three consecutive requests each respect the 4.5s floor relative to the previous request', async () => {
  const rig = createPacingRig();
  const provider = new GeminiProvider({ fetchImpl: rig.wrapFetch(async () => okResponse()), apiKeyProvider: () => 'key123', ...rig.opts });

  await provider.complete({ prompt: 'a' }); // t0, no wait
  await rig.clock.sleep(2000);
  await provider.complete({ prompt: 'b' }); // must wait 2500 to reach the floor
  await rig.clock.sleep(4500);
  await provider.complete({ prompt: 'c' }); // already clear of the floor, no wait

  assert.deepEqual(rig.pacingCalls, [2500], 'only the second request needed to wait');
  assert.ok(gaps(rig.starts).every((g) => g >= 4500));
});

// Contract change (Pass 31). This test used to assert "pacing added no extra
// wait here" for a retry -- the defect: the retry HTTP attempt bypassed the
// pacing floor. Every retry attempt is now subject to the global 4500ms
// request-start floor, on top of (not instead of) its own retry delay.
test('pacing: every retry HTTP attempt is subject to the global 4500ms request-start floor, in addition to the unchanged retry delay', async () => {
  let fetchCalls = 0;
  const fetchImpl = async () => {
    fetchCalls++;
    // Call 1 (first complete()) succeeds. Call 2 (second complete()'s first
    // attempt) is a 429 with Retry-After 1s; call 3 (its retry) succeeds.
    if (fetchCalls === 2) {
      return jsonResponse(429, { error: { message: 'RESOURCE_EXHAUSTED' } }, { 'retry-after': '1' });
    }
    return fetchCalls === 1 ? okResponse('ok') : okResponse('Retried successfully.');
  };
  const rig = createPacingRig();
  const provider = new GeminiProvider({ fetchImpl: rig.wrapFetch(fetchImpl), apiKeyProvider: () => 'key123', ...rig.opts });

  const first = await provider.complete({ prompt: 'a' });
  assert.equal(first.text, 'ok', 'default okResponse() text');
  assert.deepEqual(rig.pacingCalls, [], 'first call: no pacing wait, no retry needed');

  await rig.clock.sleep(4500); // second call's first attempt starts exactly at the floor: no wait
  const second = await provider.complete({ prompt: 'b' });

  assert.equal(fetchCalls, 3, 'first call: 1 fetch; second call: 429 then retry = 2 fetches');
  assert.deepEqual(rig.sleepCalls, [1000], 'the retry delay itself is unchanged: derived from Retry-After, not the pacing floor');
  assert.deepEqual(rig.pacingCalls, [3500], 'the retry attempt waited the rest of the floor (4500 - the 1000ms retry delay)');
  assert.ok(gaps(rig.starts).every((g) => g >= 4500), `all request-start gaps >= 4500, got ${JSON.stringify(gaps(rig.starts))}`);
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
  // A timeout/abort is now retried exactly once (bounded transient retry);
  // sleepImpl is injected so the 1s backoff never waits in real time.
  const provider = new GeminiProvider({ fetchImpl, apiKeyProvider: () => 'key123', sleepImpl: async () => {}, nowImpl: farClock() });

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
  assert.equal(capturedSignal.aborted, true, 'the request signal must be aborted once GEMINI_REQUEST_TIMEOUT_MS elapses');

  // The single bounded retry then starts a fresh request with its own
  // 120s timeout; when that also times out the call rejects (no third try).
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  t.mock.timers.tick(120000);
  await pending;
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
  const provider = new GeminiProvider({ fetchImpl, apiKeyProvider: () => 'key123', sleepImpl, ...virtualPacing() });

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
  const provider = new GeminiProvider({ fetchImpl, apiKeyProvider: () => 'key123', sleepImpl, ...virtualPacing() });

  await assert.rejects(() => provider.complete({ prompt: 'hi' }), /HTTP 429/);
  assert.equal(fetchCalls, 2, 'still exactly two attempts (MAX_ATTEMPTS_ON_429 unchanged)');
  assert.equal(sleepCalls.length, 1, 'still exactly one retry sleep, unchanged');
  assert.deepEqual(sleepCalls, [5000], 'Retry-After parsing unchanged');
});

// Observability: Gemini's `candidates[0].finishReason` is surfaced as
// `finishReason` when present; otherwise the result shape is unchanged.
test('complete(): exposes candidates[0].finishReason as finishReason when Gemini reports one', async () => {
  const fetchImpl = async () => jsonResponse(200, {
    responseId: 'req-max',
    modelVersion: 'gemini-3.5-flash-lite',
    candidates: [{ content: { parts: [{ text: '[{"claim":"trunc' }] }, finishReason: 'MAX_TOKENS' }],
    usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 4 }
  });
  const provider = new GeminiProvider({ fetchImpl, apiKeyProvider: () => 'key123', sleepImpl: async () => {} });

  const result = await provider.complete({ prompt: 'hi' });

  assert.equal(result.finishReason, 'MAX_TOKENS');
  assert.equal(result.text, '[{"claim":"trunc');
});

test('complete(): no finishReason in the response -> no finishReason key, rest of the result unchanged', async () => {
  const fetchImpl = async () => jsonResponse(200, {
    responseId: 'req-nofr',
    modelVersion: 'gemini-3.5-flash-lite',
    candidates: [{ content: { parts: [{ text: 'ok' }] } }],
    usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 }
  });
  const provider = new GeminiProvider({ fetchImpl, apiKeyProvider: () => 'key123', sleepImpl: async () => {} });

  const result = await provider.complete({ prompt: 'hi' });

  assert.equal('finishReason' in result, false);
  assert.deepEqual(result, {
    text: 'ok', model: 'gemini-3.5-flash-lite', requestId: 'req-nofr',
    inputTokens: 1, outputTokens: 1, estimatedCost: 0, isPaid: false
  });
});

// --- Pacing across per-call provider instances (LLMRouter) ----------------
// LLMRouter builds a NEW provider from its registry factory for every
// complete() call, so pacing held on the instance never applied in a real
// run (the first call of a fresh instance is never delayed). Pacing state
// must therefore be shareable.

function routerWith(pacingStateFor, rig) {
  return new LLMRouter({
    priority: ['gemini-free'],
    allowPaidProviders: false,
    registry: {
      'gemini-free': () => new GeminiProvider({
        fetchImpl: rig.wrapFetch(async () => okResponse()),
        apiKeyProvider: () => 'key123',
        ...rig.opts,
        ...pacingStateFor()
      })
    }
  });
}

test('pacing: regression -- providers created per call WITHOUT shared state are never paced', async () => {
  const rig = createPacingRig();
  const router = routerWith(() => ({}), rig);
  await router.complete({ prompt: 'a' });
  await router.complete({ prompt: 'b' });
  await router.complete({ prompt: 'c' });
  assert.deepEqual(rig.pacingCalls, [], 'documents the original defect: every call is a first call on a fresh instance');
});

test('pacing: providers created per call by the router share one pacing state, so back-to-back router calls wait the 4.5s floor', async () => {
  const rig = createPacingRig();
  const shared = createPacingState();
  const router = routerWith(() => ({ pacingState: shared }), rig);
  await router.complete({ prompt: 'a' });
  await router.complete({ prompt: 'b' });
  await router.complete({ prompt: 'c' });
  assert.deepEqual(rig.pacingCalls, [4500, 4500], 'first call free; the next two each wait out the full floor');
  assert.deepEqual(gaps(rig.starts), [4500, 4500]);
});

test('pacing: the production registry factory hands every instance the same shared pacing state', () => {
  const a = REGISTRY['gemini-free']();
  const b = REGISTRY['gemini-free']();
  assert.notEqual(a, b, 'the router really does get distinct instances');
  assert.equal(a._pacing, sharedPacingState);
  assert.equal(b._pacing, sharedPacingState);
});

test('pacing: a provider constructed without pacingState keeps private state (no cross-instance leakage in unit tests)', () => {
  const a = new GeminiProvider({ apiKeyProvider: () => 'k' });
  const b = new GeminiProvider({ apiKeyProvider: () => 'k' });
  assert.notEqual(a._pacing, b._pacing);
  assert.notEqual(a._pacing, sharedPacingState);
});
