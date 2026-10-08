import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Ken Burns / deterministic still-image motion (worker capability).
 *
 * This module is a pure MEDIA WORKER. It decides nothing editorial: it
 * receives an asset that Media Production has ALREADY passed through the
 * existing rights + checksum + existence gates (see pipeline.js), plus the
 * segment slot the existing sequencing already computed, and turns that
 * still image into a short, silent, constant-frame-rate h264 clip whose
 * length equals the slot. The clip then flows through the EXISTING concat
 * -> renderSilentVideo -> muxNarration -> validate -> checksum -> persist
 * path unchanged. It has no knowledge of rights, research, evidence,
 * claims, Gate 2, or publication, and never calls into them.
 *
 * Implementation = FFmpeg's built-in `zoompan` filter, already part of the
 * FFmpeg stack this repo shells out to. No third-party donor code is copied
 * or vendored, so there is no new license obligation.
 *
 * ---- Determinism rule (documented, tested) -------------------------------
 * The motion for a segment is a pure function of two STABLE identifiers:
 *   (asset_id, segment index within the visual timeline)
 * via   h = sha256(`ken-burns-v1:${assetId}:${segmentIndex}`)
 *       preset = PRESETS[ uint32_be(h[0..3]) % PRESETS.length ]
 * No Math.random, no clock, no environment. Same inputs -> same descriptor,
 * and the same descriptor + dimensions + fps + duration -> the same FFmpeg
 * filter string. The descriptor is recorded in render_spec (so the artifact
 * identity/checksum covers it) and short-form re-renders consume that
 * recorded descriptor rather than re-deriving it.
 *
 * ---- Motion model --------------------------------------------------------
 * A descriptor is { mode, zoom_start, zoom_end, pan_from:{x,y}, pan_to:{x,y} }.
 * The visible crop window at progress p in [0,1] has normalized size 1/zoom
 * and is positioned inside the available slack by pan x,y in [0,1]:
 *     zoom(p) = zs + (ze - zs) * p
 *     x0(p)   = (1 - 1/zoom) * px(p)        (always in [0, 1 - 1/zoom])
 * so the window can never leave the image. Pan therefore requires zoom > 1
 * (a window the size of the whole image has no slack to pan across).
 */

export const MOTION_MODE = Object.freeze({
  ZOOM_IN: 'zoom_in',
  ZOOM_OUT: 'zoom_out',
  PAN: 'pan',
  PAN_ZOOM: 'pan_zoom'
});

export const MOTION_LIMITS = Object.freeze({
  MIN_ZOOM: 1.0,
  MAX_ZOOM: 1.5,
  // Pan needs slack: every zoom value used while panning must be at least this.
  MIN_ZOOM_FOR_PAN: 1.05,
  // The source image is cover-scaled to PRESCALE x the output frame before
  // zoompan so the integer crop-window rounding inside zoompan is a fraction
  // of an output pixel (this is what keeps slow zooms from visibly jittering).
  PRESCALE: 4,
  MAX_DIMENSION: 7680,
  MIN_SOURCE_DIMENSION: 16,
  MAX_FPS: 120,
  MAX_DURATION_SECONDS: 3600
});

const mk = (mode, zs, ze, from, to) => Object.freeze({
  mode,
  zoom_start: zs,
  zoom_end: ze,
  pan_from: Object.freeze({ ...from }),
  pan_to: Object.freeze({ ...to })
});
const C = { x: 0.5, y: 0.5 };

// Order is part of the determinism contract: changing it changes which preset
// a given (asset_id, index) maps to, so it is versioned via the hash prefix.
export const MOTION_PRESETS = Object.freeze([
  mk(MOTION_MODE.ZOOM_IN, 1.0, 1.15, C, C),
  mk(MOTION_MODE.PAN, 1.12, 1.12, { x: 0, y: 0.5 }, { x: 1, y: 0.5 }),
  mk(MOTION_MODE.ZOOM_OUT, 1.15, 1.0, C, C),
  mk(MOTION_MODE.PAN, 1.12, 1.12, { x: 1, y: 0.5 }, { x: 0, y: 0.5 }),
  mk(MOTION_MODE.PAN_ZOOM, 1.05, 1.2, { x: 0.2, y: 0.5 }, { x: 0.8, y: 0.5 }),
  mk(MOTION_MODE.PAN_ZOOM, 1.2, 1.05, { x: 0.8, y: 0.4 }, { x: 0.2, y: 0.6 })
]);

/**
 * Ken Burns motion is ON by default; KEN_BURNS_MOTION=off (or 0/false/none)
 * restores the exact pre-motion still-image render. Any other value fails
 * explicitly rather than silently picking a mode (same discipline as
 * ASR_PROVIDER in asrWorker.js).
 */
