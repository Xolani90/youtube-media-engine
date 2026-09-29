import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { extractClaims, EXTRACTION_REASONING_EFFORT, EXTRACTION_PARSE_OUTCOME } from '../../src/research/claims.js';
import { LLMRouter } from '../../src/providers/llm/router.js';
import { GroqProvider } from '../../src/providers/llm/GroqProvider.js';
import { GeminiProvider } from '../../src/providers/llm/GeminiProvider.js';
import { resetProviderHealth } from '../../src/providers/llm/providerHealth.js';

// Controlled experiment: claim extraction (and ONLY claim extraction) asks
// for reasoning_effort=low. These tests pin (1) where that parameter is and
// is not sent, and (2) that extraction behaves exactly as before apart from
// that one request parameter. They do NOT, and cannot, show that Groq's
// behavior changes -- that needs a live call.

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

// Real GroqProvider behind the real LLMRouter; only the network is faked.
// `groqResponse` is the 200 body Groq "returns".
function groqRouter(groqResponse) {
  const bodies = [];
  const fetchImpl = async (_url, init) => {
    bodies.push(JSON.parse(init.body));
    return jsonResponse(200, groqResponse);
  };
  const registry = { 'groq-free': () => new GroqProvider({ fetchImpl, apiKeyProvider: () => 'key123' }) };
  const router = new LLMRouter({ priority: ['groq-free'], allowPaidProviders: false, registry });
  return { router, bodies };
}

const GROQ_LENGTH_EMPTY = {
  id: 'req-len',
  model: 'openai/gpt-oss-20b',
  choices: [{ message: { content: '' }, finish_reason: 'length' }],
  usage: { prompt_tokens: 2456, completion_tokens: 2048 }
};

const TWO_CLAIMS = JSON.stringify([
  { claim: 'The company reported $1B revenue.', claim_type: 'FACT', is_load_bearing: true },
  { claim: 'Analysts think this is impressive.', claim_type: 'OPINION', is_load_bearing: false }
]);

const GROQ_STOP_PARSEABLE = {
  id: 'req-stop',
  model: 'openai/gpt-oss-20b',
  choices: [{ message: { content: TWO_CLAIMS }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 2456, completion_tokens: 180 }
};

test('the experiment constant is exactly "low"', () => {
  assert.equal(EXTRACTION_REASONING_EFFORT, 'low');
});

test('extractClaims sends exactly { prompt, reasoningEffort } to the router: no maxTokens, no system, nothing else', async () => {
  const seen = [];
  const registry = {
    'spy': () => ({
      id: 'spy', isPaid: false,
      async healthCheck() { return true; },
      async complete(request) {
        seen.push(request);
        return { text: '[]', model: 'spy', requestId: null, inputTokens: 1, outputTokens: 1, estimatedCost: 0, isPaid: false };
      }
    })
  };
  const router = new LLMRouter({ priority: ['spy'], allowPaidProviders: false, registry });

  await extractClaims({ sourceText: 'text', coreQuestion: 'q' }, router);

  assert.equal(seen.length, 1);
  assert.deepEqual(Object.keys(seen[0]).sort(), ['prompt', 'reasoningEffort']);
  assert.equal(seen[0].reasoningEffort, 'low');
  assert.equal(typeof seen[0].prompt, 'string');
});

test('end to end: an extraction request reaches Groq with reasoning_effort=low and no max_tokens', async () => {
  const { router, bodies } = groqRouter(GROQ_STOP_PARSEABLE);

  await extractClaims({ sourceText: 'text', coreQuestion: 'q' }, router);

  assert.equal(bodies.length, 1);
  assert.deepEqual(Object.keys(bodies[0]).sort(), ['messages', 'model', 'reasoning_effort']);
  assert.equal(bodies[0].reasoning_effort, 'low');
  assert.equal(bodies[0].model, 'openai/gpt-oss-20b');
  assert.equal(Object.hasOwn(bodies[0], 'max_tokens'), false, 'maxTokens handling is unchanged: extraction still sets none');
});

test('end to end: non-extraction requests through the same router never carry reasoning_effort', async () => {
  const { router, bodies } = groqRouter(GROQ_STOP_PARSEABLE);

  // Same shapes the other real callers use (brief/script: { prompt };
  // proposition: { prompt, maxTokens }; dedup/features likewise).
  await router.complete({ prompt: 'brief-like' });
  await router.complete({ prompt: 'proposition-like', maxTokens: 1000 });
  await router.complete({ prompt: 'dedup-like', maxTokens: 250 });

  assert.equal(bodies.length, 3);
  for (const body of bodies) {
    assert.equal(Object.hasOwn(body, 'reasoning_effort'), false);
  }
  assert.equal(bodies[1].max_tokens, 1000);
  assert.equal(bodies[2].max_tokens, 250);
});

test('source guard: only claims.js (sets it) and GroqProvider.js (maps it) mention reasoningEffort / reasoning_effort', () => {
  const srcRoot = join(process.cwd(), 'src');
  const hits = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.(js|mjs)$/.test(name) && /reasoning_?[Ee]ffort/.test(readFileSync(full, 'utf8'))) {
        hits.push(relative(srcRoot, full).split('\\').join('/'));
      }
    }
  };
  walk(srcRoot);
  assert.deepEqual(hits.sort(), ['providers/llm/GroqProvider.js', 'research/claims.js']);
});

