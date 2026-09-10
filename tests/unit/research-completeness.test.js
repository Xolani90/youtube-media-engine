import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateCompleteness } from '../../src/research/completeness.js';
import researchPolicy from '../../config/research_policy.json' with { type: 'json' };

function claim(overrides) {
  return { id: overrides.id || 'c1', claim_type: 'FACT', evidence_status: 'VERIFIED', is_load_bearing: true, ...overrides };
}

test('zero load-bearing claims -> INSUFFICIENT_EVIDENCE regardless of everything else', () => {
  const result = evaluateCompleteness({
    claims: [claim({ id: 'c1', is_load_bearing: false })],
    policy: researchPolicy, coreQuestionType: 'FACTUAL', stoppingConditionMet: true
  });
  assert.equal(result.status, 'INSUFFICIENT_EVIDENCE');
  assert.equal(result.stopReason, 'NO_LOAD_BEARING_CLAIMS');
});

test('FACTUAL: a verified load-bearing FACT satisfies completeness', () => {
  const result = evaluateCompleteness({
    claims: [claim({ id: 'c1' })], policy: researchPolicy, coreQuestionType: 'FACTUAL', stoppingConditionMet: true
  });
  assert.equal(result.status, 'RESEARCH_COMPLETE');
});

test('FACTUAL: an unresolved (UNSUPPORTED) load-bearing claim blocks completion even if 90%+ of overall claims are resolved', () => {
  const claims = [
    claim({ id: 'lb', evidence_status: 'UNSUPPORTED' }),
    ...Array.from({ length: 9 }, (_, i) => claim({ id: `filler-${i}`, is_load_bearing: false, evidence_status: 'VERIFIED' }))
  ];
  const result = evaluateCompleteness({ claims, policy: researchPolicy, coreQuestionType: 'FACTUAL', stoppingConditionMet: true });
  assert.equal(result.status, 'INSUFFICIENT_EVIDENCE');
  assert.equal(result.stopReason, 'UNSUPPORTED_LOAD_BEARING_CLAIM');
});

test('SENTIMENT: a verified load-bearing claim (any type) satisfies completeness', () => {
  const result = evaluateCompleteness({
    claims: [claim({ id: 'c1', claim_type: 'OPINION', evidence_status: 'VERIFIED' })],
    policy: researchPolicy, coreQuestionType: 'SENTIMENT', stoppingConditionMet: true
  });
  assert.equal(result.status, 'RESEARCH_COMPLETE');
});

test('SENTIMENT: no verified load-bearing claim -> INSUFFICIENT_EVIDENCE', () => {
  const result = evaluateCompleteness({
    claims: [claim({ id: 'c1', claim_type: 'OPINION', evidence_status: 'PARTIALLY_SUPPORTED' })],
    policy: researchPolicy, coreQuestionType: 'SENTIMENT', stoppingConditionMet: true
  });
  assert.equal(result.status, 'INSUFFICIENT_EVIDENCE');
  assert.equal(result.stopReason, 'SENTIMENT_REQUIREMENT_UNMET');
});

test('MIXED: factual-only satisfaction is NOT COMPLETE', () => {
  const result = evaluateCompleteness({
    claims: [claim({ id: 'c1', claim_type: 'FACT', evidence_status: 'PARTIALLY_SUPPORTED' })], // does not even satisfy factual, but also no sentiment
    policy: researchPolicy, coreQuestionType: 'MIXED', stoppingConditionMet: true
  });
  assert.equal(result.status, 'INSUFFICIENT_EVIDENCE');
});

test('MIXED: a single VERIFIED FACT claim alone does NOT satisfy MIXED, even though it satisfies both components individually (must be distinct claims)', () => {
  const result = evaluateCompleteness({
    claims: [claim({ id: 'c1', claim_type: 'FACT', evidence_status: 'VERIFIED' })],
    policy: researchPolicy, coreQuestionType: 'MIXED', stoppingConditionMet: true
  });
  assert.equal(result.status, 'INSUFFICIENT_EVIDENCE');
  assert.equal(result.stopReason, 'MIXED_REQUIRES_DISTINCT_CLAIMS');
});

