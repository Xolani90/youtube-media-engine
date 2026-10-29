/**
 * Deterministic pre-download screen for stock-asset search hits (no ML, no network, no cost).
 *
 * Scope: Asset Provisioning only. It narrows WHICH of the hits the provider already received
 * is downloaded. It is not a rights, factual or safety verification: every accepted asset is
 * still persisted UNVERIFIED and goes through the unchanged rights gate. The screen can only
 * reject candidates, never promote one.
 *
 * Rules (a hit is rejected by the first that applies):
 *  1. duplicate_of_attached_asset  - its page URL is already attached to this content version.
 *  2. branded_or_ui_capture_tag:T  - its tags contain a brand/UI-capture term (logo, screenshot,
 *     browser, google, ...) that neither the scene text nor the query mentions. Such images are
 *     almost never what narration needs, and Pixabay's licence warns that recognisable marks may
 *     carry extra rights.
 *  2b. child_subject_tag:W        - its tags name a child subject (baby, infant, toddler, kid, child; explicit plurals
 *     folded) and the scene text / query does not AFFIRMATIVELY call for children. A child word that
 *     is negated ("not intended for children") is not evidence. Keyword heuristic, not semantics.
 *  2c. off_style_tag:T            - its tags mark a toy, figurine, cartoon/clip-art or AI-generated image (see
 *     OFF_STYLE_WORDS / OFF_STYLE_PHRASES), unless the scene text / query itself asks for that subject. These are the
 *     images that read as fake or off-topic in a documentary-style explainer (a toy cash register, Lego stormtroopers,
 *     a generated robot face). Keyword heuristic on tags, not semantics.
 *  3. no_tag_overlap_with_scene    - it has tags, and none shares a word with the query or the
 *     scene narration. (Weak by design: the provider already matched the query; this only removes
 *     hits that matched on something other than their subject.)
 * A hit with no tags passes rules 2-3 (nothing to judge) and is therefore not silently dropped.
 */
import { tokens } from './scenePlan.js';

export const BRANDED_UI_CAPTURE_TAGS = Object.freeze([
  'logo', 'logos', 'brand', 'branding', 'trademark', 'screenshot', 'screen shot', 'screen capture',
  'browser', 'web browser', 'website', 'web page', 'webpage', 'homepage', 'home page', 'search engine',
  'google', 'chrome', 'google chrome', 'facebook', 'twitter', 'instagram', 'youtube', 'tiktok',
  'microsoft', 'windows', 'apple', 'iphone', 'android', 'app icon', 'icon', 'icons', 'social media icons'
]);

// Off-style vocabulary. A tag WORD (exact surface form) or a tag PHRASE (substring) here marks an image whose
// subject is a toy, a figurine, a drawing or an AI-generated picture. The rule is skipped for any term the scene
// text or query itself contains, so a script ABOUT toys or AI art can still use them.
export const OFF_STYLE_WORDS = Object.freeze([
  'toy', 'toys', 'lego', 'legos', 'figurine', 'figurines', 'doll', 'dolls', 'puppet', 'puppets', 'plush', 'playmobil',
  'cartoon', 'cartoons', 'clipart', 'illustration', 'illustrations', 'vector', 'doodle', 'sketch', 'midjourney', 'dall-e', 'dalle'
]);
export const OFF_STYLE_PHRASES = Object.freeze([
  'ai generated', 'ai-generated', 'ai art', 'ai image', 'ai created', 'generative ai', 'generative art', 'stable diffusion',
  'digital art', 'digital painting', 'clip art', '3d render', '3d rendering', 'computer generated', 'toy figure', 'action figure'
]);

