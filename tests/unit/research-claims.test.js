import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractClaims, validateExtractedClaim } from '../../src/research/claims.js';
import { LLMRouter } from '../../src/providers/llm/router.js';

function stubRouter(responseText) {
  const registry = {
    'claim-stub': () => ({
      id: 'claim-stub', isPaid: false,
      async healthCheck() { return true; },
      async complete() {
        return { text: responseText, model: 'claim-stub', requestId: null, inputTokens: 1, outputTokens: 1, estimatedCost: 0, isPaid: false };
      }
    })
  };
  return new LLMRouter({ priority: ['claim-stub'], allowPaidProviders: false, registry });
}

test('validateExtractedClaim accepts a well-formed claim', () => {
  const result = validateExtractedClaim({ claim: 'The product launched in March.', claim_type: 'FACT', is_load_bearing: true });
  assert.equal(result.valid, true);
});

test('validateExtractedClaim rejects missing/empty claim text', () => {
  assert.equal(validateExtractedClaim({ claim: '', claim_type: 'FACT', is_load_bearing: true }).valid, false);
  assert.equal(validateExtractedClaim({ claim_type: 'FACT', is_load_bearing: true }).valid, false);
});

test('validateExtractedClaim rejects an invalid claim_type (old four-value vocabulary must not slip through)', () => {
  const result = validateExtractedClaim({ claim: 'x', claim_type: 'verified_fact', is_load_bearing: true });
  assert.equal(result.valid, false);
  assert.match(result.reason, /claim_type/);
});

test('validateExtractedClaim rejects a non-boolean is_load_bearing', () => {
  const result = validateExtractedClaim({ claim: 'x', claim_type: 'FACT', is_load_bearing: 'yes' });
  assert.equal(result.valid, false);
  assert.match(result.reason, /is_load_bearing/);
});

test('extractClaims parses a well-formed LLM claim array', async () => {
  const router = stubRouter(JSON.stringify([
    { claim: 'The company reported $1B revenue.', claim_type: 'FACT', is_load_bearing: true },
    { claim: 'Analysts think this is impressive.', claim_type: 'OPINION', is_load_bearing: false }
  ]));
  const { claims, providerUsed } = await extractClaims({ sourceText: 'text', coreQuestion: 'q' }, router);
  assert.equal(providerUsed, 'claim-stub');
  assert.equal(claims.length, 2);
  assert.equal(validateExtractedClaim(claims[0]).valid, true);
  assert.equal(validateExtractedClaim(claims[1]).valid, true);
});

test('extractClaims never asks the LLM for evidence_status (Generation must not include evidentiary self-certification)', async () => {
  let capturedPrompt = null;
  const registry = {
    'capture-stub': () => ({
      id: 'capture-stub', isPaid: false,
      async healthCheck() { return true; },
      async complete({ prompt }) {
        capturedPrompt = prompt;
        return { text: '[]', model: 'capture-stub', requestId: null, inputTokens: 1, outputTokens: 1, estimatedCost: 0, isPaid: false };
      }
    })
  };
  const router = new LLMRouter({ priority: ['capture-stub'], allowPaidProviders: false, registry });
  await extractClaims({ sourceText: 'text', coreQuestion: 'q' }, router);
  assert.match(capturedPrompt, /not.*evidence/i);
});

test('unparseable LLM output yields an empty claim array deterministically, no throw', async () => {
  const router = stubRouter('not json');
  const { claims } = await extractClaims({ sourceText: 'text', coreQuestion: 'q' }, router);
  assert.deepEqual(claims, []);
});

test('a non-array LLM output is treated as no claims, not an error', async () => {
  const router = stubRouter(JSON.stringify({ claim: 'not an array' }));
  const { claims } = await extractClaims({ sourceText: 'text', coreQuestion: 'q' }, router);
  assert.deepEqual(claims, []);
});

// --- Markdown-fenced JSON (real Groq/openai-gpt-oss-20b observed shape) ---

const SAMPLE_CLAIM_ARRAY = JSON.stringify([
  { claim: 'Acme reported one billion dollars in Q3 revenue following the product launch.', claim_type: 'FACT', is_load_bearing: true }
]);

