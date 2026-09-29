import crypto from 'node:crypto';
import { CLAIM_TYPE } from './constants.js';

/**
 * Structured claim identity for cross-source corroboration.
 *
 * The extraction LLM (same single call as before -- no extra API call) may
 * attach an `identity` object to a FACT claim describing WHAT proposition it
 * asserts, independent of wording. This module is deterministic Validation,
 * never Generation: it decides whether that structure is trustworthy enough
 * to derive a fingerprint from, and derives it.
 *
 * Two claims may share a claim row ONLY when their fingerprints are exactly
 * equal. There is no similarity threshold anywhere in this file. Every rule
 * here can only REMOVE the ability to merge (fail closed): a claim with no
 * identity, an invalid identity, or an identity that disagrees with its own
 * claim text gets fingerprint = null and falls back to the pre-existing
 * exact-normalized-text behavior. A missed merge costs some corroboration;
 * a false merge would corrupt evidence integrity, so every doubt resolves
 * to "keep separate".
 *
 * The human-readable claim text is never altered or replaced.
 */

export const IDENTITY_VERSION = 'v1';

export const IDENTITY_POLARITY = Object.freeze({ AFFIRMED: 'AFFIRMED', NEGATED: 'NEGATED' });
// OCCURRED = stated as having actually happened / being the case.
export const IDENTITY_MODALITY = Object.freeze({
  OCCURRED: 'OCCURRED', ANNOUNCED: 'ANNOUNCED', PLANNED: 'PLANNED', POSSIBLE: 'POSSIBLE', ESTIMATED: 'ESTIMATED'
});
export const IDENTITY_RELATION = Object.freeze({
  DESCRIPTIVE: 'DESCRIPTIVE', ASSOCIATIVE: 'ASSOCIATIVE', CAUSAL: 'CAUSAL'
});

const POLARITIES = Object.values(IDENTITY_POLARITY);
const MODALITIES = Object.values(IDENTITY_MODALITY);
const RELATIONS = Object.values(IDENTITY_RELATION);

// Deliberately tiny. Only equivalences that are unambiguous for the
// proposition itself. Anything not listed must match exactly.
// (announce != release: that distinction is materially different, so
// ANNOUNCE is intentionally NOT mapped to RELEASE.)
const PREDICATE_SYNONYMS = new Map([['launch', 'release']]);
const UNIT_SYNONYMS = new Map([
  ['$', 'usd'], ['us dollar', 'usd'], ['us dollars', 'usd'], ['dollar', 'usd'], ['dollars', 'usd'],
  ['%', 'percent'], ['pct', 'percent'], ['per cent', 'percent']
]);
const CORPORATE_SUFFIXES = new Set(['inc', 'incorporated', 'corp', 'corporation', 'ltd', 'limited', 'llc', 'plc']);

function normText(value) {
  if (typeof value !== 'string') return '';
  return value
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}%$\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normEntity(value) {
  const tokens = normText(value).split(' ').filter(Boolean);
  if (tokens[0] === 'the') tokens.shift();
  while (tokens.length > 1 && CORPORATE_SUFFIXES.has(tokens[tokens.length - 1])) tokens.pop();
  return tokens.join(' ');
}

function normPredicate(value) {
  const text = normText(value);
  return PREDICATE_SYNONYMS.get(text) ?? text;
}

function normUnit(value) {
  const text = normText(value);
  return UNIT_SYNONYMS.get(text) ?? text;
}

const TIME_RE = /^(\d{4})(?:-(0[1-9]|1[0-2])(?:-(0[1-9]|[12]\d|3[01]))?|-Q([1-4])|-H([12]))?$/;

function parseTime(value) {
  if (typeof value !== 'string') return null;
  const m = value.trim().match(TIME_RE);
  if (!m) return null;
  return {
    normalized: value.trim(),
    year: Number(m[1]),
    month: m[2] ? Number(m[2]) : null,
    day: m[3] ? Number(m[3]) : null,
    quarter: m[4] ? Number(m[4]) : null,
    half: m[5] ? Number(m[5]) : null
  };
}

const NUMBER_RE = /\d[\d,]*(?:\.\d+)?/g;

function numbersIn(text) {
  return (String(text).match(NUMBER_RE) || [])
    .map((t) => Number(t.replace(/,/g, '')))
    .filter((n) => Number.isFinite(n));
}

/**
 * Structural validation + normalization of an LLM-proposed identity object.
 * Returns { ok:true, identity } with every field normalized, or
 * { ok:false, reason }. No text is compared here.
 */
