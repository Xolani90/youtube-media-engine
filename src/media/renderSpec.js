import { canonicalStringify, sha256 } from '../production/manifest.js';
import { RENDER_DEFAULTS } from './constants.js';

/**
 * Builds the deterministic render specification for a single Media
 * Production run (Owner brief §4). Contains ONLY what the renderer
 * needs — narration path/duration, the ordered visual timeline, and the
 * output format parameters — and nothing that already lives in
 * production_manifest_v1 (script body, brief, D-G2 provenance). This is
 * an explicit, deliberate architectural choice (see docs/discovery §10):
 * production_manifest_v1 remains the authoritative *production-input*
 * artifact; render_spec is a separate, narrower, renderer-facing
 * artifact derived from it, so re-rendering with different output
 * parameters never touches — and never changes the checksum of — the
 * production manifest.
 *
 * canonicalStringify/sha256 are reused from src/production/manifest.js
 * deliberately, not re-implemented: unlike eligibility.js (business
 * logic each stage decouples independently), these are generic,
 * content-free utility functions, and Media Production is explicitly
 * built downstream of Production MVP by design — reusing them here does
 * not create the kind of stage-to-stage coupling the decoupling
 * convention exists to avoid.
 *
 * No timestamp/non-deterministic field is included, matching
 * production_manifest_v1's own determinism contract.
 */
export function buildRenderSpec({
  contentVersion,
  narrationPath,
  narrationDurationSeconds,
  visualTiming,
  captions = [],
  width = RENDER_DEFAULTS.WIDTH,
  height = RENDER_DEFAULTS.HEIGHT,
  fps = RENDER_DEFAULTS.FPS,
  outputFormat = RENDER_DEFAULTS.OUTPUT_FORMAT,
  videoEncoder = RENDER_DEFAULTS.VIDEO_ENCODER,
  audioEncoder = RENDER_DEFAULTS.AUDIO_ENCODER
}) {
  return {
    render_spec_type: 'media_render_spec_v1',
    content_version_id: contentVersion.id,
    narration: {
      path: narrationPath,
      duration_seconds: narrationDurationSeconds
    },
    visual_timing: visualTiming,
    // Media Production v1.1: deterministic burned-in captions, derived
    // from script.body. Additive to the render_spec_type shape — an
    // empty array for any render with no caption-worthy text.
    captions,
    output: {
      format: outputFormat,
      width,
      height,
      fps,
      video_encoder: videoEncoder,
      audio_encoder: audioEncoder
    }
  };
}

/** Canonical JSON text + sha256 checksum of a render_spec, for verbatim DB persistence (mirrors productions.manifest_json/artifact_checksum). */
export function renderSpecChecksum(renderSpec) {
  const json = canonicalStringify(renderSpec);
  return { json, checksum: sha256(json) };
}