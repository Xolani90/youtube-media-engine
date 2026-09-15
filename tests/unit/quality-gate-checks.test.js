import { test } from 'node:test';
import assert from 'node:assert/strict';

import { checkFactCheck, checkOriginalityEvidence, checkAssetRights } from '../../src/quality-gate/checks.js';
import { CHECK_RESULT } from '../../src/quality-gate/constants.js';

function fakeStorage({ factChecks = [], originalityChecks = [], assetUsageRows = [] } = {}) {
  return {
    get(sql, params) {
      if (sql.includes('FROM fact_checks')) {
        const rows = factChecks.filter((r) => r.script_id === params[0]);
        rows.sort((a, b) => b.version - a.version);
        return rows[0];
      }
      if (sql.includes('FROM originality_checks')) {
        const rows = originalityChecks.filter((r) => r.script_id === params[0]);
        return rows[0];
      }
      throw new Error(`unexpected get(): ${sql}`);
    },
    all(sql, params) {
      if (sql.includes('FROM assets')) {
        return assetUsageRows.filter((r) => r.content_version_id === params[0]).map((r) => r.asset);
      }
      throw new Error(`unexpected all(): ${sql}`);
    }
  };
}

// --- Check A: fact-check outcome -------------------------------------

test('checkFactCheck: PASS status -> PASS', () => {
  const storage = fakeStorage({ factChecks: [{ script_id: 's1', version: 1, status: 'PASS' }] });
  assert.equal(checkFactCheck(storage, 's1').result, CHECK_RESULT.PASS);
});

test('checkFactCheck: REVIEW status -> REVIEW', () => {
  const storage = fakeStorage({ factChecks: [{ script_id: 's1', version: 1, status: 'REVIEW' }] });
  assert.equal(checkFactCheck(storage, 's1').result, CHECK_RESULT.REVIEW);
});

test('checkFactCheck: REJECT status -> BLOCK', () => {
  const storage = fakeStorage({ factChecks: [{ script_id: 's1', version: 1, status: 'REJECT' }] });
  assert.equal(checkFactCheck(storage, 's1').result, CHECK_RESULT.BLOCK);
});

test('checkFactCheck: no evidence -> BLOCK (must not silently pass)', () => {
  const storage = fakeStorage({ factChecks: [] });
  const result = checkFactCheck(storage, 's1');
  assert.equal(result.result, CHECK_RESULT.BLOCK);
  assert.equal(result.reason, 'FACT_CHECK_EVIDENCE_MISSING');
});

test('checkFactCheck: uses latest version, not first row', () => {
  const storage = fakeStorage({
    factChecks: [
      { script_id: 's1', version: 1, status: 'REJECT' },
      { script_id: 's1', version: 2, status: 'PASS' }
    ]
  });
  assert.equal(checkFactCheck(storage, 's1').result, CHECK_RESULT.PASS);
});

// --- Check B: originality evidence -------------------------------------

test('checkOriginalityEvidence: measurement row exists -> PASS regardless of max_similarity value', () => {
  const storage = fakeStorage({ originalityChecks: [{ script_id: 's1', max_similarity: 0.97 }] });
  assert.equal(checkOriginalityEvidence(storage, 's1').result, CHECK_RESULT.PASS);
});

test('checkOriginalityEvidence: empty-corpus row (max_similarity null) still counts as evidence -> PASS', () => {
  const storage = fakeStorage({ originalityChecks: [{ script_id: 's1', max_similarity: null }] });
  assert.equal(checkOriginalityEvidence(storage, 's1').result, CHECK_RESULT.PASS);
});

test('checkOriginalityEvidence: no measurement row -> BLOCK', () => {
  const storage = fakeStorage({ originalityChecks: [] });
  const result = checkOriginalityEvidence(storage, 's1');
  assert.equal(result.result, CHECK_RESULT.BLOCK);
  assert.equal(result.reason, 'ORIGINALITY_EVIDENCE_MISSING');
});

// --- Check C: asset rights status -------------------------------------

test('checkAssetRights: no assets attached -> PASS', () => {
  const storage = fakeStorage({ assetUsageRows: [] });
  assert.equal(checkAssetRights(storage, 'cv1').result, CHECK_RESULT.PASS);
});

test('checkAssetRights: all VERIFIED -> PASS', () => {
  const storage = fakeStorage({
    assetUsageRows: [
      { content_version_id: 'cv1', asset: { verification_status: 'VERIFIED' } },
      { content_version_id: 'cv1', asset: { verification_status: 'VERIFIED' } }
    ]
  });
  assert.equal(checkAssetRights(storage, 'cv1').result, CHECK_RESULT.PASS);
});

test('checkAssetRights: any UNVERIFIED -> REVIEW', () => {
  const storage = fakeStorage({
    assetUsageRows: [
      { content_version_id: 'cv1', asset: { verification_status: 'VERIFIED' } },
      { content_version_id: 'cv1', asset: { verification_status: 'UNVERIFIED' } }
    ]
  });
  assert.equal(checkAssetRights(storage, 'cv1').result, CHECK_RESULT.REVIEW);
});

test('checkAssetRights: any DISPUTED -> BLOCK, outranks UNVERIFIED', () => {
  const storage = fakeStorage({
    assetUsageRows: [
      { content_version_id: 'cv1', asset: { verification_status: 'UNVERIFIED' } },
      { content_version_id: 'cv1', asset: { verification_status: 'DISPUTED' } }
    ]
  });
  assert.equal(checkAssetRights(storage, 'cv1').result, CHECK_RESULT.BLOCK);
});
