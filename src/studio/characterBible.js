/**
 * Persistent character bible for the animated-comedy format (additive module;
 * nothing in the existing pipeline imports it). Pure and deterministic: the
 * same seed always yields the same bible. No LLM, no network, no clock.
 *
 * `visual` holds machine-readable rendering parameters; the remaining fields
 * hold creative identity and continuity rules. `voice` is a performance
 * specification only: it names no provider and enables no audio capability.
 * Names and appearance are drawn independently, and are placeholders for a
 * later creative-selection stage, not a finished character-development step.
 */
import { createHash } from 'node:crypto';

export const BIBLE_VERSION = 1;
export const ARCHETYPES = Object.freeze(['afro', 'short', 'curly']);

/*
 * Schema extension (backward compatible, BIBLE_VERSION unchanged).
 * ARCHETYPES is the pool the seeded generator draws from and is deliberately
 * NOT extended: adding to it would change generateCharacterBible output for
 * existing seeds. EXTENDED_ARCHETYPES is what the validator accepts.
 * New `visual.*` blocks and the top-level `variation` block are optional, so
 * every previously valid bible stays valid and keeps its id.
 * The 2D renderer is not aware of these fields; it ignores them and draws an
 * unknown archetype with its fallback hair.
 */
export const EXTENDED_ARCHETYPES = Object.freeze([...ARCHETYPES, 'swept']);
export const JAW_SHAPES = Object.freeze(['oval', 'rounded-square', 'square']);
export const HAIR_SWEEPS = Object.freeze(['none', 'up-back']);
export const GLASSES_SHAPES = Object.freeze(['round', 'rounded-square', 'square']);
export const GLASSES_FINISHES = Object.freeze(['matte', 'gloss']);
export const GLASSES_THICKNESSES = Object.freeze(['thin', 'medium', 'thick']);
export const WARDROBE_KINDS = Object.freeze(['jacket-shirt-tie']);
/** Brow and mouth vocabularies mirror what characterRenderer's storyboard state already accepts. */
export const BROW_STATES = Object.freeze(['neutral', 'raised', 'smirk']);
export const MOUTH_SHAPES = Object.freeze(['closed', 'talk', 'smirk']);

const NAMES = ['Sipho', 'Thandi', 'Pieter', 'Nokuthula', 'Reza', 'Lerato', 'Johan', 'Ayesha', 'Bongani', 'Megan'];
const WORLDVIEWS = [
  'treats every queue as a personal rivalry it is quietly losing',
  'believes any form needs one more form before it counts',
  'narrates ordinary errands like heist movies',
  'is relentlessly optimistic about services that have never worked',
  'argues with automated phone menus as if they were relatives',
];
const BEHAVIOURS = [
  'rubs the back of the neck before a punchline',
  'points at the audience when escalating',
  'pauses and stares at the microphone after a big joke',
  'checks an imaginary watch when describing delays',
  'leans in and drops volume for the darkest lines',
];
const VOICE_REGISTERS = ['dry and deadpan', 'warm and conspiratorial', 'fast and exasperated', 'calm and quietly savage'];

function rng(a) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Stable canonical JSON (sorted keys) so ids and checksums never depend on key order. */
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function generateCharacterBible(seed) {
  if (!Number.isInteger(seed) || seed < 1) throw new Error(`seed must be a positive integer, got ${seed}`);
  const r = rng(seed * 7919 + 13);
  const pick = (a) => a[Math.floor(r() * a.length)];
  const archetype = ARCHETYPES[(seed - 1) % ARCHETYPES.length];
  const shirts = ['#1f6f5c', '#b83227', '#2c3e8f', '#c9831a', '#6b3fa0'];
  const visual = {
    archetype,
    glasses: seed <= 3 ? archetype === 'afro' : r() < 0.4,
    beard: seed <= 3 ? archetype === 'short' : r() < 0.4,
    skin: pick(['#8d5524', '#a8693a', '#c68642', '#e0ac69', '#5c3a21']),
    hair: pick(['#111111', '#241710', '#3b2a1e']),
    shirt: shirts[(seed - 1) % shirts.length],
    accent: pick(['#f4d03f', '#ffffff', '#e67e22']),
    trousers: pick(['#2d2d33', '#3b3f58', '#4a3b2a']),
    shoes: pick(['#e8e8e8', '#222222', '#8b1a1a']),
    curtain: pick(['#6b1426', '#14405c', '#3d1a5e']),
    headRx: 146 + Math.floor(r() * 20),
    headRy: 168 + Math.floor(r() * 16),
    build: 150 + Math.floor(r() * 26),
  };
  const body = {
    version: BIBLE_VERSION,
    seed,
    name: pick(NAMES),
    visual,
    personality: { worldview: pick(WORLDVIEWS), signatureBehaviours: [pick(BEHAVIOURS), pick(BEHAVIOURS)].filter((v, i, a) => a.indexOf(v) === i) },
    voice: { register: pick(VOICE_REGISTERS), paceWordsPerMinute: 130 + Math.floor(r() * 30), provider: null, note: 'performance specification only; no provider selected' },
    continuity: {
      immutable: ['visual.archetype', 'visual.skin', 'visual.hair', 'visual.headRx', 'visual.headRy', 'visual.build', 'visual.glasses', 'visual.beard', 'name'],
      allowedVariation: ['visual.shirt', 'visual.accent', 'visual.trousers', 'visual.shoes', 'visual.curtain'],
    },
    provenance: { generator: 'studio/characterBible', original: true, derivedFrom: null },
  };
  return { id: bibleId(body), ...body };
}

