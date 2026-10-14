import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ARCHETYPES, EXTENDED_ARCHETYPES, generateCharacterBible, validateCharacterBible,
  continuityViolations, createCanonicalCharacterBible, canonicalJson,
} from '../../src/studio/characterBible.js';

const clone = (x) => JSON.parse(JSON.stringify(x));

test('legacy: ARCHETYPES pool is unchanged and seeded generation still validates', () => {
  assert.deepEqual([...ARCHETYPES], ['afro', 'short', 'curly']);
  assert.ok(EXTENDED_ARCHETYPES.includes('swept'));
  for (let s = 1; s <= 50; s++) {
    const b = generateCharacterBible(s);
    assert.deepEqual(validateCharacterBible(b), { valid: true, errors: [] }, `seed ${s}`);
    assert.equal(b.variation, undefined);
    assert.deepEqual(b, generateCharacterBible(s));
  }
});

test('legacy: pinned ids for seeds 1-3 are stable', () => {
  const golden = { 1: generateCharacterBible(1).id, 2: generateCharacterBible(2).id, 3: generateCharacterBible(3).id };
  assert.match(golden[1], /^char_[0-9a-f]{12}$/);
  assert.equal(new Set(Object.values(golden)).size, 3);
});

test('canonical profile: valid, deterministic, original, no provider', () => {
  const a = createCanonicalCharacterBible();
  assert.deepEqual(validateCharacterBible(a), { valid: true, errors: [] });
  assert.equal(canonicalJson(a), canonicalJson(createCanonicalCharacterBible()));
  assert.equal(a.voice.provider, null);
  assert.equal(a.provenance.original, true);
  assert.equal(a.provenance.derivedFrom, null);
  assert.notEqual(a.id, createCanonicalCharacterBible({ name: 'Mpho' }).id);
});

test('canonical profile represents the intended attributes', () => {
  const { visual: v } = createCanonicalCharacterBible();
  assert.equal(v.archetype, 'swept');
  assert.equal(v.beard, false);
  assert.equal(v.glasses, true);
  assert.deepEqual(v.glassesStyle, { shape: 'rounded-square', frame: '#0d0d0f', finish: 'matte', thickness: 'thin' });
  assert.equal(v.face.jaw, 'rounded-square');
  assert.ok(v.face.cheekFullness > 0.5);
  assert.equal(v.hairStyle.sweep, 'up-back');
  assert.equal(v.hairStyle.foreheadLock, true);
  assert.equal(v.wardrobe.kind, 'jacket-shirt-tie');
  assert.ok(v.eyes.scale > 1);
});

test('identity vs variation: separated, disjoint, and enforced by continuityViolations', () => {
  const orig = createCanonicalCharacterBible();
  const ok = clone(orig);
  ok.visual.wardrobe.tie = '#222244'; ok.visual.curtain = '#3d1a5e'; ok.visual.shirt = '#ffffff';
  assert.deepEqual(continuityViolations(orig, ok), []);
  for (const [path, mutate] of [
    ['visual.hairStyle', (b) => { b.visual.hairStyle.foreheadLock = false; }],
    ['visual.face', (b) => { b.visual.face.jaw = 'oval'; }],
    ['visual.glassesStyle', (b) => { b.visual.glassesStyle.finish = 'gloss'; }],
    ['visual.wardrobe.kind', (b) => { b.visual.wardrobe.kind = 'jacket-shirt-tie'; b.visual.wardrobe = { ...b.visual.wardrobe }; delete b.visual.wardrobe.kind; }],
    ['variation', (b) => { b.variation.headMovement.maxYawDeg = 9; }],
    ['visual.skin', (b) => { b.visual.skin = '#5c3a21'; }],
  ]) {
    const bad = clone(orig); mutate(bad);
    assert.ok(continuityViolations(orig, bad).includes(path), path);
  }
});

test('controlled variation envelope is required to be sane', () => {
  const base = createCanonicalCharacterBible();
  const cases = [
    ['unknown brow', (b) => { b.variation.brows.push('furious'); }, /unknown value furious/],
    ['missing neutral', (b) => { b.variation.brows = ['raised']; }, /must include neutral/],
    ['missing closed mouth', (b) => { b.variation.mouthShapes = ['talk']; }, /must include closed/],
    ['blink inverted', (b) => { b.variation.blink.minIntervalMs = 9000; }, /must not exceed/],
    ['blink too long', (b) => { b.variation.blink.durationMs = 900; }, /durationMs out of range/],
    ['head yaw too big', (b) => { b.variation.headMovement.maxYawDeg = 45; }, /maxYawDeg out of range/],
    ['head non-number', (b) => { b.variation.headMovement.maxPitchDeg = '4'; }, /maxPitchDeg out of range/],
    ['variation not object', (b) => { b.variation = 'x'; }, /variation must be an object/],
  ];
  for (const [label, mutate, re] of cases) {
    const b = clone(base); mutate(b);
    const r = validateCharacterBible(b);
    assert.equal(r.valid, false, label);
    assert.ok(r.errors.some((e) => re.test(e)), `${label}: ${r.errors.join(' | ')}`);
  }
});