export function resolveMotionEnabled(env = process.env) {
  const v = (env.KEN_BURNS_MOTION ?? 'on').trim().toLowerCase();
  if (v === '' || v === 'on' || v === '1' || v === 'true') return true;
  if (v === 'off' || v === '0' || v === 'false' || v === 'none') return false;
  throw new MotionError('CONFIG_INVALID', `KEN_BURNS_MOTION must be one of on, off (got "${v}")`);
}

/** Error carrying a stable machine-readable reason; message is what existing RENDER_FAILED handling logs. */
export class MotionError extends Error {
  constructor(reason, detail = '') {
    super(`motion_${reason}${detail ? `: ${detail}` : ''}`);
    this.name = 'MotionError';
    this.reason = reason;
  }
}

/** Deterministic preset choice from stable identifiers. Returns a fresh plain-object descriptor. */
export function planMotion({ assetId, segmentIndex }) {
  if (typeof assetId !== 'string' || assetId.length === 0) {
    throw new MotionError('INVALID_ASSET_ID', 'assetId must be a non-empty string');
  }
  if (!Number.isInteger(segmentIndex) || segmentIndex < 0) {
    throw new MotionError('INVALID_SEGMENT_INDEX', `segmentIndex must be a non-negative integer, got ${segmentIndex}`);
  }
  const h = crypto.createHash('sha256').update(`ken-burns-v1:${assetId}:${segmentIndex}`).digest();
  const preset = MOTION_PRESETS[h.readUInt32BE(0) % MOTION_PRESETS.length];
  return {
    mode: preset.mode,
    zoom_start: preset.zoom_start,
    zoom_end: preset.zoom_end,
    pan_from: { ...preset.pan_from },
    pan_to: { ...preset.pan_to }
  };
}

const inUnit = (n) => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1;
const isPoint = (p) => p && typeof p === 'object' && inUnit(p.x) && inUnit(p.y);

/** Throws MotionError for any descriptor that is not within the bounded motion model. Returns the descriptor. */
export function validateMotion(motion) {
  if (!motion || typeof motion !== 'object') throw new MotionError('INVALID_MOTION', 'motion descriptor missing');
  if (!Object.values(MOTION_MODE).includes(motion.mode)) {
    throw new MotionError('INVALID_MODE', `unsupported mode ${JSON.stringify(motion.mode)}`);
  }
  const { zoom_start: zs, zoom_end: ze } = motion;
  for (const z of [zs, ze]) {
    if (typeof z !== 'number' || !Number.isFinite(z) || z < MOTION_LIMITS.MIN_ZOOM || z > MOTION_LIMITS.MAX_ZOOM) {
      throw new MotionError('INVALID_ZOOM', `zoom must be a number in [${MOTION_LIMITS.MIN_ZOOM}, ${MOTION_LIMITS.MAX_ZOOM}], got ${z}`);
    }
  }
  if (!isPoint(motion.pan_from) || !isPoint(motion.pan_to)) {
    throw new MotionError('INVALID_PAN', 'pan_from/pan_to must be {x,y} within [0,1]');
  }
  const zoomChanges = zs !== ze;
  const panChanges = motion.pan_from.x !== motion.pan_to.x || motion.pan_from.y !== motion.pan_to.y;
  if (motion.mode === MOTION_MODE.ZOOM_IN && !(ze > zs)) throw new MotionError('INVALID_ZOOM', 'zoom_in requires zoom_end > zoom_start');
  if (motion.mode === MOTION_MODE.ZOOM_OUT && !(ze < zs)) throw new MotionError('INVALID_ZOOM', 'zoom_out requires zoom_end < zoom_start');
  if (motion.mode === MOTION_MODE.PAN && (zoomChanges || !panChanges)) throw new MotionError('INVALID_PAN', 'pan requires constant zoom and a changing position');
  if (motion.mode === MOTION_MODE.PAN_ZOOM && (!zoomChanges || !panChanges)) throw new MotionError('INVALID_PAN', 'pan_zoom requires both zoom and position to change');
  if ((motion.mode === MOTION_MODE.ZOOM_IN || motion.mode === MOTION_MODE.ZOOM_OUT) && panChanges) {
    throw new MotionError('INVALID_PAN', 'zoom modes must not pan');
  }
  if (panChanges && Math.min(zs, ze) < MOTION_LIMITS.MIN_ZOOM_FOR_PAN) {
    throw new MotionError('INVALID_PAN', `panning requires zoom >= ${MOTION_LIMITS.MIN_ZOOM_FOR_PAN} (no slack to pan at lower zoom)`);
  }
  return motion;
}