function bibleId(body) {
  return `char_${createHash('sha256').update(canonicalJson({ ...body, id: undefined })).digest('hex').slice(0, 12)}`;
}

/**
 * Canonical profile for the intended original adult male comedy character.
 * Deterministic and explicit (no seed, no rng). It describes parameters only;
 * it does not produce or imply any artwork. `name` is a placeholder for the
 * later creative-selection stage.
 */
export const CANONICAL_PROFILE_ID = 'swept-suit-v1';
export function createCanonicalCharacterBible({ name = 'Sipho' } = {}) {
  if (typeof name !== 'string' || !name.trim()) throw new Error('name must be a non-empty string');
  const body = {
    version: BIBLE_VERSION,
    seed: 0,
    name: name.trim(),
    visual: {
      archetype: 'swept',
      glasses: true,
      beard: false,
      skin: '#a8693a',
      hair: '#12141c',
      shirt: '#f4f4f2',
      accent: '#1c2541',
      trousers: '#2a2a2e',
      shoes: '#222222',
      curtain: '#14405c',
      headRx: 158,
      headRy: 172,
      build: 164,
      face: { jaw: 'rounded-square', cheekFullness: 0.6 },
      eyes: { iris: '#3b2418', scale: 1.15 },
      brows: { color: '#0f1116', thickness: 0.8 },
      hairStyle: { sweep: 'up-back', foreheadLock: true, sheen: '#2a3a5c' },
      glassesStyle: { shape: 'rounded-square', frame: '#0d0d0f', finish: 'matte', thickness: 'thin' },
      wardrobe: { kind: 'jacket-shirt-tie', jacket: '#2b2d31', shirt: '#f4f4f2', tie: '#1c2541' },
    },
    personality: {
      worldview: 'treats every queue as a personal rivalry it is quietly losing',
      signatureBehaviours: ['rubs the back of the neck before a punchline', 'pauses and stares at the microphone after a big joke'],
    },
    voice: { register: 'dry and deadpan', paceWordsPerMinute: 140, provider: null, note: 'performance specification only; no provider selected' },
    variation: {
      brows: ['neutral', 'raised', 'smirk'],
      mouthShapes: ['closed', 'talk', 'smirk'],
      blink: { minIntervalMs: 2500, maxIntervalMs: 6000, durationMs: 120 },
      headMovement: { maxYawDeg: 6, maxPitchDeg: 4, maxRollDeg: 3 },
    },
    continuity: {
      immutable: [
        'visual.archetype', 'visual.skin', 'visual.hair', 'visual.headRx', 'visual.headRy', 'visual.build', 'visual.glasses', 'visual.beard', 'name',
        'visual.face', 'visual.eyes', 'visual.brows', 'visual.hairStyle', 'visual.glassesStyle', 'visual.wardrobe.kind', 'variation',
      ],
      allowedVariation: [
        'visual.shirt', 'visual.accent', 'visual.trousers', 'visual.shoes', 'visual.curtain',
        'visual.wardrobe.jacket', 'visual.wardrobe.shirt', 'visual.wardrobe.tie',
      ],
    },
    provenance: { generator: 'studio/characterBible', original: true, derivedFrom: null, profile: CANONICAL_PROFILE_ID },
  };
  return { id: bibleId(body), ...body };
}

