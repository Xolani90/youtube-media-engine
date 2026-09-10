import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkHardEligibility, ELIGIBILITY_REASON } from '../../src/discovery/eligibility.js';
import discoveryPolicy from '../../config/discovery_policy.json' with { type: 'json' };

const thresholds = discoveryPolicy.thresholds;

test('empty content is rejected', () => {
  const result = checkHardEligibility({ title: '', description: '' }, { thresholds });
  assert.equal(result.eligible, false);
  assert.equal(result.reason, ELIGIBILITY_REASON.INELIGIBLE_EMPTY_CONTENT);
});

test('unsupported/non-English content is rejected', () => {
  const observation = { title: 'Ceci est un article en français sur la technologie et les affaires' };
  const result = checkHardEligibility(observation, { thresholds });
  assert.equal(result.eligible, false);
  assert.equal(result.reason, ELIGIBILITY_REASON.INELIGIBLE_LANGUAGE);
});

test('malformed (too-short) content is rejected', () => {
  const result = checkHardEligibility({ title: 'AB' }, { thresholds });
  assert.equal(result.eligible, false);
  assert.equal(result.reason, ELIGIBILITY_REASON.INELIGIBLE_MALFORMED);
});

test('already-produced similar content is rejected', () => {
  const observation = { title: 'OpenAI releases a new model for small business automation today' };
  const corpus = [{ title: 'OpenAI releases a new model for small business automation today', description: '' }];
  const result = checkHardEligibility(observation, { thresholds, alreadyProducedCorpus: corpus });
  assert.equal(result.eligible, false);
  assert.equal(result.reason, ELIGIBILITY_REASON.INELIGIBLE_ALREADY_PRODUCED);
});

test('dedup-resolved duplicate is rejected with DUPLICATE reason', () => {
  const observation = { title: 'A perfectly fine and usable article about business automation' };
  const result = checkHardEligibility(observation, { thresholds, dedupResolvedDuplicate: true });
  assert.equal(result.eligible, false);
  assert.equal(result.reason, ELIGIBILITY_REASON.DUPLICATE);
});

test('stale content beyond evergreen ceiling is rejected as EXPIRED', () => {
  const observation = {
    title: 'A perfectly fine and usable article about business automation',
    publishedAt: new Date(Date.now() - 999999 * 3600 * 1000).toISOString()
  };
  const result = checkHardEligibility(observation, { thresholds });
  assert.equal(result.eligible, false);
  assert.equal(result.reason, ELIGIBILITY_REASON.EXPIRED);
});

test('one usable source is sufficient to pass — no minimum_source_count check exists', () => {
  const observation = { title: 'A perfectly fine and usable article about business automation and AI tools' };
  const result = checkHardEligibility(observation, { thresholds, alreadyProducedCorpus: [] });
  assert.equal(result.eligible, true);
  assert.equal(result.reason, null);
});
