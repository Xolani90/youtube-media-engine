import path from 'node:path';
import { Gate2ComplianceRepository } from './repository.js';
import { loadGate2Policy } from './policy.js';
import { NON_AUTHORIZING, RESULT } from './constants.js';
import {
  resolveGate2Context, hashMediaFile, collectAssetVerifications, collectProvenance, metadataRepresentation,
  collectShortFormBinding
} from './evaluator.js';

/**
 * Independently verifies that a persisted Gate 2 PASS is currently
 * authorizing (ADR-0032 sections 11 and 15). Used BOTH by the
 * final-compliance stage (to decide whether a FINAL_COMPLIANCE item still
 * has a currently valid PASS) and by the publication boundary (to decide
 * whether the provider path may be reached). It never trusts a cached
 * decision: every bound value is re-read, the policy pack is read fresh, and
 * the actual media file is re-hashed.
 *
 * Read-only by construction: it never appends a record, never transitions
 * state, and never repairs or regenerates compliance (ADR-0032 s15).
 *
 * A PASS that fails verification is merely non-authorizing -- it is not a
 * BLOCK, not NEEDS_REVIEW, not FAILED and not a new state (ADR-0032 s11).
 *
 * Throws Gate2PolicyLoadError when the policy pack cannot be used; the caller
 * must surface that as a policy-load failure (never as a verification result,
 * never as a fabricated REVIEW/BLOCK).
 *
 * The twelve checks (in the order ADR-0032 s15 lists them):
 *  1 current content version   2 newest compliance record   3 decision = PASS
 *  4 content binding           5 script binding             6 production/script consistency
 *  7 media artifact identity   8 actual file checksum (+ vs media row, + vs PASS binding)
 *  9 final metadata binding   10 policy version            11 exact rule-ID set
 * 12 evidence references
 *
 * @param {object} storage
 * @param {string} contentVersionId
 * @returns {{ authorizing: true, record: object } | { authorizing: false, reason: string, detail?: string, record?: object }}
 * @throws {import('./policy.js').Gate2PolicyLoadError}
 */
