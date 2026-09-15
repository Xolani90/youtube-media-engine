import { CHECK_RESULT, CHECK_NAME } from './constants.js';
import { AssetProvenanceRepository } from '../state/AssetProvenance.js';

/**
 * Check A — Fact-check outcome.
 * Evidence: latest `fact_checks` row for the current script_id.
 * Missing evidence must not silently pass (Owner decision) -> BLOCK.
 */
export function checkFactCheck(storage, scriptId) {
  const row = storage.get(
    'SELECT * FROM fact_checks WHERE script_id = ? ORDER BY version DESC LIMIT 1',
    [scriptId]
  );
  if (!row) {
    return { name: CHECK_NAME.FACT_CHECK, result: CHECK_RESULT.BLOCK, reason: 'FACT_CHECK_EVIDENCE_MISSING' };
  }
  if (row.status === 'PASS') {
    return { name: CHECK_NAME.FACT_CHECK, result: CHECK_RESULT.PASS, reason: 'fact_check_status_pass' };
  }
  if (row.status === 'REVIEW') {
    return { name: CHECK_NAME.FACT_CHECK, result: CHECK_RESULT.REVIEW, reason: 'fact_check_status_review' };
  }
  // status === 'REJECT'
  return { name: CHECK_NAME.FACT_CHECK, result: CHECK_RESULT.BLOCK, reason: 'fact_check_status_reject' };
}

/**
 * Check B — Originality evidence.
 * Evidence: latest `originality_checks` row for the current script_id.
 * Owner decision: evidence-existence only. Does NOT interpret
 * max_similarity, does NOT apply a threshold, does NOT derive a
 * PASS/REVIEW/BLOCK meaning from the measurement value itself.
 */
export function checkOriginalityEvidence(storage, scriptId) {
  const row = storage.get(
    'SELECT * FROM originality_checks WHERE script_id = ? ORDER BY created_at DESC LIMIT 1',
    [scriptId]
  );
  if (!row) {
    return { name: CHECK_NAME.ORIGINALITY, result: CHECK_RESULT.BLOCK, reason: 'ORIGINALITY_EVIDENCE_MISSING' };
  }
  return { name: CHECK_NAME.ORIGINALITY, result: CHECK_RESULT.PASS, reason: 'originality_evidence_present' };
}

/**
 * Check C — Asset rights status.
 * Evidence: every asset linked via `asset_usages` for the current
 * content_version_id (D-G2, read-only — never mutated here).
 * Does NOT parse usage_restrictions, does NOT invent licensing semantics.
 * Worst-case wins across attached assets: any DISPUTED -> BLOCK, else any
 * UNVERIFIED -> REVIEW, else (all VERIFIED, or none attached) -> PASS.
 */
export function checkAssetRights(storage, contentVersionId) {
  const repo = new AssetProvenanceRepository(storage);
  const assets = repo.getAssetsForContent(contentVersionId);
  if (assets.length === 0) {
    return { name: CHECK_NAME.ASSET_RIGHTS, result: CHECK_RESULT.PASS, reason: 'no_assets_attached' };
  }
  if (assets.some((a) => a.verification_status === 'DISPUTED')) {
    return { name: CHECK_NAME.ASSET_RIGHTS, result: CHECK_RESULT.BLOCK, reason: 'asset_verification_disputed' };
  }
  if (assets.some((a) => a.verification_status === 'UNVERIFIED')) {
    return { name: CHECK_NAME.ASSET_RIGHTS, result: CHECK_RESULT.REVIEW, reason: 'asset_verification_unverified' };
  }
  return { name: CHECK_NAME.ASSET_RIGHTS, result: CHECK_RESULT.PASS, reason: 'all_assets_verified' };
}
