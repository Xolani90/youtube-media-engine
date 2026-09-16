import crypto from 'node:crypto';
import { ASSET_PROVISIONING_STAGE, OUTCOME, DECISION_LOG_DECISION, PROVISIONING_USAGE_CONTEXT } from './constants.js';
import { resolveProducedContentForProvisioning } from './eligibility.js';
import { deriveVisualQuery } from './visualQuery.js';
import { validateAcquiredAsset } from './validate.js';
import { VISUAL_ASSET_TYPES } from '../media/constants.js';
import { AssetProvenanceRepository } from '../state/AssetProvenance.js';

/** Same shape/discipline as every other stage's local logDecision helper. Asset Provisioning never transitions content_versions.state (mirrors Media Production's own discipline), so resultingState is always null here. */
function logDecision(storage, { runId = null, subjectType, subjectId, decision, reason }, nowISO = () => new Date().toISOString()) {
  const id = crypto.randomUUID();
  storage.run(
    `INSERT INTO decision_log
      (id, run_id, subject_type, subject_id, decision, reason, provider, config_snapshot, confidence, risk_level, resulting_state, created_at, stage)
     VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, ?, ?)`,
    [id, runId, subjectType, subjectId, decision, reason, nowISO(), ASSET_PROVISIONING_STAGE]
  );
  return id;
}

/**
 * Runs Asset Provisioning for a content item Production has already
 * produced (Milestone D). Standalone, explicitly-invoked stage -- no
 * orchestrator calls this automatically, mirroring every prior stage's
 * manual-trigger-surface convention. NOT wired into
 * src/autonomous/runner.js's buildStages() -- that integration is
 * explicitly out of scope for this milestone.
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

  let result;
  try {
    result = await provider.acquireVisualAsset({ query, assetTypes: [...VISUAL_ASSET_TYPES] });
  } catch (err) {
    logDecision(storage, {
      runId, subjectType: 'content_version', subjectId: contentVersion.id,
      decision: DECISION_LOG_DECISION.NO_ASSET_ACQUIRED, reason: `provider_threw_${err.message}`
    }, nowISO);
    return { outcome: OUTCOME.NO_ASSET_ACQUIRED, reason: err.message, asset: null };
  }

  if (!result) {
    logDecision(storage, {
      runId, subjectType: 'content_version', subjectId: contentVersion.id,
      decision: DECISION_LOG_DECISION.NO_ASSET_ACQUIRED, reason: 'provider_returned_null'
    }, nowISO);
    return { outcome: OUTCOME.NO_ASSET_ACQUIRED, asset: null };
  }

  const validation = validateAcquiredAsset(result);
  if (!validation.valid) {
    logDecision(storage, {
      runId, subjectType: 'content_version', subjectId: contentVersion.id,
      decision: DECISION_LOG_DECISION.INVALID_PROVIDER_RESULT, reason: validation.reason
    }, nowISO);
    return { outcome: OUTCOME.INVALID_PROVIDER_RESULT, reason: validation.reason, asset: null };
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
  const assetId = storage.transaction(() => {
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
      usageContext: PROVISIONING_USAGE_CONTEXT
    });
    return id;
  });

  logDecision(storage, {
    runId, subjectType: 'content_version', subjectId: contentVersion.id,
    decision: DECISION_LOG_DECISION.PROVISIONED, reason: `asset_${assetId}_persisted`
  }, nowISO);

  const asset = repo.getAsset(assetId);
  return { outcome: OUTCOME.PROVISIONED, asset };
}

export default runAssetProvisioning;