/*
 * Child-subject vocabulary (exact surface forms; no suffix stripping, so kidney/childhood/childish/babysitter/
 * infantry/kiddo never match).
 *  - CHILD_FORMS: the words that (a) mark a hit's TAG as a child subject and (b) count as child context in the
 *    scene text/query. Rationale: they name a child as the thing depicted/discussed.
 *  - CHILD_CONTEXT_EXTRA: words that count as child context ONLY (never as tags): pupil(s), preschool,
 *    kindergarten, newborn(s), schoolchild(ren), childcare, parenting. Rationale: they are child-centred
 *    settings/topics where child imagery is normally expected. 'pupil' can also mean the eye's pupil, so it can
 *    over-enable; 'nursery' is deliberately NOT listed (plant nursery).
 *  - NOT recognised, deliberately: parent(s), famil(y/ies), student(s), teen(s)/teenager(s), minor(s), youth,
 *    young people. They do not prove a child should appear in the image.
 * Enabling child imagery only stops THIS rule from rejecting; it is not evidence the image is relevant, and the
 * other rules (duplicate, branded/UI, tag overlap) still apply in full.
 */
// Explicit normalisation: only these surface forms are recognised (no generic suffix stripping).
const CHILD_FORMS = Object.freeze({
  baby: 'baby', babies: 'baby', infant: 'infant', infants: 'infant', toddler: 'toddler', toddlers: 'toddler',
  kid: 'kid', kids: 'kid', child: 'child', children: 'child'
});
const CHILD_CONTEXT_EXTRA = Object.freeze({
  pupil: 'pupil', pupils: 'pupil', preschool: 'preschool', kindergarten: 'kindergarten',
  newborn: 'newborn', newborns: 'newborn', schoolchild: 'schoolchild', schoolchildren: 'schoolchild',
  childcare: 'childcare', parenting: 'parenting'
});
const NEGATORS = Object.freeze(new Set([
  'not', 'no', 'never', 'without', 'nor', 'non', 'cannot', 'except', 'excluding', 'barring', 'unsuitable', 'unfit'
]));
const AUXILIARIES = Object.freeze(new Set([
  'is', 'are', 'was', 'were', 'can', 'could', 'may', 'might', 'must', 'should', 'will', 'would', 'shall', 'do', 'does', 'did'
]));
const NEGATION_WINDOW = 6;
// Prepositional negators ("without adults", "except on Sundays", "no adults") negate the phrase they directly govern, not
// everything after it. A child word reached across a NON-child phrase is therefore the start of a new clause, with or
// without a comma. Only these filler words may sit between such a negator and the child word it still negates.
const PREPOSITIONAL_NEGATORS = Object.freeze(new Set(['without', 'excluding', 'except', 'barring', 'no']));
const GOVERNED_FILLER = Object.freeze(new Set(['any', 'all', 'the', 'a', 'an', 'other', 'for', 'young', 'small', 'little']));
const CONTRAST_WORDS = Object.freeze(new Set(['but', 'rather', 'instead']));
const NOT_ONLY = Object.freeze(new Set(['only', 'just', 'merely', 'simply']));
const LIST_CONJUNCTIONS = Object.freeze(new Set(['and', 'or', 'nor']));
// A "soft" clause boundary inside one sentence: comma, parentheses, en/em dash, or a spaced hyphen.
const SOFT_BOUNDARY = /[,()\u2013\u2014]|\s-\s/;

const own = (o, k) => (Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined);
const isChildWord = (w) => own(CHILD_FORMS, w) !== undefined || own(CHILD_CONTEXT_EXTRA, w) !== undefined;
const isNegator = (words, j) => NEGATORS.has(words[j]) && !(words[j] === 'not' && NOT_ONLY.has(words[j + 1]));
// "X can't wait" / "X could not wait" / "X cannot wait" is the idiom for eager anticipation, so the child is the subject of an
// affirmative statement. Deliberately the ONLY exception to the [auxiliary] + negator rule: "can't attend/enter/use" stay negated.
const isCantWait = (words, seg, i) => {
  const k = (words[i + 1] === 'can' || words[i + 1] === 'could') && words[i + 2] === 'not' ? i + 3 : words[i + 1] === 'cannot' ? i + 2 : -1;
  return k > 0 && words[k] === 'wait' && seg[k] === seg[i];
};

