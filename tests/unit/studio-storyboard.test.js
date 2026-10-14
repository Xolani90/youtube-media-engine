import test from 'node:test';
import assert from 'node:assert/strict';
import { validateStoryboard, expandToSteps, toVisualTiming } from '../../src/studio/storyboard.js';

const sb = () => ({
  characterId: 'char_test', durationSeconds: 6, fps: 10,
  beats: [
    { id: 'b1', start: 0, end: 2, shot: 'wide', pose: 'idle', purpose: 'establish stage and character' },
    { id: 'b2', start: 2, end: 3.6, shot: 'medium', pose: 'gesture', brow: 'raised', gaze: 1, purpose: 'escalate with gesture' },
    { id: 'b3', start: 3.6, end: 4, shot: 'medium', pose: 'idle', mouth: 'closed', purpose: 'pause before punchline' },
    { id: 'b4', start: 4, end: 6, shot: 'close', pose: 'idle', brow: 'smirk', mouth: 'smirk', purpose: 'punchline reaction' },
  ],
});

test('valid storyboard passes with no errors', () => {
  const r = validateStoryboard(sb());
  assert.equal(r.valid, true, r.errors.join(';'));
});
test('rejects gaps, overlaps, wrong totals and unexplained cuts', () => {
  const gap = sb(); gap.beats[1].start = 2.5;
  assert.ok(validateStoryboard(gap).errors.some((e) => e.includes('contiguous')));
  const short = sb(); short.durationSeconds = 7;
  assert.ok(validateStoryboard(short).errors.some((e) => e.includes('expected durationSeconds')));
  const noWhy = sb(); noWhy.beats[0].purpose = '  ';
  assert.ok(validateStoryboard(noWhy).errors.some((e) => e.includes('purpose required')));
  const badShot = sb(); badShot.beats[0].shot = 'drone';
  assert.ok(validateStoryboard(badShot).errors.some((e) => e.includes('unknown shot')));
  const dup = sb(); dup.beats[1].id = 'b1';
  assert.ok(validateStoryboard(dup).errors.some((e) => e.includes('duplicated')));
});
test('single dominant shot only warns (advisory), does not fail', () => {
  const one = { characterId: 'c', durationSeconds: 4, fps: 10, beats: [{ id: 'a', start: 0, end: 4, shot: 'wide', pose: 'idle', purpose: 'x' }] };
  const r = validateStoryboard(one);
  assert.equal(r.valid, true);
  assert.ok(r.warnings.length >= 1);
});
test('expansion is deterministic and covers every step', () => {
  const a = expandToSteps(sb()); const b = expandToSteps(sb());
  assert.deepEqual(a, b);
  assert.equal(a.length, 60);
  assert.equal(a[0].beatId, 'b1'); assert.equal(a[59].beatId, 'b4');
  assert.deepEqual([...new Set(a.map((s) => s.shot))], ['wide', 'medium', 'close']);
});
test('gesture eases in with a small overshoot and eases out instead of snapping', () => {
  const p = expandToSteps(sb()).map((s) => s.p);
  assert.equal(p[19], 0);                     // last idle step
  assert.equal(p[20], 0);                     // first step of the gesture beat starts from rest
  assert.ok(p[21] > 0 && p[21] < 1, 'in motion on the next step');
  assert.ok(Math.max(...p.slice(20, 24)) > 1, 'settles with a small overshoot');
  assert.equal(p[25], 1);                     // held
  assert.ok(p[37] > 0 && p[37] < 1, 'eases back out after the beat ends');
  assert.equal(p[40], 0);
});
test('visual_timing segments are contiguous, sum exactly, and match the existing segment shape', () => {
  const steps = expandToSteps(sb());
  const seg = toVisualTiming(steps, 10, (s) => ({ location: `/tmp/frame-${s.shot}-${s.zoomQ}-${s.p}.png` }));
  let t = 0;
  for (const s of seg) {
    assert.deepEqual(Object.keys(s).sort(), ['asset_id', 'asset_type', 'duration_seconds', 'location', 'start_seconds']);
    assert.equal(s.asset_type, 'image');
    assert.equal(s.start_seconds, Math.round(t * 1000) / 1000);
    assert.ok(s.duration_seconds > 0);
    t += s.duration_seconds;
  }
  assert.equal(Math.round(t * 1000) / 1000, 6);
  assert.ok(seg.length > 3, 'multiple visual intervals, not one image across the narration');
});
test('invalid storyboard cannot be expanded', () => {
  const bad = sb(); bad.beats[0].purpose = '';
  assert.throws(() => expandToSteps(bad), /invalid storyboard/);
});
