import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectContradiction } from '../../src/research/contradictionDetector.js';
import { LLMRouter } from '../../src/providers/llm/router.js';
import { CONTRADICTION_RESULT } from '../../src/research/constants.js';

function stubRouter(responseText) {
  const registry = {
    'contradiction-stub': () => ({
      id: 'contradiction-stub', isPaid: false,
      async healthCheck() { return true; },
      async complete() {
        return { text: responseText, model: 'contradiction-stub', requestId: null, inputTokens: 1, outputTokens: 1, estimatedCost: 0, isPaid: false };
      }
    })
  };
  return new LLMRouter({ priority: ['contradiction-stub'], allowPaidProviders: false, registry });
}

function throwingRouter(message = 'provider exploded') {
  const registry = {
    'contradiction-throw': () => ({
      id: 'contradiction-throw', isPaid: false,
      async healthCheck() { return true; },
      async complete() { throw new Error(message); }
    })
  };
  return new LLMRouter({ priority: ['contradiction-throw'], allowPaidProviders: false, registry });
}

const claimA = { id: 'a', claim: 'The policy took effect in 2024.' };
const claimB = { id: 'b', claim: 'The policy did not take effect in 2024.' };

test('detectContradiction returns CONTRADICTS when the model reports a contradiction', async () => {
  const router = stubRouter(JSON.stringify({ result: 'CONTRADICTS' }));
  const outcome = await detectContradiction(claimA, claimB, router);
  assert.equal(outcome, CONTRADICTION_RESULT.CONTRADICTS);
});

test('detectContradiction returns NO_CONTRADICTION when the model reports none', async () => {
  const router = stubRouter(JSON.stringify({ result: 'NO_CONTRADICTION' }));
  const outcome = await detectContradiction(claimA, claimB, router);
  assert.equal(outcome, CONTRADICTION_RESULT.NO_CONTRADICTION);
});

test('detectContradiction returns UNCERTAIN when the model reports uncertainty', async () => {
  const router = stubRouter(JSON.stringify({ result: 'UNCERTAIN' }));
  const outcome = await detectContradiction(claimA, claimB, router);
  assert.equal(outcome, CONTRADICTION_RESULT.UNCERTAIN);
});

test('detectContradiction unwraps a fenced JSON payload (observed live-provider quirk)', async () => {
  const router = stubRouter('```json\n{"result": "CONTRADICTS"}\n```');
  const outcome = await detectContradiction(claimA, claimB, router);
  assert.equal(outcome, CONTRADICTION_RESULT.CONTRADICTS);
});

test('detectContradiction resolves to UNCERTAIN on unparseable JSON rather than inventing a contradiction', async () => {
  const router = stubRouter('not json at all');
  const outcome = await detectContradiction(claimA, claimB, router);
  assert.equal(outcome, CONTRADICTION_RESULT.UNCERTAIN);
});

test('detectContradiction resolves to UNCERTAIN on a missing/invalid result field', async () => {
  const router = stubRouter(JSON.stringify({ verdict: 'CONTRADICTS' }));
  const outcome = await detectContradiction(claimA, claimB, router);
  assert.equal(outcome, CONTRADICTION_RESULT.UNCERTAIN);
});

test('detectContradiction resolves to UNCERTAIN on an out-of-vocabulary result value', async () => {
  const router = stubRouter(JSON.stringify({ result: 'PARTIAL_CONFLICT' }));
  const outcome = await detectContradiction(claimA, claimB, router);
  assert.equal(outcome, CONTRADICTION_RESULT.UNCERTAIN);
});

test('detectContradiction never returns a boolean', async () => {
  const router = stubRouter(JSON.stringify({ result: 'no_contradiction' }));
  const outcome = await detectContradiction(claimA, claimB, router);
  assert.equal(typeof outcome, 'string');
  assert.notEqual(outcome, true);
  assert.notEqual(outcome, false);
});

test('detectContradiction propagates a provider-level failure rather than swallowing it as UNCERTAIN', async () => {
  const router = throwingRouter('no usable LLM provider');
  await assert.rejects(() => detectContradiction(claimA, claimB, router), /no usable LLM provider/);
});

test('detectContradiction embeds both claims as DERIVED/UNTRUSTED data blocks, not raw instruction text', async () => {
  let capturedPrompt = null;
  const registry = {
    'capture-stub': () => ({
      id: 'capture-stub', isPaid: false,
      async healthCheck() { return true; },
      async complete(request) {
        capturedPrompt = request.prompt;
        return { text: JSON.stringify({ result: 'NO_CONTRADICTION' }), model: 'capture-stub', estimatedCost: 0, isPaid: false };
      }
    })
  };
  const router = new LLMRouter({ priority: ['capture-stub'], allowPaidProviders: false, registry });
  await detectContradiction(claimA, claimB, router);
  assert.match(capturedPrompt, /DERIVED\/UNTRUSTED DATA/);
  assert.match(capturedPrompt, /CLAIM A/);
  assert.match(capturedPrompt, /CLAIM B/);
});