/**
 * Normalized crop window at progress p in [0,1] (the exact math the FFmpeg
 * expressions implement). x/y/w/h are fractions of the source frame; the
 * window is always inside [0,1]x[0,1].
 */
export function motionWindowAt(motion, progress) {
  validateMotion(motion);
  if (typeof progress !== 'number' || !Number.isFinite(progress) || progress < 0 || progress > 1) {
    throw new MotionError('INVALID_PROGRESS', `progress must be in [0,1], got ${progress}`);
  }
  const zoom = motion.zoom_start + (motion.zoom_end - motion.zoom_start) * progress;
  const px = motion.pan_from.x + (motion.pan_to.x - motion.pan_from.x) * progress;
  const py = motion.pan_from.y + (motion.pan_to.y - motion.pan_from.y) * progress;
  const size = 1 / zoom;
  return { zoom, w: size, h: size, x: (1 - size) * px, y: (1 - size) * py };
}

function validateOutputParams({ width, height, fps, durationSeconds }) {
  const okDim = (n) => Number.isInteger(n) && n > 0 && n % 2 === 0 && n <= MOTION_LIMITS.MAX_DIMENSION;
  if (!okDim(width) || !okDim(height)) {
    throw new MotionError('UNSUPPORTED_DIMENSIONS', `width/height must be even positive integers <= ${MOTION_LIMITS.MAX_DIMENSION}, got ${width}x${height}`);
  }
  if (!Number.isInteger(fps) || fps < 1 || fps > MOTION_LIMITS.MAX_FPS) {
    throw new MotionError('INVALID_FPS', `fps must be an integer in [1, ${MOTION_LIMITS.MAX_FPS}], got ${fps}`);
  }
  if (typeof durationSeconds !== 'number' || !Number.isFinite(durationSeconds) || durationSeconds <= 0 || durationSeconds > MOTION_LIMITS.MAX_DURATION_SECONDS) {
    throw new MotionError('INVALID_DURATION', `duration must be a number in (0, ${MOTION_LIMITS.MAX_DURATION_SECONDS}], got ${durationSeconds}`);
  }
}

/**
 * Frame count for a slot: the existing timing contract is seconds; frames are
 * derived once, here. Rounded UP (with a tiny epsilon against float noise) so a
 * clip is never shorter than its slot: the concat list's per-file `duration`
 * directive trims any sub-frame surplus, whereas a short clip would let
 * rounding error accumulate across segments.
 */
export function motionFrameCount(durationSeconds, fps) {
  return Math.max(1, Math.ceil(durationSeconds * fps - 1e-9));
}

const num = (n) => Number(n.toFixed(6)).toString();

/** The FFmpeg -vf chain for one motion clip. Pure string; fully determined by its arguments. */
export function buildMotionFilter({ motion, width, height, fps, durationSeconds }) {
  validateMotion(motion);
  validateOutputParams({ width, height, fps, durationSeconds });
  const frames = motionFrameCount(durationSeconds, fps);
  const S = MOTION_LIMITS.PRESCALE;
  const pw = width * S;
  const ph = height * S;
  // progress per output frame; a 1-frame clip is pinned to progress 0.
  const p = frames > 1 ? `on/${frames - 1}` : '0';
  const z = `${num(motion.zoom_start)}+(${num(motion.zoom_end - motion.zoom_start)})*${p}`;
  const px = `${num(motion.pan_from.x)}+(${num(motion.pan_to.x - motion.pan_from.x)})*${p}`;
  const py = `${num(motion.pan_from.y)}+(${num(motion.pan_to.y - motion.pan_from.y)})*${p}`;
  return [
    // Cover (fill) the frame, then zoompan crops/zooms inside it. Cover-fill is
    // what gives panning room; it crops edges of mismatched aspect ratios.
    `scale=${pw}:${ph}:force_original_aspect_ratio=increase:flags=lanczos`,
    `crop=${pw}:${ph}`,
    `zoompan=z='${z}':x='(iw-iw/zoom)*(${px})':y='(ih-ih/zoom)*(${py})':d=${frames}:s=${width}x${height}:fps=${fps}`,
    'setsar=1',
    'format=yuv420p'
  ].join(',');
}

