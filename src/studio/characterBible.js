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
  const id = `char_${createHash('sha256').update(canonicalJson({ ...body, id: undefined })).digest('hex').slice(0, 12)}`;
  return { id, ...body };
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
    if (!ARCHETYPES.includes(v.archetype)) errors.push(`unknown archetype ${v.archetype}`);
    for (const k of ['skin', 'hair', 'shirt', 'accent', 'trousers', 'shoes', 'curtain']) if (!HEX.test(v[k] ?? '')) errors.push(`visual.${k} must be #rrggbb`);
    for (const [k, lo, hi] of [['headRx', 100, 220], ['headRy', 120, 240], ['build', 110, 220]]) if (!(v[k] >= lo && v[k] <= hi)) errors.push(`visual.${k} out of range ${lo}-${hi}`);
    for (const k of ['glasses', 'beard']) if (typeof v[k] !== 'boolean') errors.push(`visual.${k} must be boolean`);
  }
  if (!b.personality?.worldview) errors.push('personality.worldview required');
  if (!Array.isArray(b.personality?.signatureBehaviours) || b.personality.signatureBehaviours.length === 0) errors.push('personality.signatureBehaviours required');
  if (!b.voice?.register) errors.push('voice.register required');
  if (b.voice && b.voice.provider !== null) errors.push('voice.provider must be null until a provider is authorised');
  if (!Array.isArray(b.continuity?.immutable) || b.continuity.immutable.length === 0) errors.push('continuity.immutable required');
  return { valid: errors.length === 0, errors };
}

/** Continuity check: a candidate bible may only differ from the original in allowedVariation fields. */
export function continuityViolations(original, candidate) {
  const get = (o, p) => p.split('.').reduce((x, k) => x?.[k], o);
  return original.continuity.immutable.filter((p) => canonicalJson(get(original, p)) !== canonicalJson(get(candidate, p)));
}
