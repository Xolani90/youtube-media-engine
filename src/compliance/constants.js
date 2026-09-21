// Gate 2 / FINAL_COMPLIANCE v1 vocabulary (ADR-0032). Compliance owns this
// vocabulary; it is not shared with Fact-Check, Quality Gate, or any other
// stage's result vocabulary (per-stage decoupling convention).

export const FINAL_COMPLIANCE_STAGE = 'FINAL_COMPLIANCE';

// ADR-0032 section 3: exactly five deterministic rules.
export const RULE = Object.freeze({
  FINAL_MEDIA_INTEGRITY: 'GC-001',
  ASSET_RIGHTS: 'GC-002',
  FINAL_METADATA_PRESENCE: 'GC-003',
  SCRIPT_MEDIA_CONSISTENCY: 'GC-004',
  EXISTING_PROVENANCE: 'GC-005'
});

export const RULE_NAME = Object.freeze({
  'GC-001': 'FINAL_MEDIA_INTEGRITY',
  'GC-002': 'ASSET_RIGHTS',
  'GC-003': 'FINAL_METADATA_PRESENCE',
  'GC-004': 'SCRIPT_MEDIA_CONSISTENCY',
  'GC-005': 'EXISTING_PROVENANCE'
});

// The exact, sorted v1 rule-ID set. A policy pack must contain exactly these.
export const REQUIRED_RULE_IDS = Object.freeze(Object.values(RULE).slice().sort());

// Per-rule and overall result.
export const RESULT = Object.freeze({
  PASS: 'PASS',
  REVIEW: 'REVIEW',
  BLOCK: 'BLOCK'
});

// runFinalCompliance() outcome (distinct from the persisted decision).
export const OUTCOME = Object.freeze({
  STRUCTURAL_FAILURE: 'STRUCTURAL_FAILURE',
  NOT_YET_RENDERED: 'NOT_YET_RENDERED',
  INELIGIBLE_STATE: 'INELIGIBLE_STATE',
  // Deterministic policy-load failure: no PASS established, no existing PASS
  // accepted, no state transition, no fabricated REVIEW/BLOCK (ADR-0032 s13).
  POLICY_LOAD_FAILURE: 'POLICY_LOAD_FAILURE',
  // A FINAL_COMPLIANCE item whose newest PASS is still fully valid: nothing
  // is evaluated again, nothing is appended, no state changes.
  ALREADY_VALID: 'ALREADY_VALID',
  PASS: 'PASS',
  REVIEW: 'REVIEW',
  BLOCK: 'BLOCK',
  // The content_version's state changed between evaluation and persistence;
  // nothing was written.
  CONCURRENT_STATE_CHANGE: 'CONCURRENT_STATE_CHANGE'
});

export const DECISION_LOG_DECISION = Object.freeze({
  STRUCTURAL_FAILURE: 'STRUCTURAL_FAILURE',
  NOT_YET_RENDERED: 'NOT_YET_RENDERED',
  INELIGIBLE_STATE: 'INELIGIBLE_STATE',
  POLICY_LOAD_FAILURE: 'POLICY_LOAD_FAILURE',
  PASS: 'GATE2_PASS',
  REVIEW: 'GATE2_REVIEW',
  BLOCK: 'GATE2_BLOCK'
});

// Deterministic reason codes for a PASS that does not authorize (used by the
// runner's validity check and by the publication-boundary verification).
export const NON_AUTHORIZING = Object.freeze({
  CONTENT_VERSION_NOT_FOUND: 'CONTENT_VERSION_NOT_FOUND',
  STATE_NOT_FINAL_COMPLIANCE: 'STATE_NOT_FINAL_COMPLIANCE',
  NO_COMPLIANCE_RECORD: 'NO_COMPLIANCE_RECORD',
  NEWEST_RECORD_NOT_PASS: 'NEWEST_RECORD_NOT_PASS',
  CONTENT_BINDING_MISMATCH: 'CONTENT_BINDING_MISMATCH',
  SCRIPT_BINDING_MISMATCH: 'SCRIPT_BINDING_MISMATCH',
  PRODUCTION_SCRIPT_MISMATCH: 'PRODUCTION_SCRIPT_MISMATCH',
  MEDIA_ARTIFACT_IDENTITY_MISMATCH: 'MEDIA_ARTIFACT_IDENTITY_MISMATCH',
  MEDIA_FILE_MISSING: 'MEDIA_FILE_MISSING',
  MEDIA_FILE_UNREADABLE: 'MEDIA_FILE_UNREADABLE',
  MEDIA_CHECKSUM_MISMATCH: 'MEDIA_CHECKSUM_MISMATCH',
  BOUND_CHECKSUM_MISMATCH: 'BOUND_CHECKSUM_MISMATCH',
  METADATA_BINDING_MISMATCH: 'METADATA_BINDING_MISMATCH',
  POLICY_VERSION_MISMATCH: 'POLICY_VERSION_MISMATCH',
  RULE_ID_SET_MISMATCH: 'RULE_ID_SET_MISMATCH',
  EVIDENCE_REFERENCES_INVALID: 'EVIDENCE_REFERENCES_INVALID'
});