const HEX = /^#[0-9a-f]{6}$/i;
export function validateCharacterBible(b) {
  const errors = [];
  if (!b || typeof b !== 'object') return { valid: false, errors: ['bible must be an object'] };
  if (b.version !== BIBLE_VERSION) errors.push(`unsupported version ${b.version}`);
  if (typeof b.id !== 'string' || !b.id.startsWith('char_')) errors.push('id missing or malformed');
  if (typeof b.name !== 'string' || !b.name.trim()) errors.push('name required');
  const v = b.visual;
  if (!v) errors.push('visual required');
  else {
    if (!EXTENDED_ARCHETYPES.includes(v.archetype)) errors.push(`unknown archetype ${v.archetype}`);
    for (const k of ['skin', 'hair', 'shirt', 'accent', 'trousers', 'shoes', 'curtain']) if (!HEX.test(v[k] ?? '')) errors.push(`visual.${k} must be #rrggbb`);
    for (const [k, lo, hi] of [['headRx', 100, 220], ['headRy', 120, 240], ['build', 110, 220]]) if (!(v[k] >= lo && v[k] <= hi)) errors.push(`visual.${k} out of range ${lo}-${hi}`);
    for (const k of ['glasses', 'beard']) if (typeof v[k] !== 'boolean') errors.push(`visual.${k} must be boolean`);
    validateVisualExtensions(v, errors);
  }
  if (!b.personality?.worldview) errors.push('personality.worldview required');
  if (!Array.isArray(b.personality?.signatureBehaviours) || b.personality.signatureBehaviours.length === 0) errors.push('personality.signatureBehaviours required');
  if (!b.voice?.register) errors.push('voice.register required');
  if (b.voice && b.voice.provider !== null) errors.push('voice.provider must be null until a provider is authorised');
  if (!Array.isArray(b.continuity?.immutable) || b.continuity.immutable.length === 0) errors.push('continuity.immutable required');
  else if (usesExtensions(b)) validateContinuityPaths(b, errors);
  if (b.variation !== undefined) validateVariation(b.variation, errors);
  return { valid: errors.length === 0, errors };
}

const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const num = (x, lo, hi) => typeof x === 'number' && Number.isFinite(x) && x >= lo && x <= hi;
const getPath = (o, p) => p.split('.').reduce((x, k) => x?.[k], o);

function validateVisualExtensions(v, errors) {
  const hex = (path, val) => { if (!HEX.test(val ?? '')) errors.push(`${path} must be #rrggbb`); };
  const oneOf = (path, val, list) => { if (!list.includes(val)) errors.push(`${path} must be one of ${list.join('|')}`); };
  if (v.archetype === 'swept' && v.hairStyle === undefined) errors.push('visual.hairStyle required for archetype swept');
  if (v.face !== undefined) {
    if (!isObj(v.face)) errors.push('visual.face must be an object');
    else { oneOf('visual.face.jaw', v.face.jaw, JAW_SHAPES); if (!num(v.face.cheekFullness, 0, 1)) errors.push('visual.face.cheekFullness out of range 0-1'); }
  }
  if (v.eyes !== undefined) {
    if (!isObj(v.eyes)) errors.push('visual.eyes must be an object');
    else { hex('visual.eyes.iris', v.eyes.iris); if (!num(v.eyes.scale, 0.5, 1.5)) errors.push('visual.eyes.scale out of range 0.5-1.5'); }
  }
  if (v.brows !== undefined) {
    if (!isObj(v.brows)) errors.push('visual.brows must be an object');
    else { hex('visual.brows.color', v.brows.color); if (!num(v.brows.thickness, 0, 1)) errors.push('visual.brows.thickness out of range 0-1'); }
  }
  if (v.hairStyle !== undefined) {
    if (!isObj(v.hairStyle)) errors.push('visual.hairStyle must be an object');
    else {
      oneOf('visual.hairStyle.sweep', v.hairStyle.sweep, HAIR_SWEEPS);
      if (typeof v.hairStyle.foreheadLock !== 'boolean') errors.push('visual.hairStyle.foreheadLock must be boolean');
      hex('visual.hairStyle.sheen', v.hairStyle.sheen);
    }
  }
  if (v.glassesStyle !== undefined) {
    if (!isObj(v.glassesStyle)) errors.push('visual.glassesStyle must be an object');
    else {
      if (v.glasses !== true) errors.push('visual.glassesStyle requires visual.glasses true');
      oneOf('visual.glassesStyle.shape', v.glassesStyle.shape, GLASSES_SHAPES);
      hex('visual.glassesStyle.frame', v.glassesStyle.frame);
      oneOf('visual.glassesStyle.finish', v.glassesStyle.finish, GLASSES_FINISHES);
      oneOf('visual.glassesStyle.thickness', v.glassesStyle.thickness, GLASSES_THICKNESSES);
    }
  }
  if (v.wardrobe !== undefined) {
    if (!isObj(v.wardrobe)) errors.push('visual.wardrobe must be an object');
    else { oneOf('visual.wardrobe.kind', v.wardrobe.kind, WARDROBE_KINDS); for (const k of ['jacket', 'shirt', 'tie']) hex(`visual.wardrobe.${k}`, v.wardrobe[k]); }
  }
}