test('extraction behavior is unchanged: the observed Groq failure shape (length, empty content) still becomes zero claims, classified, no throw', async () => {
  const { router } = groqRouter(GROQ_LENGTH_EMPTY);

  const out = await extractClaims({ sourceText: 'text', coreQuestion: 'q' }, router);

  assert.deepEqual(out.claims, []);
  assert.equal(out.providerUsed, 'groq-free');
  assert.deepEqual(out.diagnostics, {
    provider: 'groq-free',
    model: 'openai/gpt-oss-20b',
    inputTokens: 2456,
    outputTokens: 2048,
    contentLength: 0,
    finishReason: 'length',
    parseOutcome: EXTRACTION_PARSE_OUTCOME.EMPTY_CONTENT,
    proposedClaimCount: 0
  });
});

test('extraction behavior is unchanged: a stop/parseable Groq response still yields the same claims, diagnostics and result fields', async () => {
  const { router } = groqRouter(GROQ_STOP_PARSEABLE);

  const out = await extractClaims({ sourceText: 'text', coreQuestion: 'q' }, router);

  assert.equal(out.claims.length, 2);
  assert.equal(out.claims[0].claim_type, 'FACT');
  assert.equal(out.claims[1].claim_type, 'OPINION');
  assert.equal(out.rawOutput, TWO_CLAIMS);
  assert.equal(out.estimatedCost, 0);
  assert.equal(out.isPaid, false);
  assert.deepEqual(out.diagnostics, {
    provider: 'groq-free',
    model: 'openai/gpt-oss-20b',
    inputTokens: 2456,
    outputTokens: 180,
    contentLength: TWO_CLAIMS.length,
    finishReason: 'stop',
    parseOutcome: EXTRACTION_PARSE_OUTCOME.PARSED_CLAIMS,
    proposedClaimCount: 2
  });
});

test('Gemini is unaffected: its request body is byte-identical with and without reasoningEffort', async () => {
  const bodies = [];
  const fetchImpl = async (_url, init) => {
    bodies.push(init.body);
    return jsonResponse(200, {
      candidates: [{ content: { parts: [{ text: '[]' }] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 }
    });
  };
  const noSleep = async () => {};
  const make = () => new GeminiProvider({ fetchImpl, apiKeyProvider: () => 'key123', sleepImpl: noSleep });

  await make().complete({ prompt: 'same prompt' });
  await make().complete({ prompt: 'same prompt', reasoningEffort: 'low' });

  assert.equal(bodies.length, 2);
  assert.equal(bodies[0], bodies[1]);
  assert.equal(bodies[1].includes('reasoning'), false);
});
