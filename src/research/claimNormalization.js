/**
 * Self-contained claim normalization (SAFE-inspired decontextualization),
 * hardened for convergence safety.
 *
 * The extraction LLM may rewrite a claim so it no longer depends on an
 * ambiguous reference ("They won the final." -> "Spain won the final.") and
 * supplies the pre-rewrite sentence as `original_claim`. The model is
 * UNTRUSTED here. This module is deterministic VALIDATION, never generation:
 *
 *   - "the substituted words occur somewhere in the source" is NOT proof.
 *   - A rewrite is accepted ONLY when the referent is established
 *     deterministically: the original sentence is a unique sentence of the
 *     source that starts with the pronoun "They", the IMMEDIATELY preceding
 *     sentence in the same source block is a minimal "<Entity> <verb...>"
 *     sentence with exactly one possible antecedent, and the proposed rewrite
 *     is token-for-token the original with that pronoun replaced by that
 *     entity. Anything else is rejected. No LLM, no similarity, no guessing.
 *
 * Residual limitation (deliberate, documented): this is NOT coreference
 * resolution. A bare lowercase noun in the antecedent sentence (e.g.
 * "Spain beat champions.") cannot be detected as a second candidate, so the
 * antecedent sentence is restricted to forms with no determiner, preposition,
 * conjunction or second capitalised word. We prefer rejecting legitimate
 * rewrites over accepting an unprovable one.
 *
 * Outcome statuses:
 *   UNCHANGED          claim is the source wording (verbatim in the source, or
 *                      identical to a verified original). Convergence-trusted.
 *   NORMALIZED         rewrite proven to be a mechanical antecedent
 *                      substitution. Convergence-trusted.
 *   RETAINED_ORIGINAL  original sentence verified in the source but the rewrite
 *                      was rejected. The ORIGINAL claim text is kept AND any
 *                      identity derived from the rewrite is DISCARDED
 *                      (discardIdentity = true). Not convergence-trusted.
 *   UNVERIFIED_ORIGIN  the claim's relation to the source cannot be verified
 *                      (original_claim missing/malformed/not in source, or the
 *                      claim is not verbatim and no original was given). The
 *                      claim stays available to ordinary Research but is NOT
 *                      convergence-trusted. Never throws, never fails the run.
 */

export const NORMALIZATION_STATUS = Object.freeze({
  UNCHANGED: 'UNCHANGED',
  NORMALIZED: 'NORMALIZED',
  RETAINED_ORIGINAL: 'RETAINED_ORIGINAL',
  UNVERIFIED_ORIGIN: 'UNVERIFIED_ORIGIN'
});

// Only "they": collective subject pronoun. he/she/it are excluded (gender/number
// mismatch with a country/team name and expletive "it" cannot be excluded).
const SUBJECT_PRONOUNS = new Set(['they']);
const ALL_PRONOUNS = new Set(['they', 'them', 'their', 'theirs', 'it', 'its', 'he', 'him', 'his', 'she', 'her', 'hers', 'this', 'these', 'those']);
const VAGUE_NOUN_AFTER_THE = new Set(['team', 'company', 'winner', 'tournament', 'squad', 'club', 'player', 'firm', 'group', 'organization', 'organisation', 'event', 'competition', 'side']);

// Words whose presence in the antecedent sentence could introduce a second
// noun phrase / participant (or otherwise make the referent uncertain).
const FUNCTION_WORDS = new Set([
  'a', 'an', 'the', 'this', 'that', 'these', 'those', 'his', 'her', 'its', 'their', 'our', 'my', 'your',
  'of', 'in', 'on', 'at', 'to', 'for', 'from', 'by', 'with', 'without', 'against', 'over', 'under', 'after',
  'before', 'during', 'between', 'among', 'about', 'into', 'onto', 'through', 'near', 'beyond', 'versus', 'vs',
  'and', 'or', 'but', 'nor', 'as', 'than', 'while', 'because', 'if', 'when', 'whereas', 'although', 'though',
  'who', 'whom', 'whose', 'which', 'what', 'where', 'they', 'them', 'he', 'him', 'she', 'it', 'we', 'us', 'i', 'you',
  'all', 'some', 'any', 'many', 'several', 'both', 'each', 'every', 'other', 'another', 'no', 'one', 'two'
]);