/** Words of one sentence with the index of the soft-boundary segment each came from. */
function tokenizeSentence(sentence) {
  const norm = sentence.replace(/\bcan['\u2019]t\b/g, 'can not').replace(/\bwon['\u2019]t\b/g, 'will not').replace(/n['\u2019]t\b/g, ' not');
  const words = [];
  const seg = [];
  norm.split(SOFT_BOUNDARY).forEach((part, s) => {
    for (const w of part.match(/[a-z]+/g) ?? []) { words.push(w); seg.push(s); }
  });
  return { words, seg };
}

/**
 * True if text has a child-context word that is not negated. A mention is negated when
 *  - a negator occurs <= 6 words BEFORE it in the same sentence ("not intended for children"), stopping at
 *    but/rather/instead ("not for adults but for children" stays affirmative); or
 *  - it is directly followed, in the same comma-delimited segment, by [auxiliary] + negator
 *    ("Children are not the target audience"; but "Children, not adults, can participate" is affirmative).
 *    The one exception is the idiom "can't/cannot/could not wait" ("Children can't wait for the trip"): eager
 *    anticipation, so the child is the subject of an affirmative statement. "can't attend/enter/use" stay negated.
 * The backward look may cross a comma/parenthesis/dash only when the mention continues a LIST: the segment it
 * is leaving contains nothing but child words and and/or/nor ("not for adults, children or babies"), or the word
 * just before the comma is itself a child word ("not for children, babies or toddlers"). Otherwise the comma
 * starts a new clause, so "Without adults, children play here." is affirmative.
 * A PREPOSITIONAL negator (without, excluding, except, barring, no) negates only the phrase it directly governs:
 * it reaches a child word only across child words, and/or/nor and a few fillers (any, all, the, a, an, other, for,
 * young, small, little). Any other word in between means the child word starts a new clause, with or without a comma,
 * so "Without adults children play here." is affirmative exactly like the comma form (punctuation alone never decides).
 * Likewise a prepositional negator AFTER a child word ("Children without adults play here") does not negate it.
 * "not only/just/merely/simply" is never a negator. Sentences end at . ! ? ; : and newlines.
 * Keyword heuristic, not semantic understanding. Unavoidable ambiguity: "No adults, children or babies are
 * admitted" and "Without adults, children play here" have the same shape and are both read as affirmative; a
 * negated list led by a non-child word under a prepositional negator ("Without adults, children or babies.") is
 * therefore affirmative too, while the same list under 'not' ("Not for adults, children or babies.") is negated.
 * Contradictory text ("Children are not allowed. Children learn here.") is affirmative: ANY affirmative mention wins.
 */
export function mentionsChildrenAffirmatively(text) {
  for (const sentence of String(text ?? '').toLowerCase().split(/[.!?;:\r\n]+/)) {
    const { words, seg } = tokenizeSentence(sentence);
    const governedBy = (w) => isChildWord(w) || LIST_CONJUNCTIONS.has(w) || GOVERNED_FILLER.has(w);
    const segIsPureList = (s) => words.every((w, x) => seg[x] !== s || isChildWord(w) || LIST_CONJUNCTIONS.has(w));
    for (let i = 0; i < words.length; i++) {
      if (!isChildWord(words[i])) continue;
      let negated = false;
      for (let j = i - 1; j >= Math.max(0, i - NEGATION_WINDOW); j--) {
        if (CONTRAST_WORDS.has(words[j])) break;
        if (seg[j] !== seg[j + 1] && !isChildWord(words[j]) && !segIsPureList(seg[j + 1])) break; // new clause
        if (isNegator(words, j)) {
          // "Without adults children play here": 'without' governs "adults"; the child word starts a new clause.
          if (PREPOSITIONAL_NEGATORS.has(words[j]) && !words.slice(j + 1, i).every(governedBy)) break;
          negated = true;
          break;
        }
      }
      if (!negated && !isCantWait(words, seg, i)) {
        const k = AUXILIARIES.has(words[i + 1]) && seg[i + 1] === seg[i] ? i + 2 : i + 1;
        if (k < words.length && seg[k] === seg[i] && isNegator(words, k) && !(PREPOSITIONAL_NEGATORS.has(words[k]) && words[k] !== 'no')) negated = true;
      }
      if (!negated) return true;
    }
  }
  return false;
}

export function resolveCandidateGateEnabled(env = process.env) {
  const raw = env.SCENE_CANDIDATE_GATE;
  if (raw === undefined || raw === null) return true;
  const v = String(raw).trim().toLowerCase();
  if (v === 'off' || v === '0' || v === 'false') return false;
  if (v === '' || v === 'on' || v === '1' || v === 'true') return true;
  throw new Error(`SCENE_CANDIDATE_GATE must be one of on, off (got "${v}")`);
}

export function parseTags(tags) {
  if (Array.isArray(tags)) return tags.map((t) => String(t).trim().toLowerCase()).filter(Boolean);
  return String(tags ?? '').split(',').map((t) => t.trim().toLowerCase()).filter(Boolean);
}

/**
 * @param {{sceneText?: string, query?: string, excludeOrigins?: Iterable<string>}} ctx
 * @returns {(hit: {id?: any, pageURL?: string|null, tags?: string|string[]}) => {accept: boolean, reason: string|null}}
 */
export function buildHitScreen({ sceneText = '', query = '', excludeOrigins = [] } = {}) {
  const exclude = new Set(excludeOrigins);
  const context = new Set([...tokens(sceneText), ...tokens(query)]);
  const contextText = `${sceneText} ${query}`.toLowerCase();
  const deny = new Set(BRANDED_UI_CAPTURE_TAGS);
  const childrenWanted = mentionsChildrenAffirmatively(sceneText) || mentionsChildrenAffirmatively(query);
  const screen = (hit) => {
    if (hit?.pageURL && exclude.has(hit.pageURL)) return { accept: false, reason: 'duplicate_of_attached_asset' };
    const tags = parseTags(hit?.tags);
    for (const tag of tags) {
      if (deny.has(tag) && !contextText.includes(tag)) return { accept: false, reason: `branded_or_ui_capture_tag:${tag}` };
    }
    for (const tag of tags) {
      const phrase = OFF_STYLE_PHRASES.find((ph) => tag.includes(ph));
      if (phrase && !contextText.includes(phrase)) return { accept: false, reason: `off_style_tag:${phrase}` };
      for (const w of tag.match(/[a-z0-9-]+/g) ?? []) {
        if (OFF_STYLE_WORDS.includes(w) && !contextText.includes(w)) return { accept: false, reason: `off_style_tag:${w}` };
      }
    }
    if (!childrenWanted) {
      for (const tag of tags) {
        for (const w of tag.match(/[a-z]+/g) ?? []) {
          if (own(CHILD_FORMS, w)) return { accept: false, reason: `child_subject_tag:${w}` };
        }
      }
    }
    if (tags.length > 0 && context.size > 0) {
      const tagTokens = new Set(tags.flatMap((t) => tokens(t)));
      if (![...context].some((w) => tagTokens.has(w))) return { accept: false, reason: 'no_tag_overlap_with_scene' };
    }
    return { accept: true, reason: null };
  };
  // Relevance signal for choosing AMONG hits that passed: how many distinct query words and scene words the hit's
  // tags share (query words count double: the query is what the scene's visual intent was reduced to). Higher is
  // better; 0 means "no evidence either way". Used only to order accepted hits, never to accept one.
  const queryTokens = new Set(tokens(query));
  screen.score = (hit) => {
    const tagTokens = new Set(parseTags(hit?.tags).flatMap((t) => tokens(t)));
    let score = 0;
    for (const w of tagTokens) {
      if (queryTokens.has(w)) score += 2;
      else if (context.has(w)) score += 1;
    }
    return score;
  };
  return screen;
}
