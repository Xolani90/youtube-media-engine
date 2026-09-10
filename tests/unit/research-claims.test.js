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