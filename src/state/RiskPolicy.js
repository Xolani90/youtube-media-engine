/**
 * RiskPolicy defines what CRITICAL means (spec: normal ops need no Owner
 * approval; only CRITICAL conditions stop/escalate). This is the single
 * place that list lives, so it's auditable and Owner-editable rather than
 * scattered through business logic.
 */
export const RISK_LEVELS = Object.freeze({
  PASS: 'PASS',
  WARNING: 'WARNING',
  CRITICAL: 'CRITICAL'
});

// Flags from spec §13 classified by severity. The Owner can revise this
// mapping — it is intentionally isolated from business logic.
export const FLAG_SEVERITY = Object.freeze({
  FACTUAL_UNCERTAINTY: RISK_LEVELS.WARNING,
  LOW_EVIDENCE: RISK_LEVELS.WARNING,
  DUPLICATIVE_CONTENT: RISK_LEVELS.WARNING,
  SYNTHETIC_MEDIA_DISCLOSURE: RISK_LEVELS.WARNING,
  COPYRIGHT_RISK: RISK_LEVELS.CRITICAL,
  DEFAMATION_RISK: RISK_LEVELS.CRITICAL,
  FINANCIAL_ADVICE_RISK: RISK_LEVELS.CRITICAL,
  MEDICAL_ADVICE_RISK: RISK_LEVELS.CRITICAL,
  LEGAL_ADVICE_RISK: RISK_LEVELS.CRITICAL,
  PROVIDER_FAILURE: RISK_LEVELS.CRITICAL,
  UNEXPECTED_COST: RISK_LEVELS.CRITICAL,
  BUDGET_EXCEEDED: RISK_LEVELS.CRITICAL,

  // Opportunity Discovery v0.6 §11 — HIGH_POLICY_RISK/HIGH_COPYRIGHT_RISK/
  // HIGH_REPETITION_RISK are the CRITICAL veto flags for the discovery
  // risk gate. Added here (not a parallel map) per this file's own
  // extension point.
  HIGH_POLICY_RISK: RISK_LEVELS.CRITICAL,
  HIGH_COPYRIGHT_RISK: RISK_LEVELS.CRITICAL,
  HIGH_REPETITION_RISK: RISK_LEVELS.CRITICAL
});

/**
 * Given a list of flags, returns the overall risk level (worst-case wins)
 * and the corresponding action.
 */
export function evaluateFlags(flags = []) {
  let level = RISK_LEVELS.PASS;
  for (const flag of flags) {
    const severity = FLAG_SEVERITY[flag] ?? RISK_LEVELS.WARNING; // unknown flags treated cautiously
    if (severity === RISK_LEVELS.CRITICAL) {
      level = RISK_LEVELS.CRITICAL;
      break;
    }
    if (severity === RISK_LEVELS.WARNING && level === RISK_LEVELS.PASS) {
      level = RISK_LEVELS.WARNING;
    }
  }
  const action = level === RISK_LEVELS.CRITICAL ? 'STOP_AND_ESCALATE'
    : level === RISK_LEVELS.WARNING ? 'EXECUTE_AND_LOG'
    : 'EXECUTE';
  return { level, action };
}