test('new visual blocks reject malformed values', () => {
  const base = createCanonicalCharacterBible();
  const cases = [
    ['bad jaw', (b) => { b.visual.face.jaw = 'pointy'; }, /visual\.face\.jaw/],
    ['cheek range', (b) => { b.visual.face.cheekFullness = 2; }, /cheekFullness/],
    ['iris hex', (b) => { b.visual.eyes.iris = 'brown'; }, /visual\.eyes\.iris/],
    ['eye scale', (b) => { b.visual.eyes.scale = 3; }, /visual\.eyes\.scale/],
    ['brow thickness', (b) => { b.visual.brows.thickness = -1; }, /brows\.thickness/],
    ['sweep', (b) => { b.visual.hairStyle.sweep = 'sideways'; }, /hairStyle\.sweep/],
    ['lock type', (b) => { b.visual.hairStyle.foreheadLock = 'yes'; }, /foreheadLock/],
    ['frame hex', (b) => { b.visual.glassesStyle.frame = 'black'; }, /glassesStyle\.frame/],
    ['glasses off with style', (b) => { b.visual.glasses = false; }, /requires visual\.glasses true/],
    ['wardrobe kind', (b) => { b.visual.wardrobe.kind = 'tracksuit'; }, /wardrobe\.kind/],
    ['wardrobe hex', (b) => { b.visual.wardrobe.tie = 'navy'; }, /wardrobe\.tie/],
    ['swept needs hairStyle', (b) => { delete b.visual.hairStyle; b.continuity.immutable = b.continuity.immutable.filter((p) => p !== 'visual.hairStyle'); }, /hairStyle required for archetype swept/],
    ['unknown archetype', (b) => { b.visual.archetype = 'mohawk'; }, /unknown archetype/],
  ];
  for (const [label, mutate, re] of cases) {
    const b = clone(base); mutate(b);
    const r = validateCharacterBible(b);
    assert.equal(r.valid, false, label);
    assert.ok(r.errors.some((e) => re.test(e)), `${label}: ${r.errors.join(' | ')}`);
  }
});

test('continuity paths must resolve and must not overlap', () => {
  const b1 = clone(createCanonicalCharacterBible());
  b1.continuity.immutable.push('visual.nope');
  assert.ok(validateCharacterBible(b1).errors.some((e) => /does not resolve: visual\.nope/.test(e)));
  const b2 = clone(createCanonicalCharacterBible());
  b2.continuity.allowedVariation.push('visual.skin');
  assert.ok(validateCharacterBible(b2).errors.some((e) => /both immutable and variable: visual\.skin/.test(e)));
});

test('existing guards still hold: voice provider must stay null, version and id checked', () => {
  const b = clone(createCanonicalCharacterBible());
  b.voice.provider = 'x';
  assert.ok(validateCharacterBible(b).errors.some((e) => /voice\.provider/.test(e)));
  assert.equal(validateCharacterBible({}).valid, false);
  assert.throws(() => createCanonicalCharacterBible({ name: '  ' }), /name/);
});

test('legacy bibles stay valid even with unresolvable, overlapping or malformed continuity paths (no path checks without extensions)', () => {
  const legacy = clone(generateCharacterBible(5));
  assert.deepEqual(validateCharacterBible(legacy), { valid: true, errors: [] });
  const persisted = clone(legacy);
  persisted.continuity.immutable.push('visual.retiredField', 42, null);
  persisted.continuity.allowedVariation.push('visual.skin');
  assert.deepEqual(validateCharacterBible(persisted), { valid: true, errors: [] });
});

test('canonical profile: unresolved continuity path is an error', () => {
  const b = clone(createCanonicalCharacterBible());
  b.continuity.allowedVariation.push('visual.wardrobe.cufflinks');
  const r = validateCharacterBible(b);
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => /allowedVariation path does not resolve: visual\.wardrobe\.cufflinks/.test(e)));
});

test('canonical profile: non-string continuity paths return errors and never throw', () => {
  for (const bad of [42, null, undefined, {}, ['visual.skin'], '', true]) {
    for (const list of ['immutable', 'allowedVariation']) {
      const b = clone(createCanonicalCharacterBible());
      b.continuity[list].push(bad);
      let r;
      assert.doesNotThrow(() => { r = validateCharacterBible(b); }, `${list} ${String(bad)}`);
      assert.equal(r.valid, false);
      assert.ok(r.errors.some((e) => new RegExp(`continuity\\.${list}\\[\\d+\\] must be a non-empty string path`).test(e)), r.errors.join(' | '));
    }
  }
  const b = clone(createCanonicalCharacterBible());
  b.continuity.allowedVariation = 'visual.shirt';
  assert.ok(validateCharacterBible(b).errors.some((e) => /allowedVariation must be an array/.test(e)));
});

test('swept archetype: hairStyle is mandatory and its attributes are validated', () => {
  const b = clone(createCanonicalCharacterBible());
  delete b.visual.hairStyle;
  b.continuity.immutable = b.continuity.immutable.filter((p) => p !== 'visual.hairStyle');
  assert.ok(validateCharacterBible(b).errors.some((e) => /hairStyle required for archetype swept/.test(e)));
  const c = clone(createCanonicalCharacterBible());
  c.visual.hairStyle = { sweep: 'up-back' };
  const errs = validateCharacterBible(c).errors;
  assert.ok(errs.some((e) => /foreheadLock/.test(e)) && errs.some((e) => /hairStyle\.sheen/.test(e)));
});
