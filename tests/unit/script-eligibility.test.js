import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkBriefEligibility } from '../../src/script/eligibility.js';

function wellFormedBrief(overrides = {}) {
  return {
    working_title: 'Title', core_question: 'Question?', target_audience: 'Audience',
    viewer_promise: 'Promise', hook: 'Hook', angle: 'Angle', narrative_structure: 'Structure',
    counterpoints: 'Counterpoints', original_insights: 'Insights', visual_ideas: 'Visuals',
    monetization_opportunities: 'Monetization', risk_assessment: 'Risk',
    key_claims: JSON.stringify(['claim-1', 'claim-2']),
    ...overrides
  };
}

test('checkBriefEligibility accepts a structurally complete Brief', () => {
  const result = checkBriefEligibility(wellFormedBrief());
  assert.equal(result.eligible, true);
  assert.deepEqual(result.keyClaimIds, ['claim-1', 'claim-2']);
});

test('checkBriefEligibility rejects a missing Brief', () => {
  const result = checkBriefEligibility(undefined);
  assert.equal(result.eligible, false);
  assert.equal(result.reason, 'BRIEF_NOT_FOUND');
});

test('checkBriefEligibility rejects a Brief missing a required field', () => {
  const result = checkBriefEligibility(wellFormedBrief({ hook: '' }));
  assert.equal(result.eligible, false);
  assert.equal(result.reason, 'INELIGIBLE_BRIEF_MISSING_FIELD_hook');
});

test('checkBriefEligibility rejects a Brief with a whitespace-only required field', () => {
  const result = checkBriefEligibility(wellFormedBrief({ angle: '   ' }));
  assert.equal(result.eligible, false);
  assert.equal(result.reason, 'INELIGIBLE_BRIEF_MISSING_FIELD_angle');
});

test('checkBriefEligibility rejects unparseable key_claims', () => {
  const result = checkBriefEligibility(wellFormedBrief({ key_claims: 'not json' }));
  assert.equal(result.eligible, false);
  assert.equal(result.reason, 'INELIGIBLE_BRIEF_INVALID_KEY_CLAIMS');
});

test('checkBriefEligibility rejects empty key_claims array', () => {
  const result = checkBriefEligibility(wellFormedBrief({ key_claims: JSON.stringify([]) }));
  assert.equal(result.eligible, false);
  assert.equal(result.reason, 'INELIGIBLE_BRIEF_INVALID_KEY_CLAIMS');
});

test('checkBriefEligibility rejects key_claims with non-string entries', () => {
  const result = checkBriefEligibility(wellFormedBrief({ key_claims: JSON.stringify(['a', 1, 'b']) }));
  assert.equal(result.eligible, false);
  assert.equal(result.reason, 'INELIGIBLE_BRIEF_INVALID_KEY_CLAIMS');
});

test('checkBriefEligibility rejects key_claims that is not an array', () => {
  const result = checkBriefEligibility(wellFormedBrief({ key_claims: JSON.stringify({ id: 'a' }) }));
  assert.equal(result.eligible, false);
  assert.equal(result.reason, 'INELIGIBLE_BRIEF_INVALID_KEY_CLAIMS');
});
