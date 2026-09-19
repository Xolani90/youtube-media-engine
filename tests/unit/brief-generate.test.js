import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateBriefFields, validateGeneratedBrief } from '../../src/brief/generate.js';
import { LLMRouter } from '../../src/providers/llm/router.js';

function stubRouter(responseText) {
  const registry = {
    'brief-stub': () => ({
      id: 'brief-stub', isPaid: false,
      async healthCheck() { return true; },
      async complete() {
        return { text: responseText, model: 'brief-stub', requestId: null, inputTokens: 1, outputTokens: 1, estimatedCost: 0, isPaid: false };
      }
    })
  };
  return new LLMRouter({ priority: ['brief-stub'], allowPaidProviders: false, registry });
}

function wellFormedFields(overrides = {}) {
  return {
    working_title: 'Title', target_audience: 'Audience', viewer_promise: 'Promise', hook: 'Hook',
    angle: 'Angle', narrative_structure: 'Structure', counterpoints: 'Counterpoints',
    original_insights: 'Insights', visual_ideas: 'Visuals', monetization_opportunities: 'Monetization',
    risk_assessment: 'Risk', key_claims: ['claim-1'],
    ...overrides
  };
}

test('validateGeneratedBrief accepts a well-formed object', () => {
  const result = validateGeneratedBrief(wellFormedFields());
  assert.equal(result.valid, true);
});

test('validateGeneratedBrief rejects malformed (non-JSON-object) output', () => {
  assert.equal(validateGeneratedBrief(null).valid, false);
  assert.equal(validateGeneratedBrief('a string').valid, false);
});

test('validateGeneratedBrief rejects a missing/empty required string field', () => {
  const result = validateGeneratedBrief(wellFormedFields({ hook: '' }));
  assert.equal(result.valid, false);
  assert.match(result.reason, /hook/);
});

test('validateGeneratedBrief rejects an empty key_claims array (D10)', () => {
  const result = validateGeneratedBrief(wellFormedFields({ key_claims: [] }));
  assert.equal(result.valid, false);
  assert.match(result.reason, /KEY_CLAIMS/);
});

test('validateGeneratedBrief rejects a non-array key_claims', () => {
  const result = validateGeneratedBrief(wellFormedFields({ key_claims: 'claim-1' }));
  assert.equal(result.valid, false);
});

test('generateBriefFields parses a well-formed LLM JSON object', async () => {
  const router = stubRouter(JSON.stringify(wellFormedFields()));
  const { parsed, providerUsed } = await generateBriefFields(
    { coreQuestion: 'q', opportunity: { title: 't', description: 'd' }, eligibleClaims: [{ id: 'claim-1', claim: 'x', claim_type: 'FACT' }] },
    router
  );
  assert.equal(providerUsed, 'brief-stub');
  assert.equal(validateGeneratedBrief(parsed).valid, true);
});

test('generateBriefFields returns parsed=null on unparseable LLM output rather than throwing', async () => {
  const router = stubRouter('not json');
  const { parsed } = await generateBriefFields(
    { coreQuestion: 'q', opportunity: {}, eligibleClaims: [] },
    router
  );
  assert.equal(parsed, null);
});

test('generateBriefFields never asks the LLM for core_question or evidence_status in the prompt (D14/D2 — LLM must not touch these)', async () => {
  let capturedPrompt = null;
  const registry = {
    'capture-stub': () => ({
      id: 'capture-stub', isPaid: false,
      async healthCheck() { return true; },
      async complete({ prompt }) {
        capturedPrompt = prompt;
        return { text: JSON.stringify(wellFormedFields()), model: 'capture-stub', requestId: null, inputTokens: 1, outputTokens: 1, estimatedCost: 0, isPaid: false };
      }
    })
  };
  const router = new LLMRouter({ priority: ['capture-stub'], allowPaidProviders: false, registry });
  await generateBriefFields(
    { coreQuestion: 'Did it work?', opportunity: { title: 't', description: 'd' }, eligibleClaims: [] },
    router
  );
  assert.match(capturedPrompt, /Do not rewrite/);
  assert.doesNotMatch(capturedPrompt, /evidence_status/);
});

// --- B-02a: a single Markdown-fenced JSON payload is tolerated; everything
// else keeps its existing behavior (parsed=null -> MALFORMED_LLM_OUTPUT). ---

function countingStubRouter(responseText) {
  let calls = 0;
  const registry = {
    'brief-stub-counting': () => ({
      id: 'brief-stub-counting', isPaid: false,
      async healthCheck() { return true; },
      async complete() {
        calls++;
        return { text: responseText, model: 'brief-stub-counting', requestId: null, inputTokens: 1, outputTokens: 1, estimatedCost: 0, isPaid: false };
      }
    })
  };
  const router = new LLMRouter({ priority: ['brief-stub-counting'], allowPaidProviders: false, registry });
  return { router, callCount: () => calls };
}

async function runGenerate(responseText) {
  const { router, callCount } = countingStubRouter(responseText);
  const out = await generateBriefFields(
    { coreQuestion: 'q', opportunity: { title: 't', description: 'd' }, eligibleClaims: [{ id: 'claim-1', claim: 'x', claim_type: 'FACT' }] },
    router
  );
  return { ...out, callCount: callCount() };
}

