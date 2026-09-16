import { test } from 'node:test';
import assert from 'node:assert/strict';

import { evaluate, POLICY_ID, POLICY_VERSION, APPROVED_LICENSES } from '../../src/rights-verification/policy/pixabay.js';

function baseAsset(overrides = {}) {
  return {
    id: 'a1',
    origin: 'pixabay',
    license: 'Pixabay Content License',
    checksum: 'deadbeef',
    ...overrides
  };
}

test('evaluate: VERIFIED when evidence complete, license approved, checksum checked and matches', () => {
  const result = evaluate(baseAsset(), { checksumChecked: true, checksumOk: true });
  assert.equal(result.decision, 'VERIFIED');
  assert.equal(result.reason, 'all_policy_conditions_satisfied');
  assert.equal(result.evidenceFieldsExamined.policy_id, POLICY_ID);
  assert.equal(result.evidenceFieldsExamined.policy_version, POLICY_VERSION);
});

test('evaluate: NOT_VERIFIED when a required evidence field is missing', () => {
  const result = evaluate(baseAsset({ origin: null }), { checksumChecked: true, checksumOk: true });
  assert.equal(result.decision, 'NOT_VERIFIED');
  assert.equal(result.reason, 'missing_required_field_origin');
});

test('evaluate: NOT_VERIFIED when license is not on the approved list', () => {
  assert.ok(!APPROVED_LICENSES.includes('Some Other License'));
  const result = evaluate(baseAsset({ license: 'Some Other License' }), { checksumChecked: true, checksumOk: true });
  assert.equal(result.decision, 'NOT_VERIFIED');
  assert.equal(result.reason, 'license_not_approved');
});

test('evaluate: DISPUTED (not merely NOT_VERIFIED) on a detected checksum mismatch, regardless of everything else being valid', () => {
  const result = evaluate(baseAsset(), { checksumChecked: true, checksumOk: false });
  assert.equal(result.decision, 'DISPUTED');
  assert.equal(result.reason, 'checksum_mismatch');
});

test('evaluate: NOT_VERIFIED (never inferred VERIFIED) when checksum was never actually checked', () => {
  const result = evaluate(baseAsset(), { checksumChecked: false, checksumOk: null });
  assert.equal(result.decision, 'NOT_VERIFIED');
  assert.equal(result.reason, 'checksum_not_verifiable');
});

test('evaluate: NOT_VERIFIED with missing_required_field_checksum reason when no checksum was ever persisted', () => {
  const result = evaluate(baseAsset({ checksum: null }), { checksumChecked: false, checksumOk: null });
  assert.equal(result.decision, 'NOT_VERIFIED');
  assert.equal(result.reason, 'missing_required_field_checksum');
});

test('evaluate: never throws on a bare/empty asset object', () => {
  assert.doesNotThrow(() => evaluate({}));
  const result = evaluate({});
  assert.equal(result.decision, 'NOT_VERIFIED');
});