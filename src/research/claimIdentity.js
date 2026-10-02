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

export const IDENTITY_VERSION = 'v2';

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
// (generate == produce: for a countable output such as "50 custom effects"
// the two assert the same proposition; both are inflection-normalized below.)
const PREDICATE_SYNONYMS = new Map([['launch', 'release'], ['generate', 'produce']]);

// Inflection table: ONLY regular/irregular inflected forms of a listed base
// verb map to that base (tense/number/aspect carry no propositional content
// here: polarity, modality and time are separate structured fields). This is
// an explicit whitelist, not a stemmer: an unlisted verb form must match
// exactly, so no two different verbs can ever be conflated by it.
const VERB_FORMS = [
  ['release', 'releases', 'released', 'releasing'],
  ['launch', 'launches', 'launched', 'launching'],
  ['acquire', 'acquires', 'acquired', 'acquiring'],
  ['announce', 'announces', 'announced', 'announcing'],
  ['report', 'reports', 'reported', 'reporting'],
  ['publish', 'publishes', 'published', 'publishing'],
  ['appoint', 'appoints', 'appointed', 'appointing'],
  ['hire', 'hires', 'hired', 'hiring'],
  ['raise', 'raises', 'raised', 'raising'],
  ['increase', 'increases', 'increased', 'increasing'],
  ['decrease', 'decreases', 'decreased', 'decreasing'],
  ['reduce', 'reduces', 'reduced', 'reducing'],
  ['open', 'opens', 'opened', 'opening'],
  ['close', 'closes', 'closed', 'closing'],
  ['approve', 'approves', 'approved', 'approving'],
  ['ban', 'bans', 'banned', 'banning'],
  ['sue', 'sues', 'sued', 'suing'],
  ['merge', 'merges', 'merged', 'merging'],
  ['invest', 'invests', 'invested', 'investing'],
  ['fund', 'funds', 'funded', 'funding'],
  ['ship', 'ships', 'shipped', 'shipping'],
  ['buy', 'buys', 'bought', 'buying'],
  ['sell', 'sells', 'sold', 'selling'],
  ['win', 'wins', 'won', 'winning'],
  ['lose', 'loses', 'lost', 'losing'],
  ['cut', 'cuts', 'cutting'],
  ['sign', 'signs', 'signed', 'signing'],
  ['employ', 'employs', 'employed', 'employing'],
  ['produce', 'produces', 'produced', 'producing'],
  ['generate', 'generates', 'generated', 'generating']
];
const VERB_BASE = new Map();
for (const [base, ...forms] of VERB_FORMS) {
  VERB_BASE.set(base, base);
  for (const f of forms) VERB_BASE.set(f, base);
}

// Scale words that may be written into the unit ("million USD", "USD billions").
const UNIT_SCALE = new Map([
  ['thousand', 1e3], ['thousands', 1e3], ['million', 1e6], ['millions', 1e6],
  ['billion', 1e9], ['billions', 1e9], ['trillion', 1e12], ['trillions', 1e12]
]);
const UNIT_SYNONYMS = new Map([
  ['$', 'usd'], ['us$', 'usd'], ['usd', 'usd'], ['us dollar', 'usd'], ['us dollars', 'usd'],
  ['u s dollar', 'usd'], ['u s dollars', 'usd'], ['united states dollar', 'usd'],
  ['united states dollars', 'usd'], ['dollar', 'usd'], ['dollars', 'usd'],
  ['%', 'percent'], ['pct', 'percent'], ['per cent', 'percent'], ['percent', 'percent']
]);
// Plural -> singular for unit nouns ("employees" -> "employee"). Words that
// merely end in s are left alone.
const NO_SINGULARIZE = /(?:ss|us|is|ics)$|^(?:news|series|species)$/;
const CORPORATE_SUFFIXES = new Set(['inc', 'incorporated', 'corp', 'corporation', 'ltd', 'limited', 'llc', 'llp', 'plc', 'co', 'gmbh']);
const LEADING_ARTICLES = new Set(['the', 'a', 'an']);

// "51.3 %" and "51.3%" are one spelling of the same percentage. "%" is kept
// (character class below) but "." is not, so without this the two normalize to
// ["51","3%"] vs ["51","3","%"]: a claim and its own identity that differ only in
// that whitespace fail grounding, the relative-negation accounting and the
// fingerprint. Exactly: an ASCII digit, whitespace, then "%" -> digit + "%".
// It runs after NFKD (so NBSP / thin spaces are already whitespace and a
// fullwidth "％" is already "%") and BEFORE punctuation is stripped, so only a
// literal digit<whitespace>"%" adjacency matches ("5 1.3%", "%51.3", "51.3 percent",
// "51.3 pct", "51.3 per cent" and "$" are untouched). Applied here, the one helper
// every grounding token, canonical identity field and haystack comparison goes
// through, so all of them stay consistent with each other.
const DIGIT_SPACE_PERCENT = /(\d)\s+%/g;

