import crypto from 'node:crypto';

/**
 * Deterministically stringifies a value: object keys are sorted
 * recursively (so key insertion order never affects output), while
 * array element order is always preserved (arrays are ordered data, not
 * sets). This is what makes the production artifact reproducible:
 * identical inputs always produce identical JSON text, and therefore an
 * identical checksum.
 */
export function canonicalStringify(value) {
  return JSON.stringify(sortKeysDeep(value));
}

function sortKeysDeep(value) {
  if (Array.isArray(value)) {
    return value.map(sortKeysDeep);
  }
  if (value !== null && typeof value === 'object') {
    const sorted = {};
    for (const key of Object.keys(value).sort()) {
      sorted[key] = sortKeysDeep(value[key]);
    }
    return sorted;
  }
  return value;
}

/** sha256 hex digest of a string. Used for both the manifest checksum and asset content checksums (read verbatim, never recomputed here). */
export function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * Builds the deterministic production manifest for a content_version
 * (Owner Production MVP brief, Phase 3). This is the production
 * artifact itself when no real media renderer exists yet: a structured
 * package containing the exact production inputs and D-G2 provenance a
 * future renderer needs, not a claim that rendering happened.
 *
 * Deliberately excludes any timestamp/non-deterministic field — the
 * manifest body must be byte-identical for identical inputs. created_at
 * for the production record lives only in the `productions` DB row.
 *
 * Asset fields are carried through verbatim from the authoritative D-G2
 * `assets` / `asset_usages` records (never re-derived, never
 * re-interpreted — usage_restrictions is never parsed).
 */
export function buildManifest({ contentVersion, script, contentBrief, assets }) {
  return {
    artifact_type: 'production_manifest_v1',
    content_version_id: contentVersion.id,
    script: {
      id: script.id,
      version: script.version,
      body: script.body
    },
    content_brief: {
      id: contentBrief.id,
      working_title: contentBrief.working_title ?? null
    },
    assets: (assets ?? []).map((a) => ({
      asset_id: a.id,
      asset_type: a.asset_type,
      location: a.location,
      checksum: a.checksum ?? null,
      origin: a.origin ?? null,
      license: a.license ?? null,
      attribution_required: a.attribution_required ?? 0,
      attribution_text: a.attribution_text ?? null,
      usage_restrictions: a.usage_restrictions ?? null,
      verification_status: a.verification_status,
      usage_context: a.usage_context ?? null
    }))
  };
}
