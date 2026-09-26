import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { PUBLICATION_STAGE, PUBLICATION_STATUS, PUBLICATION_RESULT_STATUS, OUTCOME, DECISION_LOG_DECISION, THUMBNAIL_STATUS, publicationActionId, VISIBILITY_MISMATCH_FAILURE_REASON, REQUESTED_VISIBILITY_PUBLIC, publicationTargetForProvider } from './constants.js';
import { generateThumbnail } from '../media/thumbnail.js';
import { finalizeArtifact, sha256File } from '../media/artifactStore.js';
import { resolveMediaForPublication } from './eligibility.js';
import { buildPublicationRequest } from './PublicationRequest.js';
import { resolveProvider } from './providerRegistry.js';
import { assertExternalActionAllowed, SideEffectDeniedError } from '../state/SideEffectAuthorization.js';
import { canTransition, transition } from '../state/ContentStateMachine.js';
import { verifyGate2Pass } from '../compliance/verify.js';
import { Gate2PolicyLoadError } from '../compliance/policy.js';
import { InvalidPublicationMetadataError } from './metadataValidation.js';
import { AssetProvenanceRepository } from '../state/AssetProvenance.js';
import { isQuarantined, recordFailedAttempt, RETRY_STAGE } from '../state/StageRetryPolicy.js';

/** Same shape/discipline as every other stage's local logDecision helper. */
function logDecision(storage, { runId = null, subjectType, subjectId, decision, reason, resultingState = null }, nowISO = () => new Date().toISOString()) {
  const id = crypto.randomUUID();
  storage.run(
    `INSERT INTO decision_log
      (id, run_id, subject_type, subject_id, decision, reason, provider, config_snapshot, confidence, risk_level, resulting_state, created_at, stage)
     VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?, ?)`,
    [id, runId, subjectType, subjectId, decision, reason, resultingState, nowISO(), PUBLICATION_STAGE]
  );
  return id;
}

/**
 * ADR-0030 Open Item 4 (Owner Option 2): a FAILED row whose failure_reason
 * is VISIBILITY_MISMATCH records an upload that DID happen (the provider
 * returned an item id) with a provider-confirmed visibility different from
 * the requested PUBLIC. It is the one narrow exception to FAILED being
 * reclaimable: it is terminal for the automatic workflow. Every other
 * FAILED reason keeps its existing reclaim behavior.
 */
function isVisibilityMismatchRow(row) {
  return row?.status === PUBLICATION_STATUS.FAILED && row.failure_reason === VISIBILITY_MISMATCH_FAILURE_REASON;
}

function visibilityMismatchResult(row, reason = 'previously_visibility_mismatch_not_auto_retried') {
  return { outcome: OUTCOME.VISIBILITY_MISMATCH, reason, publication: row };
}

/**
 * Phase 2B: best-effort, idempotent thumbnail generation. Runs once per
 * media_artifacts row (guarded by `thumbnail_path IS NULL` at the UPDATE
 * below, exactly mirroring the claim-race discipline used throughout
 * this file) using the SAME already-normalized title the publication
 * request itself carries (see ./metadataValidation.js via
 * ./PublicationRequest.js) -- never a second, independently-invented
 * title. Written via the existing tmp-file + atomic-rename artifact
 * convention (../media/artifactStore.js#finalizeArtifact), into the
 * same per-content_version directory the rendered .mp4 already lives
 * in, so no parallel artifact layout is introduced.
 *
 * A generation failure (e.g. FFmpeg missing/misconfigured) is
 * deliberately NEVER allowed to fail or block the underlying video
 * publication -- it is logged and swallowed, leaving
 * media_artifacts.thumbnail_path NULL so attemptThumbnailUpload() below
 * simply has nothing to upload (see step 9's `existsSync` guard also
 * covering a since-deleted file).
 *
 * @returns {object} the current (possibly freshly updated) media_artifacts row
 */
function ensureThumbnailArtifact(storage, { mediaArtifact, title, runId, nowISO }) {
  if (mediaArtifact.thumbnail_path && fs.existsSync(mediaArtifact.thumbnail_path)) {
    return mediaArtifact;
  }
  const dir = path.dirname(mediaArtifact.artifact_path);
  const finalPath = path.join(dir, 'thumbnail.png');
  const tmpPath = path.join(dir, `.thumbnail-${process.pid}-${Date.now()}.png`);
  try {
    generateThumbnail(title, tmpPath);
    finalizeArtifact(tmpPath, finalPath);
    const checksum = sha256File(finalPath);
    storage.run(
      `UPDATE media_artifacts SET thumbnail_path = ?, thumbnail_checksum = ? WHERE id = ? AND thumbnail_path IS NULL`,
      [finalPath, checksum, mediaArtifact.id]
    );
  } catch (err) {
    fs.rmSync(tmpPath, { force: true });
    logDecision(storage, {
      runId, subjectType: 'content_version', subjectId: mediaArtifact.content_version_id,
      decision: DECISION_LOG_DECISION.THUMBNAIL_GENERATION_FAILED, reason: `thumbnail_generation_failed_${err.message}`
    }, nowISO);
  }
  return storage.get('SELECT * FROM media_artifacts WHERE id = ?', [mediaArtifact.id]);
}

