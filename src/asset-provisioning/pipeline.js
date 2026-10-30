import crypto from 'node:crypto';
import { ASSET_PROVISIONING_STAGE, OUTCOME, DECISION_LOG_DECISION, PROVISIONING_USAGE_CONTEXT, PROVISIONING_CLAIM } from './constants.js';
import { resolveProducedContentForProvisioning } from './eligibility.js';
import { deriveVisualQuery } from './visualQuery.js';
import { validateAcquiredAsset } from './validate.js';
import { planScenes, resolveMultiSceneEnabled, formatSceneUsageContext } from './scenePlan.js';
import { buildHitScreen, resolveCandidateGateEnabled } from './candidateGate.js';
import { resolveSceneRelevance, assessAssetRelevance, withRelevanceNote, discardRejectedFile, RELEVANCE_REASON } from './sceneRelevanceCheck.js';
import { rankSceneImages } from '../media/sceneRelevance.js';
import { scriptBodyToNarrationText } from '../media/scriptText.js';
import { VISUAL_ASSET_TYPES } from '../media/constants.js';
import { AssetProvenanceRepository } from '../state/AssetProvenance.js';
import { ASSET_FAILURE_KIND, isAssetAcquisitionFailure, redactSecrets } from '../providers/asset/AssetSourceProvider.js';
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

// Retry disposition per structured provider failure kind. Only a failure
// established as item-specific and recoverable (TRANSIENT) may consume the
// shared A4 item budget; a permanent configuration/authentication/request
// fault is DETERMINISTIC or INFRASTRUCTURE and records no attempt, so it can
// never quarantine content. A kind this table does not know is treated as
// INFRASTRUCTURE (fail closed: no budget, no quarantine, still logged).
const PROVIDER_FAILURE_DISPOSITION = Object.freeze({
  [ASSET_FAILURE_KIND.EMPTY_RESULT]: { nature: FAILURE_NATURE.TRANSIENT, basis: 'provider_returned_no_asset_for_item_query' },
  [ASSET_FAILURE_KIND.DOWNLOAD_FAILURE]: { nature: FAILURE_NATURE.TRANSIENT, basis: 'asset_download_failed_after_successful_search' },
  [ASSET_FAILURE_KIND.RATE_LIMIT]: { nature: FAILURE_NATURE.TRANSIENT, basis: 'provider_rate_limited' },
  [ASSET_FAILURE_KIND.PROVIDER_SERVER_FAILURE]: { nature: FAILURE_NATURE.TRANSIENT, basis: 'provider_server_failure' },
  [ASSET_FAILURE_KIND.NETWORK_FAILURE]: { nature: FAILURE_NATURE.TRANSIENT, basis: 'provider_network_failure' },
  [ASSET_FAILURE_KIND.BAD_REQUEST]: { nature: FAILURE_NATURE.DETERMINISTIC, basis: 'provider_rejected_request' },
  [ASSET_FAILURE_KIND.UNSUPPORTED_ASSET_TYPE]: { nature: FAILURE_NATURE.DETERMINISTIC, basis: 'provider_does_not_offer_requested_asset_types' },
  [ASSET_FAILURE_KIND.MISSING_API_KEY]: { nature: FAILURE_NATURE.INFRASTRUCTURE, basis: 'provider_api_key_missing' },
  [ASSET_FAILURE_KIND.AUTH_FAILURE]: { nature: FAILURE_NATURE.INFRASTRUCTURE, basis: 'provider_authentication_failed' },
  [ASSET_FAILURE_KIND.MALFORMED_RESPONSE]: { nature: FAILURE_NATURE.INFRASTRUCTURE, basis: 'provider_response_malformed' }
});

/** Copies only the known, non-secret fields of a provider failure, re-redacting free text as defense in depth. */
function sanitizeProviderFailure(f) {
  const text = (v) => (v == null ? null : redactSecrets(String(v)).slice(0, 200));
  return {
    kind: f.kind, provider: text(f.provider), query: text(f.query),
    status: Number.isInteger(f.status) ? f.status : null,
    hitCount: Number.isInteger(f.hitCount) ? f.hitCount : null,
    retryable: Boolean(f.retryable), cause: text(f.cause), providerMessage: text(f.providerMessage)
  };
}


