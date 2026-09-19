import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateScriptFields, validateGeneratedScript } from '../../src/script/generate.js';
import { LLMRouter } from '../../src/providers/llm/router.js';

function stubRouter(responseText) {
  const registry = {
    'script-stub': () => ({
      id: 'script-stub', isPaid: false,
      async healthCheck() { return true; },
      async complete() {
        return { text: responseText, model: 'script-stub', requestId: null, inputTokens: 1, outputTokens: 1, estimatedCost: 0, isPaid: false };
      }
    })
  };
  return new LLMRouter({ priority: ['script-stub'], allowPaidProviders: false, registry });
}

function wellFormedFields(overrides = {}) {
  return {
    hook: 'Hook', narrative: 'Narrative',
    sections: [{ heading: 'Intro', content: 'Body text', claim_ids: ['claim-1'] }],
    counterpoints: 'Counterpoints', conclusion: 'Conclusion', call_to_action: null,
    ...overrides
  };
}

test('validateGeneratedScript accepts a well-formed object with CTA disallowed and null', () => {
  const result = validateGeneratedScript(wellFormedFields(), { allowCallToAction: false });
  assert.equal(result.valid, true);
});

test('validateGeneratedScript rejects malformed (non-JSON-object) output', () => {
  assert.equal(validateGeneratedScript(null, { allowCallToAction: false }).valid, false);
  assert.equal(validateGeneratedScript('a string', { allowCallToAction: false }).valid, false);
});

test('validateGeneratedScript rejects a missing/empty required string field', () => {
  const result = validateGeneratedScript(wellFormedFields({ hook: '' }), { allowCallToAction: false });
  assert.equal(result.valid, false);
  assert.match(result.reason, /hook/);
});

test('validateGeneratedScript rejects an empty sections array', () => {
  const result = validateGeneratedScript(wellFormedFields({ sections: [] }), { allowCallToAction: false });
  assert.equal(result.valid, false);
  assert.equal(result.reason, 'MISSING_OR_EMPTY_SECTIONS');
});

test('validateGeneratedScript rejects a non-object section', () => {
  const result = validateGeneratedScript(wellFormedFields({ sections: ['not an object'] }), { allowCallToAction: false });
  assert.equal(result.valid, false);
  assert.equal(result.reason, 'INVALID_SECTION_SHAPE');
});

test('validateGeneratedScript rejects a section missing heading', () => {
  const result = validateGeneratedScript(
    wellFormedFields({ sections: [{ heading: '', content: 'x', claim_ids: [] }] }),
    { allowCallToAction: false }
  );
  assert.equal(result.valid, false);
  assert.equal(result.reason, 'MISSING_OR_EMPTY_SECTION_HEADING');
});

test('validateGeneratedScript rejects a section missing content', () => {
  const result = validateGeneratedScript(
    wellFormedFields({ sections: [{ heading: 'H', content: '', claim_ids: [] }] }),
    { allowCallToAction: false }
  );
  assert.equal(result.valid, false);
  assert.equal(result.reason, 'MISSING_OR_EMPTY_SECTION_CONTENT');
});

test('validateGeneratedScript rejects a section with non-array claim_ids', () => {
  const result = validateGeneratedScript(
    wellFormedFields({ sections: [{ heading: 'H', content: 'x', claim_ids: 'claim-1' }] }),
    { allowCallToAction: false }
  );
  assert.equal(result.valid, false);
  assert.equal(result.reason, 'INVALID_SECTION_CLAIM_IDS_SHAPE');
});

test('validateGeneratedScript rejects a non-null call_to_action when disallowed', () => {
  const result = validateGeneratedScript(wellFormedFields({ call_to_action: 'Subscribe!' }), { allowCallToAction: false });
  assert.equal(result.valid, false);
  assert.equal(result.reason, 'CALL_TO_ACTION_NOT_PERMITTED');
});

test('validateGeneratedScript accepts a non-empty call_to_action when allowed', () => {
  const result = validateGeneratedScript(wellFormedFields({ call_to_action: 'Subscribe!' }), { allowCallToAction: true });
  assert.equal(result.valid, true);
});

test('validateGeneratedScript rejects a missing call_to_action when allowed', () => {
  const result = validateGeneratedScript(wellFormedFields({ call_to_action: null }), { allowCallToAction: true });
  assert.equal(result.valid, false);
  assert.equal(result.reason, 'MISSING_OR_EMPTY_FIELD_call_to_action');
});

