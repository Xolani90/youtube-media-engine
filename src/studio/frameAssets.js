/**
 * Studio frame-asset adapter (additive; no existing module is modified).
 *
 * Connects rendered studio frame files + a validated storyboard to the
 * EXISTING asset provenance repository (src/state/AssetProvenance.js) and to
 * the existing `visual_timing` segment contract
 * ({asset_id, asset_type, location, start_seconds, duration_seconds}).
 *
 * Rights gate is preserved, not bypassed:
 *   - every asset is recorded with verification_status 'UNVERIFIED';
 *   - production/pipeline.js already blocks any content_version that has an
 *     UNVERIFIED asset (ASSET_RIGHTS_BLOCKED), so a content_version carrying
 *     studio frames stays blocked until an owner/policy decision verifies them
 *     through the existing process. This module never writes 'VERIFIED'.
 *   - the result carries `verification.ownerActionRequired === true`.
 *
 * Rasterisation is behind an interface: the caller supplies `frameFiles`,
 * a function (state) => path of an already-rendered PNG. No rendering library
 * is imported here, so this work is independent of the sharp decision.
 *
 * Shape decisions grounded in the existing code:
 *   - media/production pipelines key usage_context by asset_id (one context per
 *     asset), so this adapter records ONE usage row per distinct frame asset,
 *     not one per timeline segment. Segment timing lives in `visualTiming`.
 *   - usage_context is free text and never parsed by existing consumers except
 *     the 'b-roll scene' pattern from sceneplan.js; studio contexts use a
 *     different prefix ('studio-frame ...') so they are not misparsed.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { validateCharacterBible, canonicalJson } from './characterBible.js';
import { validateStoryboard, expandToSteps, toVisualTiming } from './storyboard.js';

export const STUDIO_ASSET_ORIGIN_PREFIX = 'studio-frame-renderer';
export const STUDIO_ASSET_LICENSE = 'studio-generated-original (owner verification pending)';
export const STUDIO_USAGE_CONTEXT_PREFIX = 'studio-frame';
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Identity of a distinct rendered frame (same fields the storyboard merges on). */
export function frameKey(state) {
  return [state.shot, state.zoomQ, state.p, state.brow, state.mouth, state.gaze].join('|');
}

export class StudioFrameError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'StudioFrameError';
    this.code = code;
  }
}

