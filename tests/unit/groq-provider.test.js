import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GroqProvider } from '../../src/providers/llm/GroqProvider.js';

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body
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

test('complete(): a non-OK HTTP response is an explicit failure, never a fabricated result', async () => {
  const fetchImpl = async () => jsonResponse(401, { error: 'invalid_api_key' });
  const provider = new GroqProvider({ fetchImpl, apiKeyProvider: () => 'bad-key' });

  await assert.rejects(() => provider.complete({ prompt: 'hi' }), /HTTP 401/);
});

test('complete(): a 200 response with no completion text is an explicit failure, never fabricated', async () => {
  const fetchImpl = async () => jsonResponse(200, { choices: [{ message: {} }] });
  const provider = new GroqProvider({ fetchImpl, apiKeyProvider: () => 'key123' });

  await assert.rejects(() => provider.complete({ prompt: 'hi' }), /no usable completion text/);
});

test('isPaid is false and id is "groq-free", matching config.llmProviderPriority\'s existing id', () => {
  const provider = new GroqProvider({ apiKeyProvider: () => 'key123' });
  assert.equal(provider.id, 'groq-free');
  assert.equal(provider.isPaid, false);
});
