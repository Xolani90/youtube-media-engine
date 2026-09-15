// Real Media Production v1 — the smallest end-to-end vertical slice from
// an existing production_manifest_v1 (Production MVP) to a real,
// validated .mp4. Media owns this vocabulary; it is not shared with or
// imported from Production, Quality Gate, Fact-Check, or Originality.
//
// This stage does NOT transition content_versions.state. By the time a
// `productions` row exists, Production MVP has already transitioned the
// content_version to PRODUCED (its one legal forward step from
// PRODUCTION_READY). Media Production runs downstream of that, consuming
// the shipped production_manifest_v1 as its authoritative input; it
// never re-enters or re-drives the ContentStateMachine, and introduces
// no new lifecycle state (RENDERING/RENDER_FAILED are deliberately not
// added — see docs discussion). Failure at any internal step simply
// leaves content_version.state exactly as Production MVP already set it
// (PRODUCED) — there is no state to "leave unchanged" beyond that,
// because Media Production was never the thing that owned the
// transition in the first place.

export const MEDIA_STAGE = 'MEDIA_PRODUCTION';

export const OUTCOME = Object.freeze({
  STRUCTURAL_FAILURE: 'STRUCTURAL_FAILURE',
  NOT_YET_PRODUCED: 'NOT_YET_PRODUCED',
  ASSET_RIGHTS_BLOCKED: 'ASSET_RIGHTS_BLOCKED',
  ASSET_CHECKSUM_MISMATCH: 'ASSET_CHECKSUM_MISMATCH',
  NO_VISUAL_ASSETS: 'NO_VISUAL_ASSETS',
  NARRATION_FAILED: 'NARRATION_FAILED',
  RENDER_FAILED: 'RENDER_FAILED',
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  ALREADY_RENDERED: 'ALREADY_RENDERED',
  RENDERED: 'RENDERED'
});

export const DECISION_LOG_DECISION = Object.freeze({
  STRUCTURAL_FAILURE: 'STRUCTURAL_FAILURE',
  NOT_YET_PRODUCED: 'NOT_YET_PRODUCED',
  ASSET_RIGHTS_BLOCKED: 'ASSET_RIGHTS_BLOCKED',
  ASSET_CHECKSUM_MISMATCH: 'ASSET_CHECKSUM_MISMATCH',
  NO_VISUAL_ASSETS: 'NO_VISUAL_ASSETS',
  NARRATION_FAILED: 'NARRATION_FAILED',
  RENDER_FAILED: 'RENDER_FAILED',
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  RENDERED: 'RENDERED'
});

// Asset types the renderer will display as a visual frame. Deliberately
// an explicit allowlist, not "everything except a known-audio blocklist"
// — asset_type is unconstrained free text (0007_asset_rights_provenance.sql),
// so an allowlist fails safe: an unrecognized type is excluded from
// visual timing rather than fed into FFmpeg as an image and failing
// unpredictably.
export const VISUAL_ASSET_TYPES = Object.freeze(['image', 'video_clip']);

// Output format defaults for the v1 vertical slice (Owner brief §8).
// 720p, not 1080p: keeps the first real render fast and reliable to
// produce and validate (including in CI/sandboxed environments), while
// still being a conventional, broadly playable video. Trivial to raise
// later — nothing else in this module assumes a specific resolution.
export const RENDER_DEFAULTS = Object.freeze({
  WIDTH: 1280,
  HEIGHT: 720,
  FPS: 24,
  OUTPUT_FORMAT: 'mp4',
  // FFmpeg encoder names (used on the command line).
  VIDEO_ENCODER: 'libx264',
  AUDIO_ENCODER: 'aac',
  // Expected FFprobe-reported codec_name values for the encoders above —
  // used at validation time (§10). These are NOT the same strings as the
  // encoder names (e.g. 'libx264' encodes to a stream FFprobe reports as
  // 'h264').
  VIDEO_CODEC_NAME: 'h264',
  AUDIO_CODEC_NAME: 'aac'
});

// Narration engine for v1. espeak-ng is a local, free, open-source,
// offline formant/rule-based synthesizer — no API key, no network call.
// IMPORTANT: unlike neural TTS, espeak-ng is genuinely bit-for-bit
// deterministic (verified: identical input text produces an
// identical output WAV, byte-for-byte, across repeated runs on this
// machine). This is stated as a verified property of this specific
// engine, not assumed of TTS in general — a future neural engine would
// NOT get this same claim without separately verifying it.
export const NARRATION_ENGINE = 'espeak-ng';