test('MIXED: sentiment-only (no factual-satisfying claim) is NOT COMPLETE', () => {
  const result = evaluateCompleteness({
    claims: [claim({ id: 'c1', claim_type: 'OPINION', evidence_status: 'VERIFIED' })],
    policy: researchPolicy, coreQuestionType: 'MIXED', stoppingConditionMet: true
  });
  assert.equal(result.status, 'INSUFFICIENT_EVIDENCE');
  assert.equal(result.stopReason, 'MIXED_FACTUAL_COMPONENT_UNMET');
});

test('MIXED: distinct factual + sentiment claims together satisfy completeness', () => {
  const claims = [
    claim({ id: 'factual-claim', claim_type: 'FACT', evidence_status: 'VERIFIED' }),
    claim({ id: 'sentiment-claim', claim_type: 'OPINION', evidence_status: 'VERIFIED' })
  ];
  const result = evaluateCompleteness({ claims, policy: researchPolicy, coreQuestionType: 'MIXED', stoppingConditionMet: true });
  assert.equal(result.status, 'RESEARCH_COMPLETE');
});

test('OPINION can never satisfy a FACTUAL requirement, regardless of evidence_status', () => {
  const result = evaluateCompleteness({
    claims: [claim({ id: 'c1', claim_type: 'OPINION', evidence_status: 'VERIFIED' })],
    policy: researchPolicy, coreQuestionType: 'FACTUAL', stoppingConditionMet: true
  });
  assert.equal(result.status, 'INSUFFICIENT_EVIDENCE');
  assert.equal(result.stopReason, 'FACTUAL_REQUIREMENT_UNMET');
});

test('a VERIFIED OPINION satisfies SENTIMENT (the resolved concrete example from v0.4)', () => {
  const result = evaluateCompleteness({
    claims: [claim({ id: 'c1', claim_type: 'OPINION', evidence_status: 'VERIFIED' })],
    policy: researchPolicy, coreQuestionType: 'SENTIMENT', stoppingConditionMet: true
  });
  assert.equal(result.status, 'RESEARCH_COMPLETE');
});

test('INFERENCE claim satisfies FACTUAL at VERIFIED per policy default', () => {
  const result = evaluateCompleteness({
    claims: [claim({ id: 'c1', claim_type: 'INFERENCE', evidence_status: 'VERIFIED' })],
    policy: researchPolicy, coreQuestionType: 'FACTUAL', stoppingConditionMet: true
  });
  assert.equal(result.status, 'RESEARCH_COMPLETE');
});

test('an undefined stopping condition blocks completion even when all other criteria are met', () => {
  const result = evaluateCompleteness({
    claims: [claim({ id: 'c1' })], policy: researchPolicy, coreQuestionType: 'FACTUAL', stoppingConditionMet: false
  });
  assert.equal(result.status, 'INSUFFICIENT_EVIDENCE');
  assert.equal(result.stopReason, 'STOPPING_CONDITION_NOT_MET');
});

test('an unrecognized core_question_type is a FAILED condition, not silently treated as any known type', () => {
  const result = evaluateCompleteness({
    claims: [claim({ id: 'c1' })], policy: researchPolicy, coreQuestionType: 'SPECULATIVE', stoppingConditionMet: true
  });
  assert.equal(result.status, 'FAILED');
});

test('overall resolution threshold is supplementary and cannot substitute for the load-bearing requirement', () => {
  // Every load-bearing claim requirement met, but overall ratio deliberately kept low
  // by adding many UNSUPPORTED non-load-bearing filler claims.
  const claims = [
    claim({ id: 'lb', evidence_status: 'VERIFIED' }),
    ...Array.from({ length: 20 }, (_, i) => claim({ id: `filler-${i}`, is_load_bearing: false, evidence_status: 'UNSUPPORTED' }))
  ];
  const result = evaluateCompleteness({ claims, policy: researchPolicy, coreQuestionType: 'FACTUAL', stoppingConditionMet: true });
  assert.equal(result.status, 'INSUFFICIENT_EVIDENCE');
  assert.equal(result.stopReason, 'OVERALL_RESOLUTION_THRESHOLD_NOT_MET');
});