export function verifyGate2Pass(storage, contentVersionId) {
  // Fresh policy read first: an unusable pack means no PASS is accepted at all.
  const policy = loadGate2Policy();

  const fail = (reason, detail, record) => ({ authorizing: false, reason, detail, record });

  // 1. current content version
  const ctx = resolveGate2Context(storage, contentVersionId);
  const { contentVersion, script, brief, production, media } = ctx;
  if (!contentVersion) return fail(NON_AUTHORIZING.CONTENT_VERSION_NOT_FOUND);
  // Multi-provider publication: PUBLISHED means at least one provider has
  // already succeeded for this content_version (see
  // ../publication/pipeline.js), not that every intended provider has
  // published. A different provider's own publication attempt (or the
  // final-compliance stage's own ALREADY_VALID re-check) must still be
  // able to find a currently-authorizing PASS on an already-PUBLISHED
  // item -- so PUBLISHED is accepted here on the same footing as
  // FINAL_COMPLIANCE. This does not weaken anything below: PUBLISHED by
  // itself never authorizes anything; every one of the following eleven
  // checks (compliance record, decision, every binding, the actual file
  // checksum, policy version, rule-ID set, evidence) still runs in full
  // and must independently pass.
  if (contentVersion.state !== 'FINAL_COMPLIANCE' && contentVersion.state !== 'PUBLISHED') {
    return fail(NON_AUTHORIZING.STATE_NOT_FINAL_COMPLIANCE, `state_${contentVersion.state}`);
  }

  // 2. newest compliance record (by seq / rowid, never timestamp or UUID)
  const record = new Gate2ComplianceRepository(storage).getNewest(contentVersionId);
  if (!record) return fail(NON_AUTHORIZING.NO_COMPLIANCE_RECORD);

  // 3. decision is PASS (a newer REVIEW/BLOCK supersedes any older PASS)
  if (record.decision !== RESULT.PASS) return fail(NON_AUTHORIZING.NEWEST_RECORD_NOT_PASS, `newest_${record.decision}`, record);

  // 4. content binding
  if (record.content_version_id !== contentVersion.id || !contentVersion.script_id
      || record.bound_content_script_id !== contentVersion.script_id) {
    return fail(NON_AUTHORIZING.CONTENT_BINDING_MISMATCH, undefined, record);
  }

  // 5. script binding
  if (!script || script.id !== contentVersion.script_id || record.bound_script_id !== script.id
      || record.bound_script_version !== script.version) {
    return fail(NON_AUTHORIZING.SCRIPT_BINDING_MISMATCH, undefined, record);
  }

  // 6. production/script consistency
  if (!production || production.content_version_id !== contentVersion.id
      || production.script_id !== contentVersion.script_id
      || record.bound_production_script_id !== production.script_id) {
    return fail(NON_AUTHORIZING.PRODUCTION_SCRIPT_MISMATCH, undefined, record);
  }

  // 7. media artifact identity
  if (!media || media.content_version_id !== contentVersion.id || media.production_id !== production.id
      || record.bound_media_artifact_id !== media.id) {
    return fail(NON_AUTHORIZING.MEDIA_ARTIFACT_IDENTITY_MISMATCH, undefined, record);
  }

  // 8. actual file checksum: resolve -> exists -> SHA-256 -> vs media row -> vs PASS binding
  const file = hashMediaFile(media.artifact_path);
  if (file.status === 'MISSING') return fail(NON_AUTHORIZING.MEDIA_FILE_MISSING, undefined, record);
  if (file.status === 'UNREADABLE') return fail(NON_AUTHORIZING.MEDIA_FILE_UNREADABLE, undefined, record);
  if (typeof media.artifact_checksum !== 'string' || file.checksum !== media.artifact_checksum) {
    return fail(NON_AUTHORIZING.MEDIA_CHECKSUM_MISMATCH, undefined, record);
  }
  if (record.bound_artifact_checksum !== media.artifact_checksum) {
    return fail(NON_AUTHORIZING.BOUND_CHECKSUM_MISMATCH, undefined, record);
  }

  // 9. final metadata binding (exact strings, exact deterministic representation)
  if (!brief || typeof brief.working_title !== 'string' || typeof brief.viewer_promise !== 'string'
      || record.bound_working_title !== brief.working_title
      || record.bound_viewer_promise !== brief.viewer_promise
      || record.bound_metadata_json !== metadataRepresentation(brief.working_title, brief.viewer_promise)) {
    return fail(NON_AUTHORIZING.METADATA_BINDING_MISMATCH, undefined, record);
  }

  // 10. current policy pack version
  if (record.policy_version !== policy.version) {
    return fail(NON_AUTHORIZING.POLICY_VERSION_MISMATCH, `bound_${record.policy_version}_current_${policy.version}`, record);
  }

  // 11. current exact rule-ID set
  let boundRuleIds;
  try {
    boundRuleIds = JSON.parse(record.rule_ids_json);
  } catch {
    return fail(NON_AUTHORIZING.RULE_ID_SET_MISMATCH, 'unparseable_bound_rule_ids', record);
  }
  if (!Array.isArray(boundRuleIds) || boundRuleIds.length !== policy.ruleIds.length
      || ![...boundRuleIds].sort().every((id, i) => id === policy.ruleIds[i])) {
    return fail(NON_AUTHORIZING.RULE_ID_SET_MISMATCH, undefined, record);
  }

  // 12. evidence references: the persisted references must still be exactly the
  // current, fully-resolved references. Rows referenced are append-only, so an
  // identical id means an identical (VERIFIED / accepted-generation) row.
  let evidence;
  try {
    evidence = JSON.parse(record.evidence_json);
  } catch {
    return fail(NON_AUTHORIZING.EVIDENCE_REFERENCES_INVALID, 'unparseable_evidence', record);
  }
  const currentAssets = collectAssetVerifications(storage, contentVersionId);
  if (currentAssets.some((a) => a.decision !== 'VERIFIED' || !a.asset_verification_id)) {
    return fail(NON_AUTHORIZING.EVIDENCE_REFERENCES_INVALID, 'asset_verification_not_verified', record);
  }
  const currentProvenance = collectProvenance(storage, { script, brief });
  if (!currentProvenance.complete) {
    return fail(NON_AUTHORIZING.EVIDENCE_REFERENCES_INVALID, 'provenance_not_resolved', record);
  }
  const currentAssetRefs = currentAssets.map((a) => ({ asset_id: a.asset_id, asset_verification_id: a.asset_verification_id }));
  const mediaRef = { media_artifact_id: media.id, artifact_checksum: media.artifact_checksum };
  if (JSON.stringify(evidence?.asset_verifications) !== JSON.stringify(currentAssetRefs)
      || JSON.stringify(evidence?.decision_log) !== JSON.stringify(currentProvenance.refs)
      || JSON.stringify(evidence?.media) !== JSON.stringify(mediaRef)) {
    return fail(NON_AUTHORIZING.EVIDENCE_REFERENCES_INVALID, 'references_differ_from_current', record);
  }

  return { authorizing: true, record };
}

