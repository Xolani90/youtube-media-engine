import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { aggregateGate2Results } from '../../src/compliance/evaluator.js';
import { RULE, RESULT, REQUIRED_RULE_IDS } from '../../src/compliance/constants.js';
import { loadGate2Policy, Gate2PolicyLoadError, POLICY_LOAD_FAILURE_CODE } from '../../src/compliance/policy.js';

/**
 * ADR-0032 aggregation and policy-pack tests (Batch 3). No evaluator or
 * policy source is touched -- these exercise the real exported functions
 * with synthetic rule-result arrays and real temp policy files on disk.
 */

const r = (rule_id, result, reason = 'test') => ({ rule_id, result, reason });

describe('aggregateGate2Results', () => {
  test('all five PASS -> overall PASS', () => {
    const results = [
      r(RULE.FINAL_MEDIA_INTEGRITY, RESULT.PASS),
      r(RULE.ASSET_RIGHTS, RESULT.PASS),
      r(RULE.FINAL_METADATA_PRESENCE, RESULT.PASS),
      r(RULE.SCRIPT_MEDIA_CONSISTENCY, RESULT.PASS),
      r(RULE.EXISTING_PROVENANCE, RESULT.PASS)
    ];
    assert.equal(aggregateGate2Results(results), RESULT.PASS);
  });

  test('PASS + one REVIEW -> overall REVIEW', () => {
    const results = [
      r(RULE.FINAL_MEDIA_INTEGRITY, RESULT.PASS),
      r(RULE.ASSET_RIGHTS, RESULT.REVIEW),
      r(RULE.FINAL_METADATA_PRESENCE, RESULT.PASS),
      r(RULE.SCRIPT_MEDIA_CONSISTENCY, RESULT.PASS),
      r(RULE.EXISTING_PROVENANCE, RESULT.PASS)
    ];
    assert.equal(aggregateGate2Results(results), RESULT.REVIEW);
  });

  test('any BLOCK -> overall BLOCK', () => {
    const results = [
      r(RULE.FINAL_MEDIA_INTEGRITY, RESULT.PASS),
      r(RULE.ASSET_RIGHTS, RESULT.PASS),
      r(RULE.FINAL_METADATA_PRESENCE, RESULT.PASS),
      r(RULE.SCRIPT_MEDIA_CONSISTENCY, RESULT.BLOCK),
      r(RULE.EXISTING_PROVENANCE, RESULT.PASS)
    ];
    assert.equal(aggregateGate2Results(results), RESULT.BLOCK);
  });

  test('multiple REVIEWs with no BLOCK -> overall REVIEW', () => {
    const results = [
      r(RULE.FINAL_MEDIA_INTEGRITY, RESULT.REVIEW),
      r(RULE.ASSET_RIGHTS, RESULT.REVIEW),
      r(RULE.FINAL_METADATA_PRESENCE, RESULT.REVIEW),
      r(RULE.SCRIPT_MEDIA_CONSISTENCY, RESULT.PASS),
      r(RULE.EXISTING_PROVENANCE, RESULT.PASS)
    ];
    assert.equal(aggregateGate2Results(results), RESULT.REVIEW);
  });

  test('BLOCK takes precedence over REVIEW when both are present', () => {
    const results = [
      r(RULE.FINAL_MEDIA_INTEGRITY, RESULT.REVIEW),
      r(RULE.ASSET_RIGHTS, RESULT.BLOCK),
      r(RULE.FINAL_METADATA_PRESENCE, RESULT.REVIEW),
      r(RULE.SCRIPT_MEDIA_CONSISTENCY, RESULT.REVIEW),
      r(RULE.EXISTING_PROVENANCE, RESULT.PASS)
    ];
    assert.equal(aggregateGate2Results(results), RESULT.BLOCK);
  });
});

// ------------------------------------------------------------------ policy pack

function tmpPolicyFile(content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate2-policy-'));
  const file = path.join(dir, 'gate2_policy.json');
  if (content !== undefined) fs.writeFileSync(file, content);
  return file;
}

