import crypto from 'node:crypto';

/**
 * Data-access layer over the append-only `gate2_compliance_records` table
 * (0019_gate2_compliance_records.sql), in the same thin style as
 * AssetVerificationRepository. There is deliberately NO update method and NO
 * delete method: records are only ever appended (and the table's triggers
 * reject UPDATE/DELETE at the database level).
 *
 * "Newest record for a content_version_id" is defined by `seq` -- the table's
 * AUTOINCREMENT rowid alias -- never by timestamp or UUID (ADR-0032 s10).
 */
export class Gate2ComplianceRepository {
  constructor(storage) {
    this.storage = storage;
  }

  /**
   * Appends one compliance record and returns the persisted row (including
   * its `seq`). `binding` values that could not be resolved are null; a PASS
   * without every binding is rejected by the table's CHECK constraint.
   */
  append({ contentVersionId, decision, policyVersion, ruleIds, ruleResults, binding, evidence, createdAt = new Date().toISOString() }) {
    if (!contentVersionId) throw new Error('append requires contentVersionId');
    if (!decision) throw new Error('append requires decision');
    if (!policyVersion) throw new Error('append requires policyVersion');
    const id = crypto.randomUUID();
    this.storage.run(
      `INSERT INTO gate2_compliance_records
        (id, content_version_id, decision, policy_version, rule_ids_json, rule_results_json,
         bound_content_script_id, bound_script_id, bound_script_version, bound_production_script_id,
         bound_media_artifact_id, bound_artifact_checksum, bound_working_title, bound_viewer_promise,
         bound_metadata_json, evidence_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id, contentVersionId, decision, policyVersion,
        JSON.stringify([...ruleIds].sort()),
        JSON.stringify(ruleResults),
        binding.contentScriptId ?? null, binding.scriptId ?? null, binding.scriptVersion ?? null,
        binding.productionScriptId ?? null, binding.mediaArtifactId ?? null, binding.artifactChecksum ?? null,
        binding.workingTitle ?? null, binding.viewerPromise ?? null, binding.metadataJson ?? null,
        JSON.stringify(evidence),
        createdAt
      ]
    );
    return this.storage.get('SELECT * FROM gate2_compliance_records WHERE id = ?', [id]);
  }

  /** The newest record for a content_version (highest seq), or null. */
  getNewest(contentVersionId) {
    return (
      this.storage.get(
        'SELECT * FROM gate2_compliance_records WHERE content_version_id = ? ORDER BY seq DESC LIMIT 1',
        [contentVersionId]
      ) ?? null
    );
  }

  /** Every record for a content_version, oldest first (audit/tests). */
  getAll(contentVersionId) {
    return this.storage.all(
      'SELECT * FROM gate2_compliance_records WHERE content_version_id = ? ORDER BY seq ASC',
      [contentVersionId]
    );
  }
}

export default Gate2ComplianceRepository;
