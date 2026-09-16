// Pixabay-specific Rights Verification policy (F2 §16). Provider-
// specific rules live only here -- the stage/framework code
// (rights-verification/pipeline.js) contains no Pixabay-specific
// conditionals (F2 §22 acceptance criterion).
//
// This module answers exactly one question, deterministically, per F2
// §8's promotion rule: given an asset's currently-persisted provider +
// local evidence, does it satisfy this policy? It never inspects
// anything about the depicted subject, releases, or trademarks --
// no evidence source in this architecture produces that, so this
// module does not pretend to evaluate it (F2 §3's exclusion list).

export const POLICY_ID = 'pixabay';
export const POLICY_VERSION = 'v1';

// The exact provider-reported license strings this policy accepts.
// Matched byte-for-byte against assets.license -- no fuzzy matching, no
// substring matching (F2 §8 condition 2: "exactly matches").
export const APPROVED_LICENSES = Object.freeze(['Pixabay Content License']);

// Required provider-evidence fields for THIS provider, evaluated
// against the fields the current schema actually persists (F2 §5:
// structured provider_asset_id/provider_retrieval_timestamp fields were
// explicitly deferred as Open Decision 3 -- not implemented in this
// milestone). `origin` and `license` are first-class columns already
// populated by PixabayAssetSourceProvider; both must be present.
const REQUIRED_FIELDS = Object.freeze(['origin', 'license']);

/**
 * Deterministic policy evaluation for one asset, per F2 §8's four-
 * condition promotion rule. Never throws on missing/bad evidence --
 * every path returns an explicit decision + reason (F2 §9's "never
 * silently pass" discipline).
 *
 * Checksum verification is the caller's responsibility (it requires
 * filesystem access, which this pure policy module deliberately does
 * not perform -- see rights-verification/pipeline.js) and is passed in
 * as `checksumOk` / `checksumChecked` so this module stays a pure
 * function of already-gathered evidence.
 *
 * @param {object} asset - a row from `assets`
 * @param {object} [options]
 * @param {boolean} [options.checksumChecked] - whether a checksum comparison was actually performed
 * @param {boolean} [options.checksumOk] - result of that comparison, meaningless if checksumChecked is false
 * @returns {{decision: 'VERIFIED'|'NOT_VERIFIED'|'DISPUTED', reason: string, evidenceFieldsExamined: object}}
 */
export function evaluate(asset, { checksumChecked = false, checksumOk = null } = {}) {
  const evidenceFieldsExamined = {
    policy_id: POLICY_ID,
    policy_version: POLICY_VERSION,
    origin: asset.origin ?? null,
    license: asset.license ?? null,
    checksum_present: Boolean(asset.checksum),
    checksum_checked: checksumChecked,
    checksum_ok: checksumChecked ? checksumOk : null
  };

  // Condition 3 first: a detected checksum mismatch is conflicting
  // evidence (F2 §11) -- DISPUTED, not merely NOT_VERIFIED, regardless
  // of what else is true about the asset.
  if (checksumChecked && checksumOk === false) {
    return {
      decision: 'DISPUTED',
      reason: 'checksum_mismatch',
      evidenceFieldsExamined
    };
  }

  // Condition 1: every required provider-evidence field present and non-null.
  const missingField = REQUIRED_FIELDS.find((field) => asset[field] === null || asset[field] === undefined || asset[field] === '');
  if (missingField) {
    return {
      decision: 'NOT_VERIFIED',
      reason: `missing_required_field_${missingField}`,
      evidenceFieldsExamined
    };
  }

  // Condition 2: license exactly matches a policy-approved value.
  if (!APPROVED_LICENSES.includes(asset.license)) {
    return {
      decision: 'NOT_VERIFIED',
      reason: 'license_not_approved',
      evidenceFieldsExamined
    };
  }

  // Condition 3 (continued): checksum required but never actually
  // checked (e.g. no checksum persisted, or file not present on disk at
  // verification time) -- this is missing evidence, not a pass. F2 §9
  // never infers a positive result from partial evidence.
  if (!checksumChecked) {
    return {
      decision: 'NOT_VERIFIED',
      reason: asset.checksum ? 'checksum_not_verifiable' : 'missing_required_field_checksum',
      evidenceFieldsExamined
    };
  }

  // All four conditions satisfied.
  return {
    decision: 'VERIFIED',
    reason: 'all_policy_conditions_satisfied',
    evidenceFieldsExamined
  };
}

export default { POLICY_ID, POLICY_VERSION, APPROVED_LICENSES, evaluate };