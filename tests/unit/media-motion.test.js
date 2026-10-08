import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  MOTION_MODE, MOTION_LIMITS, MOTION_PRESETS, MotionError,
  planMotion, validateMotion, motionWindowAt, motionFrameCount, buildMotionFilter,
  renderMotionClip, annotateTimingWithMotion, prepareMotionClips, resolveMotionEnabled
} from '../../src/media/motion.js';
import { RENDER_DEFAULTS } from '../../src/media/constants.js';
import { computeVisualTiming } from '../../src/media/visualTiming.js';

const W = RENDER_DEFAULTS.WIDTH;
const H = RENDER_DEFAULTS.HEIGHT;
const FPS = RENDER_DEFAULTS.FPS;

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'motion-unit-'));
}

/** Real still image (FFmpeg testsrc, 320x180) so renderMotionClip is exercised against actual decodable input. */
function makeImage(dir, name = 'in.png', size = '320x180') {
  const p = path.join(dir, name);
  execFileSync('ffmpeg', ['-f', 'lavfi', '-i', `testsrc=s=${size}:d=1`, '-frames:v', '1', '-y', p], { stdio: 'ignore' });
  return p;
}

const probe = (file) => JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', '-count_frames', file]).toString());

const byMode = (mode) => MOTION_PRESETS.find((p) => p.mode === mode);

// --- A: deterministic motion ----------------------------------------------

test('A. same (asset_id, segment index) -> identical motion descriptor and identical FFmpeg filter; rule is sha256("ken-burns-v1:<id>:<i>")', () => {
  const a = planMotion({ assetId: 'asset-123', segmentIndex: 2 });
  const b = planMotion({ assetId: 'asset-123', segmentIndex: 2 });
  assert.deepEqual(a, b);
  const args = { width: W, height: H, fps: FPS, durationSeconds: 4.5 };
  assert.equal(buildMotionFilter({ motion: a, ...args }), buildMotionFilter({ motion: b, ...args }));

  // The documented rule, recomputed independently of the module's code path.
  const h = crypto.createHash('sha256').update('ken-burns-v1:asset-123:2').digest();
  const expected = MOTION_PRESETS[h.readUInt32BE(0) % MOTION_PRESETS.length];
  assert.equal(a.mode, expected.mode);
  assert.equal(a.zoom_start, expected.zoom_start);
  assert.equal(a.zoom_end, expected.zoom_end);

  // Varies deterministically with the stable identifiers (not a constant), and never via Math.random.
  const seen = new Set();
  for (let i = 0; i < 40; i++) seen.add(JSON.stringify(planMotion({ assetId: `asset-${i}`, segmentIndex: i })));
  assert.ok(seen.size > 1);
  const original = Math.random;
  Math.random = () => { throw new Error('Math.random must not be used'); };
  try { planMotion({ assetId: 'x', segmentIndex: 0 }); } finally { Math.random = original; }

  // The plan returns fresh objects: mutating one never leaks into the preset table.
  a.pan_from.x = 0.99;
  assert.notEqual(planMotion({ assetId: 'asset-123', segmentIndex: 2 }).pan_from.x, 0.99);
});

test('A2. planMotion rejects non-stable identifiers', () => {
  for (const assetId of ['', null, undefined, 7]) {
    assert.throws(() => planMotion({ assetId, segmentIndex: 0 }), (e) => e instanceof MotionError && e.reason === 'INVALID_ASSET_ID');
  }
  for (const segmentIndex of [-1, 1.5, NaN, '0', undefined]) {
    assert.throws(() => planMotion({ assetId: 'a', segmentIndex }), (e) => e instanceof MotionError && e.reason === 'INVALID_SEGMENT_INDEX');
  }
});

// --- B: zoom-in ------------------------------------------------------------