function parseBoundShortForm(record) {
  try {
    const sf = JSON.parse(record.evidence_json)?.short_form;
    if (sf && typeof sf.short_form_media_artifact_id === 'string' && sf.short_form_media_artifact_id
        && typeof sf.artifact_checksum === 'string' && sf.artifact_checksum) return sf;
  } catch { /* unparseable evidence is simply "not bound" */ }
  return null;
}

/**
 * Publication-boundary check for SHORT_FORM providers: the file about to be
 * uploaded must be exactly the short-form artifact bound into the Gate 2 PASS.
 * Call AFTER verifyGate2Pass() returned authorizing, passing its `record`.
 * Read-only. Checks, in order: a binding exists; the bound row still exists
 * under the same id for this content_version and derives from this
 * content_version's long-form row; it is the artifact publication resolved;
 * its persisted checksum equals the bound checksum; the path to upload IS that
 * row's path; the actual file at that path exists and re-hashes to the bound
 * checksum.
 *
 * @param {object} storage
 * @param {object} args
 * @param {string} args.contentVersionId
 * @param {object} args.record - the authorizing Gate 2 record from verifyGate2Pass
 * @param {string|null} args.resolvedShortFormId - short-form row id publication resolved
 * @param {string} args.mediaFilePath - the exact path the adapter will receive
 * @returns {{authorizing: true} | {authorizing: false, reason: string, detail?: string}}
 */
export function verifyShortFormBinding(storage, { contentVersionId, record, resolvedShortFormId, mediaFilePath }) {
  const fail = (reason, detail) => ({ authorizing: false, reason, detail });
  const bound = parseBoundShortForm(record);
  if (!bound) return fail(NON_AUTHORIZING.SHORT_FORM_BINDING_ABSENT);

  const row = storage.get('SELECT * FROM short_form_media_artifacts WHERE content_version_id = ?', [contentVersionId]);
  if (!row) return fail(NON_AUTHORIZING.SHORT_FORM_ARTIFACT_MISSING);
  const longForm = storage.get('SELECT id FROM media_artifacts WHERE content_version_id = ?', [contentVersionId]);
  if (row.id !== bound.short_form_media_artifact_id || resolvedShortFormId !== bound.short_form_media_artifact_id
      || !longForm || row.media_artifact_id !== longForm.id) {
    return fail(NON_AUTHORIZING.SHORT_FORM_IDENTITY_MISMATCH);
  }
  if (typeof row.artifact_checksum !== 'string' || row.artifact_checksum !== bound.artifact_checksum) {
    return fail(NON_AUTHORIZING.SHORT_FORM_CHECKSUM_MISMATCH);
  }
  if (typeof mediaFilePath !== 'string' || !mediaFilePath || typeof row.artifact_path !== 'string'
      || path.resolve(mediaFilePath) !== path.resolve(row.artifact_path)) {
    return fail(NON_AUTHORIZING.SHORT_FORM_PATH_MISMATCH);
  }
  const file = hashMediaFile(mediaFilePath);
  if (file.status === 'MISSING') return fail(NON_AUTHORIZING.SHORT_FORM_FILE_MISSING);
  if (file.status === 'UNREADABLE') return fail(NON_AUTHORIZING.SHORT_FORM_FILE_UNREADABLE);
  if (file.checksum !== bound.artifact_checksum) return fail(NON_AUTHORIZING.SHORT_FORM_FILE_CHECKSUM_MISMATCH);
  return { authorizing: true };
}

/**
 * True when the PASS record's short-form binding equals what Gate 2 would bind
 * right now (both absent counts as equal). The final-compliance stage uses this
 * so a PASS made before the short-form existed (or before it changed) is
 * re-evaluated instead of reported ALREADY_VALID. Read-only.
 */
export function isShortFormBindingCurrent(storage, contentVersionId, record) {
  const ctx = resolveGate2Context(storage, contentVersionId);
  const current = collectShortFormBinding(storage, ctx);
  const bound = parseBoundShortForm(record);
  return JSON.stringify(current ?? null) === JSON.stringify(bound ? {
    short_form_media_artifact_id: bound.short_form_media_artifact_id, artifact_checksum: bound.artifact_checksum
  } : null);
}

export default verifyGate2Pass;