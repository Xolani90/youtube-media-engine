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
