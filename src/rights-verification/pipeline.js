import crypto from 'node:crypto';
import fs from 'node:fs';
import { RIGHTS_VERIFICATION_STAGE, OUTCOME, DECISION_LOG_DECISION, VERIFIER_TYPE, VERIFICATION_STATUS } from './constants.js';
import { resolveProducedContentForRightsVerification, selectEligibleAssets } from './eligibility.js';
import { AssetVerificationRepository } from '../state/AssetVerification.js';
import { sha256File } from '../media/artifactStore.js';
import * as pixabayPolicy from './policy/pixabay.js';

/** Same shape/discipline as every other stage's local logDecision helper. Rights Verification never transitions content_versions.state (mirrors Asset Provisioning/Media Production's own discipline), so resultingState is always null here. */
function logDecision(storage, { runId = null, subjectType, subjectId, decision, reason }, nowISO = () => new Date().toISOString()) {
  const id = crypto.randomUUID();
  storage.run(
    `INSERT INTO decision_log
      (id, run_id, subject_type, subject_id, decision, reason, provider, config_snapshot, confidence, risk_level, resulting_state, created_at, stage)
     VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, ?, ?)`,
    [id, runId, subjectType, subjectId, decision, reason, nowISO(), RIGHTS_VERIFICATION_STAGE]
  );
  return id;
}

// Maps an asset_verifications.decision value onto the
// assets.verification_status cache column's own, distinct vocabulary
// (0007_asset_rights_provenance.sql CHECK constraint: UNVERIFIED /
// VERIFIED / DISPUTED -- NOT_VERIFIED is deliberately not a member of
// that constraint and must never be written to this column). A
// NOT_VERIFIED decision is still fully persisted in asset_verifications
// itself (recordDecision, below); it simply has no cache transition
// away from UNVERIFIED (F2 §6/§9).
const CACHE_STATUS_FOR_DECISION = Object.freeze({
  VERIFIED: VERIFICATION_STATUS.VERIFIED,
  NOT_VERIFIED: VERIFICATION_STATUS.UNVERIFIED,
  DISPUTED: VERIFICATION_STATUS.DISPUTED
});

// Provider -> policy module resolution (F2 §16). Kept as the one place
// that knows about more than one provider; adding a second provider
// later means adding one entry here and one new policy module, never
// touching the per-provider policy logic itself. Resolved off
// provenance_notes' existing `provider=<id>` free-text token (the same
// field PixabayAssetSourceProvider already writes) -- no new schema
// needed for this milestone's single-provider scope.
function resolvePolicyForAsset(asset) {
  const notes = asset.provenance_notes ?? '';
  if (notes.includes('provider=pixabay')) return pixabayPolicy;
  return null;
}

/**
 * Runs Rights Verification for a produced content_version's currently-
 * attached, currently-eligible assets (F2 §9). Standalone, explicitly-
 * invoked stage -- no orchestrator calls this automatically outside the
 * one authorized runner insertion (Asset Provisioning -> Rights
 * Verification -> Media Production).
 *
 * This stage never transitions content_versions.state. The only field
 * it is ever allowed to mutate on `assets` is verification_status, and
 * only ever alongside a new asset_verifications row in the same
 * transaction (F2 §6/§9/§10) -- provenance fields (origin, license,
 * checksum, etc.) are read-only here and are never rewritten.
 *
 * Per-asset decisions this run made are returned in `results`; the
 * top-level `outcome` summarizes whether any processing happened at
 * all. A DISPUTED result for any asset is never resolved back by this
 * automated stage -- only a human-initiated call (verifierType: 'human',
 * not exposed through this entry point) may do that (F2 §7).
 *
 * @param {object} deps
 * @param {import('../storage/StorageDriver.js').StorageDriver} deps.storage
 * @param {string} deps.contentBriefId
 * @param {string} [deps.runId]
 */