function probeJson(file, extraArgs = []) {
  const out = execFileSync(
    'ffprobe',
    ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', ...extraArgs, file],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  ).toString();
  return JSON.parse(out);
}

/**
 * Renders ONE silent motion clip from a still image. Throws MotionError on
 * any invalid input or failed/invalid output; never leaves a partial file.
 */
export function renderMotionClip({ imagePath, outputPath, motion, width, height, fps, durationSeconds, videoEncoder = 'libx264' }) {
  validateMotion(motion);
  validateOutputParams({ width, height, fps, durationSeconds });
  if (typeof outputPath !== 'string' || outputPath.length === 0) throw new MotionError('MISSING_OUTPUT_PATH');
  if (typeof imagePath !== 'string' || imagePath.length === 0 || !fs.existsSync(imagePath)) {
    throw new MotionError('MISSING_IMAGE', String(imagePath));
  }
  if (fs.statSync(imagePath).size <= 0) throw new MotionError('INVALID_IMAGE', 'image file is empty');

  let src;
  try {
    src = probeJson(imagePath).streams?.find((s) => s.codec_type === 'video');
  } catch (err) {
    throw new MotionError('INVALID_IMAGE', `ffprobe could not read image: ${String(err.message).split('\n')[0]}`);
  }
  if (!src || !(src.width > 0) || !(src.height > 0)) throw new MotionError('INVALID_IMAGE', 'no decodable image stream');
  if (src.width < MOTION_LIMITS.MIN_SOURCE_DIMENSION || src.height < MOTION_LIMITS.MIN_SOURCE_DIMENSION) {
    throw new MotionError('UNSUPPORTED_DIMENSIONS', `source image ${src.width}x${src.height} is below ${MOTION_LIMITS.MIN_SOURCE_DIMENSION}px`);
  }

  const frames = motionFrameCount(durationSeconds, fps);
  const vf = buildMotionFilter({ motion, width, height, fps, durationSeconds });
  try {
    execFileSync(
      'ffmpeg',
      ['-y', '-i', imagePath, '-vf', vf, '-frames:v', String(frames), '-r', String(fps), '-an',
        '-c:v', videoEncoder, '-pix_fmt', 'yuv420p', path.resolve(outputPath)],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    );
  } catch (err) {
    fs.rmSync(outputPath, { force: true });
    const tail = String(err.stderr ?? err.message).trim().split('\n').slice(-3).join(' | ');
    throw new MotionError('FFMPEG_FAILED', tail);
  }

  // FFmpeg exiting 0 is never sufficient: confirm the clip is what was asked for.
  if (!fs.existsSync(outputPath) || fs.statSync(outputPath).size <= 0) {
    fs.rmSync(outputPath, { force: true });
    throw new MotionError('OUTPUT_MISSING', outputPath);
  }
  try {
    const v = probeJson(outputPath, ['-count_frames']).streams?.find((s) => s.codec_type === 'video');
    if (!v || v.width !== width || v.height !== height || Number(v.nb_read_frames) !== frames) {
      throw new Error(`got ${v?.width}x${v?.height} frames=${v?.nb_read_frames}, expected ${width}x${height} frames=${frames}`);
    }
  } catch (err) {
    fs.rmSync(outputPath, { force: true });
    throw new MotionError('OUTPUT_INVALID', String(err.message).split('\n')[0]);
  }
  return { outputPath, frames, durationSeconds: frames / fps };
}

/**
 * Adds a deterministic `motion` descriptor to every still-image segment of an
 * existing visual timeline (video_clip segments are untouched). Pure; returns
 * a new array. The descriptor is what gets recorded in render_spec.
 */
export function annotateTimingWithMotion(visualTiming) {
  return (visualTiming ?? []).map((seg, i) => (
    seg.asset_type === 'image'
      ? { ...seg, motion: planMotion({ assetId: seg.asset_id, segmentIndex: i }) }
      : seg
  ));
}

/**
 * Turns an annotated timeline into a render timeline: each segment carrying a
 * `motion` descriptor is rendered to a clip in `dir` and its `location` is
 * swapped to the clip (flagged `pre_rendered` so the concat list does not
 * append the "repeat last file" still-image quirk workaround, which would
 * replay a whole clip). Segment start/duration are NOT altered -- the existing
 * timing contract still decides the slot. Returns { timing, cleanup }.
 * On failure every clip already written is removed before rethrowing.
 */
export function prepareMotionClips({ visualTiming, width, height, fps, dir, tag, videoEncoder }) {
  const created = [];
  const cleanup = () => { for (const f of created.splice(0)) fs.rmSync(f, { force: true }); };
  try {
    const timing = visualTiming.map((seg, i) => {
      if (!seg.motion) return seg;
      const clipPath = path.join(dir, `.motion-${tag}-${i}.mp4`);
      created.push(clipPath);
      renderMotionClip({
        imagePath: seg.location, outputPath: clipPath, motion: seg.motion,
        width, height, fps, durationSeconds: seg.duration_seconds, videoEncoder
      });
      return { ...seg, location: clipPath, pre_rendered: true };
    });
    return { timing, cleanup };
  } catch (err) {
    cleanup();
    throw err;
  }
}