test('B. zoom-in: window shrinks monotonically from full frame, stays centered; filter zooms up', () => {
  const m = byMode(MOTION_MODE.ZOOM_IN);
  validateMotion(m);
  assert.ok(m.zoom_end > m.zoom_start);
  const w0 = motionWindowAt(m, 0);
  const w1 = motionWindowAt(m, 1);
  assert.equal(w0.zoom, m.zoom_start);
  assert.equal(w1.zoom, m.zoom_end);
  assert.ok(w1.w < w0.w, 'visible window gets smaller as it zooms in');
  assert.ok(Math.abs((w1.x + w1.w / 2) - 0.5) < 1e-9, 'stays centred');
  const f = buildMotionFilter({ motion: m, width: W, height: H, fps: FPS, durationSeconds: 2 });
  assert.match(f, /zoompan=z='1\+\(0\.15\)\*on\/47'/);
  assert.match(f, new RegExp(`s=${W}x${H}:fps=${FPS}`));
});

// --- C: zoom-out -----------------------------------------------------------

test('C. zoom-out: window grows monotonically back to full frame; filter zooms down', () => {
  const m = byMode(MOTION_MODE.ZOOM_OUT);
  validateMotion(m);
  assert.ok(m.zoom_end < m.zoom_start);
  assert.equal(m.zoom_end, 1);
  const w0 = motionWindowAt(m, 0);
  const w1 = motionWindowAt(m, 1);
  assert.ok(w1.w > w0.w);
  assert.deepEqual({ x: w1.x, y: w1.y, w: w1.w, h: w1.h }, { x: 0, y: 0, w: 1, h: 1 });
  const f = buildMotionFilter({ motion: m, width: W, height: H, fps: FPS, durationSeconds: 2 });
  assert.match(f, /zoompan=z='1\.15\+\(-0\.15\)\*on\/47'/);
});

// --- D: pan within image bounds ---------------------------------------------

test('D. pan / pan_zoom: the crop window never leaves the image for every preset at every progress', () => {
  for (const preset of MOTION_PRESETS) {
    validateMotion(preset);
    for (let i = 0; i <= 100; i++) {
      const w = motionWindowAt(preset, i / 100);
      const eps = 1e-9;
      assert.ok(w.x >= -eps && w.y >= -eps, `${preset.mode} origin inside image`);
      assert.ok(w.x + w.w <= 1 + eps && w.y + w.h <= 1 + eps, `${preset.mode} far edge inside image`);
      assert.ok(w.zoom >= MOTION_LIMITS.MIN_ZOOM && w.zoom <= MOTION_LIMITS.MAX_ZOOM);
    }
  }
  const pan = byMode(MOTION_MODE.PAN);
  assert.ok(motionWindowAt(pan, 0).x !== motionWindowAt(pan, 1).x, 'pan actually moves');
  // Pan at zoom 1.0 has no slack and is rejected; so is any out-of-range position.
  assert.throws(() => validateMotion({ mode: 'pan', zoom_start: 1, zoom_end: 1, pan_from: { x: 0, y: 0.5 }, pan_to: { x: 1, y: 0.5 } }), (e) => e.reason === 'INVALID_PAN');
  assert.throws(() => validateMotion({ ...pan, pan_to: { x: 1.2, y: 0.5 } }), (e) => e.reason === 'INVALID_PAN');
  assert.throws(() => validateMotion({ ...pan, pan_from: { x: -0.1, y: 0.5 } }), (e) => e.reason === 'INVALID_PAN');
});

// --- E: duration follows the existing media timing contract -----------------

test('E. duration: frames derive from the existing slot (never shorter than it); annotate leaves every slot untouched', () => {
  assert.equal(motionFrameCount(4.5, 24), 108);
  assert.equal(motionFrameCount(0.1, 24), 3, 'rounded UP so a clip never undershoots its slot');
  assert.equal(motionFrameCount(0.001, 24), 1);
  assert.equal(motionFrameCount(12.000000000000002, 24), 288, 'float noise does not add a frame');

  const assets = [
    { id: 'a1', asset_type: 'image', location: '/x/a1.png' },
    { id: 'a2', asset_type: 'video_clip', location: '/x/a2.mp4' },
    { id: 'a3', asset_type: 'image', location: '/x/a3.png' }
  ];
  const timing = computeVisualTiming(assets, 10);
  const annotated = annotateTimingWithMotion(timing);
  assert.equal(annotated.length, timing.length);
  annotated.forEach((seg, i) => {
    assert.equal(seg.start_seconds, timing[i].start_seconds);
    assert.equal(seg.duration_seconds, timing[i].duration_seconds);
    assert.equal(seg.location, timing[i].location);
  });
  assert.ok(annotated[0].motion && annotated[2].motion);
  assert.equal('motion' in annotated[1], false, 'video_clip segments are never given motion');
  // Input not mutated; deterministic across calls.
  assert.equal('motion' in timing[0], false);
  assert.deepEqual(annotateTimingWithMotion(timing), annotated);
});

