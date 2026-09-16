// Asset Provisioning — Milestone D. The missing stage between Production
// and Media Production: acquires and persists ONE real, provenance-honest
// visual asset for a produced content_version, so Media Production has
// something to consume. Asset Provisioning owns this vocabulary; it is
// not shared with or imported from Production, Media Production, or
// Quality Gate.
//
// This stage does NOT transition content_versions.state. Production
// already transitioned PRODUCTION_READY -> PRODUCED; Asset Provisioning
// runs downstream of that as a pure acquisition + persistence step and
// introduces no new lifecycle state.

export const ASSET_PROVISIONING_STAGE = 'ASSET_PROVISIONING';

export const OUTCOME = Object.freeze({
  STRUCTURAL_FAILURE: 'STRUCTURAL_FAILURE',
  NOT_YET_PRODUCED: 'NOT_YET_PRODUCED',
  ALREADY_PROVISIONED: 'ALREADY_PROVISIONED',
  NO_VISUAL_CONTEXT: 'NO_VISUAL_CONTEXT',
  NO_ASSET_ACQUIRED: 'NO_ASSET_ACQUIRED',
  INVALID_PROVIDER_RESULT: 'INVALID_PROVIDER_RESULT',
  PROVISIONED: 'PROVISIONED'
});

export const DECISION_LOG_DECISION = Object.freeze({
  STRUCTURAL_FAILURE: 'STRUCTURAL_FAILURE',
  NOT_YET_PRODUCED: 'NOT_YET_PRODUCED',
  ALREADY_PROVISIONED: 'ALREADY_PROVISIONED',
  NO_VISUAL_CONTEXT: 'NO_VISUAL_CONTEXT',
  NO_ASSET_ACQUIRED: 'NO_ASSET_ACQUIRED',
  INVALID_PROVIDER_RESULT: 'INVALID_PROVIDER_RESULT',
  PROVISIONED: 'PROVISIONED'
});

// The usage_context this stage records for the one visual asset it
// provisions. 'b-roll' is an existing convention already used elsewhere
// in fixtures/docs for a general (non-thumbnail) visual usage — reused
// here rather than inventing a new usage_context string.
export const PROVISIONING_USAGE_CONTEXT = 'b-roll';

// Free-text length the derived visual query is truncated to when it is
// built from a Script fallback (visual_ideas is used verbatim, untouched,
// since it is already meant to be a short/curated field).
export const SCRIPT_FALLBACK_QUERY_MAX_LENGTH = 120;
