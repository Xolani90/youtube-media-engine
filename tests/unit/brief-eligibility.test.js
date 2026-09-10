import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkResearchEligibility } from '../../src/brief/eligibility.js';

test('checkResearchEligibility accepts RESEARCH_COMPLETE', () => {
  const result = checkResearchEligibility({ status: 'RESEARCH_COMPLETE' });
  assert.equal(result.eligible, true);
});

test('checkResearchEligibility rejects INSUFFICIENT_EVIDENCE (D1: no restricted path)', () => {
  const result = checkResearchEligibility({ status: 'INSUFFICIENT_EVIDENCE' });
  assert.equal(result.eligible, false);
  assert.match(result.reason, /INSUFFICIENT_EVIDENCE/);
});

test('checkResearchEligibility rejects FAILED', () => {
  const result = checkResearchEligibility({ status: 'FAILED' });
  assert.equal(result.eligible, false);
  assert.match(result.reason, /FAILED/);
});

test('checkResearchEligibility rejects RESEARCHING (not yet complete)', () => {
  const result = checkResearchEligibility({ status: 'RESEARCHING' });
  assert.equal(result.eligible, false);
});

test('checkResearchEligibility rejects a missing Research project', () => {
  const result = checkResearchEligibility(null);
  assert.equal(result.eligible, false);
  assert.equal(result.reason, 'RESEARCH_PROJECT_NOT_FOUND');
});