test('bare JSON (no fence) still parses exactly as before', async () => {
  const router = stubRouter(SAMPLE_CLAIM_ARRAY);
  const { claims } = await extractClaims({ sourceText: 'text', coreQuestion: 'q' }, router);
  assert.equal(claims.length, 1);
  assert.equal(claims[0].claim, 'Acme reported one billion dollars in Q3 revenue following the product launch.');
});

test('a claim array wrapped in exactly one ```json fence parses', async () => {
  const router = stubRouter('```json\n' + SAMPLE_CLAIM_ARRAY + '\n```');
  const { claims, rawOutput } = await extractClaims({ sourceText: 'text', coreQuestion: 'q' }, router);
  assert.equal(claims.length, 1);
  assert.equal(claims[0].claim_type, 'FACT');
  assert.equal(claims[0].is_load_bearing, true);
  // rawOutput must still be the exact, unmodified model output.
  assert.equal(rawOutput, '```json\n' + SAMPLE_CLAIM_ARRAY + '\n```');
});

test('a claim array wrapped in exactly one ```JSON (uppercase tag) fence parses', async () => {
  const router = stubRouter('```JSON\n' + SAMPLE_CLAIM_ARRAY + '\n```');
  const { claims } = await extractClaims({ sourceText: 'text', coreQuestion: 'q' }, router);
  assert.equal(claims.length, 1);
});

test('a claim array wrapped in a bare ``` fence (no language tag) parses', async () => {
  const router = stubRouter('```\n' + SAMPLE_CLAIM_ARRAY + '\n```');
  const { claims } = await extractClaims({ sourceText: 'text', coreQuestion: 'q' }, router);
  assert.equal(claims.length, 1);
});

test('leading/trailing whitespace around a complete fenced response is tolerated', async () => {
  const router = stubRouter('  \n```json\n' + SAMPLE_CLAIM_ARRAY + '\n```\n  ');
  const { claims } = await extractClaims({ sourceText: 'text', coreQuestion: 'q' }, router);
  assert.equal(claims.length, 1);
});

test('the exact live Groq shape (trailing blank line before the closing fence) parses', async () => {
  // Mirrors the literal shape observed from the real groq-free/openai-gpt-oss-20b
  // response: a blank line between the JSON payload and the closing fence.
  const router = stubRouter('```json\n' + SAMPLE_CLAIM_ARRAY + '\n\n```');
  const { claims } = await extractClaims({ sourceText: 'text', coreQuestion: 'q' }, router);
  assert.equal(claims.length, 1);
  assert.equal(claims[0].claim, 'Acme reported one billion dollars in Q3 revenue following the product launch.');
});

test('prose before a fenced JSON block is rejected (no substring extraction)', async () => {
  const router = stubRouter('Here is the JSON:\n```json\n' + SAMPLE_CLAIM_ARRAY + '\n```');
  const { claims } = await extractClaims({ sourceText: 'text', coreQuestion: 'q' }, router);
  assert.deepEqual(claims, []);
});

test('prose after a fenced JSON block is rejected (no substring extraction)', async () => {
  const router = stubRouter('```json\n' + SAMPLE_CLAIM_ARRAY + '\n```\nHope that helps!');
  const { claims } = await extractClaims({ sourceText: 'text', coreQuestion: 'q' }, router);
  assert.deepEqual(claims, []);
});

test('an unclosed fence is rejected', async () => {
  const router = stubRouter('```json\n' + SAMPLE_CLAIM_ARRAY);
  const { claims } = await extractClaims({ sourceText: 'text', coreQuestion: 'q' }, router);
  assert.deepEqual(claims, []);
});

test('fenced malformed JSON is rejected', async () => {
  const router = stubRouter('```json\n{not valid json at all\n```');
  const { claims } = await extractClaims({ sourceText: 'text', coreQuestion: 'q' }, router);
  assert.deepEqual(claims, []);
});

test('fenced JSON with a non-array root is rejected, same as the unfenced case', async () => {
  const router = stubRouter('```json\n' + JSON.stringify({ claim: 'not an array' }) + '\n```');
  const { claims } = await extractClaims({ sourceText: 'text', coreQuestion: 'q' }, router);
  assert.deepEqual(claims, []);
});