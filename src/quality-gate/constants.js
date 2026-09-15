// Gate 1 — Quality Gate / Production Readiness (ADR-0006 D-G8, Owner
// Gate-1 decision). Quality Gate owns this vocabulary; it is not shared
// with or imported from Fact-Check, Originality, or RiskPolicy.
//
// Gate 1 evaluates FOUR independent, single-dimension checks (Owner
// decision) and combines them with a deterministic worst-case selector —
// never a score, weighting, or average:
//
//   any BLOCK  -> aggregate BLOCK  -> BLOCKED
//   else any REVIEW -> aggregate REVIEW -> NEEDS_REVIEW
//   else all PASS -> aggregate PASS -> PRODUCTION_READY
//
// This module deliberately does NOT read or write `risk_assessments`
// (ADR-0006 Architectural Decision A: that table "remains Risk's alone").
// It deliberately does NOT interpret `originality_checks.max_similarity`
// (Owner decision: evidence-existence only, no threshold). It deliberately
// does NOT parse `assets.usage_restrictions` (free text, not authorized
// for automated interpretation).

export const QUALITY_GATE_STAGE = 'QUALITY_GATE';

export const CHECK_RESULT = Object.freeze({
  PASS: 'PASS',
  REVIEW: 'REVIEW',
  BLOCK: 'BLOCK'
});

// worst-case-wins ordering, mirrors Fact-Check's SEVERITY_RANK precedent.
export const RESULT_RANK = Object.freeze({
  [CHECK_RESULT.BLOCK]: 2,
  [CHECK_RESULT.REVIEW]: 1,
  [CHECK_RESULT.PASS]: 0
});

export const CHECK_NAME = Object.freeze({
  FACT_CHECK: 'FACT_CHECK_CHECK',
  ORIGINALITY: 'ORIGINALITY_EVIDENCE_CHECK',
  ASSET_RIGHTS: 'ASSET_RIGHTS_CHECK',
  STRUCTURAL: 'STRUCTURAL_COMPLETENESS_CHECK'
});

// Maps the aggregate Gate 1 result to the legal exit state. Both
// NEEDS_REVIEW and BLOCKED are pre-existing ContentStateMachine
// FAILURE_STATES (reachable from any state); PRODUCTION_READY is the
// single legal forward step from QUALITY_GATE. No new state is
// introduced by this module.
export const TARGET_STATE = Object.freeze({
  [CHECK_RESULT.BLOCK]: 'BLOCKED',
  [CHECK_RESULT.REVIEW]: 'NEEDS_REVIEW',
  [CHECK_RESULT.PASS]: 'PRODUCTION_READY'
});

export const DECISION_LOG_DECISION = Object.freeze({
  STRUCTURAL_FAILURE: 'STRUCTURAL_FAILURE',
  QUALITY_GATE_ENTERED: 'QUALITY_GATE'
});