test('E2. a real rendered clip has exactly the slot length in frames, the requested size and h264', () => {
  const dir = tmp();
  try {
    const img = makeImage(dir);
    const out = path.join(dir, 'clip.mp4');
    const motion = planMotion({ assetId: 'real', segmentIndex: 0 });
    const r = renderMotionClip({ imagePath: img, outputPath: out, motion, width: 640, height: 360, fps: FPS, durationSeconds: 1.5 });
    assert.equal(r.frames, 36);
    const v = probe(out).streams.find((s) => s.codec_type === 'video');
    assert.equal(v.codec_name, 'h264');
    assert.equal(v.width, 640);
    assert.equal(v.height, 360);
    assert.equal(Number(v.nb_read_frames), 36);
    assert.equal(probe(out).streams.some((s) => s.codec_type === 'audio'), false, 'clip is silent');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('E3. rendering is reproducible: same inputs produce byte-identical clips', () => {
  const dir = tmp();
  try {
    const img = makeImage(dir);
    const motion = planMotion({ assetId: 'repeat', segmentIndex: 1 });
    const args = { imagePath: img, motion, width: 320, height: 180, fps: 12, durationSeconds: 1 };
    renderMotionClip({ ...args, outputPath: path.join(dir, 'a.mp4') });
    renderMotionClip({ ...args, outputPath: path.join(dir, 'b.mp4') });
    assert.ok(fs.readFileSync(path.join(dir, 'a.mp4')).equals(fs.readFileSync(path.join(dir, 'b.mp4'))));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// --- F: invalid input rejected with stable error semantics -------------------

test('F. invalid image / duration / dimensions / config are rejected with MotionError and never leave a file', () => {
  const dir = tmp();
  try {
    const img = makeImage(dir);
    const out = path.join(dir, 'o.mp4');
    const motion = planMotion({ assetId: 'a', segmentIndex: 0 });
    const ok = { imagePath: img, outputPath: out, motion, width: 320, height: 180, fps: 24, durationSeconds: 1 };
    const reason = (over) => { try { renderMotionClip({ ...ok, ...over }); return 'NO_THROW'; } catch (e) { assert.ok(e instanceof MotionError, String(e)); assert.match(e.message, /^motion_/); return e.reason; } };

    assert.equal(reason({ imagePath: path.join(dir, 'missing.png') }), 'MISSING_IMAGE');
    assert.equal(reason({ imagePath: '' }), 'MISSING_IMAGE');
    fs.writeFileSync(path.join(dir, 'empty.png'), '');
    assert.equal(reason({ imagePath: path.join(dir, 'empty.png') }), 'INVALID_IMAGE');
    fs.writeFileSync(path.join(dir, 'garbage.png'), 'this is not an image at all');
    assert.equal(reason({ imagePath: path.join(dir, 'garbage.png') }), 'INVALID_IMAGE');
    assert.equal(reason({ imagePath: makeImage(dir, 'tiny.png', '8x8') }), 'UNSUPPORTED_DIMENSIONS');

    for (const durationSeconds of [0, -1, NaN, Infinity, '2', MOTION_LIMITS.MAX_DURATION_SECONDS + 1]) {
      assert.equal(reason({ durationSeconds }), 'INVALID_DURATION', `duration ${durationSeconds}`);
    }
    for (const [width, height] of [[0, 180], [321, 180], [320, -2], [320.5, 180], [MOTION_LIMITS.MAX_DIMENSION + 2, 180]]) {
      assert.equal(reason({ width, height }), 'UNSUPPORTED_DIMENSIONS', `${width}x${height}`);
    }
    for (const fps of [0, -24, 24.5, 500]) assert.equal(reason({ fps }), 'INVALID_FPS');
    assert.equal(reason({ outputPath: '' }), 'MISSING_OUTPUT_PATH');
    assert.equal(reason({ motion: null }), 'INVALID_MOTION');
    assert.equal(reason({ motion: { ...motion, mode: 'spin' } }), 'INVALID_MODE');
    assert.equal(reason({ motion: { ...byMode('zoom_in'), zoom_end: 3 } }), 'INVALID_ZOOM');
    assert.equal(reason({ motion: { ...byMode('zoom_in'), zoom_end: NaN } }), 'INVALID_ZOOM');
    assert.equal(reason({ motion: { ...byMode('zoom_in'), zoom_end: 0.9, zoom_start: 1 } }), 'INVALID_ZOOM');
    assert.equal(fs.existsSync(out), false, 'no broken artifact left behind by any rejection');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('F2. a failed FFmpeg execution is surfaced as FFMPEG_FAILED and leaves no partial output', () => {
  const dir = tmp();
  try {
    const img = makeImage(dir);
    const out = path.join(dir, 'o.mp4');
    const motion = planMotion({ assetId: 'a', segmentIndex: 0 });
    assert.throws(
      () => renderMotionClip({ imagePath: img, outputPath: out, motion, width: 320, height: 180, fps: 24, durationSeconds: 1, videoEncoder: 'no_such_encoder' }),
      (e) => e instanceof MotionError && e.reason === 'FFMPEG_FAILED'
    );
    assert.equal(fs.existsSync(out), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('F3. prepareMotionClips cleans every clip it already wrote when a later segment fails; pass-through segments are untouched', () => {
  const dir = tmp();
  try {
    const good = makeImage(dir, 'good.png');
    const timing = annotateTimingWithMotion([
      { asset_id: 'g', asset_type: 'image', location: good, start_seconds: 0, duration_seconds: 1 },
      { asset_id: 'v', asset_type: 'video_clip', location: '/not/touched.mp4', start_seconds: 1, duration_seconds: 1 },
      { asset_id: 'b', asset_type: 'image', location: path.join(dir, 'gone.png'), start_seconds: 2, duration_seconds: 1 }
    ]);
    assert.throws(
      () => prepareMotionClips({ visualTiming: timing, width: 320, height: 180, fps: 24, dir, tag: 't' }),
      (e) => e instanceof MotionError && e.reason === 'MISSING_IMAGE'
    );
    assert.deepEqual(fs.readdirSync(dir).filter((f) => f.startsWith('.motion-')), []);

    const ok = prepareMotionClips({ visualTiming: timing.slice(0, 2), width: 320, height: 180, fps: 24, dir, tag: 't' });
    assert.equal(ok.timing[0].pre_rendered, true);
    assert.notEqual(ok.timing[0].location, good);
    assert.equal(ok.timing[1].location, '/not/touched.mp4');
    assert.equal('pre_rendered' in ok.timing[1], false);
    assert.equal(ok.timing[0].duration_seconds, 1, 'slot unchanged');
    ok.cleanup();
    assert.deepEqual(fs.readdirSync(dir).filter((f) => f.startsWith('.motion-')), []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('F4. KEN_BURNS_MOTION toggle: on by default, explicit off honoured, garbage rejected', () => {
  assert.equal(resolveMotionEnabled({}), true);
  assert.equal(resolveMotionEnabled({ KEN_BURNS_MOTION: 'on' }), true);
  for (const v of ['off', 'OFF', '0', 'false', 'none']) assert.equal(resolveMotionEnabled({ KEN_BURNS_MOTION: v }), false);
  assert.throws(() => resolveMotionEnabled({ KEN_BURNS_MOTION: 'maybe' }), (e) => e instanceof MotionError && e.reason === 'CONFIG_INVALID');
});