test('generateScriptFields parses a well-formed LLM JSON object', async () => {
  const router = stubRouter(JSON.stringify(wellFormedFields()));
  const { parsed, providerUsed } = await generateScriptFields(
    { brief: { working_title: 't', core_question: 'q', hook: 'h', angle: 'a', narrative_structure: 'n' }, eligibleClaimIds: ['claim-1'], allowCallToAction: false },
    router
  );
  assert.equal(providerUsed, 'script-stub');
  assert.equal(validateGeneratedScript(parsed, { allowCallToAction: false }).valid, true);
});

test('generateScriptFields returns parsed=null on unparseable LLM output rather than throwing', async () => {
  const router = stubRouter('not json');
  const { parsed } = await generateScriptFields(
    { brief: {}, eligibleClaimIds: [], allowCallToAction: false },
    router
  );
  assert.equal(parsed, null);
});

test('generateScriptFields prompt instructs null CTA when disallowed, and does not leak Research internals', async () => {
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
  await generateScriptFields(
    { brief: { working_title: 't', core_question: 'q', hook: 'h', angle: 'a', narrative_structure: 'n' }, eligibleClaimIds: ['claim-1'], allowCallToAction: false },
    router
  );
  assert.match(capturedPrompt, /must be null/);
  assert.doesNotMatch(capturedPrompt, /evidence_status/);
});

test('generateScriptFields prompt requires a non-empty CTA string when allowed', async () => {
  let capturedPrompt = null;
  const registry = {
    'capture-stub': () => ({
      id: 'capture-stub', isPaid: false,
      async healthCheck() { return true; },
      async complete({ prompt }) {
        capturedPrompt = prompt;
        return { text: JSON.stringify(wellFormedFields({ call_to_action: 'Subscribe!' })), model: 'capture-stub', requestId: null, inputTokens: 1, outputTokens: 1, estimatedCost: 0, isPaid: false };
      }
    })
  };
  const router = new LLMRouter({ priority: ['capture-stub'], allowPaidProviders: false, registry });
  await generateScriptFields(
    { brief: {}, eligibleClaimIds: [], allowCallToAction: true },
    router
  );
  assert.match(capturedPrompt, /must be a non-empty string/);
});

// --- B-02a: a single Markdown-fenced JSON payload is tolerated; everything
// else keeps its existing behavior (parsed=null -> MALFORMED_LLM_OUTPUT). ---

function countingStubRouter(responseText) {
  let calls = 0;
  const registry = {
    'script-stub-counting': () => ({
      id: 'script-stub-counting', isPaid: false,
      async healthCheck() { return true; },
      async complete() {
        calls++;
        return { text: responseText, model: 'script-stub-counting', requestId: null, inputTokens: 1, outputTokens: 1, estimatedCost: 0, isPaid: false };
      }
    })
  };
  const router = new LLMRouter({ priority: ['script-stub-counting'], allowPaidProviders: false, registry });
  return { router, callCount: () => calls };
}

async function runGenerate(responseText) {
  const { router, callCount } = countingStubRouter(responseText);
  const out = await generateScriptFields(
    { brief: { working_title: 't', core_question: 'q', hook: 'h', angle: 'a', narrative_structure: 'n' }, eligibleClaimIds: ['claim-1'], allowCallToAction: false },
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
  assert.equal(validateGeneratedScript(parsed, { allowCallToAction: false }).valid, true);
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
  assert.equal(validateGeneratedScript(parsed, { allowCallToAction: false }).reason, 'MALFORMED_LLM_OUTPUT');
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
  assert.equal(validateGeneratedScript(missingField.parsed, { allowCallToAction: false }).reason, 'MISSING_OR_EMPTY_FIELD_hook');

  const other = await runGenerate(`${FENCE}json\n${JSON.stringify(wellFormedFields({ sections: [] }))}\n${FENCE}`);
  assert.notEqual(other.parsed, null);
  assert.equal(validateGeneratedScript(other.parsed, { allowCallToAction: false }).reason, 'MISSING_OR_EMPTY_SECTIONS');
});

test('B-02a: generation makes exactly one LLM call per invocation, malformed or fenced (retry stays in the pipeline loop, unchanged)', async () => {
  assert.equal((await runGenerate('not json')).callCount, 1);
  assert.equal((await runGenerate(`${FENCE}json\nnot json\n${FENCE}`)).callCount, 1);
  assert.equal((await runGenerate(`${FENCE}json\n${JSON.stringify(wellFormedFields())}\n${FENCE}`)).callCount, 1);
});
