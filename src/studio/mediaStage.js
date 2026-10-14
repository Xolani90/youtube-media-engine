/**
 * Opt-in studio integration for the existing Media Production stage (additive).
 *
 * src/media/pipeline.js calls resolveStudioSequencing() at the single point
 * where it chooses visual timing. Everything else (rights re-check, checksum
 * gates, narration, captions, motion for legacy timing, render, validation,
 * persistence) is the unchanged existing code.
 *
 * Flag (mirrors MULTI_SCENE_VISUALS / KEN_BURNS_MOTION conventions):
 *   STUDIO_VISUALS = off (default) | on      anything else is a configuration error
 *
 * Where the plan comes from (no schema change): the frame-asset step writes
 * `studio-plan.json` into the content version's media artifact directory
 * (writeStudioPlan). The plan names the frames by asset_id; the assets
 * themselves are ordinary rows in `assets`/`asset_usages` and therefore pass
 * through the existing UNVERIFIED/DISPUTED rights gate BEFORE this code runs.
 *
 * Outcomes of resolveStudioSequencing:
 *   source 'legacy'    flag off. Nothing here has any effect.
 *   source 'legacy'    flag on, no plan file. `fallback` is set; the caller logs
 *                      STUDIO_VISUALS_FALLBACK so the fallback is observable
 *                      (same policy as music: absent -> unchanged path, recorded).
 *   source 'studio'    flag on, plan present and valid.
 *   source 'rejected'  flag on, plan present but invalid. The caller fails the
 *                      render (same policy as undecodable music), it never
 *                      silently substitutes legacy visuals.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const STUDIO_PLAN_FILENAME = 'studio-plan.json';
export const STUDIO_PLAN_TYPE = 'studio_visual_plan_v1';
export const STUDIO_DECISION = Object.freeze({
  APPLIED: 'STUDIO_VISUALS_APPLIED',
  FALLBACK: 'STUDIO_VISUALS_FALLBACK'
});
/** Total studio timing may differ from the narration by at most this (then the last segment absorbs it). */
export const STUDIO_DURATION_TOLERANCE_SECONDS = 0.05;

const round3 = (n) => Math.round(n * 1000) / 1000;
const EPS = 0.0005;

/** 'on' | 'off' (default). Anything else is a configuration error, never silently coerced. */
export function resolveStudioVisualsEnabled(env = process.env) {
  const v = String(env.STUDIO_VISUALS ?? 'off').trim().toLowerCase();
  if (v === '' || v === 'off' || v === '0' || v === 'false') return false;
  if (v === 'on' || v === '1' || v === 'true') return true;
  throw new Error(`STUDIO_VISUALS must be one of on, off (got "${v}")`);
}

/** Writes the plan next to the media artifacts. Returns { path, checksum }. */
export function writeStudioPlan(dir, { visualTiming, durationSeconds, characterId, storyboardDigest }) {
  const plan = {
    plan_type: STUDIO_PLAN_TYPE,
    character_id: characterId,
    storyboard_digest: storyboardDigest ?? null,
    duration_seconds: durationSeconds,
    visual_timing: visualTiming
  };
  const json = JSON.stringify(plan, null, 2);
  const file = path.join(dir, STUDIO_PLAN_FILENAME);
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, json, 'utf8');
  fs.renameSync(tmp, file);
  return { path: file, checksum: crypto.createHash('sha256').update(json).digest('hex') };
}

/**
 * Pure validation of studio timing against the renderer's segment contract and
 * the attached assets. Returns { ok, errors:[{code, detail}], timing }.
 * `timing` (only when ok) is normalised: rounded to ms, last segment absorbs a
 * sub-tolerance remainder so the segments sum to the narration duration exactly,
 * as the FFmpeg concat demuxer requires.
 */
