import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateFlags, RISK_LEVELS } from '../../src/state/RiskPolicy.js';

test('no flags -> PASS/execute', () => {
  const { level, action } = evaluateFlags([]);
  assert.equal(level, RISK_LEVELS.PASS);
  assert.equal(action, 'EXECUTE');
});

test('warning-only flag -> WARNING/execute+log', () => {
  const { level, action } = evaluateFlags(['LOW_EVIDENCE']);
  assert.equal(level, RISK_LEVELS.WARNING);
  assert.equal(action, 'EXECUTE_AND_LOG');
});

test('critical flag -> CRITICAL/stop', () => {
  const { level, action } = evaluateFlags(['COPYRIGHT_RISK']);
  assert.equal(level, RISK_LEVELS.CRITICAL);
  assert.equal(action, 'STOP_AND_ESCALATE');
});

test('critical wins even when mixed with warning', () => {
  const { level } = evaluateFlags(['LOW_EVIDENCE', 'DEFAMATION_RISK']);
  assert.equal(level, RISK_LEVELS.CRITICAL);
});

test('unknown flag treated as warning, not silently ignored', () => {
  const { level } = evaluateFlags(['SOME_NEW_FLAG_NOBODY_CLASSIFIED_YET']);
  assert.equal(level, RISK_LEVELS.WARNING);
});
