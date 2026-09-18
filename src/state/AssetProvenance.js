import crypto from 'node:crypto';

/**
 * D-G2: asset-level rights/provenance (ADR-0008 §5 — separately
 * authorized from D-C2). This module is a thin data-access layer over
 * the `assets` / `asset_usages` tables (0007_asset_rights_provenance.sql),
 * matching the existing style of SystemRunRecorder/CostTracker: a class
 * wrapping a StorageDriver, no ORM, no framework.
 *
 * Kept deliberately in two halves, mirroring the schema:
 *   - asset identity + provenance/rights (recordAsset / getAsset)
 *   - the separate asset-to-content usage relationship (recordUsage /
 *     getAssetsForContent / getUsagesForAsset)
 * An asset's provenance fields never carry content information, and a
 * usage row never carries provenance information — see the schema
 * comment in the migration for why that boundary matters.
 *
 * This is unrelated to research `sources` (src/state/SystemRun.js does
 * not touch it, and neither does this module) — asset provenance and
 * research-source provenance remain two separate concepts.
 */
export class AssetProvenanceRepository {
  constructor(storage) {
    this.storage = storage;
  }

  /**
   * Records a new asset's identity and provenance/rights information.
   * Returns the new asset's id. Does not associate it with any content —
   * use recordUsage for that, separately.
   */
  recordAsset({
    assetType,
    location,
    checksum = null,
    origin = null,
    license = null,
    attributionRequired = false,
    attributionText = null,
    usageRestrictions = null,
    provenanceNotes = null,
    verificationStatus = 'UNVERIFIED'
  }) {
    if (!assetType) throw new Error('recordAsset requires assetType');
    if (!location) throw new Error('recordAsset requires location');

    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    this.storage.run(
      `INSERT INTO assets
        (id, asset_type, location, checksum, origin, license, attribution_required,
         attribution_text, usage_restrictions, provenance_notes, verification_status,
         imported_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        assetType,
        location,
        checksum,
        origin,
        license,
        attributionRequired ? 1 : 0,
        attributionText,
        usageRestrictions,
        provenanceNotes,
        verificationStatus,
        now,
        now
      ]
    );
    return id;
  }

  getAsset(assetId) {
    return this.storage.get('SELECT * FROM assets WHERE id = ?', [assetId]) ?? null;
  }

  /**
   * Records that `assetId` is used by `contentVersionId`. This is the
   * ONLY place the asset<->content relationship is represented — it is
   * never inferred from, or folded into, an asset's provenance fields.
   * Calling this multiple times for the same asset against different
   * content_version_ids is how one asset comes to be used by multiple
   * pieces of content; calling it multiple times for the same
   * content_version_id with different asset_ids is how one piece of
   * content comes to use multiple assets.
   */
  /**
   * `provisioningClaim` (F5-01, Candidate A): an optional, separate
   * identity distinct from `usageContext`. Every existing caller omits
   * it and gets the same NULL it always got. Only
   * src/asset-provisioning/pipeline.js's automated path supplies it, so
   * that stage's own concurrency invariant (at most one automated
   * provisioning claim per content_version_id) can be enforced by the
   * partial UNIQUE index in 0014_asset_usages_provisioning_claim.sql --
   * without touching `usageContext`'s existing free-text semantics or
   * any existing row/caller.
   */
  recordUsage({ assetId, contentVersionId, usageContext = null, provisioningClaim = null }) {
    if (!assetId) throw new Error('recordUsage requires assetId');
    if (!contentVersionId) throw new Error('recordUsage requires contentVersionId');

    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    this.storage.run(
      `INSERT INTO asset_usages (id, asset_id, content_version_id, usage_context, provisioning_claim, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [id, assetId, contentVersionId, usageContext, provisioningClaim, now]
    );
    return id;
  }

  /** All assets used by a given content_version, via the usage relationship. */
  getAssetsForContent(contentVersionId) {
    return this.storage.all(
      `SELECT assets.* FROM assets
       JOIN asset_usages ON asset_usages.asset_id = assets.id
       WHERE asset_usages.content_version_id = ?`,
      [contentVersionId]
    );
  }

  /** All usage rows for a given asset (which content_versions use it). */
  getUsagesForAsset(assetId) {
    return this.storage.all('SELECT * FROM asset_usages WHERE asset_id = ?', [assetId]);
  }
}

export default AssetProvenanceRepository;