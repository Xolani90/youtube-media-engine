import fs from 'node:fs';
import { sha256File } from './artifactStore.js';
import { resolveMusicMixEnabled } from './audioMix.js';

/**
 * Decides whether a short-form derivative gets the same background music as its long-form source.
 *
 * The long-form render spec records the music it used (asset id, sha256, mix params). The short re-reads that
 * record and re-checks the asset before using it: it must still exist, still be type 'music', still be
 * VERIFIED, still match the recorded checksum, and the file must be readable. Any failure means the short
 * stays narration-only and says why; it never mixes music it could not re-verify.
 *
 * @returns {{ music: {path, narrationDurationSeconds, params}|null, assetId: string|null, reason: string|null }}
 *   music=null && reason=null means the source had no music (nothing to do).
 */
export function resolveShortFormMusic({ storage, sourceRenderSpec, env = process.env }) {
  const rec = sourceRenderSpec?.music;
  if (!rec?.asset_id) return { music: null, assetId: null, reason: null };
  const fail = (reason) => ({ music: null, assetId: rec.asset_id, reason });
  const asset = storage.get('SELECT * FROM assets WHERE id = ?', [rec.asset_id]);
  if (!asset || asset.asset_type !== 'music') return fail('asset_missing');
  if (asset.verification_status !== 'VERIFIED') return fail(`verification_${asset.verification_status}`);
  if (!resolveMusicMixEnabled(env)) return fail('mixing_disabled');
  if (!asset.location || !fs.existsSync(asset.location)) return fail('file_missing');
  try {
    if (sha256File(asset.location) !== rec.sha256) return fail('checksum_mismatch');
  } catch { return fail('file_unreadable'); }
  const dur = sourceRenderSpec?.narration?.duration_seconds;
  if (!Number.isFinite(dur) || dur <= 0 || !rec.params) return fail('render_spec_incomplete');
  return { music: { path: asset.location, narrationDurationSeconds: dur, params: rec.params }, assetId: asset.id, reason: null };
}