/**
 * Phase 2B: thumbnail upload as a SECOND, independently observable
 * external step against an already-PUBLISHED publications row --
 * tracked via the thumbnail_* columns on that same row (see
 * 0023_thumbnail_columns.sql), never a second `publications` row and
 * never a reason to touch `status`/`provider_item_id` (the video's own
 * confirmed-success fields, which this function only ever reads).
 *
 * This is what makes the required recovery shape possible:
 *   video upload -> provider video ID persisted
 *   -> thumbnail upload fails -> retry thumbnail -> NO second video upload
 * because runPublication's existing idempotency check (step 3) already
 * returns the ALREADY_PUBLISHED publications row unchanged on every
 * subsequent call for this (content_version, provider) -- this function
 * is called from that exact path (and from the fresh-publish success
 * path) and never claims or re-claims a video upload itself.
 *
 * Non-throwing and side-effect-safe to call repeatedly: a row whose
 * thumbnail_status is already SUCCESS or AMBIGUOUS is left untouched
 * (SUCCESS = nothing to do; AMBIGUOUS = never auto-retried, mirrors the
 * video AMBIGUOUS precedent -- requires the same kind of explicit
 * reconciliation). FAILED and NULL/never-attempted are both retried.
 *
 * @returns {object} the current (possibly freshly updated) publications row
 */
async function attemptThumbnailUpload(storage, { publication, mediaArtifact, contentVersion, provider, adapter, action, mode, runId, nowISO }) {
  if (!mediaArtifact?.thumbnail_path || !fs.existsSync(mediaArtifact.thumbnail_path)) {
    return publication;
  }
  if (publication.thumbnail_status === THUMBNAIL_STATUS.SUCCESS || publication.thumbnail_status === THUMBNAIL_STATUS.AMBIGUOUS) {
    return publication;
  }
  if (typeof adapter.publishThumbnail !== 'function') {
    return publication;
  }
  if (!publication.provider_item_id) {
    // Defensive only: this function is only ever called once the video
    // is confirmed PUBLISHED, at which point provider_item_id is always
    // set. Nothing to upload a thumbnail against without it.
    return publication;
  }

  // Same D-C2 external-action authorization gate as the video upload,
  // re-checked fresh immediately before this external call (never
  // cached from the earlier video-publish attempt, which may have been
  // a different runPublication() invocation entirely on a retry).
  let grant;
  try {
    grant = assertExternalActionAllowed({ action, mode });
  } catch (err) {
    if (!(err instanceof SideEffectDeniedError)) throw err;
    logDecision(storage, {
      runId, subjectType: 'content_version', subjectId: contentVersion.id,
      decision: DECISION_LOG_DECISION.THUMBNAIL_AUTHORIZATION_DENIED, reason: err.message
    }, nowISO);
    // Left exactly as-is (thumbnail_status untouched) so a future,
    // authorized run can still attempt it -- an authorization denial is
    // not an external attempt at all, so it is never persisted as FAILED.
    return publication;
  }
  void grant; // audited above via decision_log only; carries no thumbnail-specific visibility concept.

  storage.run(
    `UPDATE publications SET thumbnail_status = ?, thumbnail_attempt_count = thumbnail_attempt_count + 1, thumbnail_updated_at = ? WHERE id = ?`,
    [THUMBNAIL_STATUS.PENDING, nowISO(), publication.id]
  );

  let result;
  try {
    result = await adapter.publishThumbnail({ videoId: publication.provider_item_id, thumbnailFilePath: mediaArtifact.thumbnail_path });
  } catch (err) {
    result = { status: PUBLICATION_RESULT_STATUS.AMBIGUOUS, provider, reconciliationInfo: { note: `thumbnail_adapter_threw_${err.message}` } };
  }

  const nextStatus = result.status === PUBLICATION_RESULT_STATUS.SUCCESS
    ? THUMBNAIL_STATUS.SUCCESS
    : result.status === PUBLICATION_RESULT_STATUS.EXPLICIT_FAILURE
      ? THUMBNAIL_STATUS.FAILED
      : THUMBNAIL_STATUS.AMBIGUOUS;

  storage.run(
    `UPDATE publications SET thumbnail_status = ?, thumbnail_result_json = ?, thumbnail_updated_at = ? WHERE id = ?`,
    [nextStatus, JSON.stringify(result), nowISO(), publication.id]
  );

  const decision = nextStatus === THUMBNAIL_STATUS.SUCCESS
    ? DECISION_LOG_DECISION.THUMBNAIL_SUCCESS
    : nextStatus === THUMBNAIL_STATUS.FAILED
      ? DECISION_LOG_DECISION.THUMBNAIL_FAILURE
      : DECISION_LOG_DECISION.THUMBNAIL_AMBIGUOUS;
  logDecision(storage, {
    runId, subjectType: 'content_version', subjectId: contentVersion.id,
    decision, reason: `thumbnail_${publication.id}_${nextStatus.toLowerCase()}`
  }, nowISO);

  return storage.get('SELECT * FROM publications WHERE id = ?', [publication.id]);
}