const ABBREVIATION = /(?:\b[A-Za-z]\.){2,}|\b[A-Z]\.\s|\b(?:Mr|Mrs|Ms|Dr|Prof|St|Mt|Jr|Sr|vs|No|Inc|Ltd|Co|Corp|Gen|Sen|Rep|Gov|Lt|Capt)\./;
const QUOTE_CHARS = /["\u201c\u201d\u2018\u2019'`]/;
const MAX_ENTITY_WORDS = 4;

function tokenize(text) {
  return String(text).normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/['\u2019]s\b/g, '')
    .replace(/[^\p{L}\p{N}%$\s]/gu, ' ').split(/\s+/).filter(Boolean);
}

function containsSequence(haystack, needle) {
  if (needle.length === 0) return true;
  outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) if (haystack[i + j] !== needle[j]) continue outer;
    return true;
  }
  return false;
}

const sameTokens = (a, b) => a.length === b.length && a.every((t, i) => t === b[i]);

// Newline = block boundary (an antecedent must never be assumed across a
// paragraph/line break). Within a block, split on sentence punctuation.
function sentenceBlocks(text) {
  return String(text).split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
    .map((line) => line.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean));
}

const stripTerminal = (s) => s.replace(/[.!?]+$/u, '');

/**
 * Deterministic sole-antecedent test for the sentence immediately before a
 * pronoun. Returns { entity } or { reason }.
 */
function soleSubjectEntity(sentence) {
  if (QUOTE_CHARS.test(sentence)) return { reason: 'quote_in_antecedent_sentence' };
  const body = stripTerminal(sentence.trim());
  if (/[^\p{L}\s]/u.test(body)) return { reason: 'punctuation_or_digits_in_antecedent_sentence' };
  const words = body.split(/\s+/).filter(Boolean);
  if (words.length < 2) return { reason: 'antecedent_sentence_too_short' };
  const isCap = (w) => /^\p{Lu}\p{L}*$/u.test(w);
  const run = [];
  for (const w of words) {
    if (!isCap(w)) break;
    run.push(w);
  }
  if (run.length === 0) return { reason: 'no_leading_named_entity' };
  if (run.length > MAX_ENTITY_WORDS) return { reason: 'entity_run_too_long' };
  if (run.some((w) => FUNCTION_WORDS.has(w.toLowerCase()) || ALL_PRONOUNS.has(w.toLowerCase()))) return { reason: 'entity_starts_with_function_word' };
  const rest = words.slice(run.length);
  if (rest.length === 0) return { reason: 'no_predicate_after_entity' };
  if (rest.some((w) => isCap(w) || /^\p{Lu}/u.test(w))) return { reason: 'second_capitalised_entity_present' };
  if (rest.some((w) => FUNCTION_WORDS.has(w.toLowerCase()))) return { reason: 'possible_second_noun_phrase' };
  return { entity: run.join(' ') };
}

/**
 * Attempts to prove `claim` is the mechanical antecedent substitution of
 * `original` against `sourceText`. Returns { ok:true, claim } or { ok:false, reason }.
 */
function proveMechanicalSubstitution({ claim, original, sourceText }) {
  const trimmed = original.trim();
  const m = trimmed.match(/^(\S+)([\s\S]*)$/);
  if (!m || !SUBJECT_PRONOUNS.has(m[1].toLowerCase())) return { ok: false, reason: 'original_not_led_by_they' };
  const oTokens = tokenize(trimmed);
  const pronounCount = oTokens.filter((t) => ALL_PRONOUNS.has(t)).length;
  const vagueNoun = oTokens.some((t, i) => t === 'the' && VAGUE_NOUN_AFTER_THE.has(oTokens[i + 1]));
  if (pronounCount !== 1 || vagueNoun) return { ok: false, reason: 'multiple_or_other_references_in_original' };

  const target = oTokens.join(' ');
  const matches = [];
  for (const sentences of sentenceBlocks(sourceText)) {
    sentences.forEach((s, i) => { if (tokenize(s).join(' ') === target) matches.push({ sentences, i }); });
  }
  if (matches.length !== 1) return { ok: false, reason: matches.length === 0 ? 'original_not_a_source_sentence' : 'original_sentence_not_unique' };
  const { sentences, i } = matches[0];
  if (i === 0) return { ok: false, reason: 'no_adjacent_antecedent_sentence' };
  const prior = sentences[i - 1];
  // Abbreviations anywhere in the line can mis-split sentences (e.g. "Dr. Smith"
  // yields a stray "Dr." sentence), so the guard covers the whole source line.
  if (ABBREVIATION.test(sentences.join(' '))) return { ok: false, reason: 'ambiguous_sentence_boundary' };
  if (QUOTE_CHARS.test(sentences[i])) return { ok: false, reason: 'quote_in_original_sentence' };

  const ante = soleSubjectEntity(prior);
  if (!ante.entity) return { ok: false, reason: `antecedent_not_unambiguous:${ante.reason}` };

  const constructed = `${ante.entity}${m[2]}`;
  if (!sameTokens(tokenize(constructed), tokenize(claim))) return { ok: false, reason: 'rewrite_not_mechanical_substitution_of_antecedent' };
  return { ok: true, claim: constructed.trim(), antecedent: ante.entity };
}

