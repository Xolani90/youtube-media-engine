import test from 'node:test';
import assert from 'node:assert/strict';
import { generateCharacterBible, validateCharacterBible, continuityViolations, canonicalJson } from '../../src/studio/characterBible.js';

test('same seed gives an identical bible and id', () => {
  assert.equal(canonicalJson(generateCharacterBible(1)), canonicalJson(generateCharacterBible(1)));
});
test('seeds 1-3 give distinct characters and ids', () => {
  const b = [1, 2, 3].map(generateCharacterBible);
  assert.equal(new Set(b.map((x) => x.id)).size, 3);
  assert.deepEqual(b.map((x) => x.visual.archetype), ['afro', 'short', 'curly']);
});
test('generated bibles validate', () => {
  for (let s = 1; s <= 25; s++) assert.deepEqual(validateCharacterBible(generateCharacterBible(s)), { valid: true, errors: [] }, `seed ${s}`);
});
test('invalid seeds are rejected', () => {
  for (const s of [0, -1, 1.5, '1', null]) assert.throws(() => generateCharacterBible(s));
});
test('validator reports specific faults', () => {
  const b = generateCharacterBible(2);
  const bad = { ...b, visual: { ...b.visual, skin: 'brown', headRx: 5 }, voice: { ...b.voice, provider: 'x' } };
  const { valid, errors } = validateCharacterBible(bad);
  assert.equal(valid, false);
  assert.ok(errors.some((e) => e.includes('visual.skin')));
  assert.ok(errors.some((e) => e.includes('visual.headRx')));
  assert.ok(errors.some((e) => e.includes('voice.provider')));
});
test('continuity: wardrobe may change, identity may not', () => {
  const b = generateCharacterBible(1);
  const costume = { ...b, visual: { ...b.visual, shirt: '#000000' } };
  assert.deepEqual(continuityViolations(b, costume), []);
  const face = { ...b, visual: { ...b.visual, skin: '#000000', glasses: !b.visual.glasses } };
  assert.deepEqual(continuityViolations(b, face).sort(), ['visual.glasses', 'visual.skin']);
});