/**
 * Runs Publication v1 for the current Script/content_version of a
 * content item that Media Production has already rendered (a
 * `media_artifacts` row exists). This function may be invoked directly
 * by any caller, mirroring every prior stage's manual-trigger-surface
 * convention, and is also invoked automatically by
 * src/autonomous/runner.js's buildStages() as part of the Owner-authorized
 * runner stage order (ADR-0010), with the run's mode (D-C2) propagated
 * into assertExternalActionAllowed() as documented at the call site.
 *
 * This is the ONLY place FINAL_COMPLIANCE -> PUBLISHED is transitioned, and
 * only after a confirmed provider SUCCESS result (see step 7 below). There is
 * no PRODUCED -> PUBLISHED path (ADR-0032): Gate 2 is verified independently
 * here at the publication boundary (step 4.7) for every attempt that could
 * reach the provider, so calling this function directly cannot bypass it.
 *
 * Provider-neutral core: this function knows nothing about YouTube. It
 * resolves a PublicationProvider via ../publication/providerRegistry.js
 * and interacts with it only through the normalized
 * publish()/PUBLICATION_RESULT_STATUS contract in ./PublicationProvider.js.
 *
 * @param {object} deps
 * @param {import('../storage/StorageDriver.js').StorageDriver} deps.storage
 * @param {string} deps.contentBriefId
 * @param {string} [deps.provider] - provider id, defaults to 'youtube'
 * @param {import('./PublicationProvider.js').PublicationProvider} [deps.adapter] - injectable for tests; defaults to providerRegistry's resolution of `provider`
 * @param {string|null} [deps.requestedPublishAt]
 * @param {string} [deps.runId]
 * @param {string} [deps.mode] - 'SIMULATION' | 'LIVE', the authoritative
 *   mode of the enclosing run (e.g. the value returned by
 *   SystemRunRecorder.start()). Forwarded verbatim to
 *   assertExternalActionAllowed() below (D-C2 §3.1.1/§3.3) so
 *   authorization is checked against the actual run's mode rather than
 *   process-global config. Left undefined by existing direct callers,
 *   in which case assertExternalActionAllowed() keeps its own existing
 *   fallback to config.runMode -- unchanged behavior for every caller
 *   that does not pass this.
 */