function normText(value) {
  if (typeof value !== 'string') return '';
  return value
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(DIGIT_SPACE_PERCENT, '$1%')
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}%$\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normEntity(value) {
  // Possessive marker is presentation, not identity ("Acme's" == "Acme").
  const stripped = typeof value === 'string' ? value.replace(/['\u2019]s\b/gi, '') : value;
  const tokens = normText(stripped).split(' ').filter(Boolean);
  if (tokens.length > 1 && LEADING_ARTICLES.has(tokens[0])) tokens.shift();
  while (tokens.length > 1 && CORPORATE_SUFFIXES.has(tokens[tokens.length - 1])) tokens.pop();
  return tokens.join(' ');
}

// Qualifiers: same surface normalization, plus a leading article/"in" is
// presentation ("in Europe" == "Europe").
// A per-day frequency written as "daily", "per/each/every/a day" or
// "in/within a/one (single) day" is one qualifier. Whole-qualifier match only:
// a bare "one day" (which can mean "someday") and anything with extra words
// ("in one day of testing") are left exactly as written.
const DAY_FREQUENCY = /^(?:daily|(?:per|each|every|a) day|(?:in|within) (?:a|one)(?: single)? day)$/;

function normQualifier(value) {
  // Possessive marker is presentation, not identity (same rule as normEntity and
  // groundingTokens): normText would otherwise leave a stray "s" token
  // ("Zapier's" -> "zapier s") that the claim-side grounding tokens never contain.
  const text = normText(typeof value === 'string' ? value.replace(/['\u2019]s\b/gi, '') : value);
  if (DAY_FREQUENCY.test(text)) return 'per day';
  const tokens = text.split(' ').filter(Boolean);
  while (tokens.length > 1 && (LEADING_ARTICLES.has(tokens[0]) || tokens[0] === 'in')) tokens.shift();
  return tokens.join(' ');
}

function normPredicate(value) {
  const text = normText(value);
  const base = VERB_BASE.get(text) ?? text;
  return PREDICATE_SYNONYMS.get(base) ?? base;
}

// Returns { unit, multiplier } where a scale word inside the unit is folded
// into a multiplier for the quantity ("million USD" -> usd, x1e6).
function normUnit(value) {
  let tokens = normText(value).split(' ').filter(Boolean);
  let multiplier = 1;
  if (tokens.length > 1 && UNIT_SCALE.has(tokens[0])) multiplier = UNIT_SCALE.get(tokens.shift());
  else if (tokens.length > 1 && UNIT_SCALE.has(tokens[tokens.length - 1])) multiplier = UNIT_SCALE.get(tokens.pop());
  let text = tokens.join(' ');
  if (UNIT_SYNONYMS.has(text)) return { unit: UNIT_SYNONYMS.get(text), multiplier };
  if (tokens.length > 0) {
    const last = tokens[tokens.length - 1];
    if (last.length > 3 && last.endsWith('ies')) tokens[tokens.length - 1] = `${last.slice(0, -3)}y`;
    else if (last.length > 3 && last.endsWith('s') && !NO_SINGULARIZE.test(last)) tokens[tokens.length - 1] = last.slice(0, -1);
    text = tokens.join(' ');
  }
  return { unit: text, multiplier };
}

const MONTHS_ALL = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const MONTH_LOOKUP = new Map();
MONTHS_ALL.forEach((m, i) => {
  MONTH_LOOKUP.set(m, i + 1);
  MONTH_LOOKUP.set(m.slice(0, 3), i + 1);
});
MONTH_LOOKUP.set('sept', 9);
const ORDINAL_WORD = new Map([['first', 1], ['second', 2], ['third', 3], ['fourth', 4]]);
const MONTH_NAMES = '(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept|sep|oct|nov|dec)';

function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

// Canonical ISO string for one supported spelling, or null. Every accepted
// form has a single unambiguous reading; day/month-numeric forms such as
// "03/04/2026" (ambiguous between D/M and M/D) are deliberately NOT accepted.
function canonicalTime(raw) {
  const t = raw.trim().replace(/\s+/g, ' ').replace(/\.$/, '');
  const lower = t.toLowerCase();
  let m;
  const ymd = (y, mo, d) => {
    const year = Number(y); const month = Number(mo); const day = Number(d);
    if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return null;
    return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  };
  const ym = (y, mo) => {
    const month = Number(mo);
    if (month < 1 || month > 12) return null;
    return `${y}-${String(month).padStart(2, '0')}`;
  };

  if ((m = t.match(/^(\d{4})$/))) return m[1];
  if ((m = t.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/))) return ymd(m[1], m[2], m[3]);
  if ((m = t.match(/^(\d{4})[-/](\d{1,2})$/))) return ym(m[1], m[2]);
  if ((m = lower.match(/^(\d{4})[- ]?q([1-4])$/))) return `${m[1]}-Q${m[2]}`;
  if ((m = lower.match(/^q([1-4])[ ,]*(\d{4})$/))) return `${m[2]}-Q${m[1]}`;
  if ((m = lower.match(/^([1-4])q ?(\d{4})$/))) return `${m[2]}-Q${m[1]}`;
  if ((m = lower.match(/^(first|second|third|fourth) quarter(?: of)?,? (\d{4})$/))) return `${m[2]}-Q${ORDINAL_WORD.get(m[1])}`;
  if ((m = lower.match(/^(\d{4})[- ]?h([12])$/))) return `${m[1]}-H${m[2]}`;
  if ((m = lower.match(/^h([12])[ ,]*(\d{4})$/))) return `${m[2]}-H${m[1]}`;
  if ((m = lower.match(/^(first|second) half(?: of)?,? (\d{4})$/))) return `${m[2]}-H${ORDINAL_WORD.get(m[1])}`;
  if ((m = lower.match(new RegExp(`^${MONTH_NAMES},? (\\d{4})$`)))) return ym(m[2], MONTH_LOOKUP.get(m[1]));
  if ((m = lower.match(new RegExp(`^${MONTH_NAMES} (\\d{1,2})(?:st|nd|rd|th)?,? (\\d{4})$`)))) return ymd(m[3], MONTH_LOOKUP.get(m[1]), m[2]);
  if ((m = lower.match(new RegExp(`^(\\d{1,2})(?:st|nd|rd|th)?(?: of)? ${MONTH_NAMES},? (\\d{4})$`)))) return ymd(m[3], MONTH_LOOKUP.get(m[2]), m[1]);
  return null;
}

const TIME_RE = /^(\d{4})(?:-(0[1-9]|1[0-2])(?:-(0[1-9]|[12]\d|3[01]))?|-Q([1-4])|-H([12]))?$/;

function parseTime(value) {
  if (typeof value !== 'string') return null;
  const canonical = canonicalTime(value);
  if (!canonical) return null;
  const m = canonical.match(TIME_RE);
  if (!m) return null;
  return {
    normalized: canonical,
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
    qualifiers = [...new Set(raw.qualifiers.map(normQualifier).filter(Boolean))].sort();
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
    const u = normUnit(raw.unit);
    if (!u.unit) return { ok: false, reason: 'identity_unit_missing' };
    unit = u.unit;
    // Fold a scale word written into the unit into the number; round away
    // binary floating-point noise (1.1 * 1e9) so equal amounts compare equal.
    quantity = u.multiplier === 1 ? raw.quantity : Number((raw.quantity * u.multiplier).toPrecision(12));
  } else if (raw.unit !== null && raw.unit !== undefined && normUnit(raw.unit).unit) {
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
const MODALITY_CUE = /\b(?:plan(?:s|ned|ning)?|will|would|expect(?:s|ed|ing)?|could|might|possibly|potentially|likely|unlikely|estimat(?:e|es|ed|ing)|approximately|roughly|nearly|almost|forecast(?:s|ed)?|project(?:s|ed|ion)?|announc(?:e|es|ed|ing)|propos(?:e|es|ed)|intend(?:s|ed)?|aims?|reportedly|allegedly|rumou?red|up\s+to|as\s+(?:many|much)\s+as|more\s+than|less\s+than|at\s+least|at\s+most)\b/i;
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

// A negation inside a temporal/conditional subordinate clause ("...when you
// aren't actively working with it") qualifies WHEN the proposition holds; it
// does not negate the proposition. Without this, a correctly AFFIRMED claim
// could only pass the polarity veto if the model mislabelled it NEGATED.
// Only clauses introduced by when/whenever/while/if are removed, and only up
// to the next comma/semicolon/period (a leading clause needs its comma), so
// negation in the main clause is still detected and the veto stays two-way.
const TRAILING_CONDITION_CLAUSE = /(?<=\S)\s+(?:even\s+)?(?:when(?:ever)?|while|if)\b[^,;.]*/gi;
const LEADING_CONDITION_CLAUSE = /^\s*(?:even\s+)?(?:when(?:ever)?|while|if)\b[^,;]*,/i;
function stripConditionClauses(text) {
  return text.replace(LEADING_CONDITION_CLAUSE, ' ').replace(TRAILING_CONDITION_CLAUSE, ' ');
}

// A negation that is the first word of a SUBJECT relative clause
// ("tools that can't send messages") restricts which tools are meant; it does
// not negate the main proposition. This is distinguishable from a
// complementizer ("announced that it can't ship"), because a relative pronoun
// acting as the clause subject is followed DIRECTLY by the negated auxiliary,
// whereas a complementizer "that" is always followed by its own subject first.
// The negation is only set aside when the identity itself carries the negated
// restriction (its words are in subject/object/qualifiers, together with a
// negation marker), so the fingerprint still distinguishes "tools that can't
// send" from plain "tools". Otherwise it stays a negation and the two-way
// polarity veto applies exactly as before. Only the negated auxiliary is
// removed; the rest of the text is still scanned for other negations.
const AUX_NEG = "(?:can['\\u2019]t|couldn['\\u2019]t|won['\\u2019]t|wouldn['\\u2019]t|shouldn['\\u2019]t|don['\\u2019]t|doesn['\\u2019]t|didn['\\u2019]t|isn['\\u2019]t|aren['\\u2019]t|wasn['\\u2019]t|weren['\\u2019]t|hasn['\\u2019]t|haven['\\u2019]t|hadn['\\u2019]t|mustn['\\u2019]t|cannot|(?:can|could|do|does|did|is|are|was|were|will|would|should|has|have|had|must|may|might)\\s+not)";
const RELATIVE_NEGATION = new RegExp(`\\b(?:that|which|who)\\s+${AUX_NEG}(?![\\p{L}\\p{N}])`, 'giu');
const NEGATION_IN_HAY = /\b(?:not|no|never|none|cannot|without|unable|non|t)\b/;

function stripAccountedRelativeNegation(text, hay) {
  if (!NEGATION_IN_HAY.test(hay)) return text;
  const hayTokens = new Set(hay.split(' ').filter(Boolean));
  let out = text;
  for (const m of [...text.matchAll(RELATIVE_NEGATION)].reverse()) {
    const start = m.index;
    const end = start + m[0].length;
    let tail = text.slice(end).split(/[,;.]/)[0];
    const next = tail.search(NEGATION_CUE);
    if (next >= 0) tail = tail.slice(0, next);
    const tokens = normText(tail).split(' ').filter(Boolean);
    if (tokens.length === 0 || !tokens.every((t) => hayTokens.has(t))) continue;
    out = `${out.slice(0, start)} ${out.slice(end)}`;
  }
  return out;
}

function identityHaystack(identity) {
  return [identity.subject, identity.object, ...identity.qualifiers].filter(Boolean).join(' ');
}

// ---- Identity coverage (compound claims) --------------------------------
// A trusted fingerprint must describe the WHOLE claim. These checks look for
// deterministic evidence that the text asserts more than one proposition and
// that a single identity (one predicate, one polarity, one modality) cannot
// represent all of them. They use only the existing verb vocabulary
// (VERB_BASE / normPredicate); no verb or synonym is added, and the identity's
// own subject/object/qualifier words are deliberately NOT consulted, so
// copying a second event into object/qualifiers cannot hide it. Lexical only,
// fail-closed (can only make an identity untrusted), never a general compound
// detector: a plain "and", "but", comma, list, appositive or purpose phrase
// is not by itself evidence of anything.
const VERB_KIND = new Map(); // surface form -> 'base' | 'past' | 'sg' | 'ing'
for (const [base, ...forms] of VERB_FORMS) {
  // Table layout: [base, 3sg, past(/participle)?, -ing]; "cut" has no distinct past.
  const kinds = forms.length === 3 ? ['sg', 'past', 'ing'] : ['sg', 'ing'];
  if (!VERB_KIND.has(base)) VERB_KIND.set(base, 'base');
  forms.forEach((f, i) => { if (!VERB_KIND.has(f)) VERB_KIND.set(f, kinds[i]); });
}
const COVERAGE_ADVERBS = '(?:(?:also|already|subsequently|later|just|now|previously|since|not|never|yet|still)\\s+)*';
const VERB_ALT = [...VERB_KIND.keys()].sort((a, b) => b.length - a.length).join('|');
const BE_HAVE_PAST = new RegExp(`\\b(?:was|were|is|are|been|be|being|has|have|had)\\s+${COVERAGE_ADVERBS}(${VERB_ALT})\\b`, 'g');
const AFTER_BOUNDARY = new RegExp(`(?:^|\\b(?:and|but|yet|then)\\b|;)\\s*${COVERAGE_ADVERBS}(${VERB_ALT})\\b`, 'g');
const AFTER_BOUNDARY_MODAL = new RegExp(`(?:\\b(?:and|but|yet|then)\\b|;)\\s*(?:will|would|can|could|may|might|should|must)\\s+${COVERAGE_ADVERBS}(${VERB_ALT})\\b`, 'g');
// Explicit sequencing ("then expanded"): the following -ed word is a second
// event even when it is not in the verb table (e.g. "expanded"). Only the
// "then" connector qualifies, never a bare "and".
const THEN_SEQUENCE = new RegExp(`\\bthen\\s+${COVERAGE_ADVERBS}([a-z]{3,}ed)\\b`, 'g');

function coverageText(text) {
  return stripConditionClauses(String(text)).toLowerCase().replace(/[\u2019]/g, "'").replace(/,/g, ' , ').replace(/[^a-z0-9';,\s-]+/g, ' ').replace(/\s+/g, ' ');
}

// Subordinate material is not an independently asserted top-level event.
// Verbs inside a content clause ("announced that Argon was released"), a
// relative clause (", which Google said was advanced,") or an adverbial
// subordinate clause ("after Google announced it") are masked BEFORE event
// detection. A masked span runs to the next hard top-level boundary (";",
// but/yet, then, or "and" + auxiliary), or, for a comma-delimited relative
// clause, to its closing comma. The boundary itself is left in place, so
// "announced that Argon launched, then expanded testing" still exposes the
// "then" event. Bare "and" and bare commas never end a masked span, so
// "announced that X was released and opened" stays one proposition.
// "to" (purpose/infinitive) is not a boundary and base verbs after it are
// never counted; -ing forms are never counted.
const SUBORDINATE_START = /,\s*(?:which|who|whom|whose)\b|\b(?:that|which|who|whom|whose|after|before|because|although|though|until|whereas)\b/g;
const HARD_BOUNDARY = /;|,?\s*\b(?:but|yet)\b|,?\s*(?:and\s+)?\bthen\b|\band\s+(?:also\s+|already\s+)*(?=(?:has|have|had|is|are|was|were|will|would|does|do|did|can|could)\b)/g;

function maskSubordinate(t) {
  let out = '';
  let pos = 0;
  SUBORDINATE_START.lastIndex = 0;
  for (;;) {
    SUBORDINATE_START.lastIndex = pos;
    const m = SUBORDINATE_START.exec(t);
    if (!m) break;
    const from = m.index;
    const bodyStart = from + m[0].length;
    let end = t.length;
    HARD_BOUNDARY.lastIndex = bodyStart;
    const hb = HARD_BOUNDARY.exec(t);
    if (hb) end = hb.index;
    if (m[0].startsWith(',')) {
      const comma = t.indexOf(',', bodyStart);
      if (comma >= 0 && comma < end) end = comma + 1;
    }
    out += `${t.slice(pos, from)} _ `;
    pos = end;
  }
  return out + t.slice(pos);
}

/** Distinct event labels asserted in verbal position (normalized predicate, or "then:<word>"). */
export function recognizedEvents(claimText) {
  const t = ` ${maskSubordinate(coverageText(claimText))}`;
  const events = new Set();
  const add = (form, allowed) => {
    const kind = VERB_KIND.get(form);
    if (kind && allowed.includes(kind)) events.add(normPredicate(form));
  };
  for (const m of t.matchAll(BE_HAVE_PAST)) add(m[1], ['past']);
  for (const m of t.matchAll(AFTER_BOUNDARY)) add(m[1], ['past', 'sg']);
  for (const m of t.matchAll(AFTER_BOUNDARY_MODAL)) add(m[1], ['base']);
  for (const m of t.matchAll(THEN_SEQUENCE)) {
    if (VERB_KIND.has(m[1])) add(m[1], ['past']);
    else events.add(`then:${m[1]}`);
  }
  return events;
}

const CLAUSE_BOUNDARY = /;|\s+(?:but|yet)\s+|,?\s+(?:and\s+)?then\s+|\s+and\s+(?:also\s+|already\s+)*(?=(?:has|have|had|is|are|was|were|will|would|does|do|did|can|could)\b)/gi;

function compoundTextConflict(claimText, identity, hay) {
  // (1) Event coverage: any recognized event other than the identity's own predicate.
  for (const e of recognizedEvents(claimText)) {
    if (e !== identity.predicate) return 'compound_text_partial_identity';
  }
  // (2) Mixed polarity: clauses disagree on negation, so one polarity cannot represent the claim.
  const base = stripConditionClauses(String(claimText)).replace(/\bnot\s+only\b/gi, ' ');
  const clauses = base.split(CLAUSE_BOUNDARY).filter((c) => c && c.trim());
  if (clauses.length > 1) {
    const flags = new Set(clauses.map((c) => NEGATION_CUE.test(stripAccountedRelativeNegation(c, normText(hay)))));
    if (flags.size > 1) return 'compound_text_mixed_polarity';
  }
  return null;
}

/**
 * Returns null if the claim text is consistent with the identity, else a
 * short machine reason. Pure and deterministic.
 */
export function identityTextConflict(claimText, identity, timeParts) {
  const text = String(claimText);
  const hay = identityHaystack(identity);

  // Negation: text with a negation cue must be NEGATED; NEGATED must have a cue.
  const hasNegation = NEGATION_CUE.test(stripAccountedRelativeNegation(stripConditionClauses(text), normText(hay)));
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
    } else {
      // normText deliberately separates punctuation in entity/version fields
      // (e.g. "Gemini 3.5" becomes "gemini 3 5").  For a bare decimal only,
      // recognise that exact adjacent integer/fractional token pair without
      // changing quantity or scale accounting.
      const decimalParts = m[1].match(/^(\d+)\.(\d+)$/);
      const decimalEntityAccounted = decimalParts && new RegExp(`(?<!\\d)${decimalParts[1]}\\s+${decimalParts[2]}(?!\\d)`).test(hay);
      if (!accounted.has(n) && !(hasQuantity && nearlyEqual(n, identity.quantity)) && !decimalEntityAccounted) {
      return 'number_not_accounted';
      }
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

  // Last, so every existing reason keeps its precedence.
  return compoundTextConflict(text, identity, hay);
}

// ---- Grounding (text -> structure) ---------------------------------------
// The identity is LLM-proposed. A fingerprint is only issued when the
// components that say WHO / WHAT / WHEN the claim is about actually appear in
// the claim's own wording: subject, object, qualifiers and the structured
// year. Predicate and relation are deliberately NOT token-grounded (a
// legitimate rewording such as "won" / "captured the title" must still
// converge). Pure, deterministic token-sequence matching only: no similarity,
// no stemming beyond a trailing plural "s". It can only make an identity
// untrusted (fingerprint => null); it never decides two claims are equal.
const DAY_FREQUENCY_IN_TEXT = /\b(?:daily|(?:per|each|every|a) day|(?:in|within) (?:a|one)(?: single)? day|one day)\b/;

function groundingTokens(value) {
  return normText(typeof value === 'string' ? value.replace(/['\u2019]s\b/gi, '') : value)
    .split(' ').filter(Boolean)
    .map((t) => (t.length > 3 && t.endsWith('s') && !NO_SINGULARIZE.test(t) ? t.slice(0, -1) : t));
}

function containsTokenSequence(haystackTokens, needleTokens) {
  if (needleTokens.length === 0) return true;
  for (let i = 0; i + needleTokens.length <= haystackTokens.length; i += 1) {
    if (needleTokens.every((t, j) => haystackTokens[i + j] === t)) return true;
  }
  return false;
}

/**
 * Returns null if every load-bearing identity component is grounded in the
 * claim text, else a short machine reason.
 */
export function identityGroundingConflict(claimText, identity, timeParts) {
  const textTokens = groundingTokens(String(claimText));
  if (!containsTokenSequence(textTokens, groundingTokens(identity.subject))) return 'subject_not_grounded';
  if (identity.object && !containsTokenSequence(textTokens, groundingTokens(identity.object))) return 'object_not_grounded';
  for (const q of identity.qualifiers) {
    if (q === 'per day') {
      if (!DAY_FREQUENCY_IN_TEXT.test(normText(String(claimText)))) return 'qualifier_not_grounded';
    } else if (!containsTokenSequence(textTokens, groundingTokens(q))) {
      return 'qualifier_not_grounded';
    }
  }
  if (identity.time !== null) {
    const year = timeParts?.year;
    if (year === null || year === undefined || !textTokens.includes(String(year))) return 'time_year_not_grounded';
  }
  return null;
}

// ---- Publication-date year grounding -------------------------------------
// A month-only claim ("... in March.") names no year, so `time_year_not_grounded`
// normally fails it closed. A TRUSTED publication date may vouch for the year,
// and ONLY for that one check: every other veto and grounding rule still
// applies first. Every rule below can only reject (fail closed); a resolved
// year is the publication year, never a guess. Pure and deterministic.

// A publication date is trusted only when the provider's own metadata is an
// unambiguous publication date. GDELT `seendate` is a crawl/seen time, not a
// publication time, and is never trusted; DuckDuckGo supplies no date at all.
const TRUSTED_DATE_PROVIDERS = new Set(['tavily', 'google-news-rss']);
const DATELESS_PROVIDERS = new Set(['duckduckgo']);
export const MAX_PUBLICATION_GAP_MONTHS = 3;

// Accepts a single provider id or the production composite
// "<primary>+<fallback>-fallback". Every component must be a known provider
// (so any composite containing gdelt, or an unknown id, is rejected) and at
// least one must be a trusted date source.
function isTrustedDateProvider(providerId) {
  if (typeof providerId !== 'string' || providerId === '') return false;
  const parts = providerId.split('+').map((p) => p.replace(/-fallback$/, ''));
  if (!parts.every((p) => TRUSTED_DATE_PROVIDERS.has(p) || DATELESS_PROVIDERS.has(p))) return false;
  return parts.some((p) => TRUSTED_DATE_PROVIDERS.has(p));
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const ISO_DATETIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;
const RFC822_DATE = /^(?:(Mon|Tue|Wed|Thu|Fri|Sat|Sun), )?(\d{1,2}) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{4}) (\d{2}):(\d{2})(?::(\d{2}))? (GMT|UTC|UT|Z|[+-]\d{4})$/;
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const RFC822_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function zoneOffsetMinutes(zone) {
  if (['Z', 'GMT', 'UTC', 'UT'].includes(zone)) return 0;
  const m = zone.match(/^([+-])(\d{2}):?(\d{2})$/);
  if (!m || Number(m[2]) > 23 || Number(m[3]) > 59) return null;
  return (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]));
}

// -> { year, month } or null. Only the three shapes the trusted providers
// emit are accepted (ISO date, ISO datetime WITH a zone, RFC-822 with a
// GMT/UT/UTC or numeric zone). A timestamp whose zone offset puts it in a
// different calendar month than its written date is ambiguous and rejected.
function parsePublicationDate(raw) {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  let year; let month; let day; let hour = 0; let minute = 0; let second = 0; let offset = 0; let weekday = null;
  let m;
  if ((m = s.match(ISO_DATE))) {
    [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  } else if ((m = s.match(ISO_DATETIME))) {
    [year, month, day, hour, minute, second] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6] ?? 0)];
    offset = zoneOffsetMinutes(m[7]);
  } else if ((m = s.match(RFC822_DATE))) {
    weekday = m[1] ?? null;
    [day, year, hour, minute, second] = [Number(m[2]), Number(m[4]), Number(m[5]), Number(m[6]), Number(m[7] ?? 0)];
    month = RFC822_MONTHS.indexOf(m[3]) + 1;
    offset = zoneOffsetMinutes(m[8]);
  } else {
    return null;
  }
  if (offset === null || month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return null;
  if (hour > 23 || minute > 59 || second > 59) return null;
  if (weekday && WEEKDAYS[new Date(Date.UTC(year, month - 1, day)).getUTCDay()] !== weekday) return null;
  const utc = new Date(Date.UTC(year, month - 1, day, hour, minute, second) - offset * 60000);
  if (utc.getUTCFullYear() !== year || utc.getUTCMonth() + 1 !== month) return null;
  return { year, month };
}

// Relative / scoping / recurring wording anywhere in the claim means "March"
// may not be the single plain calendar month it appears to be.
const SCOPING_WORDING = /\b(?:last|next|this|previous|prior|past|ago|annual|annually|yearly|every|each|since|until|till|by|early|late|mid|earlier|later|recent|recently|upcoming|current|currently|weekly|monthly|quarterly|anniversary|season|seasonal|per|before|after|between|throughout|during|within)\b/i;
const FULL_MONTH_NAME = /\b(january|february|march|april|june|july|august|september|october|november|december)\b/gi;
const ABBREVIATED_MONTH = /\b(?:jan|feb|mar|apr|jun|jul|aug|sept?|oct|nov|dec)\b/i;

/**
 * Resolves the missing year of a month-only claim from a trusted publication
 * date. Returns { ok:true, year } or { ok:false, reason }. It never reads the
 * LLM-proposed year to decide anything except to REJECT a disagreement.
 *
 * @param {string} claimText
 * @param {{modality:string}} identity
 * @param {{year:number|null, month:number|null, day:number|null, quarter:number|null, half:number|null}|null} timeParts
 * @param {{providerId?:string, publishedAt?:string}|null} context
 */
export function resolvePublicationYear(claimText, identity, timeParts, context) {
  const fail = (reason) => ({ ok: false, reason });
  const text = String(claimText);

  if (identity?.modality !== IDENTITY_MODALITY.OCCURRED && identity?.modality !== IDENTITY_MODALITY.ANNOUNCED) return fail('modality_not_past');
  if (!timeParts || timeParts.month === null || timeParts.day !== null || timeParts.quarter !== null || timeParts.half !== null) {
    return fail('time_not_month_level');
  }
  if (/\b\d{4}\b/.test(text)) return fail('claim_names_year');
  // "may" is a modal verb or an unprovable month: never resolved.
  if (/\bmay\b/i.test(text)) return fail('may_unresolvable');
  if (SCOPING_WORDING.test(text)) return fail('relative_or_scoping_wording');
  if (ABBREVIATED_MONTH.test(text)) return fail('month_abbreviated');

  const monthNames = [...text.matchAll(FULL_MONTH_NAME)].map((m) => m[1].toLowerCase());
  if (monthNames.length !== 1) return fail('claimed_month_not_unique');
  // The month must be written as a plain "in <Month>" and nothing else.
  if (!new RegExp(`\\bin ${monthNames[0]}(?![\\p{L}\\p{N}'\\u2019-])`, 'iu').test(text)) return fail('month_wording_not_plain');
  const claimedMonth = MONTHS.indexOf(monthNames[0]) + 1;
  if (claimedMonth !== timeParts.month) return fail('claimed_month_mismatch');

  if (!context || typeof context !== 'object' || !isTrustedDateProvider(context.providerId)) return fail('provider_not_trusted');
  const published = parsePublicationDate(context.publishedAt);
  if (!published) return fail('publication_date_invalid');
  // Same calendar year only, and strictly after the claimed month.
  if (published.month <= claimedMonth) return fail('publication_not_after_claimed_month');
  if (published.month - claimedMonth > MAX_PUBLICATION_GAP_MONTHS) return fail('publication_gap_too_large');
  if (timeParts.year !== published.year) return fail('proposed_year_mismatch');
  return { ok: true, year: published.year };
}

/**
 * Derives the corroboration fingerprint for one extracted claim, or null.
 *
 * null (=> exact-normalized-text matching only, i.e. previous behavior) when:
 * the claim is not a FACT; there is no identity; the identity is
 * structurally invalid; it conflicts with the claim's own text; or its
 * subject / object / qualifiers / structured year are not grounded in that text.
 *
 * Optional `publicationContext` ({ providerId, publishedAt }) lets a trusted
 * publication date vouch for the year of a month-only claim, and nothing
 * else: it can only satisfy `time_year_not_grounded` (see
 * resolvePublicationYear). Omitted => behavior is exactly as before.
 *
 * @param {object} proposed
 * @param {{providerId?:string, publishedAt?:string}|null} [publicationContext]
 * @returns {{ fingerprint: string|null, reason: string|null, identity?: object }}
 */
export function deriveClaimIdentity(proposed, publicationContext = null) {
  if (!proposed || proposed.claim_type !== CLAIM_TYPE.FACT) return { fingerprint: null, reason: 'not_a_fact_claim' };
  const normalized = normalizeClaimIdentity(proposed.identity);
  if (!normalized.ok) return { fingerprint: null, reason: normalized.reason };
  const conflict = identityTextConflict(proposed.claim, normalized.identity, normalized.timeParts);
  // `identity` (the normalized structure) is returned for observability only,
  // including when the identity is untrusted, so a run can show WHY two claims
  // did or did not share a fingerprint. It never influences merging.
  if (conflict) return { fingerprint: null, reason: conflict, identity: normalized.identity };
  const ungrounded = identityGroundingConflict(proposed.claim, normalized.identity, normalized.timeParts);
  if (ungrounded) {
    // The year check is the last grounding check, so reaching it means
    // subject/object/qualifiers are already grounded. Only it may be
    // satisfied, and only by a resolved publication year.
    const resolved = ungrounded === 'time_year_not_grounded' && publicationContext
      ? resolvePublicationYear(proposed.claim, normalized.identity, normalized.timeParts, publicationContext)
      : null;
    if (!resolved?.ok) {
      // An abbreviated month ("Mar.") is a month the veto above cannot account for.
      const reason = resolved?.reason === 'month_abbreviated' ? 'month_not_accounted' : ungrounded;
      return { fingerprint: null, reason, identity: normalized.identity };
    }
  }

  const i = normalized.identity;
  // Fixed key order => byte-stable canonical form.
  const canonical = JSON.stringify([
    IDENTITY_VERSION, i.subject, i.predicate, i.object, i.qualifiers, i.time,
    i.quantity, i.unit, i.polarity, i.modality, i.relation
  ]);
  return { fingerprint: crypto.createHash('sha256').update(canonical).digest('hex'), reason: null, identity: i };
}

/**
 * Deterministic, metadata-only summary of structured-identity coverage for
 * one extraction result (used for the existing CLAIM_EXTRACTION/EXTRACTED
 * decision row; no claim text or model output is included). It only reports
 * what deriveClaimIdentity already decided -- it changes no behavior.
 *
 * Buckets for FACT claims without a fingerprint:
 *   missing      -- no identity object at all
 *   malformed    -- identity present but structurally invalid (identity_* reasons)
 *   inconsistent -- structurally valid but disagrees with its own claim text
 * `reasons` carries the exact machine reason counts.
 *
 * @param {Array<{claim, claim_type, identity}>} claims
 * @param {{providerId?:string, publishedAt?:string}|null} [publicationContext] same optional context as deriveClaimIdentity
 * @returns {{ factClaims:number, fingerprinted:number, missing:number, malformed:number, inconsistent:number, reasons:Object<string,number> }}
 */
export function summarizeIdentityCoverage(claims, publicationContext = null) {
  const summary = { factClaims: 0, fingerprinted: 0, missing: 0, malformed: 0, inconsistent: 0, reasons: {} };
  for (const c of Array.isArray(claims) ? claims : []) {
    if (!c || c.claim_type !== CLAIM_TYPE.FACT || typeof c.claim !== 'string' || c.claim.trim() === '') continue;
    summary.factClaims += 1;
    const { fingerprint, reason } = deriveClaimIdentity(c, publicationContext);
    if (fingerprint) { summary.fingerprinted += 1; continue; }
    summary.reasons[reason] = (summary.reasons[reason] ?? 0) + 1;
    if (reason === 'identity_missing') summary.missing += 1;
    else if (reason.startsWith('identity_')) summary.malformed += 1;
    else summary.inconsistent += 1;
  }
  return summary;
}
