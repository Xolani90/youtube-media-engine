import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GeminiProvider } from '../../src/providers/llm/GeminiProvider.js';

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