let lastSource = { text: null, tokens: null };
function sourceTokens(text) {
  if (lastSource.text !== text) lastSource = { text, tokens: tokenize(text) };
  return lastSource.tokens;
}

const result = (claim, status, reason, extra = {}) => ({
  claim, status, reason, originalClaim: null, proposedClaim: typeof claim === 'string' ? claim : null,
  convergenceTrusted: false, discardIdentity: false, ...extra
});

/**
 * @param {{claim:string, originalClaim:any, sourceText:string}} input
 * @returns {{claim:string, status:string, reason:string, originalClaim:string|null, proposedClaim:string|null, convergenceTrusted:boolean, discardIdentity:boolean}}
 */
export function applySafeNormalization({ claim, originalClaim, sourceText } = {}) {
  try {
    if (typeof claim !== 'string' || claim.trim() === '') {
      return result(claim, NORMALIZATION_STATUS.UNVERIFIED_ORIGIN, 'claim_not_string');
    }
    const proposedClaim = claim;
    const base = (c, status, reason, extra = {}) => result(c, status, reason, { proposedClaim, ...extra });
    if (typeof sourceText !== 'string' || sourceText === '') {
      return base(claim, NORMALIZATION_STATUS.UNVERIFIED_ORIGIN, 'source_text_unavailable', { originalClaim: typeof originalClaim === 'string' ? originalClaim.trim() : null });
    }
    const src = sourceTokens(sourceText);
    const c = tokenize(claim);
    if (c.length === 0) return base(claim, NORMALIZATION_STATUS.UNVERIFIED_ORIGIN, 'empty_after_tokenization');

    if (originalClaim === undefined || originalClaim === null) {
      // No original supplied: the claim may only be trusted if it IS the source wording.
      return containsSequence(src, c)
        ? base(claim, NORMALIZATION_STATUS.UNCHANGED, 'claim_verbatim_in_source', { convergenceTrusted: true })
        : base(claim, NORMALIZATION_STATUS.UNVERIFIED_ORIGIN, 'original_claim_missing_and_claim_not_verbatim');
    }
    if (typeof originalClaim !== 'string' || originalClaim.trim() === '') {
      return base(claim, NORMALIZATION_STATUS.UNVERIFIED_ORIGIN, 'original_claim_invalid');
    }
    const original = originalClaim.trim();
    const o = tokenize(original);
    if (o.length === 0 || !containsSequence(src, o)) {
      // The "original" is itself not grounded in the source: nothing is verified.
      return base(claim, NORMALIZATION_STATUS.UNVERIFIED_ORIGIN, 'original_not_in_source', { originalClaim: original });
    }
    if (sameTokens(o, c)) {
      return base(claim, NORMALIZATION_STATUS.UNCHANGED, 'identical_to_original', { originalClaim: original, convergenceTrusted: true });
    }

    const proof = proveMechanicalSubstitution({ claim, original, sourceText });
    if (proof.ok) {
      return base(proof.claim, NORMALIZATION_STATUS.NORMALIZED, 'mechanical_antecedent_substitution', { originalClaim: original, convergenceTrusted: true });
    }
    // Rejected: original wording restored; identity derived from the rewrite is void.
    return base(original, NORMALIZATION_STATUS.RETAINED_ORIGINAL, proof.reason, { originalClaim: original, discardIdentity: true });
  } catch {
    return result(claim, NORMALIZATION_STATUS.UNVERIFIED_ORIGIN, 'normalization_error');
  }
}
