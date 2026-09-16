import crypto from 'node:crypto';

/**
 * D-G2: Rights Verification decision history (ADR-0013, migration
 * 0011_asset_verification.sql). Thin data-access layer over the
 * append-only `asset_verifications` table, matching the existing style
 * of AssetProvenanceRepository/SystemRunRecorder/CostTracker: a class
 * wrapping a StorageDriver, no ORM, no framework.
 *
 * Every row this class writes is a new row -- there is no update
 * method, by design. `assets.verification_status` is the fast-read
 * cache; callers (rights-verification/pipeline.js) are responsible for
 * updating it in the same transaction as recordDecision, exactly as
 * every other stage updates its own cache columns alongside its own
 * decision_log/append-only row.
 */
export class AssetVerificationRepository {
  constructor(storage) {
    this.storage = storage;
  }

  /**
   * Records a new verification decision for an asset. Returns the new
   * row's id. Does not touch `assets.verification_status` itself --
   * the caller updates that column in the same transaction (see
   * rights-verification/pipeline.js).
   */
  recordDecision({
    assetId,
    decision,
    policyId,
    policyVersion,
    evidenceFieldsExamined,
    reason,
    verifierType
  }) {
    if (!assetId) throw new Error('recordDecision requires assetId');
    if (!decision) throw new Error('recordDecision requires decision');
    if (!policyId) throw new Error('recordDecision requires policyId');
    if (!policyVersion) throw new Error('recordDecision requires policyVersion');
    if (!reason) throw new Error('recordDecision requires reason');
    if (!verifierType) throw new Error('recordDecision requires verifierType');

    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    this.storage.run(
      `INSERT INTO asset_verifications
        (id, asset_id, decision, policy_id, policy_version, evidence_fields_examined, reason, verifier_type, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        assetId,
        decision,
        policyId,
        policyVersion,
        JSON.stringify(evidenceFieldsExamined ?? {}),
        reason,
        verifierType,
        now
      ]
    );
    return id;
  }

  /** Every decision ever recorded for an asset, oldest first. */
  getDecisionsForAsset(assetId) {
    return this.storage.all(
      'SELECT * FROM asset_verifications WHERE asset_id = ? ORDER BY created_at ASC',
      [assetId]
    );
  }

  /**
   * Most recent decision recorded for an asset under a specific
   * policy id/version, or null if none exists yet. This is the lazy
   * re-verification check (F2 §15): an asset already decided under
   * policy_id/policy_version X is not re-evaluated again for that same
   * X. A later policy version is a different lookup and will return
   * null, correctly making the asset eligible again.
   */
  getLatestDecisionForPolicyVersion(assetId, policyId, policyVersion) {
    return (
      this.storage.get(
        `SELECT * FROM asset_verifications
         WHERE asset_id = ? AND policy_id = ? AND policy_version = ?
         ORDER BY created_at DESC LIMIT 1`,
        [assetId, policyId, policyVersion]
      ) ?? null
    );
  }
}

export default AssetVerificationRepository;