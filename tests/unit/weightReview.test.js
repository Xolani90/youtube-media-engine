import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isReviewEligible, reviewWeightConfiguration, OUTCOME_BEARING_REVIEW_THRESHOLD } from '../../src/discovery/weightReview.js';

test('threshold is exactly 100', () => {
  assert.equal(OUTCOME_BEARING_REVIEW_THRESHOLD, 100);
});

test('below 100 outcome-bearing opportunities -> not review-eligible', () => {
  assert.equal(isReviewEligible(99), false);
});

test('exactly 100 outcome-bearing opportunities -> review-eligible', () => {
  assert.equal(isReviewEligible(100), true);
});

test('reaching 100 does NOT automatically change the active weight version', () => {
  const result = reviewWeightConfiguration({ outcomeBearingCount: 100, evidenceSufficient: false, currentWeightsVersion: '0.1' });
  assert.equal(result.eligible, true);
  assert.equal(result.adopted, false);
  assert.equal(result.activeVersion, '0.1', 'active version must remain unchanged when evidence is judged insufficient');
});

test('below 100, review is not even eligible regardless of evidence flag', () => {
  const result = reviewWeightConfiguration({ outcomeBearingCount: 50, evidenceSufficient: true, proposedWeights: { version: '0.2' }, currentWeightsVersion: '0.1' });
  assert.equal(result.eligible, false);
  assert.equal(result.adopted, false);
  assert.equal(result.activeVersion, '0.1');
});

test('explicit adoption only occurs when eligible AND evidence is explicitly judged sufficient', () => {
  const result = reviewWeightConfiguration({ outcomeBearingCount: 150, evidenceSufficient: true, proposedWeights: { version: '0.2' }, currentWeightsVersion: '0.1' });
  assert.equal(result.eligible, true);
  assert.equal(result.adopted, true);
  assert.equal(result.activeVersion, '0.2');
});

test('evidenceSufficient=true without a proposed configuration throws rather than silently adopting nothing', () => {
  assert.throws(() => reviewWeightConfiguration({ outcomeBearingCount: 150, evidenceSufficient: true, currentWeightsVersion: '0.1' }));
});
