import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateScriptClaimReferences, buildClaimLinks } from '../../src/script/claims.js';

test('validateScriptClaimReferences accepts sections referencing only eligible ids', () => {
  const sections = [
    { heading: 'A', content: 'x', claim_ids: ['c1'] },
    { heading: 'B', content: 'y', claim_ids: ['c2'] }
  ];
  const result = validateScriptClaimReferences(sections, ['c1', 'c2']);
  assert.equal(result.valid, true);
});

// Regression (live run 36642307938): a one-key-claim Brief produced a Script
// that linked the same claim id in two sections. Script accepted it, then
// Fact-Check failed it with CLAIM_LINKS_DUPLICATE_CLAIM_REFERENCE on every
// sweep (deterministic, never retried), stalling the item.
test('validateScriptClaimReferences rejects a claim id repeated across sections', () => {
  const sections = [
    { heading: 'A', content: 'x', claim_ids: ['c1'] },
    { heading: 'B', content: 'y', claim_ids: ['c1'] }
  ];
  const result = validateScriptClaimReferences(sections, ['c1']);
  assert.equal(result.valid, false);
  assert.equal(result.reason, 'DUPLICATE_CLAIM_REFERENCE_c1');
});

test('validateScriptClaimReferences rejects a claim id repeated within one section', () => {
  const sections = [{ heading: 'A', content: 'x', claim_ids: ['c1', 'c1'] }];
  const result = validateScriptClaimReferences(sections, ['c1']);
  assert.equal(result.valid, false);
  assert.equal(result.reason, 'DUPLICATE_CLAIM_REFERENCE_c1');
});

test('a Script accepted by validateScriptClaimReferences always passes Fact-Check claim-link uniqueness', () => {
  const sections = [
    { heading: 'A', content: 'x', claim_ids: ['c1'] },
    { heading: 'B', content: 'y', claim_ids: [] },
    { heading: 'C', content: 'z', claim_ids: ['c2'] }
  ];
  assert.equal(validateScriptClaimReferences(sections, ['c1', 'c2']).valid, true);
});

test('validateScriptClaimReferences accepts sections with no claim references', () => {
  const sections = [{ heading: 'A', content: 'x', claim_ids: [] }];
  const result = validateScriptClaimReferences(sections, ['c1']);
  assert.equal(result.valid, true);
});

test('validateScriptClaimReferences rejects an invented claim id', () => {
  const sections = [{ heading: 'A', content: 'x', claim_ids: ['not-real'] }];
  const result = validateScriptClaimReferences(sections, ['c1', 'c2']);
  assert.equal(result.valid, false);
  assert.equal(result.reason, 'INVALID_CLAIM_REFERENCE_not-real');
});

test('validateScriptClaimReferences rejects non-array claim_ids', () => {
  const sections = [{ heading: 'A', content: 'x', claim_ids: 'c1' }];
  const result = validateScriptClaimReferences(sections, ['c1']);
  assert.equal(result.valid, false);
  assert.equal(result.reason, 'INVALID_SECTION_CLAIM_IDS_SHAPE');
});

test('validateScriptClaimReferences rejects non-string entries in claim_ids', () => {
  const sections = [{ heading: 'A', content: 'x', claim_ids: ['c1', 42] }];
  const result = validateScriptClaimReferences(sections, ['c1']);
  assert.equal(result.valid, false);
  assert.equal(result.reason, 'INVALID_SECTION_CLAIM_IDS_SHAPE');
});

test('buildClaimLinks derives heading/claim_ids pairs in section order', () => {
  const sections = [
    { heading: 'Intro', content: 'x', claim_ids: ['c1'] },
    { heading: 'Body', content: 'y', claim_ids: [] }
  ];
  assert.deepEqual(buildClaimLinks(sections), [
    { heading: 'Intro', claim_ids: ['c1'] },
    { heading: 'Body', claim_ids: [] }
  ]);
});

test('buildClaimLinks defaults claim_ids to an empty array when missing', () => {
  const sections = [{ heading: 'Intro', content: 'x' }];
  assert.deepEqual(buildClaimLinks(sections), [{ heading: 'Intro', claim_ids: [] }]);
});
