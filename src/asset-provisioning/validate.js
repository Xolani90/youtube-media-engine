import fs from 'node:fs';
import crypto from 'node:crypto';
import { VISUAL_ASSET_TYPES } from '../media/constants.js';

/**
 * Validates a raw AssetSourceProvider.acquireVisualAsset() result before
 * it is ever passed to AssetProvenanceRepository.recordAsset(). Fails
 * safe and explicit: invalid data is never silently converted into a
 * valid-looking asset, and nothing here mutates the filesystem or the
 * database.
 *
 * VISUAL_ASSET_TYPES is imported (not re-declared) from
 * src/media/constants.js because it is Media Production's own allowlist
 * of what it can actually display as a visual frame -- provisioning an
 * asset type Media Production cannot use would defeat the point of this
 * milestone, so this is the single source of truth, read-only.
 *
 * @param {object|null} result - raw provider result
 * @param {object} [opts]
 * @param {typeof import('node:fs')} [opts.fsImpl] - injectable for tests
 * @returns {{valid: boolean, reason?: string}}
 */
export function validateAcquiredAsset(result, { fsImpl = fs } = {}) {
  const fsMod = fsImpl;

  if (!result || typeof result !== 'object') {
    return { valid: false, reason: 'EMPTY_RESULT' };
  }

  if (!VISUAL_ASSET_TYPES.includes(result.assetType)) {
    return { valid: false, reason: 'UNSUPPORTED_ASSET_TYPE' };
  }

  if (typeof result.location !== 'string' || !result.location.trim()) {
    return { valid: false, reason: 'MISSING_LOCATION' };
  }

  // Must be a local filesystem path, never a remote URL -- mirrors the
  // Pixabay provider's own contract ("never a Pixabay URL", see
  // PixabayAssetSourceProvider's docstring) but is enforced here
  // independently of any specific provider's discipline.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(result.location)) {
    return { valid: false, reason: 'LOCATION_NOT_LOCAL' };
  }

  let stat;
  try {
    stat = fsMod.statSync(result.location);
  } catch {
    return { valid: false, reason: 'FILE_NOT_FOUND' };
  }
  if (!stat.isFile()) {
    return { valid: false, reason: 'FILE_NOT_FOUND' };
  }
  if (stat.size === 0) {
    return { valid: false, reason: 'FILE_EMPTY' };
  }

  if (result.checksum) {
    let actual;
    try {
      const buffer = fsMod.readFileSync(result.location);
      actual = crypto.createHash('sha256').update(buffer).digest('hex');
    } catch {
      return { valid: false, reason: 'FILE_NOT_FOUND' };
    }
    if (actual !== result.checksum) {
      return { valid: false, reason: 'CHECKSUM_MISMATCH' };
    }
  }

  if (result.verificationStatus === 'DISPUTED') {
    return { valid: false, reason: 'DISPUTED_ASSET' };
  }

  return { valid: true };
}

export default validateAcquiredAsset;