// Multi-scene extension (default on; MULTI_SCENE_VISUALS=off restores single-asset). The partial UNIQUE
// index from 0014 only constrains rows whose provisioning_claim IS NOT NULL, so
// the one claim row stays unique per content_version while additional scene
// assets are ordinary usage rows (claim NULL) carrying their span in
// usage_context. No schema change. Additional scenes are best-effort: scene 1
// is the stage's contract; a missing later scene only narrows the sequencing.
const MAX_EXTRA_QUERY_ATTEMPTS = 3;

function assetFingerprints(asset) {
  return [asset.checksum && `c:${asset.checksum}`, asset.location && `l:${asset.location}`, asset.origin && `o:${asset.origin}`].filter(Boolean);
}

async function provisionAdditionalScenes({ storage, repo, provider, contentVersionId, scenePlan, firstAsset, runId, nowISO, gate = resolveCandidateGateEnabled(), relevance = { enabled: false }, relevanceRanker = rankSceneImages }) {
  const seen = new Set(assetFingerprints(firstAsset));
  const attachedOrigins = new Set([firstAsset.origin].filter(Boolean));
  const added = [];
  const skipped = [];
  let stopReason = 'not_attempted_rate_limited';
  for (const scene of scenePlan.slice(1)) {
    // The last query is the unchanged whole-video query, which would only re-find scene 1's asset.
    const queries = scene.queries.slice(0, -1).slice(0, MAX_EXTRA_QUERY_ATTEMPTS);
    let skipReason = queries.length ? 'no_acceptable_candidate' : 'no_scene_specific_query';
    let stop = false;
    for (const q of queries) {
      let result;
      try {
        result = await provider.acquireVisualAsset({
          query: q, assetTypes: [...VISUAL_ASSET_TYPES],
          ...(gate ? { screenHit: buildHitScreen({ sceneText: scene.text ?? '', query: q, excludeOrigins: attachedOrigins }) } : {})
        });
      } catch (err) {
        skipReason = 'provider_threw'; continue;
      }
      if (isAssetAcquisitionFailure(result)) {
        skipReason = `provider_failure_${result.failure.kind}`;
        if (result.failure.kind === ASSET_FAILURE_KIND.RATE_LIMIT) { stop = true; break; }
        continue;
      }
      if (!result) continue;
      if (!validateAcquiredAsset(result).valid) { skipReason = 'invalid_provider_result'; continue; }
      if (assetFingerprints(result).some((f) => seen.has(f))) { skipReason = 'duplicate_of_attached_asset'; continue; }
      // Optional reject-only pixel check (SCENE_RELEVANCE=on). Runs before anything is recorded.
      const verdict = assessAssetRelevance({ sceneText: scene.text, query: q, asset: result, relevance, ranker: relevanceRanker });
      if (!verdict.accept) {
        skipReason = verdict.reason;
        if (result.origin) attachedOrigins.add(result.origin);
        discardRejectedFile(result, (a) => assetFingerprints(a).some((f) => seen.has(f)));
        if (verdict.reason === RELEVANCE_REASON.UNAVAILABLE) { stop = true; stopReason = 'not_attempted_relevance_unavailable'; break; }
        continue;
      }
      const assetId = storage.transaction(() => {
        const id = repo.recordAsset({
          assetType: result.assetType, location: result.location, checksum: result.checksum ?? null,
          origin: result.origin ?? null, license: result.license ?? null,
          attributionRequired: result.attributionRequired ?? false, attributionText: result.attributionText ?? null,
          usageRestrictions: result.usageRestrictions ?? null, provenanceNotes: withRelevanceNote(result.provenanceNotes, verdict, relevance),
          verificationStatus: result.verificationStatus ?? 'UNVERIFIED'
        });
        repo.recordUsage({
          assetId: id, contentVersionId,
          usageContext: formatSceneUsageContext({ order: scene.index + 1, count: scene.total, span: scene.span })
        });
        return id;
      });
      assetFingerprints(result).forEach((f) => seen.add(f));
      if (result.origin) attachedOrigins.add(result.origin);
      added.push(repo.getAsset(assetId));
      logDecision(storage, {
        runId, subjectType: 'content_version', subjectId: contentVersionId,
        decision: DECISION_LOG_DECISION.PROVISIONED, reason: `scene_${scene.index + 1}_asset_${assetId}_persisted`
      }, nowISO);
      skipReason = null;
      break;
    }
    if (skipReason) {
      logDecision(storage, {
        runId, subjectType: 'content_version', subjectId: contentVersionId,
        decision: 'SCENE_ASSET_SKIPPED', reason: `scene_${scene.index + 1}_${skipReason}`
      }, nowISO);
      skipped.push({ scene: scene.index + 1, reason: skipReason });
    }
    if (stop) {
      // Scenes never attempted because the provider rate-limited are still on the record.
      for (const rest of scenePlan.slice(scene.index + 1)) skipped.push({ scene: rest.index + 1, reason: stopReason });
      break;
    }
  }
  return { added, skipped };
}

