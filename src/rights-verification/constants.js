// Rights Verification -- F2/F3 (ADR-0013). The stage between Asset
// Provisioning and Media Production that makes `VERIFIED` reachable at
// all (F1 finding 3: no production path previously ever set it -- see
// the existing ASSET_RIGHTS_BLOCKED gates in
// src/production/pipeline.js and src/media/pipeline.js, which today
// can only ever see UNVERIFIED or DISPUTED).
//
// This stage does NOT transition content_versions.state -- mirrors
// Asset Provisioning and Media Production's own discipline (F2 §9). The
// only field it is ever allowed to mutate on `assets` is
// verification_status, and only ever alongside a new, append-only
// asset_verifications row in the same transaction (F2 §6/§10).
//
// VERIFIED means exactly (F2 §3): "The recorded evidence for this asset
// satisfies AME's currently-defined automated verification policy." It
// does NOT mean legal clearance, copyright-free status, ownership,
// releases, or absence of third-party claims -- those words must never
// appear as this stage's meaning anywhere in this module or its policy
// submodules.

export const RIGHTS_VERIFICATION_STAGE = 'RIGHTS_VERIFICATION';

export const OUTCOME = Object.freeze({
  STRUCTURAL_FAILURE: 'STRUCTURAL_FAILURE',
  NOT_YET_PRODUCED: 'NOT_YET_PRODUCED',
  NO_ASSETS_ATTACHED: 'NO_ASSETS_ATTACHED',
  NO_ELIGIBLE_ASSETS: 'NO_ELIGIBLE_ASSETS',
  PROCESSED: 'PROCESSED'
});

export const DECISION_LOG_DECISION = Object.freeze({
  STRUCTURAL_FAILURE: 'STRUCTURAL_FAILURE',
  NOT_YET_PRODUCED: 'NOT_YET_PRODUCED',
  NO_ASSETS_ATTACHED: 'NO_ASSETS_ATTACHED',
  NO_ELIGIBLE_ASSETS: 'NO_ELIGIBLE_ASSETS',
  VERIFIED: 'VERIFIED',
  NOT_VERIFIED: 'NOT_VERIFIED',
  DISPUTED: 'DISPUTED'
});

// Per-asset decision values persisted to asset_verifications.decision
// (0011_asset_verification.sql CHECK constraint) -- re-exported here so
// pipeline/policy modules share one vocabulary rather than repeating
// string literals.
export const DECISION = Object.freeze({
  VERIFIED: 'VERIFIED',
  NOT_VERIFIED: 'NOT_VERIFIED',
  DISPUTED: 'DISPUTED'
});

export const VERIFIER_TYPE = Object.freeze({
  AUTOMATED: 'automated',
  HUMAN: 'human'
});

// assets.verification_status values this stage may read/write (existing
// CHECK constraint on the assets table, 0007_asset_rights_provenance.sql
// -- unchanged, not redefined here, just referenced).
export const VERIFICATION_STATUS = Object.freeze({
  UNVERIFIED: 'UNVERIFIED',
  VERIFIED: 'VERIFIED',
  DISPUTED: 'DISPUTED'
});