const FENCE = '```';

test('B-02a: plain unfenced JSON still parses to exactly the same object', async () => {
  const { parsed, rawOutput } = await runGenerate(JSON.stringify(wellFormedFields()));
  assert.deepEqual(parsed, wellFormedFields());
  assert.equal(rawOutput, JSON.stringify(wellFormedFields()));
});

test('B-02a: a payload wrapped in one ```json fence parses and validates; rawOutput stays the original fenced text', async () => {
  const fenced = `${FENCE}json\n${JSON.stringify(wellFormedFields(), null, 2)}\n${FENCE}`;
  const { parsed, rawOutput } = await runGenerate(fenced);
  assert.deepEqual(parsed, wellFormedFields());
  assert.equal(validateGeneratedBrief(parsed).valid, true);
  assert.equal(rawOutput, fenced);
});

test('B-02a: a ```JSON (uppercase tag) fence parses', async () => {
  const { parsed } = await runGenerate(`${FENCE}JSON\n${JSON.stringify(wellFormedFields())}\n${FENCE}`);
  assert.deepEqual(parsed, wellFormedFields());
});

test('B-02a: a bare ``` fence (no language tag) parses', async () => {
  const { parsed } = await runGenerate(`${FENCE}\n${JSON.stringify(wellFormedFields())}\n${FENCE}`);
  assert.deepEqual(parsed, wellFormedFields());
});

test('B-02a: leading/trailing whitespace and CRLF line breaks around a complete fenced response are tolerated', async () => {
  const crlf = `  \n${FENCE}json\r\n${JSON.stringify(wellFormedFields())}\r\n${FENCE}\n\n`;
  const { parsed } = await runGenerate(crlf);
  assert.deepEqual(parsed, wellFormedFields());
});

test('B-02a: malformed JSON inside a fence stays malformed (parsed=null, MALFORMED_LLM_OUTPUT, no repair)', async () => {
  const { parsed } = await runGenerate(`${FENCE}json\n{"hook": "unterminated\n${FENCE}`);
  assert.equal(parsed, null);
  assert.equal(validateGeneratedBrief(parsed).reason, 'MALFORMED_LLM_OUTPUT');
});

test('B-02a: unrelated prose is still rejected, plain or fenced', async () => {
  assert.equal((await runGenerate('I could not produce that.')).parsed, null);
  assert.equal((await runGenerate(`${FENCE}\nI could not produce that.\n${FENCE}`)).parsed, null);
});

test('B-02a: prose before or after a fenced payload is NOT stripped (no extraction from surrounding text)', async () => {
  const fenced = `${FENCE}json\n${JSON.stringify(wellFormedFields())}\n${FENCE}`;
  assert.equal((await runGenerate(`Here is the result:\n${fenced}`)).parsed, null);
  assert.equal((await runGenerate(`${fenced}\nHope that helps!`)).parsed, null);
});

test('B-02a: an unclosed fence, multiple fences, and a JSON-looking object inside prose are all rejected', async () => {
  const json = JSON.stringify(wellFormedFields());
  assert.equal((await runGenerate(`${FENCE}json\n${json}`)).parsed, null);
  assert.equal((await runGenerate(`${FENCE}json\n${json}\n${FENCE}\n${FENCE}json\n${json}\n${FENCE}`)).parsed, null);
  assert.equal((await runGenerate(`The answer is ${json} as requested.`)).parsed, null);
});

test('B-02a: a fenced non-object root (array) is rejected exactly like the unfenced case', async () => {
  assert.equal((await runGenerate('[1, 2, 3]')).parsed, null);
  assert.equal((await runGenerate(`${FENCE}json\n[1, 2, 3]\n${FENCE}`)).parsed, null);
});

test('B-02a: validation failures inside a fenced payload remain validation failures, not malformed output', async () => {
  const missingField = await runGenerate(`${FENCE}json\n${JSON.stringify(wellFormedFields({ hook: '' }))}\n${FENCE}`);
  assert.notEqual(missingField.parsed, null);
  assert.equal(validateGeneratedBrief(missingField.parsed).reason, 'MISSING_OR_EMPTY_FIELD_hook');

  const other = await runGenerate(`${FENCE}json\n${JSON.stringify(wellFormedFields({ key_claims: [] }))}\n${FENCE}`);
  assert.notEqual(other.parsed, null);
  assert.equal(validateGeneratedBrief(other.parsed).reason, 'MISSING_OR_EMPTY_KEY_CLAIMS');
});

test('B-02a: generation makes exactly one LLM call per invocation, malformed or fenced (retry stays in the pipeline loop, unchanged)', async () => {
  assert.equal((await runGenerate('not json')).callCount, 1);
  assert.equal((await runGenerate(`${FENCE}json\nnot json\n${FENCE}`)).callCount, 1);
  assert.equal((await runGenerate(`${FENCE}json\n${JSON.stringify(wellFormedFields())}\n${FENCE}`)).callCount, 1);
});