const validPolicy = (overrides = {}) => JSON.stringify({
  policy_id: 'gate2-final-compliance',
  version: '1.0.0',
  rules: REQUIRED_RULE_IDS.map((id) => ({ id, name: id })),
  ...overrides
});

describe('loadGate2Policy', () => {
  test('exactly five rules exist in the real config/gate2_policy.json', () => {
    const { ruleIds } = loadGate2Policy();
    assert.equal(ruleIds.length, 5);
  });

  test('rule IDs are exactly GC-001..GC-005', () => {
    const { ruleIds } = loadGate2Policy();
    assert.deepEqual(ruleIds, REQUIRED_RULE_IDS.slice().sort());
  });

  test('malformed policy (invalid JSON) -> deterministic policy-load failure', () => {
    const file = tmpPolicyFile('{ not valid json');
    assert.throws(() => loadGate2Policy(file), (err) => {
      assert.ok(err instanceof Gate2PolicyLoadError);
      assert.equal(err.code, POLICY_LOAD_FAILURE_CODE.MALFORMED);
      return true;
    });
  });

  test('missing policy file -> deterministic policy-load failure', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate2-policy-'));
    const file = path.join(dir, 'does-not-exist.json');
    assert.throws(() => loadGate2Policy(file), (err) => {
      assert.ok(err instanceof Gate2PolicyLoadError);
      assert.equal(err.code, POLICY_LOAD_FAILURE_CODE.MISSING);
      return true;
    });
  });

  test('unsupported rule set (missing a required id) -> deterministic policy-load failure', () => {
    const file = tmpPolicyFile(validPolicy({ rules: REQUIRED_RULE_IDS.slice(1).map((id) => ({ id, name: id })) }));
    assert.throws(() => loadGate2Policy(file), (err) => {
      assert.ok(err instanceof Gate2PolicyLoadError);
      assert.equal(err.code, POLICY_LOAD_FAILURE_CODE.INVALID_RULE_SET);
      return true;
    });
  });

  test('unsupported rule set (extra id) -> deterministic policy-load failure', () => {
    const file = tmpPolicyFile(validPolicy({ rules: [...REQUIRED_RULE_IDS.map((id) => ({ id, name: id })), { id: 'GC-006', name: 'EXTRA' }] }));
    assert.throws(() => loadGate2Policy(file), (err) => {
      assert.ok(err instanceof Gate2PolicyLoadError);
      assert.equal(err.code, POLICY_LOAD_FAILURE_CODE.INVALID_RULE_SET);
      return true;
    });
  });

  test('unsupported rule set (duplicate id) -> deterministic policy-load failure', () => {
    const file = tmpPolicyFile(validPolicy({ rules: [...REQUIRED_RULE_IDS.map((id) => ({ id, name: id })), { id: REQUIRED_RULE_IDS[0], name: 'DUP' }] }));
    assert.throws(() => loadGate2Policy(file), (err) => {
      assert.ok(err instanceof Gate2PolicyLoadError);
      assert.equal(err.code, POLICY_LOAD_FAILURE_CODE.INVALID_RULE_SET);
      return true;
    });
  });

  test('policy is read fresh rather than cached: an on-disk edit is observed on the very next call', () => {
    const file = tmpPolicyFile(validPolicy({ version: '1.0.0' }));
    const first = loadGate2Policy(file);
    assert.equal(first.version, '1.0.0');
    fs.writeFileSync(file, validPolicy({ version: '2.0.0' }));
    const second = loadGate2Policy(file);
    assert.equal(second.version, '2.0.0', 'loadGate2Policy must not cache the previous read');
  });

  test('version changes are observable by the evaluator/caller on every call, including reverting to invalid', () => {
    const file = tmpPolicyFile(validPolicy({ version: 'v1' }));
    assert.equal(loadGate2Policy(file).version, 'v1');
    fs.writeFileSync(file, validPolicy({ version: 'v2' }));
    assert.equal(loadGate2Policy(file).version, 'v2');
    fs.writeFileSync(file, '{ broken');
    assert.throws(() => loadGate2Policy(file), Gate2PolicyLoadError);
  });
});
