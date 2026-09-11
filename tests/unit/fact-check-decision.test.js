import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { severityForClaim, evaluateDecision } from '../../src/fact-check/decision.js';
import { CLAIM_SEVERITY, FACT_CHECK_STATUS } from '../../src/fact-check/constants.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// --- Risk isolation (spec D5/§9/§18): no fact-check source file may
// import RiskPolicy or reference risk_assessments. ---

test('risk isolation: no src/fact-check/*.js file imports RiskPolicy or touches risk_assessments', () => {
  const dir = path.resolve(__dirname, '../../src/fact-check');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.js'));
  assert.ok(files.length > 0, 'expected fact-check source files to exist');
  for (const file of files) {
    const content = fs.readFileSync(path.join(dir, file), 'utf8');
    // Only executable import/require statements are checked — explanatory
    // comments are allowed to name RiskPolicy when documenting that no
    // such dependency exists (as this repository's own convention does
    // for e.g. Script's independence from Research).
    const importLines = content
      .split('\n')
      .filter((line) => /^\s*import\b/.test(line) || /require\(/.test(line));
    for (const line of importLines) {
      assert.ok(!/risk[-_]?policy/i.test(line), `${file} must not import RiskPolicy: "${line.trim()}"`);
    }
    assert.ok(!/\brisk_assessments\b/i.test(content.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')),
      `${file} must not reference the risk_assessments table outside comments`);
  }
});

// --- severityForClaim: exact evidence_status mapping (spec §8) ---------

test('severityForClaim: VERIFIED -> PASS_COMPATIBLE', () => {
  assert.equal(severityForClaim({ evidence_status: 'VERIFIED' }, false), CLAIM_SEVERITY.PASS_COMPATIBLE);
});

test('severityForClaim: PARTIALLY_SUPPORTED -> REVIEW', () => {
  assert.equal(severityForClaim({ evidence_status: 'PARTIALLY_SUPPORTED' }, false), CLAIM_SEVERITY.REVIEW);
});

test('severityForClaim: UNSUPPORTED -> REJECT', () => {
  assert.equal(severityForClaim({ evidence_status: 'UNSUPPORTED' }, false), CLAIM_SEVERITY.REJECT);
});

test('severityForClaim: CONTESTED -> REJECT', () => {
  assert.equal(severityForClaim({ evidence_status: 'CONTESTED' }, false), CLAIM_SEVERITY.REJECT);
});

test('severityForClaim: applicable CONTRADICTS forces REJECT even when evidence_status is VERIFIED', () => {
  assert.equal(severityForClaim({ evidence_status: 'VERIFIED' }, true), CLAIM_SEVERITY.REJECT);
});

test('severityForClaim: applicable CONTRADICTS forces REJECT even when evidence_status is PARTIALLY_SUPPORTED', () => {
  assert.equal(severityForClaim({ evidence_status: 'PARTIALLY_SUPPORTED' }, true), CLAIM_SEVERITY.REJECT);
});

// --- evaluateDecision: aggregation (spec §8: REJECT > REVIEW > PASS) ---

function claim(id, evidenceStatus) {
  return { heading: 'Intro', claim: { id, evidence_status: evidenceStatus }, hasApplicableContradiction: false };
}

test('evaluateDecision: all VERIFIED -> overall PASS', () => {
  const { status, findings } = evaluateDecision([claim('c1', 'VERIFIED'), claim('c2', 'VERIFIED')]);
  assert.equal(status, FACT_CHECK_STATUS.PASS);
  assert.equal(findings.length, 2);
  assert.ok(findings.every((f) => f.finding === CLAIM_SEVERITY.PASS_COMPATIBLE));
});

test('evaluateDecision: PASS + REVIEW -> overall REVIEW', () => {
  const { status } = evaluateDecision([claim('c1', 'VERIFIED'), claim('c2', 'PARTIALLY_SUPPORTED')]);
  assert.equal(status, FACT_CHECK_STATUS.REVIEW);
});

test('evaluateDecision: REVIEW + REJECT -> overall REJECT', () => {
  const { status } = evaluateDecision([claim('c1', 'PARTIALLY_SUPPORTED'), claim('c2', 'UNSUPPORTED')]);
  assert.equal(status, FACT_CHECK_STATUS.REJECT);
});

test('evaluateDecision: PASS + REJECT -> overall REJECT (worst-case-wins, not majority)', () => {
  const { status } = evaluateDecision([
    claim('c1', 'VERIFIED'), claim('c2', 'VERIFIED'), claim('c3', 'VERIFIED'), claim('c4', 'UNSUPPORTED')
  ]);
  assert.equal(status, FACT_CHECK_STATUS.REJECT);
});

test('evaluateDecision: a single applicable CONTRADICTS among otherwise-VERIFIED claims forces overall REJECT', () => {
  const items = [
    { heading: 'Intro', claim: { id: 'c1', evidence_status: 'VERIFIED' }, hasApplicableContradiction: false },
    { heading: 'Intro', claim: { id: 'c2', evidence_status: 'VERIFIED' }, hasApplicableContradiction: true }
  ];
  const { status, findings } = evaluateDecision(items);
  assert.equal(status, FACT_CHECK_STATUS.REJECT);
  const c2Finding = findings.find((f) => f.claim_id === 'c2');
  assert.equal(c2Finding.finding, CLAIM_SEVERITY.REJECT);
});

test('evaluateDecision: findings preserve claim_id and section_heading', () => {
  const { findings } = evaluateDecision([claim('c1', 'VERIFIED')]);
  assert.deepEqual(findings, [{ claim_id: 'c1', section_heading: 'Intro', finding: CLAIM_SEVERITY.PASS_COMPATIBLE }]);
});

test('evaluateDecision: absent heading -> section_heading key is omitted from the finding', () => {
  const items = [{ heading: undefined, claim: { id: 'c1', evidence_status: 'VERIFIED' }, hasApplicableContradiction: false }];
  const { findings } = evaluateDecision(items);
  assert.deepEqual(findings, [{ claim_id: 'c1', finding: CLAIM_SEVERITY.PASS_COMPATIBLE }]);
  assert.ok(!('section_heading' in findings[0]));
});

test('evaluateDecision: empty-string heading -> section_heading key is omitted from the finding', () => {
  const items = [{ heading: '', claim: { id: 'c1', evidence_status: 'VERIFIED' }, hasApplicableContradiction: false }];
  const { findings } = evaluateDecision(items);
  assert.deepEqual(findings, [{ claim_id: 'c1', finding: CLAIM_SEVERITY.PASS_COMPATIBLE }]);
  assert.ok(!('section_heading' in findings[0]));
});

test('evaluateDecision: mixed headed and headless findings each behave independently', () => {
  const items = [
    { heading: 'Intro', claim: { id: 'c1', evidence_status: 'VERIFIED' }, hasApplicableContradiction: false },
    { heading: undefined, claim: { id: 'c2', evidence_status: 'VERIFIED' }, hasApplicableContradiction: false }
  ];
  const { findings } = evaluateDecision(items);
  const c1Finding = findings.find((f) => f.claim_id === 'c1');
  const c2Finding = findings.find((f) => f.claim_id === 'c2');
  assert.equal(c1Finding.section_heading, 'Intro');
  assert.ok(!('section_heading' in c2Finding));
});

test('evaluateDecision: is deterministic for the same input', () => {
  const items = [claim('c1', 'PARTIALLY_SUPPORTED'), claim('c2', 'VERIFIED')];
  const first = evaluateDecision(items);
  const second = evaluateDecision(items);
  assert.deepEqual(first, second);
});