export function runRightsVerification({ storage, contentBriefId, runId = null }) {
  const nowISO = () => new Date().toISOString();

  const eligibility = resolveProducedContentForRightsVerification(storage, contentBriefId);
  if (!eligibility.eligible) {
    const decision = eligibility.reason === 'NO_PRODUCTION_RECORD'
      ? DECISION_LOG_DECISION.NOT_YET_PRODUCED
      : DECISION_LOG_DECISION.STRUCTURAL_FAILURE;
    logDecision(storage, {
      runId, subjectType: 'content_brief', subjectId: contentBriefId,
      decision, reason: eligibility.reason
    }, nowISO);
    const outcome = eligibility.reason === 'NO_PRODUCTION_RECORD' ? OUTCOME.NOT_YET_PRODUCED : OUTCOME.STRUCTURAL_FAILURE;
    return { outcome, reason: eligibility.reason, results: [] };
  }
  const { contentVersion } = eligibility;

  const verificationRepo = new AssetVerificationRepository(storage);

  // Resolve policy id/version once per run. Single-provider scope for
  // this milestone (Pixabay only) -- selectEligibleAssets is called per
  // asset's own resolved policy below, since a content_version could in
  // principle have assets from more than one provider even though only
  // one provider exists today.
  const provenanceAssets = selectEligibleAssets(storage, contentVersion.id, pixabayPolicy.POLICY_ID, pixabayPolicy.POLICY_VERSION);
  const { allAssets, eligibleAssets } = provenanceAssets;

  if (allAssets.length === 0) {
    logDecision(storage, {
      runId, subjectType: 'content_version', subjectId: contentVersion.id,
      decision: DECISION_LOG_DECISION.NO_ASSETS_ATTACHED, reason: 'no_assets_attached'
    }, nowISO);
    return { outcome: OUTCOME.NO_ASSETS_ATTACHED, results: [] };
  }

  if (eligibleAssets.length === 0) {
    logDecision(storage, {
      runId, subjectType: 'content_version', subjectId: contentVersion.id,
      decision: DECISION_LOG_DECISION.NO_ELIGIBLE_ASSETS, reason: 'all_assets_already_decided_or_disputed'
    }, nowISO);
    return { outcome: OUTCOME.NO_ELIGIBLE_ASSETS, results: [] };
  }

  const results = [];

  for (const asset of eligibleAssets) {
    const policy = resolvePolicyForAsset(asset);

    let evaluation;
    if (!policy) {
      // No policy exists for this provider -- an explicit NOT_VERIFIED,
      // never a silent skip or an inferred pass (F2 §8/§9).
      evaluation = {
        decision: 'NOT_VERIFIED',
        reason: 'no_policy_for_provider',
        evidenceFieldsExamined: { origin: asset.origin ?? null, license: asset.license ?? null }
      };
    } else {
      // Checksum check: only performed (and only counted as "checked")
      // when both a checksum is persisted AND the file is currently
      // present on disk -- a missing file is required evidence that is
      // simply absent, not an error and not a pass (mirrors Media
      // Production's own existing checksum-check discipline, F2 §2/§8).
      let checksumChecked = false;
      let checksumOk = null;
      if (asset.checksum && fs.existsSync(asset.location)) {
        checksumChecked = true;
        checksumOk = sha256File(asset.location) === asset.checksum;
      }
      evaluation = policy.evaluate(asset, { checksumChecked, checksumOk });
    }

    const policyId = policy ? policy.POLICY_ID : 'unassigned';
    const policyVersion = policy ? policy.POLICY_VERSION : 'unassigned';

    // Persist decision row + update assets.verification_status in one
    // transaction (F2 §9's restart guarantee, mirroring
    // asset-provisioning/pipeline.js's own recordAsset+recordUsage
    // transaction discipline): a crash before commit leaves the asset
    // exactly as it was (still eligible, re-processed next run); a
    // crash after commit leaves a complete, consistent pair.
    storage.transaction(() => {
      verificationRepo.recordDecision({
        assetId: asset.id,
        decision: evaluation.decision,
        policyId,
        policyVersion,
        evidenceFieldsExamined: evaluation.evidenceFieldsExamined,
        reason: evaluation.reason,
        verifierType: VERIFIER_TYPE.AUTOMATED
      });
      storage.run('UPDATE assets SET verification_status = ? WHERE id = ?', [CACHE_STATUS_FOR_DECISION[evaluation.decision], asset.id]);
    });

    logDecision(storage, {
      runId, subjectType: 'content_version', subjectId: contentVersion.id,
      decision: DECISION_LOG_DECISION[evaluation.decision] ?? evaluation.decision,
      reason: `asset_${asset.id}_${evaluation.reason}`
    }, nowISO);

    results.push({ assetId: asset.id, decision: evaluation.decision, reason: evaluation.reason });
  }

  return { outcome: OUTCOME.PROCESSED, results };
}

export default runRightsVerification;