export async function runPublication({
  storage,
  contentBriefId,
  provider = 'youtube',
  adapter = resolveProvider(provider),
  requestedPublishAt = null,
  runId = null,
  mode
}) {
  const nowISO = () => new Date().toISOString();

  // --- 1. Eligibility: resolve Script/content_brief + the Media
  // Production artifact. Short-form derivative production (provider =
  // 'youtube_shorts') resolves the short-form artifact instead of the
  // long-form one -- see ./constants.js#publicationTargetForProvider
  // and ../media/eligibility.js's `target` param. Every other provider
  // is unaffected (defaults to 'LONGFORM', unchanged behavior). ---
  const target = publicationTargetForProvider(provider);
  const eligibility = resolveMediaForPublication(storage, contentBriefId, { target });
  if (!eligibility.eligible) {
    const decision = eligibility.reason === 'NOT_YET_RENDERED'
      ? DECISION_LOG_DECISION.NOT_YET_RENDERED
      : DECISION_LOG_DECISION.STRUCTURAL_FAILURE;
    logDecision(storage, {
      runId, subjectType: 'content_brief', subjectId: contentBriefId,
      decision, reason: eligibility.reason
    }, nowISO);
    const outcome = eligibility.reason === 'NOT_YET_RENDERED' ? OUTCOME.NOT_YET_RENDERED : OUTCOME.STRUCTURAL_FAILURE;
    return { outcome, reason: eligibility.reason, publication: null };
  }
  const { contentVersion, script, contentBrief } = eligibility;
  let { mediaArtifact } = eligibility;

  // --- 2. Lifecycle precondition. States that could still be relevant to
  // an existing publication record are let through so the short-circuits
  // below (PUBLISHED / AMBIGUOUS / VISIBILITY_MISMATCH / PENDING /
  // quarantine) behave exactly as before: PUBLISHED (a media_artifacts row +
  // PUBLISHED state is the normal steady state after a successful prior run),
  // FINAL_COMPLIANCE (ADR-0032: the only state from which an upload may
  // proceed) and PRODUCED (legacy items whose publication record may already
  // be AMBIGUOUS / VISIBILITY_MISMATCH / PENDING). Admitting PRODUCED here does
  // NOT let it publish: step 4.7 (Gate 2) requires FINAL_COMPLIANCE and a
  // currently valid PASS before authorization, the claim or the provider. ---
  if (contentVersion.state !== 'PRODUCED' && contentVersion.state !== 'FINAL_COMPLIANCE' && contentVersion.state !== 'PUBLISHED') {
    logDecision(storage, {
      runId, subjectType: 'content_version', subjectId: contentVersion.id,
      decision: DECISION_LOG_DECISION.INELIGIBLE_STATE, reason: `not_eligible_from_state_${contentVersion.state}`
    }, nowISO);
    return { outcome: OUTCOME.INELIGIBLE_STATE, reason: contentVersion.state, publication: null };
  }

  // --- 3. Idempotency / restart-safety: consult the durable
  // publication record for this (content_version, provider) BEFORE
  // doing anything else. A confirmed PUBLISHED row is returned
  // unchanged, never re-uploaded (Publication v1 spec §10). An
  // AMBIGUOUS row is also never retried automatically (§11/§12) -- it
  // requires explicit reconciliation outside this pipeline. A PENDING
  // row found here means a prior run was interrupted after claiming the
  // attempt but before a provider result was confirmed one way or the
  // other; since we cannot safely tell "never sent" from "sent but the
  // process died before the response," it is treated the same as an
  // ambiguous result rather than blindly retried (§18: a crash must not
  // cause the engine to unknowingly create duplicate publications). ---
  const existing = storage.get(
    'SELECT * FROM publications WHERE content_version_id = ? AND provider = ?',
    [contentVersion.id, provider]
  );
  if (existing?.status === PUBLICATION_STATUS.PUBLISHED) {
    // Phase 2B: the video itself is never re-uploaded here (this is the
    // existing, unchanged idempotency short-circuit) -- but this is
    // exactly the path a thumbnail retry takes ("video already
    // PUBLISHED, thumbnail not yet SUCCESS"), so a not-yet-successful
    // thumbnail is (re)attempted before returning. thumbnailAction is
    // computed here (pure, no side effect) since step 5's D-C2 grant
    // below is never reached on this short-circuit path.
    const thumbnailAction = publicationActionId(provider, contentVersion.id);
    const updated = await attemptThumbnailUpload(storage, {
      publication: existing, mediaArtifact, contentVersion, provider, adapter,
      action: thumbnailAction, mode, runId, nowISO
    });
    return { outcome: OUTCOME.ALREADY_PUBLISHED, publication: updated };
  }
  if (existing?.status === PUBLICATION_STATUS.AMBIGUOUS) {
    return { outcome: OUTCOME.AMBIGUOUS, reason: 'previously_ambiguous_not_auto_retried', publication: existing };
  }
  // ADR-0030 Open Item 4: a confirmed visibility mismatch is terminal for
  // the automatic workflow -- the upload already happened, so it is never
  // reclaimed, re-uploaded, or re-authorized here. No provider call, no
  // new claim, no retry-budget consumption.
  if (isVisibilityMismatchRow(existing)) {
    return visibilityMismatchResult(existing);
  }
  if (existing?.status === PUBLICATION_STATUS.PENDING) {
    const interrupted = storage.transaction(() => {
      storage.run(
        `UPDATE publications SET status = ?, result_json = ?, updated_at = ? WHERE id = ? AND status = 'PENDING'`,
        [PUBLICATION_STATUS.AMBIGUOUS, JSON.stringify({ note: 'interrupted_prior_attempt' }), nowISO(), existing.id]
      );
      return storage.get('SELECT * FROM publications WHERE id = ?', [existing.id]);
    });
    logDecision(storage, {
      runId, subjectType: 'content_version', subjectId: contentVersion.id,
      decision: DECISION_LOG_DECISION.INTERRUPTED_ATTEMPT, reason: `publication_${existing.id}_interrupted`
    }, nowISO);
    return { outcome: OUTCOME.AMBIGUOUS, reason: 'interrupted_prior_attempt', publication: interrupted };
  }

  // --- 3.5. Bounded-retry governance: a quarantined (FAILED-cap-exhausted)
  // publication is refused on direct invocation as well as by selection.
  // publications.status stays FAILED; quarantine is a separate record. ---
  if (isQuarantined(storage, contentVersion.id, RETRY_STAGE.PUBLICATION)) {
    logDecision(storage, {
      runId, subjectType: 'content_version', subjectId: contentVersion.id,
      decision: 'QUARANTINE_REFUSED', reason: 'publication_quarantined_owner_reactivation_required'
    }, nowISO);
    return { outcome: OUTCOME.QUARANTINED, reason: 'publication_quarantined', publication: existing ?? null };
  }

  // --- 4. Media artifact must still exist on disk. ---
  if (!fs.existsSync(mediaArtifact.artifact_path)) {
    logDecision(storage, {
      runId, subjectType: 'content_version', subjectId: contentVersion.id,
      decision: DECISION_LOG_DECISION.ARTIFACT_MISSING, reason: `media_artifact_file_missing_${mediaArtifact.artifact_path}`
    }, nowISO);
    return { outcome: OUTCOME.ARTIFACT_MISSING, publication: null };
  }

  // --- 4.5. F2-G Open Decision 1 (ADR-0013 §6 "Publication redesign")
  // -- Owner decision: publication-time blocking rights gate. Re-reads
  // assets.verification_status fresh, right now, via the same
  // AssetProvenanceRepository.getAssetsForContent() relationship
  // Production and Media Production each already use to determine
  // which assets belong to this content_version (asset_usages join) --
  // never a status cached from an earlier stage. Placed after artifact
  // existence (step 4) and before D-C2 authorization/the durable claim
  // (steps 5-6), so a DISPUTED/UNVERIFIED asset stops this attempt
  // before authorization is checked, before a publications row is
  // claimed, and before the provider adapter is ever reached -- mirrors
  // Media Production's own placement and non-transitioning behavior
  // (content_version.state is left exactly as it is; Publication does
  // not own a BLOCKED transition here, matching Media Production's
  // precedent rather than Production's, since both Media Production and
  // Publication run on an already-PRODUCED content_version and neither
  // transitions state on this outcome). ---
  const assets = new AssetProvenanceRepository(storage).getAssetsForContent(contentVersion.id);
  const unsafeAsset = assets.find((a) => a.verification_status === 'DISPUTED' || a.verification_status === 'UNVERIFIED');
  if (unsafeAsset) {
    logDecision(storage, {
      runId, subjectType: 'content_version', subjectId: contentVersion.id,
      decision: DECISION_LOG_DECISION.ASSET_RIGHTS_BLOCKED,
      reason: `asset_${unsafeAsset.id}_verification_status_${unsafeAsset.verification_status}`
    }, nowISO);
    return { outcome: OUTCOME.ASSET_RIGHTS_BLOCKED, reason: unsafeAsset.verification_status, publication: null };
  }

  // --- 4.7. ADR-0032 Gate 2 / FINAL_COMPLIANCE publication-boundary
  // verification. Runs AFTER every existing short-circuit (step 3), the media
  // file check (step 4) and the publication-time rights re-read (step 4.5), and
  // BEFORE D-C2 authorization, the durable PENDING claim and any provider call,
  // so it covers every attempt capable of reaching the provider -- including
  // reclaim of a FAILED row. It independently re-verifies the newest compliance
  // record, all bindings, the actual file checksum, the fresh policy pack and
  // the evidence references (see compliance/verify.js). It is read-only: it
  // never repairs or regenerates compliance, never transitions state, never
  // consumes retry budget, and a refusal here is not a BLOCK/NEEDS_REVIEW/FAILED
  // (a non-authorizing PASS is simply not authorizing). ---
  let gate2;
  try {
    gate2 = verifyGate2Pass(storage, contentVersion.id);
  } catch (err) {
    if (!(err instanceof Gate2PolicyLoadError)) throw err;
    logDecision(storage, {
      runId, subjectType: 'content_version', subjectId: contentVersion.id,
      decision: DECISION_LOG_DECISION.GATE2_POLICY_LOAD_FAILURE, reason: `${err.code}: ${err.message}`
    }, nowISO);
    return { outcome: OUTCOME.GATE2_POLICY_LOAD_FAILURE, reason: err.code, publication: null };
  }
  if (!gate2.authorizing) {
    logDecision(storage, {
      runId, subjectType: 'content_version', subjectId: contentVersion.id,
      decision: DECISION_LOG_DECISION.GATE2_NOT_AUTHORIZING,
      reason: `gate2_pass_non_authorizing_${gate2.reason}${gate2.detail ? `_${gate2.detail}` : ''}`
    }, nowISO);
    return { outcome: OUTCOME.GATE2_NOT_AUTHORIZING, reason: gate2.reason, publication: null };
  }

  // --- 5. D-C2 external side-effect authorization. Checked immediately
  // before the external action, never cached, and identifies exactly
  // this content_version's publish action (see
  // constants.js#publicationActionId) -- never a blanket
  // "publish:<provider>" that would authorize every future video at
  // once (ADR-0008 §3.1). The provider adapter is never invoked before
  // this passes, so a caller cannot bypass D-C2 by reaching the adapter
  // directly through this pipeline. ---
  //
  // ADR-0030: assertExternalActionAllowed() also reports WHICH grant
  // authorized this action (exact per-item, or the dormant standing
  // YouTube PUBLIC entry) and the authorization-derived requested
  // visibility. Precedence when both match: the exact per-item grant wins
  // and supplies no visibility (baseline/private default preserved); the
  // standing grant supplies 'public'. The grant is chosen solely inside
  // SideEffectAuthorization from the Owner-controlled file -- nothing
  // passed to runPublication (caller, runner, content, provider) selects it.
  const action = publicationActionId(provider, contentVersion.id);
  let grant;
  try {
    grant = assertExternalActionAllowed({ action, mode });
  } catch (err) {
    if (!(err instanceof SideEffectDeniedError)) throw err;
    logDecision(storage, {
      runId, subjectType: 'content_version', subjectId: contentVersion.id,
      decision: DECISION_LOG_DECISION.AUTHORIZATION_DENIED, reason: err.message
    }, nowISO);
    return { outcome: OUTCOME.AUTHORIZATION_DENIED, reason: err.message, publication: null };
  }
  // Audit (ADR-0030): record which mechanism matched. Contains only the
  // grant name, the action id and the requested visibility -- no secrets.
  logDecision(storage, {
    runId, subjectType: 'content_version', subjectId: contentVersion.id,
    decision: DECISION_LOG_DECISION.AUTHORIZATION_GRANTED,
    reason: `authorization_grant_${grant.grant}_action_${action}_requested_visibility_${grant.requestedVisibility ?? 'provider_default'}`
  }, nowISO);

  // --- 6. Build the provider-neutral request and durably claim this
  // attempt (PENDING row) BEFORE calling the provider, so a crash
  // between here and the provider result is itself detectable as an
  // interrupted attempt on the next run (step 3 above), rather than
  // leaving no trace at all that an external call may have been made. ---
  // Phase 2A: buildPublicationRequest() normalizes title/description
  // (./metadataValidation.js) and throws InvalidPublicationMetadataError
  // for metadata that is fundamentally invalid (missing/empty/wrong
  // type) rather than merely over a length limit. That is a structural
  // precondition failure, same as every other precondition check above
  // (eligibility, lifecycle state, Gate 2) -- it fails clearly via the
  // existing STRUCTURAL_FAILURE outcome/decision-log contract, before
  // any PENDING row is claimed and before the adapter is ever reached,
  // rather than inventing replacement metadata.
  let request;
  try {
    request = buildPublicationRequest({
      contentVersion, script, contentBrief, mediaArtifact, requestedPublishAt,
      requestedVisibility: grant.requestedVisibility
    });
  } catch (err) {
    if (!(err instanceof InvalidPublicationMetadataError)) throw err;
    logDecision(storage, {
      runId, subjectType: 'content_version', subjectId: contentVersion.id,
      decision: DECISION_LOG_DECISION.STRUCTURAL_FAILURE, reason: err.message
    }, nowISO);
    return { outcome: OUTCOME.STRUCTURAL_FAILURE, reason: err.message, publication: null };
  }
  // Phase 2B: best-effort thumbnail generation, from the SAME
  // already-normalized title just placed on `request` -- never a
  // second, independently-derived title. Idempotent (a no-op once
  // media_artifacts.thumbnail_path is set) and never blocks or fails
  // the video publication attempt itself (see ensureThumbnailArtifact).
  mediaArtifact = ensureThumbnailArtifact(storage, { mediaArtifact, title: request.title, runId, nowISO });

  const requestJson = JSON.stringify(request);

  // Performs the claim attempt (race re-check + INSERT) inside a single
  // transaction, obtaining a fresh SQLite snapshot each time it is
  // invoked. Factored out only so the SQLITE_BUSY_SNAPSHOT recovery
  // path below can perform its one bounded retry as a brand-new
  // transaction without duplicating this body.
  const attemptClaim = () => storage.transaction(() => {
    // Re-check for a race: a concurrent run may have already claimed or
    // completed this (content_version, provider) while this run was
    // getting here.
    const raceExisting = storage.get(
      'SELECT * FROM publications WHERE content_version_id = ? AND provider = ?',
      [contentVersion.id, provider]
    );
    if (raceExisting) {
      // ADR-0030: a VISIBILITY_MISMATCH FAILED row is deliberately excluded
      // from reclaim (falls through to `raced` below, never flipped to
      // PENDING, never re-uploaded). All other FAILED rows are unchanged.
      if (raceExisting.status === PUBLICATION_STATUS.FAILED && !isVisibilityMismatchRow(raceExisting)) {
        // FAILED is documented (0010_publication.sql, PublicationProvider.js)
        // as safe to retry -- no external side effect occurred. Reuse
        // this exact row (the UNIQUE(content_version_id, provider)
        // index forbids a second one anyway) and atomically transition
        // it back to PENDING, but ONLY if it is still FAILED at the
        // moment of this UPDATE, in this same transaction/snapshot as
        // the read above. A second, concurrent reclaim attempt loses
        // this race the identical way any other claim race already
        // does: its stale snapshot throws SQLITE_BUSY_SNAPSHOT on this
        // same UPDATE, which the existing recovery path below already
        // handles by re-reading and mapping non-PUBLISHED -> AMBIGUOUS.
        const reclaim = storage.run(
          `UPDATE publications
             SET status = 'PENDING', request_json = ?, attempt_count = attempt_count + 1, updated_at = ?
           WHERE id = ? AND status = 'FAILED'`,
          [requestJson, nowISO(), raceExisting.id]
        );
        if (reclaim.changes === 1) {
          return { publicationId: raceExisting.id };
        }
        // Defensive fallback only: under SQLite's single-writer
        // serialization this WHERE guard should never actually miss
        // inside a transaction that just read the same row, but if it
        // ever does, treat it like any other claim race rather than
        // silently proceeding.
      }
      return { raced: true, existing: raceExisting };
    }
    const publicationId = crypto.randomUUID();
    storage.run(
      `INSERT INTO publications
        (id, content_version_id, media_artifact_id, provider, status, request_json, attempt_count, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'PENDING', ?, 1, ?, ?)`,
      [publicationId, contentVersion.id, mediaArtifact.id, provider, requestJson, nowISO(), nowISO()]
    );
    return { publicationId };
  });

  let claim;
  try {
    claim = attemptClaim();
  } catch (err) {
    // A stale-snapshot conflict on the claim transaction: this
    // connection's deferred-transaction read snapshot (established by
    // the raceExisting SELECT above) predates a commit made elsewhere
    // in the database, so SQLite refuses the subsequent write. This is
    // a storage-level condition, not a normal claim.raced outcome, so
    // it is caught narrowly by exact SQLite error code -- every other
    // exception (including plain SQLITE_BUSY) propagates unchanged.
    if (err.code !== 'SQLITE_BUSY_SNAPSHOT') {
      throw err;
    }

    // Let the failed transaction unwind completely (it already has,
    // since storage.transaction() has returned via throw), then take a
    // fresh autocommit read -- never from inside a transaction -- to
    // see whether the conflict was actually a competing Publication
    // claimant for this exact (content_version, provider) pair.
    const freshRow = storage.get(
      'SELECT * FROM publications WHERE content_version_id = ? AND provider = ?',
      [contentVersion.id, provider]
    );

    if (freshRow) {
      // A competing claimant is responsible for the conflict. Map its
      // status exactly the same way the ordinary claim.raced path
      // below does.
      if (freshRow.status === PUBLICATION_STATUS.PUBLISHED) {
        return { outcome: OUTCOME.ALREADY_PUBLISHED, publication: freshRow };
      }
      if (isVisibilityMismatchRow(freshRow)) {
        return visibilityMismatchResult(freshRow);
      }
      return { outcome: OUTCOME.AMBIGUOUS, reason: 'concurrent_attempt_in_progress', publication: freshRow };
    }

    // No competing Publication row: the conflict must have come from
    // some other writer elsewhere in the shared SQLite database. Give
    // this attempt exactly one more try, as a brand-new transaction
    // (and therefore a fresh snapshot) -- never a general retry loop.
    try {
      claim = attemptClaim();
    } catch (retryErr) {
      if (retryErr.code !== 'SQLITE_BUSY_SNAPSHOT') {
        throw retryErr;
      }
      // The single bounded retry itself hit another stale-snapshot
      // conflict. Do not retry again and do not call the provider;
      // report a defined, reconcilable outcome instead.
      return { outcome: OUTCOME.AMBIGUOUS, reason: 'busy_snapshot_retry_exhausted', publication: null };
    }
  }

  if (claim.raced) {
    // Another run already owns this attempt. Do not call the provider
    // twice for the same content_version/provider pair; report the
    // race's current state rather than guessing.
    if (claim.existing.status === PUBLICATION_STATUS.PUBLISHED) {
      return { outcome: OUTCOME.ALREADY_PUBLISHED, publication: claim.existing };
    }
    if (isVisibilityMismatchRow(claim.existing)) {
      return visibilityMismatchResult(claim.existing);
    }
    return { outcome: OUTCOME.AMBIGUOUS, reason: 'concurrent_attempt_in_progress', publication: claim.existing };
  }

  // --- 7. Perform the external side effect via the provider adapter.
  // The publication core never inspects YouTube-specific fields on the
  // result -- only the normalized PUBLICATION_RESULT_STATUS contract. ---
  let result;
  try {
    result = await adapter.publish(request);
  } catch (err) {
    // A provider adapter throwing is a programmer/contract error (see
    // PublicationProvider.js docstring), not a normal outcome -- but we
    // still must not leave the row silently PENDING forever, and we
    // must not guess success or failure, so this is treated as
    // ambiguous and requires reconciliation like any other
    // undetermined outcome.
    const ambiguousResult = { status: PUBLICATION_RESULT_STATUS.AMBIGUOUS, provider, reconciliationInfo: { note: `adapter_threw_${err.message}` } };
    const row = storage.transaction(() => {
      storage.run(
        `UPDATE publications SET status = 'AMBIGUOUS', result_json = ?, updated_at = ? WHERE id = ?`,
        [JSON.stringify(ambiguousResult), nowISO(), claim.publicationId]
      );
      return storage.get('SELECT * FROM publications WHERE id = ?', [claim.publicationId]);
    });
    logDecision(storage, {
      runId, subjectType: 'content_version', subjectId: contentVersion.id,
      decision: DECISION_LOG_DECISION.AMBIGUOUS, reason: `adapter_threw_${err.message}`
    }, nowISO);
    return { outcome: OUTCOME.AMBIGUOUS, reason: err.message, publication: row };
  }

  // --- 8. Interpret the normalized result and persist accordingly. ---
  if (result.status === PUBLICATION_RESULT_STATUS.EXPLICIT_FAILURE) {
    // One Publication attempt = one confirmed EXPLICIT_FAILURE persisted as
    // FAILED. The FAILED update, counter increment and (on the 3rd) the
    // quarantine record commit together; failure propagates.
    const { row, retry } = storage.transaction(() => {
      storage.run(
        `UPDATE publications SET status = 'FAILED', result_json = ?, failure_reason = ?, updated_at = ? WHERE id = ?`,
        [JSON.stringify(result), result.errorClass ?? 'PROVIDER_FAILURE', nowISO(), claim.publicationId]
      );
      const retryResult = recordFailedAttempt(storage, {
        contentVersionId: contentVersion.id, stage: RETRY_STAGE.PUBLICATION,
        reason: `publication_failed_${result.errorClass ?? 'PROVIDER_FAILURE'}`, runId, nowISO
      });
      return { row: storage.get('SELECT * FROM publications WHERE id = ?', [claim.publicationId]), retry: retryResult };
    });
    logDecision(storage, {
      runId, subjectType: 'content_version', subjectId: contentVersion.id,
      decision: DECISION_LOG_DECISION.PROVIDER_FAILURE, reason: `publication_${claim.publicationId}_failed_${result.errorClass}`
    }, nowISO);
    return { outcome: OUTCOME.PROVIDER_FAILURE, reason: result.errorClass, publication: row, attempt: retry.attempt, quarantined: retry.quarantined };
  }

  if (result.status === PUBLICATION_RESULT_STATUS.AMBIGUOUS) {
    const row = storage.transaction(() => {
      storage.run(
        `UPDATE publications SET status = 'AMBIGUOUS', result_json = ?, updated_at = ? WHERE id = ?`,
        [JSON.stringify(result), nowISO(), claim.publicationId]
      );
      return storage.get('SELECT * FROM publications WHERE id = ?', [claim.publicationId]);
    });
    logDecision(storage, {
      runId, subjectType: 'content_version', subjectId: contentVersion.id,
      decision: DECISION_LOG_DECISION.AMBIGUOUS, reason: `publication_${claim.publicationId}_ambiguous`
    }, nowISO);
    return { outcome: OUTCOME.AMBIGUOUS, publication: row };
  }

  // result.status === SUCCESS: this is the ONLY path that transitions
  // the lifecycle, and only now, with a confirmed provider item id in
  // hand (Publication v1 spec §13).
  if (result.status !== PUBLICATION_RESULT_STATUS.SUCCESS || !result.providerItemId) {
    throw new Error(`Publication provider "${provider}" returned an unrecognized or incomplete result: ${JSON.stringify(result)}`);
  }

  // --- 8.5. ADR-0030 §8 / Open Item 4 (Owner Option 2): requested PUBLIC
  // but the provider did not CONFIRM public. A returned video id alone is
  // never a successful PUBLIC publication. The upload has already
  // happened, so this is recorded as FAILED with failure_reason
  // VISIBILITY_MISMATCH -- a terminal, non-reclaimable exception to FAILED
  // (see isVisibilityMismatchRow). The provider-confirmed value (or null if
  // the provider reported none) is preserved verbatim in result_json as
  // factual evidence, together with the item id/url so the Owner can
  // reconcile manually. Deliberately NOT done here: no
  // recordFailedAttempt() (no retry budget, no quarantine), no
  // content_versions transition (stays FINAL_COMPLIANCE), no provider_item_id /
  // provider_url columns (documented as set only on PUBLISHED), no
  // follow-up call to change visibility, no second upload, no AMBIGUOUS.
  // A missing confirmed visibility fails closed the same way: PUBLIC was
  // not confirmed.
  if (request.requestedVisibility === REQUESTED_VISIBILITY_PUBLIC && result.confirmedVisibility !== REQUESTED_VISIBILITY_PUBLIC) {
    const confirmed = result.confirmedVisibility ?? null;
    const mismatchRow = storage.transaction(() => {
      storage.run(
        `UPDATE publications SET status = 'FAILED', result_json = ?, failure_reason = ?, updated_at = ? WHERE id = ?`,
        [
          JSON.stringify({ ...result, visibilityMismatch: { requested: request.requestedVisibility, confirmed } }),
          VISIBILITY_MISMATCH_FAILURE_REASON, nowISO(), claim.publicationId
        ]
      );
      return storage.get('SELECT * FROM publications WHERE id = ?', [claim.publicationId]);
    });
    logDecision(storage, {
      runId, subjectType: 'content_version', subjectId: contentVersion.id,
      decision: DECISION_LOG_DECISION.PROVIDER_FAILURE,
      reason: `publication_${claim.publicationId}_failed_${VISIBILITY_MISMATCH_FAILURE_REASON}_requested_${request.requestedVisibility}_confirmed_${confirmed ?? 'none'}`
    }, nowISO);
    return { outcome: OUTCOME.VISIBILITY_MISMATCH, reason: VISIBILITY_MISMATCH_FAILURE_REASON, requestedVisibility: request.requestedVisibility, confirmedVisibility: confirmed, publication: mismatchRow };
  }

  const published = storage.transaction(() => {
    const cv = storage.get('SELECT * FROM content_versions WHERE id = ?', [contentVersion.id]);
    let resultingState = cv.state;
    // ADR-0032 s16: FINAL_COMPLIANCE -> PUBLISHED is the successful-publication
    // transition (Gate 2 already verified it above, before the claim). This
    // block must NEVER throw: the provider has already CONFIRMED the upload, so
    // a local state-machine rejection here would leave a confirmed upload
    // unrecorded (the row stuck PENDING). FINAL_COMPLIANCE -> PUBLISHED is
    // always legal, so the guard below is belt-and-braces; if the state is
    // anything else (it cannot be, barring an out-of-band state edit) the
    // external truth is still recorded and the state is left exactly as it is.
    if (cv.state === 'FINAL_COMPLIANCE' && canTransition(cv.state, 'PUBLISHED')) {
      resultingState = transition(cv.state, 'PUBLISHED');
      storage.run('UPDATE content_versions SET state = ? WHERE id = ?', [resultingState, cv.id]);
    }
    storage.run(
      `UPDATE publications
        SET status = 'PUBLISHED', provider_item_id = ?, provider_url = ?, result_json = ?, updated_at = ?
       WHERE id = ?`,
      [result.providerItemId, result.providerUrl ?? null, JSON.stringify(result), nowISO(), claim.publicationId]
    );
    logDecision(storage, {
      runId, subjectType: 'content_version', subjectId: contentVersion.id,
      decision: DECISION_LOG_DECISION.PUBLISHED, reason: `publication_${claim.publicationId}_persisted`, resultingState
    }, nowISO);
    return storage.get('SELECT * FROM publications WHERE id = ?', [claim.publicationId]);
  });

  // Phase 2B: thumbnail upload only NOW, after the video upload is
  // durably PUBLISHED (a confirmed provider_item_id is on the row) --
  // never before (see ../youtube/YouTubeAdapter.js#publishThumbnail's
  // own MISSING_VIDEO_ID guard as a second, defensive layer). Reuses the
  // exact `action`/`mode` already authorized for this same publish
  // action above (step 5) -- no second authorization prompt for the
  // attempt that immediately follows a fresh video upload.
  const withThumbnail = await attemptThumbnailUpload(storage, {
    publication: published, mediaArtifact, contentVersion, provider, adapter,
    action, mode, runId, nowISO
  });

  return { outcome: OUTCOME.PUBLISHED, publication: withThumbnail };
}

export default runPublication;