function validateVariation(x, errors) {
  if (!isObj(x)) { errors.push('variation must be an object'); return; }
  for (const [key, list, required] of [['brows', BROW_STATES, 'neutral'], ['mouthShapes', MOUTH_SHAPES, 'closed']]) {
    const a = x[key];
    if (!Array.isArray(a) || a.length === 0) errors.push(`variation.${key} required`);
    else {
      for (const e of a) if (!list.includes(e)) errors.push(`variation.${key} has unknown value ${e}`);
      if (!a.includes(required)) errors.push(`variation.${key} must include ${required}`);
      if (new Set(a).size !== a.length) errors.push(`variation.${key} has duplicates`);
    }
  }
  const bl = x.blink;
  if (!isObj(bl)) errors.push('variation.blink required');
  else {
    if (!num(bl.minIntervalMs, 500, 20000)) errors.push('variation.blink.minIntervalMs out of range 500-20000');
    if (!num(bl.maxIntervalMs, 500, 20000)) errors.push('variation.blink.maxIntervalMs out of range 500-20000');
    else if (num(bl.minIntervalMs, 500, 20000) && bl.minIntervalMs > bl.maxIntervalMs) errors.push('variation.blink.minIntervalMs must not exceed maxIntervalMs');
    if (!num(bl.durationMs, 40, 500)) errors.push('variation.blink.durationMs out of range 40-500');
  }
  const hm = x.headMovement;
  if (!isObj(hm)) errors.push('variation.headMovement required');
  else for (const [k, hi] of [['maxYawDeg', 20], ['maxPitchDeg', 15], ['maxRollDeg', 10]]) if (!num(hm[k], 0, hi)) errors.push(`variation.headMovement.${k} out of range 0-${hi}`);
}

/**
 * Bibles that use none of the schema extensions are legacy: the validator never inspected their
 * continuity paths, so path checks are not applied to them (BIBLE_VERSION is unchanged and
 * previously valid persisted bibles must stay valid).
 */
function usesExtensions(b) {
  const v = b.visual;
  if (b.variation !== undefined || v?.archetype === 'swept') return true;
  return isObj(v) && ['face', 'eyes', 'brows', 'hairStyle', 'glassesStyle', 'wardrobe'].some((k) => v[k] !== undefined);
}

/** Extended bibles only: every continuity path must be a string that resolves, and may not be both immutable and variable. */
function validateContinuityPaths(b, errors) {
  const { immutable, allowedVariation: allowed } = b.continuity;
  if (allowed !== undefined && !Array.isArray(allowed)) { errors.push('continuity.allowedVariation must be an array'); return; }
  const strings = (list, name) => list.filter((p, i) => {
    if (typeof p === 'string' && p.length > 0) return true;
    errors.push(`continuity.${name}[${i}] must be a non-empty string path`);
    return false;
  });
  const imm = strings(immutable, 'immutable');
  const alw = strings(allowed ?? [], 'allowedVariation');
  for (const p of imm) if (getPath(b, p) === undefined) errors.push(`continuity.immutable path does not resolve: ${p}`);
  for (const p of alw) {
    if (getPath(b, p) === undefined) errors.push(`continuity.allowedVariation path does not resolve: ${p}`);
    if (imm.some((i) => i === p || p.startsWith(`${i}.`) || i.startsWith(`${p}.`))) errors.push(`continuity path is both immutable and variable: ${p}`);
  }
}

/** Continuity check: a candidate bible may only differ from the original in allowedVariation fields. */
export function continuityViolations(original, candidate) {
  const get = (o, p) => p.split('.').reduce((x, k) => x?.[k], o);
  return original.continuity.immutable.filter((p) => canonicalJson(get(original, p)) !== canonicalJson(get(candidate, p)));
}
