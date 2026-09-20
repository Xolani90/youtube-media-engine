import crypto from 'node:crypto';
import { ASSET_PROVISIONING_STAGE, OUTCOME, DECISION_LOG_DECISION, PROVISIONING_USAGE_CONTEXT, PROVISIONING_CLAIM } from './constants.js';
import { resolveProducedContentForProvisioning } from './eligibility.js';
import { deriveVisualQuery } from './visualQuery.js';
import { validateAcquiredAsset } from './validate.js';
import { VISUAL_ASSET_TYPES } from '../media/constants.js';
import { AssetProvenanceRepository } from '../state/AssetProvenance.js';
import { isQuarantined, recordFailedAttemptIfRetryable, retryFields, FAILURE_NATURE, RETRY_STAGE } from '../state/StageRetryPolicy.js';

/** Same shape/discipline as every other stage's local logDecision helper. Asset Provisioning never transitions content_versions.state (mirrors Media Production's own discipline), so resultingState is always null here. */
function logDecision(storage, { runId = null, subjectType, subjectId, decision, reason, evidence = null }, nowISO = () => new Date().toISOString()) {
  const id = crypto.randomUUID();
  // `evidence` (optional) is persisted as structured JSON in config_snapshot so
  // a later classification (A2, Slice 3) can re-read WHY a failure was
  // dispositioned as it was, without parsing the free-text reason.
  storage.run(
    `INSERT INTO decision_log
      (id, run_id, subject_type, subject_id, decision, reason, provider, config_snapshot, confidence, risk_level, resulting_state, created_at, stage)
     VALUES (?, ?, ?, ?, ?, ?, NULL, ?, NULL, NULL, NULL, ?, ?)`,
    [id, runId, subjectType, subjectId, decision, reason, evidence ? JSON.stringify(evidence) : null, nowISO(), ASSET_PROVISIONING_STAGE]
  );
  return id;
}

/**
 * Runs Asset Provisioning for a content item Production has already
 * produced (Milestone D). This function may be invoked directly by any
 * caller, mirroring every prior stage's manual-trigger-surface
 * convention, and is also invoked automatically by
 * src/autonomous/runner.js's buildStages() as the Owner-authorized
 * Asset Provisioning -> Rights Verification -> Media Production runner
 * insertion (ADR-0013).
 *
 * Entry precondition: content_version.state === 'PRODUCED' and a
 * `productions` row exists for it (Production has already run). This
 * stage never transitions content_versions.state itself, and never
 * writes to the `assets` / `asset_usages` tables except through
 * AssetProvenanceRepository.
 *
 * @param {object} deps
 * @param {import('../storage/StorageDriver.js').StorageDriver} deps.storage
 * @param {string} deps.contentBriefId
 * @param {import('../providers/asset/AssetSourceProvider.js').AssetSourceProvider} deps.provider
 * @param {string} [deps.runId]
 */