export function sha256Hex(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function storyboardDigest(storyboard) {
  return sha256Hex(Buffer.from(canonicalJson(storyboard)));
}

function readPng(file, readFile) {
  if (typeof file !== 'string' || !file) throw new StudioFrameError('FRAME_PATH_INVALID', 'frameFiles must return a non-empty path');
  if (!path.isAbsolute(file)) throw new StudioFrameError('FRAME_PATH_NOT_ABSOLUTE', `frame path must be absolute: ${file}`);
  if (path.extname(file).toLowerCase() !== '.png') throw new StudioFrameError('FRAME_NOT_PNG', `frame must be a .png file: ${file}`);
  let buf;
  try {
    buf = readFile(file);
  } catch (err) {
    throw new StudioFrameError('FRAME_UNREADABLE', `cannot read frame ${file}: ${err.code ?? err.message}`);
  }
  if (!buf || buf.length < PNG_SIGNATURE.length || !buf.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new StudioFrameError('FRAME_NOT_PNG', `file is empty or lacks a PNG signature: ${file}`);
  }
  return buf;
}

/**
 * @param {object} p
 * @param {import('../state/AssetProvenance.js').AssetProvenanceRepository} p.repository
 * @param {string} p.contentVersionId  existing content_versions.id
 * @param {object} p.character         validated character bible
 * @param {object} p.storyboard        validated storyboard (storyboard.characterId must equal character.id)
 * @param {(state:object)=>string} p.frameFiles  rasteriser interface: state -> absolute path of a rendered PNG
 * @param {{name:string, version:string}} p.renderer  identity of whatever produced the frames
 * @param {(file:string)=>Buffer} [p.readFile]
 * @returns {{assets:Array, usageIds:string[], visualTiming:Array, verification:object}}
 */
export function registerStudioFrames({
  repository, contentVersionId, character, storyboard, frameFiles, renderer, readFile = fs.readFileSync
}) {
  // ---- validation: everything is checked and read BEFORE any write ----
  if (!repository || typeof repository.recordAsset !== 'function' || typeof repository.recordUsage !== 'function' || !repository.storage) {
    throw new StudioFrameError('REPOSITORY_INVALID', 'an AssetProvenanceRepository is required');
  }
  if (!contentVersionId) throw new StudioFrameError('CONTENT_VERSION_REQUIRED', 'contentVersionId is required');
  if (typeof frameFiles !== 'function') throw new StudioFrameError('FRAME_FILES_REQUIRED', 'frameFiles must be a function (state) => path');
  if (!renderer?.name || !renderer?.version) throw new StudioFrameError('RENDERER_IDENTITY_REQUIRED', 'renderer {name, version} is required for provenance');

  const bv = validateCharacterBible(character);
  if (!bv.valid) throw new StudioFrameError('BIBLE_INVALID', `invalid character bible: ${bv.errors.join('; ')}`);
  const sv = validateStoryboard(storyboard);
  if (!sv.valid) throw new StudioFrameError('STORYBOARD_INVALID', `invalid storyboard: ${sv.errors.join('; ')}`);
  if (storyboard.characterId !== character.id) {
    throw new StudioFrameError('CHARACTER_MISMATCH', `storyboard.characterId ${storyboard.characterId} does not match bible ${character.id}`);
  }

  const cv = repository.storage.get('SELECT id FROM content_versions WHERE id = ?', [contentVersionId]);
  if (!cv) throw new StudioFrameError('CONTENT_VERSION_NOT_FOUND', `content_version ${contentVersionId} does not exist`);

  const steps = expandToSteps(storyboard);
  const statesByKey = new Map();
  toVisualTiming(steps, storyboard.fps, (state) => {
    const k = frameKey(state);
    if (!statesByKey.has(k)) statesByKey.set(k, state);
    return { location: '' };
  });

  // resolve + read + checksum each distinct frame; identical bytes share one asset
  const frames = new Map(); // frameKey -> { location, checksum, state }
  for (const [k, state] of statesByKey) {
    const location = frameFiles(state);
    const buf = readPng(location, readFile);
    frames.set(k, { location, checksum: sha256Hex(buf), state });
  }

  const origin = `${STUDIO_ASSET_ORIGIN_PREFIX}:${renderer.name}@${renderer.version}`;
  const sbDigest = storyboardDigest(storyboard);

  // ---- writes: one transaction; nothing persists on failure ----
  const byChecksum = new Map();
  const assets = [];
  const usageIds = [];
  const keyToAsset = new Map();

  repository.storage.transaction(() => {
    for (const [k, f] of frames) {
      let entry = byChecksum.get(f.checksum);
      if (!entry) {
        // idempotent re-run: reuse an existing studio asset already attached to this content_version
        const existing = repository.storage.get(
          `SELECT assets.id AS id FROM assets
             JOIN asset_usages ON asset_usages.asset_id = assets.id
            WHERE asset_usages.content_version_id = ? AND assets.checksum = ? AND assets.origin = ?`,
          [contentVersionId, f.checksum, origin]
        );
        if (existing) {
          entry = { assetId: existing.id, reused: true };
        } else {
          const assetId = repository.recordAsset({
            assetType: 'image',
            location: f.location,
            checksum: f.checksum,
            origin,
            license: STUDIO_ASSET_LICENSE,
            attributionRequired: false,
            usageRestrictions: null,
            provenanceNotes: JSON.stringify({
              generator: 'studio/frameAssets',
              renderer: { name: renderer.name, version: renderer.version },
              characterId: character.id,
              characterSeed: character.seed,
              characterBibleVersion: character.version,
              storyboardDigest: sbDigest,
              frameKey: k,
              original: true
            }),
            verificationStatus: 'UNVERIFIED' // never auto-verified; see module header
          });
          const usageId = repository.recordUsage({
            assetId,
            contentVersionId,
            usageContext: `${STUDIO_USAGE_CONTEXT_PREFIX} char=${character.id} frame=${k}`
          });
          usageIds.push(usageId);
          entry = { assetId, reused: false };
        }
        byChecksum.set(f.checksum, entry);
        assets.push({ assetId: entry.assetId, location: f.location, checksum: f.checksum, reused: entry.reused, frameKeys: [] });
      }
      keyToAsset.set(k, entry.assetId);
      assets.find((a) => a.assetId === entry.assetId).frameKeys.push(k);
    }
  });

  const visualTiming = toVisualTiming(steps, storyboard.fps, (state) => {
    const k = frameKey(state);
    return { location: frames.get(k).location, asset_id: keyToAsset.get(k) };
  });

  const assetIds = assets.map((a) => a.assetId);
  return {
    assets,
    usageIds,
    visualTiming,
    verification: {
      status: 'UNVERIFIED',
      ownerActionRequired: true,
      assetIds,
      message: `${assetIds.length} studio-generated asset(s) recorded UNVERIFIED. The existing production rights gate will block content_version ${contentVersionId} (ASSET_RIGHTS_BLOCKED) until an owner/policy decision verifies them through the existing process.`
    }
  };
}
