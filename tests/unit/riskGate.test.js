import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateOpportunityRisk } from '../../src/discovery/riskGate.js';
import discoveryPolicy from '../../config/discovery_policy.json' with { type: 'json' };

const riskThresholds = discoveryPolicy.thresholds.risk;

test('low risk on all dimensions -> PASS', () => {
  const { level, action } = evaluateOpportunityRisk({ policyRisk: 0.1, copyrightRisk: 0.1, repetitionRisk: 0.1 }, riskThresholds);
  assert.equal(level, 'PASS');
  assert.equal(action, 'EXECUTE');
});

test('warning-band repetition risk -> WARNING, execute+log', () => {
  const { level, action } = evaluateOpportunityRisk({ policyRisk: 0.1, copyrightRisk: 0.1, repetitionRisk: 0.5 }, riskThresholds);
  assert.equal(level, 'WARNING');
  assert.equal(action, 'EXECUTE_AND_LOG');
});

test('critical copyright risk -> CRITICAL, hard veto regardless of other dimensions', () => {
  const { level, action } = evaluateOpportunityRisk({ policyRisk: 0.0, copyrightRisk: 0.9, repetitionRisk: 0.0 }, riskThresholds);
  assert.equal(level, 'CRITICAL');
  assert.equal(action, 'STOP_AND_ESCALATE');
});

test('critical risk vetoes regardless of how low other risk dimensions are (no averaging)', () => {
  const { level } = evaluateOpportunityRisk({ policyRisk: 0.95, copyrightRisk: 0.0, repetitionRisk: 0.0 }, riskThresholds);
  assert.equal(level, 'CRITICAL', 'a single critical dimension must veto even when the others are at zero risk');
});