/**
 * Honest account of what scene provisioning achieved. Persisted as a decision_log
 * row (SCENE_PROVISIONING_SUMMARY, JSON) so Media Production can report on it.
 * fallback_reason: null (every planned scene got an asset), multi_scene_disabled,
 * no_scene_plan, scene_assets_unavailable (only scene 1) or some_scene_assets_unavailable.
 */
function buildSceneReport({ multiScene, planned, accepted, skipped }) {
  let fallbackReason = null;
  if (!multiScene) fallbackReason = 'multi_scene_disabled';
  else if (planned === 0) fallbackReason = 'no_scene_plan';
  else if (planned > 1 && accepted <= 1) fallbackReason = 'scene_assets_unavailable';
  else if (accepted < planned) fallbackReason = 'some_scene_assets_unavailable';
  return { planned_scenes: planned, accepted_assets: accepted, skipped_scenes: skipped, fallback_reason: fallbackReason };
}

function recordSceneSummary(storage, { runId, contentVersionId, report }, nowISO) {
  logDecision(storage, {
    runId, subjectType: 'content_version', subjectId: contentVersionId,
    decision: 'SCENE_PROVISIONING_SUMMARY', reason: JSON.stringify(report)
  }, nowISO);
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
export async function runAssetProvisioning({ storage, contentBriefId, provider, runId = null, multiScene = resolveMultiSceneEnabled(), relevance = resolveSceneRelevance(), relevanceRanker = rankSceneImages }) {
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

  // Multi-scene plan (default on). Any planning problem (e.g. an unparseable script
  // body) silently keeps the unchanged single-query behaviour.
  let scenePlan = [];
  if (multiScene) {
    try {
      scenePlan = planScenes({ visualIdeas: contentBrief?.visual_ideas, scriptBody: scriptBodyToNarrationText(script?.body), fallbackQuery: query });
    } catch {
      scenePlan = [];
    }
  }
  const primaryQuery = scenePlan.length ? scenePlan[0].queries[0] : query;

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
    result = await provider.acquireVisualAsset({
      query: primaryQuery, assetTypes: [...VISUAL_ASSET_TYPES],
      ...(resolveCandidateGateEnabled() ? { screenHit: buildHitScreen({ sceneText: scenePlan[0]?.text ?? '', query: primaryQuery }) } : {})
    });
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

  if (isAssetAcquisitionFailure(result)) {
    // Structured failure: EMPTY_RESULT (the provider answered with nothing)
    // is kept distinct from every way the provider could fail to answer.
    const providerFailure = sanitizeProviderFailure(result.failure);
    const known = PROVIDER_FAILURE_DISPOSITION[providerFailure.kind];
    const evidence = known ?? { nature: FAILURE_NATURE.INFRASTRUCTURE, basis: 'unrecognized_provider_failure_kind' };
    return failWith(
      OUTCOME.NO_ASSET_ACQUIRED, DECISION_LOG_DECISION.NO_ASSET_ACQUIRED, `provider_failure_${providerFailure.kind}`, providerFailure.kind,
      evidence,
      { failureKind: providerFailure.kind, providerFailure }
    );
  }

  if (!result) {
    // A bare null from a legacy provider: an unclassified "no asset" for this item's query.
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

  // Optional reject-only pixel check on scene 1 (SCENE_RELEVANCE=on). A rejected candidate is never recorded;
  // the scene's other queries are tried with the rejected origins excluded. Scene 1 is the stage's contract, so
  // if nothing passes the stage fails closed (NO_ASSET_ACQUIRED) instead of attaching an irrelevant picture.
  if (relevance.enabled) {
    const sceneText = scenePlan[0]?.text ?? '';
    const queries = [primaryQuery, ...(scenePlan[0]?.queries ?? []).filter((q) => q !== primaryQuery)].slice(0, MAX_EXTRA_QUERY_ATTEMPTS + 1);
    const rejectedOrigins = new Set();
    let verdict = assessAssetRelevance({ sceneText, query: primaryQuery, asset: result, relevance, ranker: relevanceRanker });
    let lastReason = verdict.reason;
    let next = 1;
    while (!verdict.accept && verdict.reason !== RELEVANCE_REASON.UNAVAILABLE && next < queries.length) {
      if (result.origin) rejectedOrigins.add(result.origin);
      discardRejectedFile(result, () => false);
      const q = queries[next++];
      let again;
      try {
        again = await provider.acquireVisualAsset({
          query: q, assetTypes: [...VISUAL_ASSET_TYPES],
          ...(resolveCandidateGateEnabled() ? { screenHit: buildHitScreen({ sceneText, query: q, excludeOrigins: rejectedOrigins }) } : {})
        });
      } catch { continue; }
      if (!again || isAssetAcquisitionFailure(again) || !validateAcquiredAsset(again).valid) continue;
      result = again;
      verdict = assessAssetRelevance({ sceneText, query: q, asset: result, relevance, ranker: relevanceRanker });
      lastReason = verdict.reason;
    }
    if (!verdict.accept) {
      discardRejectedFile(result, () => false);
      const transient = lastReason === RELEVANCE_REASON.UNAVAILABLE;
      return failWith(
        OUTCOME.NO_ASSET_ACQUIRED, DECISION_LOG_DECISION.NO_ASSET_ACQUIRED, `scene_1_${lastReason}`, lastReason,
        { nature: transient ? FAILURE_NATURE.INFRASTRUCTURE : FAILURE_NATURE.TRANSIENT, basis: transient ? 'scene_relevance_check_unavailable' : 'scene_relevance_rejected_all_candidates' },
        { failureKind: 'SCENE_RELEVANCE_REJECTED' }
      );
    }
    result = { ...result, provenanceNotes: withRelevanceNote(result.provenanceNotes, verdict, relevance) };
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
      usageContext: scenePlan.length
        ? formatSceneUsageContext({ order: 1, count: scenePlan.length, span: scenePlan[0].span })
        : PROVISIONING_USAGE_CONTEXT,
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
  let additionalAssets = [];
  let skipped = [];
  if (scenePlan.length > 1) {
    ({ added: additionalAssets, skipped } = await provisionAdditionalScenes({
      storage, repo, provider, contentVersionId: contentVersion.id, scenePlan, firstAsset: asset, runId, nowISO, relevance, relevanceRanker
    }));
  }
  const sceneReport = buildSceneReport({
    multiScene, planned: scenePlan.length, accepted: 1 + additionalAssets.length, skipped
  });
  recordSceneSummary(storage, { runId, contentVersionId: contentVersion.id, report: sceneReport }, nowISO);
  return scenePlan.length > 1
    ? { outcome: OUTCOME.PROVISIONED, asset, additionalAssets, sceneReport }
    : { outcome: OUTCOME.PROVISIONED, asset, sceneReport };
}

export default runAssetProvisioning;