export function validateStudioTiming(rawTiming, { narrationDurationSeconds, visualAssets }) {
  const errors = [];
  const err = (code, detail) => errors.push({ code, detail });

  if (!(narrationDurationSeconds > 0)) err('STUDIO_NARRATION_DURATION_INVALID', String(narrationDurationSeconds));
  if (!Array.isArray(rawTiming) || rawTiming.length === 0) {
    err('STUDIO_TIMING_EMPTY', 'visual_timing must be a non-empty array');
    return { ok: false, errors, timing: null };
  }

  const byId = new Map((visualAssets ?? []).map((a) => [a.id, a]));
  let cursor = 0;
  rawTiming.forEach((s, i) => {
    const tag = `segment ${i}`;
    if (!s || typeof s !== 'object') { err('STUDIO_TIMING_SEGMENT_INVALID', tag); return; }
    if (typeof s.asset_id !== 'string' || !s.asset_id) { err('STUDIO_TIMING_SEGMENT_INVALID', `${tag}: asset_id missing`); return; }
    if (!Number.isFinite(s.start_seconds) || !Number.isFinite(s.duration_seconds)) { err('STUDIO_TIMING_SEGMENT_INVALID', `${tag}: start/duration not numbers`); return; }
    if (!(s.duration_seconds > 0)) err('STUDIO_TIMING_NON_POSITIVE', `${tag}: duration ${s.duration_seconds}`);
    if (Math.abs(s.start_seconds - cursor) > EPS) err('STUDIO_TIMING_GAP_OR_OVERLAP', `${tag}: starts at ${s.start_seconds}, expected ${cursor}`);
    cursor = round3(s.start_seconds + s.duration_seconds);
    const asset = byId.get(s.asset_id);
    if (!asset) err('STUDIO_ASSET_NOT_ATTACHED', `${tag}: asset ${s.asset_id} is not a visual asset attached to this content version`);
    else if (asset.location !== s.location) err('STUDIO_ASSET_LOCATION_MISMATCH', `${tag}: plan location differs from the attached asset's location`);
  });

  if (errors.length === 0 && Math.abs(cursor - narrationDurationSeconds) > STUDIO_DURATION_TOLERANCE_SECONDS) {
    err('STUDIO_TIMING_DURATION_MISMATCH', `timing ends at ${cursor}s but narration is ${narrationDurationSeconds}s (tolerance ${STUDIO_DURATION_TOLERANCE_SECONDS}s)`);
  }
  if (errors.length > 0) return { ok: false, errors, timing: null };

  const timing = rawTiming.map((s) => ({
    asset_id: s.asset_id,
    asset_type: byId.get(s.asset_id).asset_type,
    location: byId.get(s.asset_id).location,
    start_seconds: round3(s.start_seconds),
    duration_seconds: round3(s.duration_seconds)
  }));
  const last = timing[timing.length - 1];
  last.duration_seconds = round3(narrationDurationSeconds - last.start_seconds);
  if (!(last.duration_seconds > 0)) {
    return { ok: false, errors: [{ code: 'STUDIO_TIMING_NON_POSITIVE', detail: 'last segment has no time left after normalisation' }], timing: null };
  }
  return { ok: true, errors: [], timing };
}

/**
 * The single decision point called by the media pipeline.
 * Throws only for an invalid STUDIO_VISUALS value (a configuration error the
 * caller turns into a RENDER_FAILED, never a silent default).
 */
export function resolveStudioSequencing({ dir, visualAssets, narrationDurationSeconds, env = process.env }) {
  if (!resolveStudioVisualsEnabled(env)) return { source: 'legacy', enabled: false };

  const planPath = path.join(dir, STUDIO_PLAN_FILENAME);
  if (!fs.existsSync(planPath)) {
    return { source: 'legacy', enabled: true, fallback: { reason: 'studio_plan_missing' } };
  }

  const reject = (errors) => ({ source: 'rejected', enabled: true, errors, reason: errors.map((e) => e.code).join(',') });
  let raw;
  let plan;
  try {
    raw = fs.readFileSync(planPath, 'utf8');
    plan = JSON.parse(raw);
  } catch (e) {
    return reject([{ code: 'STUDIO_PLAN_UNREADABLE', detail: String(e.message).slice(0, 200) }]);
  }
  if (!plan || plan.plan_type !== STUDIO_PLAN_TYPE) {
    return reject([{ code: 'STUDIO_PLAN_SCHEMA', detail: `plan_type must be ${STUDIO_PLAN_TYPE}` }]);
  }
  const v = validateStudioTiming(plan.visual_timing, { narrationDurationSeconds, visualAssets });
  if (!v.ok) return reject(v.errors);
  return {
    source: 'studio',
    enabled: true,
    timing: v.timing,
    planChecksum: crypto.createHash('sha256').update(raw).digest('hex'),
    characterId: plan.character_id ?? null
  };
}