export function normalizeClaimIdentity(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, reason: 'identity_missing' };

  const subject = normEntity(raw.subject);
  const predicate = normPredicate(raw.predicate);
  if (!subject) return { ok: false, reason: 'identity_subject_missing' };
  if (!predicate) return { ok: false, reason: 'identity_predicate_missing' };

  if (!POLARITIES.includes(raw.polarity)) return { ok: false, reason: 'identity_polarity_invalid' };
  if (!MODALITIES.includes(raw.modality)) return { ok: false, reason: 'identity_modality_invalid' };
  if (!RELATIONS.includes(raw.relation)) return { ok: false, reason: 'identity_relation_invalid' };

  const object = raw.object === null || raw.object === undefined ? null : normEntity(raw.object) || null;

  let qualifiers = [];
  if (raw.qualifiers !== null && raw.qualifiers !== undefined) {
    if (!Array.isArray(raw.qualifiers) || raw.qualifiers.some((q) => typeof q !== 'string')) {
      return { ok: false, reason: 'identity_qualifiers_invalid' };
    }
    qualifiers = [...new Set(raw.qualifiers.map(normText).filter(Boolean))].sort();
  }

  let time = null;
  let timeParts = null;
  if (raw.time !== null && raw.time !== undefined) {
    timeParts = parseTime(raw.time);
    if (!timeParts) return { ok: false, reason: 'identity_time_invalid' };
    time = timeParts.normalized;
  }

  let quantity = null;
  let unit = null;
  if (raw.quantity !== null && raw.quantity !== undefined) {
    if (typeof raw.quantity !== 'number' || !Number.isFinite(raw.quantity)) return { ok: false, reason: 'identity_quantity_invalid' };
    quantity = raw.quantity;
    unit = normUnit(raw.unit);
    if (!unit) return { ok: false, reason: 'identity_unit_missing' };
  } else if (raw.unit !== null && raw.unit !== undefined && normUnit(raw.unit)) {
    return { ok: false, reason: 'identity_unit_without_quantity' };
  }

  return {
    ok: true,
    identity: {
      subject, predicate, object, qualifiers, time, quantity, unit,
      polarity: raw.polarity, modality: raw.modality, relation: raw.relation
    },
    timeParts
  };
}

// ---- Text-consistency vetoes -------------------------------------------
// The structured identity is LLM-proposed and therefore untrusted. These
// checks compare it against the claim's own text using cue lists. They are
// one-directional: they can only make an identity UNTRUSTED (=> no merge);
// they are never used to decide two claims ARE equal.

