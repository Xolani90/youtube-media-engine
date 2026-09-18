// Publication v1 — the provider-agnostic core that takes an already
// rendered `media_artifacts` row and, via a provider adapter (see
// ./PublicationProvider.js and ./youtube/YouTubeAdapter.js), produces a
// confirmed external publication. Publication owns this vocabulary; it
// is not shared with or imported from Media Production, Production, or
// any earlier stage.
//
// This is the ONLY stage that transitions content_versions.state from
// PRODUCED -> PUBLISHED (ContentStateMachine's one legal step past
// PRODUCED), and only after a confirmed provider result — never on
// authorization, request construction, or a successful HTTP send alone.

export const PUBLICATION_STAGE = 'PUBLICATION';

// Durable status values for the `publications` table (see
// 0010_publication.sql for the full meaning of each).
export const PUBLICATION_STATUS = Object.freeze({
  PENDING: 'PENDING',
  PUBLISHED: 'PUBLISHED',
  FAILED: 'FAILED',
  AMBIGUOUS: 'AMBIGUOUS'
});

// Normalized result shape a provider adapter returns from publish()
// (see ./PublicationProvider.js). The publication core interprets only
// these three, never a provider-specific shape.
export const PUBLICATION_RESULT_STATUS = Object.freeze({
  SUCCESS: 'SUCCESS',
  EXPLICIT_FAILURE: 'EXPLICIT_FAILURE',
  AMBIGUOUS: 'AMBIGUOUS'
});

// runPublication()'s outcome (distinct from PUBLICATION_STATUS, which
// is the persisted row status — mirrors the existing
// OUTCOME-vs-persisted-state split used by every prior stage).
export const OUTCOME = Object.freeze({
  STRUCTURAL_FAILURE: 'STRUCTURAL_FAILURE',
  NOT_YET_RENDERED: 'NOT_YET_RENDERED',
  INELIGIBLE_STATE: 'INELIGIBLE_STATE',
  ARTIFACT_MISSING: 'ARTIFACT_MISSING',
  ALREADY_PUBLISHED: 'ALREADY_PUBLISHED',
  // F2-G Open Decision 1 (ADR-0013 §6 "Publication redesign") — Owner
  // decision: publication-time blocking rights gate. Re-reads the
  // current assets.verification_status immediately before the D-C2
  // authorization/provider-call sequence, exactly mirroring the
  // existing ASSET_RIGHTS_BLOCKED vocabulary already used identically
  // by src/production/pipeline.js and src/media/pipeline.js (each
  // module re-declares its own copy per this repository's existing
  // per-stage decoupling convention -- this is not a new value, just
  // this module's own copy of an established cross-stage vocabulary).
  ASSET_RIGHTS_BLOCKED: 'ASSET_RIGHTS_BLOCKED',
  AUTHORIZATION_DENIED: 'AUTHORIZATION_DENIED',
  PROVIDER_FAILURE: 'PROVIDER_FAILURE',
  AMBIGUOUS: 'AMBIGUOUS',
  PUBLISHED: 'PUBLISHED'
});

export const DECISION_LOG_DECISION = Object.freeze({
  STRUCTURAL_FAILURE: 'STRUCTURAL_FAILURE',
  NOT_YET_RENDERED: 'NOT_YET_RENDERED',
  INELIGIBLE_STATE: 'INELIGIBLE_STATE',
  ARTIFACT_MISSING: 'ARTIFACT_MISSING',
  ASSET_RIGHTS_BLOCKED: 'ASSET_RIGHTS_BLOCKED',
  AUTHORIZATION_DENIED: 'AUTHORIZATION_DENIED',
  PROVIDER_FAILURE: 'PROVIDER_FAILURE',
  AMBIGUOUS: 'AMBIGUOUS',
  INTERRUPTED_ATTEMPT: 'INTERRUPTED_ATTEMPT',
  PUBLISHED: 'PUBLISHED'
});

// D-C2 action-id convention (ADR-0008 §3.1.3/§3.2; matches the worked
// example already present in
// tests/unit/side-effect-authorization.test.js, 'publish:youtube:abc123'):
// authorization is granted per external action, not per run and not for
// an entire content item's future actions in the abstract — so the
// action id is scoped to this exact content_version + provider, never
// just `publish:${provider}` alone.
export function publicationActionId(provider, contentVersionId) {
  return `publish:${provider}:${contentVersionId}`;
}
