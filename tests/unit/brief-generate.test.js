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