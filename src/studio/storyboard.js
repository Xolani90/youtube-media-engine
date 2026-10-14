/**
 * Storyboard representation for the animated-comedy format (additive module).
 * A storyboard is an ordered, contiguous list of beats; each beat says WHY the
 * camera or pose changes (purpose) so cuts are never arbitrary. The expansion
 * functions are pure and produce `visual_timing`-compatible segments
 * ({asset_id, asset_type, location, start_seconds, duration_seconds}) so the
 * existing renderSilentVideo path can consume them unchanged.
 *
 * Coverage warnings are advisory: thresholds are NOT yet calibrated against
 * real outputs and must not be treated as proof of cinematic quality.
 */
export const SHOTS = Object.freeze(['wide', 'medium', 'close']);
export const POSES = Object.freeze(['idle', 'gesture']);
export const BROWS = Object.freeze(['neutral', 'raised', 'smirk']);
export const MOUTHS = Object.freeze(['talk', 'closed', 'smirk']);
const round3 = (n) => Math.round(n * 1000) / 1000;
const EPS = 0.0005;

export function validateStoryboard(sb) {
  const errors = []; const warnings = [];
  if (!sb || typeof sb !== 'object') return { valid: false, errors: ['storyboard must be an object'], warnings };
  if (typeof sb.characterId !== 'string' || !sb.characterId) errors.push('characterId required');
  if (!(sb.durationSeconds > 0)) errors.push('durationSeconds must be positive');
  if (!Number.isInteger(sb.fps) || sb.fps < 1 || sb.fps > 30) errors.push('fps must be an integer 1-30');
  const beats = sb.beats;
  if (!Array.isArray(beats) || beats.length === 0) { errors.push('at least one beat required'); return { valid: false, errors, warnings }; }
  let cursor = 0; const ids = new Set();
  beats.forEach((b, i) => {
    const tag = `beat ${i}${b?.id ? ` (${b.id})` : ''}`;
    if (!b?.id || ids.has(b.id)) errors.push(`${tag}: id missing or duplicated`); else ids.add(b.id);
    if (!(b.end > b.start)) errors.push(`${tag}: end must be greater than start`);
    if (Math.abs(b.start - cursor) > EPS) errors.push(`${tag}: starts at ${b.start}, expected ${cursor} (beats must be contiguous)`);
    cursor = b.end;
    if (!SHOTS.includes(b.shot)) errors.push(`${tag}: unknown shot ${b.shot}`);
    if (!POSES.includes(b.pose)) errors.push(`${tag}: unknown pose ${b.pose}`);
    if (!BROWS.includes(b.brow ?? 'neutral')) errors.push(`${tag}: unknown brow ${b.brow}`);
    if (!MOUTHS.includes(b.mouth ?? 'talk')) errors.push(`${tag}: unknown mouth ${b.mouth}`);
    if (typeof b.purpose !== 'string' || !b.purpose.trim()) errors.push(`${tag}: purpose required (no unexplained cuts)`);
  });
  if (Math.abs(cursor - sb.durationSeconds) > EPS) errors.push(`beats end at ${cursor}, expected durationSeconds ${sb.durationSeconds}`);
  if (errors.length === 0) {
    const byShot = {};
    for (const b of beats) byShot[b.shot] = (byShot[b.shot] ?? 0) + (b.end - b.start);
    for (const [shot, secs] of Object.entries(byShot)) if (secs / sb.durationSeconds > 0.6) warnings.push(`shot "${shot}" covers ${Math.round((secs / sb.durationSeconds) * 100)}% of the video (uncalibrated advisory)`);
    if (Object.keys(byShot).length < 2) warnings.push('only one shot type used (uncalibrated advisory)');
  }
  return { valid: errors.length === 0, errors, warnings };
}

const easeOutBack = (x) => { const c1 = 1.2; const c3 = c1 + 1; return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2); };
const easeInOut = (x) => (x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2);

/** One state per frame-step (1/fps s). Pure function of the storyboard. */
export function expandToSteps(sb) {
  const v = validateStoryboard(sb);
  if (!v.valid) throw new Error(`invalid storyboard: ${v.errors.join('; ')}`);
  const steps = Math.round(sb.durationSeconds * sb.fps);
  const out = [];
  for (let i = 0; i < steps; i++) {
    const t = i / sb.fps;
    const bi = sb.beats.findIndex((b) => t >= b.start - EPS && t < b.end - EPS);
    const b = sb.beats[bi === -1 ? sb.beats.length - 1 : bi];
    const prev = sb.beats[(bi === -1 ? sb.beats.length - 1 : bi) - 1];
    const local = t - b.start;
    let p = b.pose === 'gesture' ? 1 : 0;
    if (b.pose === 'gesture' && prev?.pose !== 'gesture') p = easeOutBack(Math.min(1, local / 0.3));
    if (b.pose === 'idle' && prev?.pose === 'gesture') p = 1 - easeInOut(Math.min(1, local / 0.3));
    const span = b.end - b.start;
    out.push({
      index: i, t: round3(t), beatId: b.id, shot: b.shot,
      zoomQ: Math.min(5, Math.floor((local / span) * 6)),
      p: (Math.round(p * 10) / 10) || 0, // normalises -0
      brow: b.brow ?? 'neutral', mouth: b.mouth ?? 'talk', gaze: b.gaze ?? 0,
    });
  }
  return out;
}

const keyOf = (s) => [s.shot, s.zoomQ, s.p, s.brow, s.mouth, s.gaze].join('|');

/**
 * Merges consecutive identical steps into visual_timing segments. `frameFor(state)`
 * must return {location, asset_id?}; asset provenance and rights verification stay
 * the responsibility of the existing asset/rights stages, which this module does not bypass.
 */
export function toVisualTiming(steps, fps, frameFor) {
  if (!steps.length) return [];
  const segs = []; let cur = null;
  for (const s of steps) {
    const k = keyOf(s);
    if (cur && cur.key === k) { cur.n += 1; continue; }
    cur = { key: k, state: s, n: 1 }; segs.push(cur);
  }
  let elapsed = 0;
  return segs.map((g, i) => {
    const isLast = i === segs.length - 1;
    const total = round3(steps.length / fps);
    const dur = isLast ? round3(total - elapsed) : round3(g.n / fps);
    const f = frameFor(g.state);
    const seg = { asset_id: f.asset_id ?? null, asset_type: 'image', location: f.location, start_seconds: round3(elapsed), duration_seconds: dur };
    elapsed += dur;
    return seg;
  });
}
