import { AssetProvenanceRepository } from '../state/AssetProvenance.js';
import { AssetVerificationRepository } from '../state/AssetVerification.js';

/**
 * Resolves the inputs Rights Verification needs: the content_version for
 * this content_brief (same repository-established rule every prior
 * stage uses independently) plus a `productions` row (Rights
 * Verification sits downstream of Production/Asset Provisioning, same
 * structural precondition as Media Production -- F2 §9). Deliberately
 * re-implemented rather than imported from asset-provisioning/eligibility.js
 * or media/eligibility.js, per the existing per-stage decoupling
 * convention.
 *
 * @param {import('../storage/StorageDriver.js').StorageDriver} storage
 * @param {string} contentBriefId
 * @returns {{eligible: boolean, reason?: string, contentVersion?: object}}
 */
export function resolveProducedContentForRightsVerification(storage, contentBriefId) {
  const contentVersion = storage.get(
    'SELECT * FROM content_versions WHERE content_brief_id = ?',
    [contentBriefId]
  );
  if (!contentVersion) {
    return { eligible: false, reason: 'CONTENT_VERSION_NOT_FOUND' };
  }
  const production = storage.get(
    'SELECT * FROM productions WHERE content_version_id = ?',
    [contentVersion.id]
  );
  if (!production) {
    return { eligible: false, reason: 'NO_PRODUCTION_RECORD', contentVersion };
  }
  return { eligible: true, contentVersion };
}

/**
 * Selects which of a content_version's attached assets Rights
 * Verification should actually process this run (F2 §11's eligibility
 * rule): an asset is eligible if it is not currently DISPUTED, and it
 * has no asset_verifications row yet under the given policy id/version.
 * DISPUTED assets are excluded entirely -- resolving a dispute is
 * human-only (F2 §7) and this automated stage must never touch one.
 *
 * @param {import('../storage/StorageDriver.js').StorageDriver} storage
 * @param {string} contentVersionId
 * @param {string} policyId
 * @param {string} policyVersion
 * @returns {{allAssets: object[], eligibleAssets: object[]}}
 */
export function selectEligibleAssets(storage, contentVersionId, policyId, policyVersion) {
  const provenanceRepo = new AssetProvenanceRepository(storage);
  const verificationRepo = new AssetVerificationRepository(storage);

  const allAssets = provenanceRepo.getAssetsForContent(contentVersionId);
  const eligibleAssets = allAssets.filter((asset) => {
    if (asset.verification_status === 'DISPUTED') return false;
    const existing = verificationRepo.getLatestDecisionForPolicyVersion(asset.id, policyId, policyVersion);
    return !existing;
  });

  return { allAssets, eligibleAssets };
}

export default resolveProducedContentForRightsVerification;