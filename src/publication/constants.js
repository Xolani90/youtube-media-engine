// Publication v1 — the provider-agnostic core that takes an already
// rendered `media_artifacts` row and, via a provider adapter (see
// ./PublicationProvider.js and ./youtube/YouTubeAdapter.js), produces a
// confirmed external publication. Publication owns this vocabulary; it
// is not shared with or imported from Media Production, Production, or
// any earlier stage.
//
// This is the ONLY stage that transitions content_versions.state from
// FINAL_COMPLIANCE -> PUBLISHED (ContentStateMachine's one legal step past
// FINAL_COMPLIANCE; ADR-0032 removed the direct PRODUCED -> PUBLISHED step so
// Gate 2 cannot be bypassed), and only after a confirmed provider result —
// never on authorization, request construction, or a successful HTTP send alone.

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
  // ADR-0032 (Gate 2 / FINAL_COMPLIANCE) publication-boundary outcomes.
  // GATE2_NOT_AUTHORIZING: no currently valid Gate 2 PASS (the newest
  // compliance record is absent/non-PASS, or any bound value, the file
  // checksum, the policy version, the rule-ID set or an evidence reference no
  // longer matches, or the item is not in FINAL_COMPLIANCE). The `reason`
  // carries a deterministic code from compliance/constants.js NON_AUTHORIZING.
  // GATE2_POLICY_LOAD_FAILURE: the Gate 2 policy pack is missing/malformed/
  // wrong, so no PASS can be accepted. Neither outcome changes state, claims
  // a publication, or reaches authorization or the provider.
  GATE2_NOT_AUTHORIZING: 'GATE2_NOT_AUTHORIZING',
  GATE2_POLICY_LOAD_FAILURE: 'GATE2_POLICY_LOAD_FAILURE',
  AUTHORIZATION_DENIED: 'AUTHORIZATION_DENIED',
  PROVIDER_FAILURE: 'PROVIDER_FAILURE',
  // ADR-0030 §8: the upload happened and the provider returned an item id,
  // but the provider-confirmed visibility is not the requested PUBLIC.
  // Persisted as publications.status='FAILED' + failure_reason
  // VISIBILITY_MISMATCH (see below). Distinct from PROVIDER_FAILURE so the
  // runner's PROVIDER_FAILURE-keyed retry accounting is not consumed.
  VISIBILITY_MISMATCH: 'VISIBILITY_MISMATCH',
  QUARANTINED: 'QUARANTINED',
  AMBIGUOUS: 'AMBIGUOUS',
  PUBLISHED: 'PUBLISHED'
});

export const DECISION_LOG_DECISION = Object.freeze({
  STRUCTURAL_FAILURE: 'STRUCTURAL_FAILURE',
  NOT_YET_RENDERED: 'NOT_YET_RENDERED',
  INELIGIBLE_STATE: 'INELIGIBLE_STATE',
  ARTIFACT_MISSING: 'ARTIFACT_MISSING',
  ASSET_RIGHTS_BLOCKED: 'ASSET_RIGHTS_BLOCKED',
  GATE2_NOT_AUTHORIZING: 'GATE2_NOT_AUTHORIZING',
  GATE2_POLICY_LOAD_FAILURE: 'GATE2_POLICY_LOAD_FAILURE',
  AUTHORIZATION_DENIED: 'AUTHORIZATION_DENIED',
  PROVIDER_FAILURE: 'PROVIDER_FAILURE',
  AMBIGUOUS: 'AMBIGUOUS',
  // ADR-0030 audit: which grant authorized the external action.
  AUTHORIZATION_GRANTED: 'AUTHORIZATION_GRANTED',
  INTERRUPTED_ATTEMPT: 'INTERRUPTED_ATTEMPT',
  PUBLISHED: 'PUBLISHED',
  // Phase 2B: thumbnail upload is a second, independently observable
  // external action against an already-PUBLISHED video (see
  // pipeline.js#attemptThumbnailUpload). Distinct decision values so a
  // thumbnail outcome is never conflated with the video's own
  // PROVIDER_FAILURE/AMBIGUOUS/PUBLISHED audit trail.
  THUMBNAIL_GENERATION_FAILED: 'THUMBNAIL_GENERATION_FAILED',
  THUMBNAIL_AUTHORIZATION_DENIED: 'THUMBNAIL_AUTHORIZATION_DENIED',
  THUMBNAIL_SUCCESS: 'THUMBNAIL_SUCCESS',
  THUMBNAIL_FAILURE: 'THUMBNAIL_FAILURE',
  THUMBNAIL_AMBIGUOUS: 'THUMBNAIL_AMBIGUOUS'
});

// Phase 2B: durable `publications.thumbnail_status` vocabulary -- the
// thumbnail-upload analogue of PUBLICATION_STATUS above, tracked on the
// SAME row (never a second `publications` row: see
// 0023_thumbnail_columns.sql). NULL/absent means "never attempted".
export const THUMBNAIL_STATUS = Object.freeze({
  PENDING: 'PENDING',
  SUCCESS: 'SUCCESS',
  FAILED: 'FAILED',
  AMBIGUOUS: 'AMBIGUOUS'
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

// ADR-0030 §8 / Owner Open Item 4 decision (Option 2). A confirmed upload
// whose provider-returned visibility is not the requested PUBLIC is stored
// as publications.status = FAILED with this failure_reason. This is a
// NARROW, terminal exception to FAILED's otherwise-reclaimable semantics:
// the external upload already occurred, so a FAILED row with THIS reason
// is never reclaimed, re-uploaded, selected for automatic re-publication,
// or counted against the bounded retry budget. No other failure_reason is
// affected. No new lifecycle status exists.
export const VISIBILITY_MISMATCH_FAILURE_REASON = 'VISIBILITY_MISMATCH';

// Visibility values the YouTube adapter supports (ADR-0030 open item 3).
export const REQUESTED_VISIBILITY_PUBLIC = 'public';

// Short-form derivative production: which media artifact target a given
// provider id publishes. Every provider not listed here publishes the
// long-form (default) artifact -- this map only needs an entry for a
// provider that publishes the SHORT_FORM derivative instead (see
// ../media/eligibility.js's `target` param and providerRegistry.js's
// `youtube_shorts` entry, the only such provider at implementation
// time).
export const PUBLICATION_TARGET_BY_PROVIDER = Object.freeze({
  youtube_shorts: 'SHORT_FORM',
  tiktok: 'SHORT_FORM',
  facebook_reels: 'SHORT_FORM'
});

export function publicationTargetForProvider(provider) {
  return PUBLICATION_TARGET_BY_PROVIDER[provider] ?? 'LONGFORM';
}