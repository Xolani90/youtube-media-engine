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

// --- Markdown JSON fence handling (parser hardening) ---

test('existing raw JSON (unfenced) still parses successfully', async () => {
  const router = stubRouter(COMPLETE_PROPOSITION);
  const { proposition } = await generateProposition({ title: 'x' }, router);
  assert.equal(validateProposition(proposition).valid, true);
  assert.equal(proposition.subject, JSON.parse(COMPLETE_PROPOSITION).subject);
});

test('Markdown-fenced JSON (```json ... ```) parses successfully', async () => {
  const fenced = '```json\n' + COMPLETE_PROPOSITION + '\n```';
  const router = stubRouter(fenced);
  const { proposition } = await generateProposition({ title: 'x' }, router);
  const validation = validateProposition(proposition);
  assert.equal(validation.valid, true, validation.reason || '');
  const expected = JSON.parse(COMPLETE_PROPOSITION);
  for (const field of ['subject', 'target_audience', 'audience_problem', 'core_question', 'gap', 'angle', 'differentiation', 'commercial_relevance', 'core_question_type']) {
    assert.equal(proposition[field], expected[field]);
  }
});

test('the observed Groq-shaped fenced proposition produces a populated, valid proposition object', async () => {
  const groqShaped = {
    subject: 'Preserving the Passage of Time',
    target_audience: 'Adults aged 30-55 who feel nostalgic or overwhelmed by how quickly time passes',
    audience_problem: 'They struggle to keep track of memories and feel disconnected from past experiences',
    core_question: 'How can we create a digital solution that helps people recall and cherish the moments that feel like they have slipped away?',
    gap: 'Existing memory apps focus on storage but lack emotional context and storytelling features that engage users over time',
    angle: 'An AI-powered interactive timeline that turns personal data into a narrative journey',
    differentiation: 'Unlike generic photo albums, our platform uses contextual AI, AR overlays, and scheduled prompts to actively engage users and reinforce memory recall',
    commercial_relevance: 'The personal memory and wellness market is projected to grow; subscription-based model and B2B partnerships with elder-care facilities create multiple revenue streams',
    core_question_type: 'MIXED'
  };
  const fenced = '```json\n' + JSON.stringify(groqShaped) + '\n```';
  const router = stubRouter(fenced);
  const { proposition } = await generateProposition({ title: 'x' }, router);
  const validation = validateProposition(proposition);
  assert.equal(validation.valid, true, validation.reason || '');
  assert.equal(proposition.subject, groqShaped.subject);
  assert.equal(proposition.core_question_type, 'MIXED');
});

test('an invalid/non-JSON fenced response still fails closed', async () => {
  const fenced = '```json\nnot actually json\n```';
  const router = stubRouter(fenced);
  const { proposition } = await generateProposition({ title: 'x' }, router);
  assert.equal(validateProposition(proposition).valid, false);
});

test('arbitrary prose containing a JSON-looking object is NOT silently accepted (no broad extraction)', async () => {
  const prose = `Sure, here is the proposition you asked for:\n${COMPLETE_PROPOSITION}\nLet me know if you need anything else!`;
  const router = stubRouter(prose);
  const { proposition } = await generateProposition({ title: 'x' }, router);
  // Not a whole-string fence, and not raw JSON on its own -> must fail closed
  // rather than having the embedded object silently extracted.
  assert.equal(validateProposition(proposition).valid, false);
});

test('a fence with leading/trailing prose around it is NOT unwrapped (fence must be the entire response)', async () => {
  const notWholeFence = 'preamble\n```json\n' + COMPLETE_PROPOSITION + '\n```\ntrailing text';
  const router = stubRouter(notWholeFence);
  const { proposition } = await generateProposition({ title: 'x' }, router);
  assert.equal(validateProposition(proposition).valid, false);
});

test('a bare fence with no language tag (``` ... ```) also parses successfully', async () => {
  const fenced = '```\n' + COMPLETE_PROPOSITION + '\n```';
  const router = stubRouter(fenced);
  const { proposition } = await generateProposition({ title: 'x' }, router);
  assert.equal(validateProposition(proposition).valid, true);
});
