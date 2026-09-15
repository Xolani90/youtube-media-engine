// Production — smallest real production artifact (Owner Production MVP
// brief). Production owns this vocabulary; it is not shared with or
// imported from Fact-Check, Originality, or Quality Gate.
//
// The only legal entry point is PRODUCTION_READY, and the only legal
// successful exit is PRODUCED (ContentStateMachine). Production does not
// introduce any new lifecycle state.

export const PRODUCTION_STAGE = 'PRODUCTION';

export const OUTCOME = Object.freeze({
  STRUCTURAL_FAILURE: 'STRUCTURAL_FAILURE',
  INELIGIBLE_STATE: 'INELIGIBLE_STATE',
  ASSET_RIGHTS_BLOCKED: 'ASSET_RIGHTS_BLOCKED',
  ARTIFACT_WRITE_FAILED: 'ARTIFACT_WRITE_FAILED',
  ALREADY_PRODUCED: 'ALREADY_PRODUCED',
  PRODUCED: 'PRODUCED'
});

export const DECISION_LOG_DECISION = Object.freeze({
  STRUCTURAL_FAILURE: 'STRUCTURAL_FAILURE',
  INELIGIBLE_STATE: 'INELIGIBLE_STATE',
  ASSET_RIGHTS_BLOCKED: 'ASSET_RIGHTS_BLOCKED',
  ARTIFACT_WRITE_FAILED: 'ARTIFACT_WRITE_FAILED',
  PRODUCED: 'PRODUCED'
});