export async function runAssetProvisioning({ storage, contentBriefId, provider, runId = null }) {
  const nowISO = () => new Date().toISOString();

  const eligibility = resolveProducedContentForProvisioning(storage, contentBriefId);
  if (!eligibility.eligible) {
    const decision = eligibility.reason === 'NO_PRODUCTION_RECORD'
      ? DECISION_LOG_DECISION.NOT_YET_PRODUCED
      : DECISION_LOG_DECISION.STRUCTURAL_FAILURE;
    logDecision(storage, {
      runId, subjectType: 'content_brief', subjectId: contentBriefId,
      decision, reason: eligibility.reason
    }, nowISO);
    const outcome = eligibility.reason === 'NO_PRODUCTION_RECORD' ? OUTCOME.NOT_YET_PRODUCED : OUTCOME.STRUCTURAL_FAILURE;
    return { outcome, reason: eligibility.reason, asset: null };
  }
  const { contentVersion, script, contentBrief } = eligibility;

  if (contentVersion.state !== 'PRODUCED') {
    logDecision(storage, {
      runId, subjectType: 'content_version', subjectId: contentVersion.id,
      decision: DECISION_LOG_DECISION.NOT_YET_PRODUCED, reason: `content_version_state_${contentVersion.state}`
    }, nowISO);
    return { outcome: OUTCOME.NOT_YET_PRODUCED, reason: contentVersion.state, asset: null };
  }

  // A4 bounded-retry governance: a quarantined content version is refused on
  // direct invocation too (no provider call is made). Owner-only reactivation
  // is the sole way out.
  if (isQuarantined(storage, contentVersion.id, RETRY_STAGE.ASSET_PROVISIONING)) {
    logDecision(storage, {
      runId, subjectType: 'content_version', subjectId: contentVersion.id,
      decision: 'QUARANTINE_REFUSED', reason: 'asset_provisioning_quarantined_owner_reactivation_required'
    }, nowISO);
    return { outcome: OUTCOME.QUARANTINED, reason: 'ASSET_PROVISIONING_QUARANTINED', asset: null };
  }

  // A4: NO_ASSET_ACQUIRED and INVALID_PROVIDER_RESULT are the two authorized
  // named outcome CLASSES; they share ONE budget under (ASSET_PROVISIONING,
  // content_version_id) but only a failure whose evidence establishes an
  // item-specific, recoverable cause consumes it (see StageRetryPolicy
  // assessRetryEligibility). One invocation makes at most one provider call
  // and records at most one attempt - there is no in-invocation retry. The
  // decision_log entry (with structured evidence), counter increment and (on
  // the 3rd) quarantine commit in ONE transaction; a persistence error
  // propagates.
  const failWith = (outcome, decision, logReason, resultReason, evidence, extra = {}) => {
    const retry = storage.transaction(() => {
      logDecision(storage, {
        runId, subjectType: 'content_version', subjectId: contentVersion.id, decision, reason: logReason,
        evidence: { failure: outcome, evidence: evidence ?? null, ...extra }
      }, nowISO);
      return recordFailedAttemptIfRetryable(storage, {
        outcome, evidence,
        subjectId: contentVersion.id, stage: RETRY_STAGE.ASSET_PROVISIONING, reason: `${outcome}_${logReason}`, runId, nowISO
      });
    });
    return {
      outcome, ...(resultReason !== undefined ? { reason: resultReason } : {}), asset: null,
      ...extra, ...retryFields(retry)
    };
  };

  const repo = new AssetProvenanceRepository(storage);

  // Idempotency: if a suitable (visual-type) asset is already attached to
  // this content_version, never acquire another -- survives process
  // restart because it is derived purely from already-persisted rows,
  // never from in-memory state.
  const existingAssets = repo.getAssetsForContent(contentVersion.id);
  const existingVisualAsset = existingAssets.find((a) => VISUAL_ASSET_TYPES.includes(a.asset_type));
  if (existingVisualAsset) {
    logDecision(storage, {
      runId, subjectType: 'content_version', subjectId: contentVersion.id,
      decision: DECISION_LOG_DECISION.ALREADY_PROVISIONED, reason: `existing_asset_${existingVisualAsset.id}`
    }, nowISO);
    return { outcome: OUTCOME.ALREADY_PROVISIONED, asset: existingVisualAsset };
  }

  const query = deriveVisualQuery(contentBrief, script);
  if (!query) {
    logDecision(storage, {
      runId, subjectType: 'content_version', subjectId: contentVersion.id,
      decision: DECISION_LOG_DECISION.NO_VISUAL_CONTEXT, reason: 'no_usable_visual_context'
    }, nowISO);
    return { outcome: OUTCOME.NO_VISUAL_CONTEXT, asset: null };
  }

  // Missing provider = CONFIGURATION failure, not an item-specific asset
  // acquisition failure. It keeps the existing NO_ASSET_ACQUIRED outcome
  // (no new outcome) but is distinguishable (reason PROVIDER_NOT_CONFIGURED,
  // configurationFailure: true, structured evidence in decision_log) and can
  // NEVER consume item retry budget or quarantine content: the runner being
  // misconfigured says nothing about this content item. Its final disposition
  // is deferred to Slice 3 (A2/A3).
  if (typeof provider?.acquireVisualAsset !== 'function') {
    return failWith(
      OUTCOME.NO_ASSET_ACQUIRED, DECISION_LOG_DECISION.NO_ASSET_ACQUIRED, 'provider_not_configured', 'PROVIDER_NOT_CONFIGURED',
      { nature: FAILURE_NATURE.INFRASTRUCTURE, basis: 'asset_provider_not_configured' },
      { configurationFailure: true, failureKind: 'PROVIDER_NOT_CONFIGURED' }
    );
  }

  let result;
  try {
    result = await provider.acquireVisualAsset({ query, assetTypes: [...VISUAL_ASSET_TYPES] });
  } catch (err) {
    // A provider THROW is not a provider result: the in-repo provider never
    // throws for operational failures (it returns null), so a throw is a
    // contract/programming/configuration fault, and nothing here establishes
    // it is item-specific or transient. It records NO A4 attempt; the error is
    // preserved as structured evidence for Slice 3's classification.
    return failWith(
      OUTCOME.NO_ASSET_ACQUIRED, DECISION_LOG_DECISION.NO_ASSET_ACQUIRED, `provider_threw_${err.message}`, err.message,
      { nature: FAILURE_NATURE.INFRASTRUCTURE, basis: 'provider_threw_not_a_provider_result' },
      { failureKind: 'PROVIDER_THREW', providerError: { name: err?.name ?? null, message: err?.message ?? String(err) } }
    );
  }

  if (!result) {
    // A genuine provider result of "no asset" for this item's query.
    return failWith(
      OUTCOME.NO_ASSET_ACQUIRED, DECISION_LOG_DECISION.NO_ASSET_ACQUIRED, 'provider_returned_null', undefined,
      { nature: FAILURE_NATURE.TRANSIENT, basis: 'provider_returned_no_asset_for_item_query' },
      { failureKind: 'PROVIDER_RETURNED_NULL' }
    );
  }

  const validation = validateAcquiredAsset(result);
  if (!validation.valid) {
    return failWith(
      OUTCOME.INVALID_PROVIDER_RESULT, DECISION_LOG_DECISION.INVALID_PROVIDER_RESULT, validation.reason, validation.reason,
      { nature: FAILURE_NATURE.TRANSIENT, basis: 'provider_result_failed_validation_for_item' },
      { failureKind: 'INVALID_PROVIDER_RESULT' }
    );
  }

  // Persist the provider's provenance fields unaltered -- in particular
  // verificationStatus is never promoted/reinterpreted here (see this
  // milestone's rights rule; PixabayAssetSourceProvider always returns
  // 'UNVERIFIED' and that value is carried straight through).
  //
  // recordAsset() + recordUsage() are wrapped in a single DB transaction
  // (mirrors src/production/pipeline.js and src/media/pipeline.js's own
  // precedent for multi-statement persistence): if recordUsage() throws
  // for any reason, the whole transaction rolls back and the asset row
  // is never left orphaned without a usage.
  //
  // F5-01 (Owner-authorized Candidate A): a concurrent invocation may
  // have already committed its own automated-provisioning claim for
  // this content_version between the pre-call check above and this
  // transaction (the awaited provider call in between is exactly the
  // check-then-act window F5-01 identified). Re-check for that race
  // immediately before persisting, inside this same transaction, mirroring
  // src/publication/pipeline.js's attemptClaim() and src/media/pipeline.js's
  // race re-check. The partial UNIQUE index in
  // 0014_asset_usages_provisioning_claim.sql (content_version_id WHERE
  // provisioning_claim IS NOT NULL) is the actual backstop for
  // interleavings this re-check can still miss; this re-check exists so
  // the common case resolves to a clean, defined outcome rather than a
  // raw constraint-violation exception.
  const outcome = storage.transaction(() => {
    const raceExisting = storage.get(
      'SELECT * FROM asset_usages WHERE content_version_id = ? AND provisioning_claim IS NOT NULL',
      [contentVersion.id]
    );
    if (raceExisting) {
      return { raced: true, existingAssetId: raceExisting.asset_id };
    }

    const id = repo.recordAsset({
      assetType: result.assetType,
      location: result.location,
      checksum: result.checksum ?? null,
      origin: result.origin ?? null,
      license: result.license ?? null,
      attributionRequired: result.attributionRequired ?? false,
      attributionText: result.attributionText ?? null,
      usageRestrictions: result.usageRestrictions ?? null,
      provenanceNotes: result.provenanceNotes ?? null,
      verificationStatus: result.verificationStatus ?? 'UNVERIFIED'
    });
    repo.recordUsage({
      assetId: id,
      contentVersionId: contentVersion.id,
      usageContext: PROVISIONING_USAGE_CONTEXT,
      provisioningClaim: PROVISIONING_CLAIM
    });
    return { raced: false, assetId: id };
  });

  if (outcome.raced) {
    // Another invocation's automated-provisioning claim won the race.
    // This invocation acquired a (now-discarded) asset from the provider
    // but persisted nothing -- the existing ALREADY_PROVISIONED outcome
    // already represents "automated provisioning has already happened
    // for this content_version" accurately from this invocation's point
    // of view, so no new outcome is introduced (F5-01 design §9).
    const existingAsset = repo.getAsset(outcome.existingAssetId);
    logDecision(storage, {
      runId, subjectType: 'content_version', subjectId: contentVersion.id,
      decision: DECISION_LOG_DECISION.ALREADY_PROVISIONED, reason: `race_lost_existing_asset_${outcome.existingAssetId}`
    }, nowISO);
    return { outcome: OUTCOME.ALREADY_PROVISIONED, asset: existingAsset };
  }

  logDecision(storage, {
    runId, subjectType: 'content_version', subjectId: contentVersion.id,
    decision: DECISION_LOG_DECISION.PROVISIONED, reason: `asset_${outcome.assetId}_persisted`
  }, nowISO);

  const asset = repo.getAsset(outcome.assetId);
  return { outcome: OUTCOME.PROVISIONED, asset };
}

export default runAssetProvisioning;