import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateProposition, validateProposition, CORE_QUESTION_TYPES } from '../../src/discovery/proposition.js';
import { LLMRouter } from '../../src/providers/llm/router.js';

function stubRouter(responseText) {
  const registry = {
    'prop-stub': () => ({
      id: 'prop-stub', isPaid: false,
      async healthCheck() { return true; },
      async complete() {
        return { text: responseText, model: 'prop-stub', requestId: null, inputTokens: 1, outputTokens: 1, estimatedCost: 0, isPaid: false };
      }
    })
  };
  return new LLMRouter({ priority: ['prop-stub'], allowPaidProviders: false, registry });
}

const COMPLETE_PROPOSITION = JSON.stringify({
  subject: 'New AI model launch',
  target_audience: 'Small business owners',
  audience_problem: 'Unsure if the model can replace their current paid tool',
  core_question: 'Does the new model save time or money vs current alternatives?',
  gap: 'Most coverage is technical benchmarks, not practical business impact',
  angle: 'Independent business-use assessment',
  differentiation: 'Evidence-backed comparison rather than announcement coverage',
  commercial_relevance: 'High - direct SaaS-replacement angle',
  core_question_type: 'FACTUAL'
});

test('generates a complete, structurally valid proposition', async () => {
  const router = stubRouter(COMPLETE_PROPOSITION);
  const { proposition, providerUsed } = await generateProposition({ title: 'x', description: 'y' }, router);
  assert.equal(providerUsed, 'prop-stub');
  const validation = validateProposition(proposition);
  assert.equal(validation.valid, true);
});

test('validation rejects missing required field', () => {
  const proposition = { subject: 'x', target_audience: 'y' }; // missing several fields
  const result = validateProposition(proposition);
  assert.equal(result.valid, false);
});

test('validation rejects empty/whitespace-only field', () => {
  const proposition = JSON.parse(COMPLETE_PROPOSITION);
  proposition.gap = '   ';
  const result = validateProposition(proposition);
  assert.equal(result.valid, false);
});

test('validation rejects degenerate copy-of-subject fields', () => {
  const proposition = JSON.parse(COMPLETE_PROPOSITION);
  proposition.gap = proposition.subject;
  proposition.angle = proposition.subject;
  proposition.differentiation = proposition.subject;
  const result = validateProposition(proposition);
  assert.equal(result.valid, false);
});

test('unparseable LLM output produces an empty proposition that fails validation deterministically, no second LLM call', async () => {
  const router = stubRouter('not valid json at all');
  const { proposition } = await generateProposition({ title: 'x' }, router);
  const validation = validateProposition(proposition);
  assert.equal(validation.valid, false);
});

// D-02: core_question_type coverage.

test('generation propagates a valid core_question_type from the LLM output', async () => {
  const router = stubRouter(COMPLETE_PROPOSITION);
  const { proposition } = await generateProposition({ title: 'x' }, router);
  assert.equal(proposition.core_question_type, 'FACTUAL');
  assert.equal(validateProposition(proposition).valid, true);
});

test('existing core_question and all other proposition fields remain present and unchanged alongside core_question_type', async () => {
  const router = stubRouter(COMPLETE_PROPOSITION);
  const { proposition } = await generateProposition({ title: 'x' }, router);
  const expected = JSON.parse(COMPLETE_PROPOSITION);
  for (const field of ['subject', 'target_audience', 'audience_problem', 'core_question', 'gap', 'angle', 'differentiation', 'commercial_relevance']) {
    assert.equal(proposition[field], expected[field]);
  }
});

test('validation rejects a missing core_question_type', () => {
  const proposition = JSON.parse(COMPLETE_PROPOSITION);
  delete proposition.core_question_type;
  const result = validateProposition(proposition);
  assert.equal(result.valid, false);
  assert.match(result.reason, /core_question_type/);
});

test('validation rejects an invented core_question_type value', () => {
  const proposition = JSON.parse(COMPLETE_PROPOSITION);
  proposition.core_question_type = 'SPECULATIVE';
  const result = validateProposition(proposition);
  assert.equal(result.valid, false);
  assert.match(result.reason, /core_question_type/);
});

test('validation accepts each of the three allowed core_question_type values', () => {
  for (const type of CORE_QUESTION_TYPES) {
    const proposition = JSON.parse(COMPLETE_PROPOSITION);
    proposition.core_question_type = type;
    assert.equal(validateProposition(proposition).valid, true, `${type} should be valid`);
  }
});

test('unparseable LLM output yields core_question_type=null, still fails validation (no silent default)', async () => {
  const router = stubRouter('not valid json at all');
  const { proposition } = await generateProposition({ title: 'x' }, router);
  assert.equal(proposition.core_question_type, null);
  assert.equal(validateProposition(proposition).valid, false);
});