const NEGATION_CUE = /\b(?:not|no|never|none|neither|nor|cannot|without|unable|fail(?:s|ed|ing)?\s+to|den(?:y|ies|ied|ying)|refus(?:e|es|ed|ing))\b|n['\u2019]t\b/i;
const CAUSAL_CUE = /\b(?:caus(?:e|es|ed|ing)|because|led\s+to|leads?\s+to|leading\s+to|resulted?\s+in|result\s+of|due\s+to|driven\s+by|drove|drives?|driving|boost(?:ed|s)?|triggered?|thanks\s+to|owing\s+to|attributable\s+to|contribut(?:e|es|ed|ing)\s+to)\b/i;
const ASSOCIATIVE_CUE = /\b(?:associated\s+with|correlat(?:ed|es|ion)|linked\s+to|tied\s+to|related\s+to|coincid(?:ed|es|ing)\s+with)\b/i;
const MODALITY_CUE = /\b(?:plan(?:s|ned|ning)?|will|would|expect(?:s|ed|ing)?|could|might|possibly|potentially|likely|unlikely|estimat(?:e|es|ed|ing)|approximately|roughly|nearly|almost|forecast(?:s|ed)?|project(?:s|ed|ion)?|announc(?:e|es|ed|ing)|propos(?:e|es|ed)|intend(?:s|ed)?|aims?|reportedly|allegedly|rumou?red|up\s+to|more\s+than|less\s+than|at\s+least|at\s+most)\b/i;
// Lowercase "may" is the modal verb; capitalised "May" is handled as a month below.
const MODAL_MAY = /\bmay\b/;
const SPELLED_NUMBER = /\b(?:two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million|billion|trillion|dozen)\b/i;
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const MONTH_IN_TEXT = /\b(january|february|march|april|june|july|august|september|october|november|december)\b/gi;
const MAY_AS_MONTH = /\b(?:in|of|during|since|by|on|until|before|after|from|through|early|late|mid)[ -]May\b/;
const QUARTER_WORD = { first: 1, second: 2, third: 3, fourth: 4 };
const SCALE_SUFFIX = new Map([
  ['hundred', 1e2], ['thousand', 1e3], ['k', 1e3], ['million', 1e6], ['mm', 1e6], ['m', 1e6],
  ['billion', 1e9], ['bn', 1e9], ['b', 1e9], ['trillion', 1e12], ['t', 1e12]
]);
// A digit-number with an optional scale suffix written right after it.
const NUMBER_WITH_SCALE = /(\d[\d,]*(?:\.\d+)?)(?:\s*(hundred|thousand|million|billion|trillion|mm|bn|k|m|b|t)(?![a-z]))?/gi;
const nearlyEqual = (a, b) => Math.abs(a - b) <= Math.abs(b) * 1e-9;

function identityHaystack(identity) {
  return [identity.subject, identity.object, ...identity.qualifiers].filter(Boolean).join(' ');
}

/**
 * Returns null if the claim text is consistent with the identity, else a
 * short machine reason. Pure and deterministic.
 */
export function identityTextConflict(claimText, identity, timeParts) {
  const text = String(claimText);
  const hay = identityHaystack(identity);

  // Negation: text with a negation cue must be NEGATED; NEGATED must have a cue.
  const hasNegation = NEGATION_CUE.test(text);
  if (hasNegation !== (identity.polarity === IDENTITY_POLARITY.NEGATED)) return 'polarity_text_mismatch';

  // Causation / association cues in the text pin the relation.
  const causal = CAUSAL_CUE.test(text);
  const associative = ASSOCIATIVE_CUE.test(text);
  if (causal && associative) return 'relation_text_ambiguous';
  if (causal && identity.relation !== IDENTITY_RELATION.CAUSAL) return 'relation_text_mismatch';
  if (associative && identity.relation !== IDENTITY_RELATION.ASSOCIATIVE) return 'relation_text_mismatch';

  // Hedged / planned / estimated / bounded wording cannot be labelled OCCURRED.
  if ((MODALITY_CUE.test(text) || MODAL_MAY.test(text)) && identity.modality === IDENTITY_MODALITY.OCCURRED) return 'modality_text_mismatch';

  // Every digit-number in the text must be accounted for by the structure:
  // a number followed by a scale word/suffix ("1 billion", "$2B") must equal
  // the structured quantity at exactly THAT scale; a bare number must equal
  // the quantity or a number inside the structured fields (time components,
  // or digits in subject/object/qualifiers such as "Q3" or "GPT-5"). A
  // structure that drops or alters a number is untrusted.
  const accounted = new Set(numbersIn(hay));
  if (timeParts) {
    for (const part of [timeParts.year, timeParts.month, timeParts.day, timeParts.quarter, timeParts.half]) {
      if (part !== null) accounted.add(part);
    }
  }
  const hasQuantity = identity.quantity !== null;
  for (const m of text.matchAll(NUMBER_WITH_SCALE)) {
    const n = Number(m[1].replace(/,/g, ''));
    if (!Number.isFinite(n)) continue;
    if (m[2]) {
      if (!hasQuantity || !nearlyEqual(n * SCALE_SUFFIX.get(m[2].toLowerCase()), identity.quantity)) return 'number_not_accounted';
    } else if (!accounted.has(n) && !(hasQuantity && nearlyEqual(n, identity.quantity))) {
      return 'number_not_accounted';
    }
  }

  // Spelled-out numbers cannot be checked against the structure; only allow
  // them when the same word is inside the structured strings. (Scale words
  // directly after a digit-number were already verified above.)
  const withoutDigitScales = text.replace(new RegExp(NUMBER_WITH_SCALE.source, 'gi'), ' ');
  const spelled = withoutDigitScales.match(new RegExp(SPELLED_NUMBER.source, 'gi')) || [];
  if (spelled.some((w) => !hay.includes(w.toLowerCase()))) return 'spelled_number_unverifiable';

  // Month names must match the structured time (or be part of an entity name).
  const monthsInText = [...(text.match(MONTH_IN_TEXT) || []).map((m) => m.toLowerCase())];
  if (MAY_AS_MONTH.test(text)) monthsInText.push('may');
  for (const month of monthsInText) {
    const monthNumber = MONTHS.indexOf(month) + 1;
    if (!(timeParts && timeParts.month === monthNumber) && !hay.includes(month)) return 'month_not_accounted';
  }

  // Quarter wording must match a structured quarter.
  const quarters = [];
  for (const m of text.matchAll(/\b(first|second|third|fourth)\s+quarter\b/gi)) quarters.push(QUARTER_WORD[m[1].toLowerCase()]);
  for (const m of text.matchAll(/\bQ([1-4])\b/g)) quarters.push(Number(m[1]));
  for (const q of quarters) {
    if (!(timeParts && timeParts.quarter === q) && !hay.includes(`q${q}`)) return 'quarter_not_accounted';
  }

  return null;
}

/**
 * Derives the corroboration fingerprint for one extracted claim, or null.
 *
 * null (=> exact-normalized-text matching only, i.e. previous behavior) when:
 * the claim is not a FACT; there is no identity; the identity is
 * structurally invalid; or it conflicts with the claim's own text.
 *
 * @returns {{ fingerprint: string|null, reason: string|null }}
 */
export function deriveClaimIdentity(proposed) {
  if (!proposed || proposed.claim_type !== CLAIM_TYPE.FACT) return { fingerprint: null, reason: 'not_a_fact_claim' };
  const normalized = normalizeClaimIdentity(proposed.identity);
  if (!normalized.ok) return { fingerprint: null, reason: normalized.reason };
  const conflict = identityTextConflict(proposed.claim, normalized.identity, normalized.timeParts);
  if (conflict) return { fingerprint: null, reason: conflict };

  const i = normalized.identity;
  // Fixed key order => byte-stable canonical form.
  const canonical = JSON.stringify([
    IDENTITY_VERSION, i.subject, i.predicate, i.object, i.qualifiers, i.time,
    i.quantity, i.unit, i.polarity, i.modality, i.relation
  ]);
  return { fingerprint: crypto.createHash('sha256').update(canonical).digest('hex'), reason: null };
}
