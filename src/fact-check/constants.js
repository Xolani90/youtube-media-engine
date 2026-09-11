// Fact-Check Specification §7/§8/§11. Fact-Check owns this vocabulary; it
// is not shared with or imported from RiskPolicy.

export const FACT_CHECK_STAGE = 'FACT_CHECK';

export const FACT_CHECK_STATUS = Object.freeze({
  PASS: 'PASS',
  REVIEW: 'REVIEW',
  REJECT: 'REJECT'
});

// Per-claim finding severity (spec §7): a distinct vocabulary from the
// persisted overall status, even though the string values overlap for
// REVIEW/REJECT.
export const CLAIM_SEVERITY = Object.freeze({
  PASS_COMPATIBLE: 'PASS_COMPATIBLE',
  REVIEW: 'REVIEW',
  REJECT: 'REJECT'
});

// Exhaustive per spec §8. MUST NOT be altered or extended by implementation.
export const EVIDENCE_SEVERITY_MAP = Object.freeze({
  VERIFIED: CLAIM_SEVERITY.PASS_COMPATIBLE,
  PARTIALLY_SUPPORTED: CLAIM_SEVERITY.REVIEW,
  UNSUPPORTED: CLAIM_SEVERITY.REJECT,
  CONTESTED: CLAIM_SEVERITY.REJECT
});

// worst-case-wins ordering (spec §8): REJECT > REVIEW > PASS.
export const SEVERITY_RANK = Object.freeze({
  [CLAIM_SEVERITY.REJECT]: 2,
  [CLAIM_SEVERITY.REVIEW]: 1,
  [CLAIM_SEVERITY.PASS_COMPATIBLE]: 0
});

export const DECISION_LOG_DECISION = Object.freeze({
  STRUCTURAL_FAILURE: 'STRUCTURAL_FAILURE'
});