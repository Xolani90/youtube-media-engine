/**
 * Candidate-convergence layer for Research claims.
 *
 * WHY: exact structured-identity fingerprints (claimIdentity.js) are
 * fail-closed but fail to merge independently sourced equivalent claims whose
 * representations differ only superficially. This module adds a deterministic
 * layer BETWEEN extraction and evidence grading:
 *
 *   structured identity -> blocking -> field-level comparison
 *     -> CANDIDATE_SAME_FACT -> conservative deterministic promotion
 *
 * INVARIANT: candidate similarity != same fact != VERIFIED.
 * Nothing here touches evidence_status, evidence thresholds, independence
 * rules, contradiction detection or Brief eligibility. A promotion only lets
 * two representations share one claim row; evidence is still earned through
 * computeEvidenceStatus() afterwards. No embeddings, no LLM, no fuzzy
 * similarity score, no probabilistic threshold appears anywhere in this file.
 *
 * SAFETY POSTURE: missed convergence > false convergence. There is NO entity
 * alias / suffix / semantic equivalence here: two entity strings are equal only
 * if they are byte-identical after the existing identity normalization.
 * "Spain" != "Spain national football team" != "Spain women's national team" !=
 * "Spain U21". Promotion requires EVERY field to be exact.
 *
 * Borrowed concepts (no code copied): Splink's blocking + per-field
 * comparison levels with explainable results; SAFE's self-contained /
 * check-worthiness ideas (as deterministic signals only).
 *
 * Everything is pure and total: malformed input yields an INCOMPARABLE /
 * UNCLASSIFIED result, never an exception that could alter a claim.
 */

export const CONVERGENCE_VERDICT = Object.freeze({
  CANDIDATE_SAME_FACT: 'CANDIDATE_SAME_FACT', // plausible same fact; eligible for further DETERMINISTIC evaluation only
  DISTINCT: 'DISTINCT',                       // at least one field conflicts
  INCOMPARABLE: 'INCOMPARABLE'                // an identity is missing/malformed
});

export const FIELD_STATUS = Object.freeze({
  EXACT: 'exact',
  EQUIVALENT: 'equivalent',   // different spelling, deterministic rule proves same value
  COMPATIBLE: 'compatible',   // one side is strictly more specific/precise; NOT proof of sameness
  UNRESOLVED: 'unresolved',   // cannot be decided deterministically
  CONFLICT: 'conflict'
});

export const PROMOTION_RULE = Object.freeze({
  IDENTICAL_STRUCTURE: 'identical_structure'
});

const S = FIELD_STATUS;
const MAX_BUCKET_SIZE = 200;

function tokens(value) {
  return typeof value === 'string' ? value.split(' ').filter(Boolean) : [];
}

const isDigitToken = (t) => /\d/.test(t);
const digitSet = (toks) => new Set(toks.filter(isDigitToken));
const sameSet = (a, b) => a.size === b.size && [...a].every((x) => b.has(x));
const isSubset = (a, b) => [...a].every((x) => b.has(x));

function fieldResult(status, detail = null) {
  return detail ? { status, detail } : { status };
}

// ---- field comparators ------------------------------------------------------

// Entities are EXACT only when byte-identical. Every other outcome is
// diagnostic and can never promote: the token comparison below only explains
// WHY two different entity strings were kept apart.
function compareEntity(a, b) {
  const aNull = a === null || a === undefined || a === '';
  const bNull = b === null || b === undefined || b === '';
  if (aNull && bNull) return fieldResult(S.EXACT);
  if (aNull || bNull) return fieldResult(S.UNRESOLVED, 'one_side_missing');
  if (a === b) return fieldResult(S.EXACT);
  const ta = tokens(a);
  const tb = tokens(b);
  const da = digitSet(ta);
  const db = digitSet(tb);
  if (da.size > 0 && db.size > 0 && !sameSet(da, db)) return fieldResult(S.CONFLICT, 'differing_numeric_tokens');
  const sa = new Set(ta);
  const sb = new Set(tb);
  const shared = ta.filter((t) => sb.has(t));
  if (shared.length === 0) return fieldResult(S.CONFLICT, 'no_shared_tokens');
  if (isSubset(sa, sb) || isSubset(sb, sa)) return fieldResult(S.COMPATIBLE, 'entity_not_identical_token_specificity_difference');
  return fieldResult(S.UNRESOLVED, 'entity_not_identical_partial_token_overlap');
}

// Explicit inverse-perspective pairs. These describe one event from opposite
// grammatical sides with swapped roles; they are NEVER treated as equivalent.
const INVERSE_PREDICATES = Object.freeze([['win', 'defeat'], ['win', 'lose'], ['beat', 'lose'], ['defeat', 'lose']]);

function comparePredicate(a, b) {
  if (a === b) return fieldResult(S.EXACT);
  const inverse = INVERSE_PREDICATES.some(([x, y]) => (a === x && b === y) || (a === y && b === x));
  return fieldResult(S.CONFLICT, inverse ? 'inverse_perspective_pair' : 'different_predicate');
}

function dayNumber(y, m, d) {
  return Math.floor(Date.UTC(y, m - 1, d) / 86400000);
}

// Returns [startDay, endDay] for YYYY, YYYY-MM, YYYY-MM-DD, YYYY-Qn, YYYY-Hn; null if unparseable.
function timeInterval(t) {
  if (typeof t !== 'string') return null;
  let m;
  if ((m = t.match(/^(\d{4})$/))) return [dayNumber(+m[1], 1, 1), dayNumber(+m[1], 12, 31)];
  if ((m = t.match(/^(\d{4})-(\d{2})$/))) {
    const mo = +m[2];
    if (mo < 1 || mo > 12) return null;
    return [dayNumber(+m[1], mo, 1), dayNumber(+m[1], mo + 1, 1) - 1];
  }
  if ((m = t.match(/^(\d{4})-(\d{2})-(\d{2})$/))) {
    const n = dayNumber(+m[1], +m[2], +m[3]);
    return [n, n];
  }
  if ((m = t.match(/^(\d{4})-Q([1-4])$/))) {
    const q = +m[2];
    return [dayNumber(+m[1], (q - 1) * 3 + 1, 1), dayNumber(+m[1], q * 3 + 1, 1) - 1];
  }
  if ((m = t.match(/^(\d{4})-H([12])$/))) {
    const h = +m[2];
    return [dayNumber(+m[1], (h - 1) * 6 + 1, 1), dayNumber(+m[1], h * 6 + 1, 1) - 1];
  }
  return null;
}

function compareTime(a, b) {
  const aNull = a === null || a === undefined;
  const bNull = b === null || b === undefined;
  if (aNull && bNull) return fieldResult(S.EXACT);
  if (aNull || bNull) return fieldResult(S.UNRESOLVED, 'one_side_missing');
  if (a === b) return fieldResult(S.EXACT);
  const ia = timeInterval(a);
  const ib = timeInterval(b);
  if (!ia || !ib) return fieldResult(S.UNRESOLVED, 'unparseable_time');
  if (ia[1] < ib[0] || ib[1] < ia[0]) return fieldResult(S.CONFLICT, 'disjoint_periods');
  const aInB = ia[0] >= ib[0] && ia[1] <= ib[1];
  const bInA = ib[0] >= ia[0] && ib[1] <= ia[1];
  if (aInB || bInA) return fieldResult(S.COMPATIBLE, 'granularity_difference');
  return fieldResult(S.UNRESOLVED, 'partial_overlap');
}

function compareQuantity(ia, ib) {
  const aNull = ia.quantity === null || ia.quantity === undefined;
  const bNull = ib.quantity === null || ib.quantity === undefined;
  if (aNull && bNull) return { quantity: fieldResult(S.EXACT), unit: fieldResult(S.EXACT) };
  if (aNull || bNull) return { quantity: fieldResult(S.UNRESOLVED, 'one_side_missing'), unit: fieldResult(S.UNRESOLVED, 'one_side_missing') };
  const unit = ia.unit === ib.unit ? fieldResult(S.EXACT) : fieldResult(S.CONFLICT, 'different_unit');
  const quantity = ia.quantity === ib.quantity ? fieldResult(S.EXACT) : fieldResult(S.CONFLICT, 'different_quantity');
  return { quantity, unit };
}

function compareQualifiers(a, b) {
  const qa = Array.isArray(a) ? a : [];
  const qb = Array.isArray(b) ? b : [];
  const sa = new Set(qa);
  const sb = new Set(qb);
  if (sameSet(sa, sb)) return fieldResult(S.EXACT);
  if (isSubset(sa, sb) || isSubset(sb, sa)) return fieldResult(S.COMPATIBLE, 'qualifier_detail_difference');
  const da = digitSet(qa.flatMap((q) => tokens(q)));
  const db = digitSet(qb.flatMap((q) => tokens(q)));
  if (da.size > 0 && db.size > 0 && !sameSet(da, db)) return fieldResult(S.CONFLICT, 'differing_numeric_tokens');
  return fieldResult(S.UNRESOLVED, 'different_qualifiers');
}

const exactOrConflict = (a, b, label) => (a === b ? fieldResult(S.EXACT) : fieldResult(S.CONFLICT, label));

function validIdentity(i) {
  return i && typeof i === 'object' && typeof i.subject === 'string' && i.subject !== '' &&
    typeof i.predicate === 'string' && i.predicate !== '' && Array.isArray(i.qualifiers);
}

/**
 * Field-level, explainable comparison of two NORMALIZED structured identities
 * (the `identity` returned by deriveClaimIdentity for a trusted claim).
 *
 * @param {object} a normalized identity
 * @param {object} b normalized identity
 * @param {{claimTypeA?:string, claimTypeB?:string, loadBearingA?:boolean, loadBearingB?:boolean}} [meta]
 * @returns {{verdict:string, fields:Object<string,{status:string,detail?:string}>, promotion:{eligible:boolean, rule:string|null}}}
 */
export function compareClaimIdentities(a, b, meta = {}) {
  if (!validIdentity(a) || !validIdentity(b)) {
    return { verdict: CONVERGENCE_VERDICT.INCOMPARABLE, fields: {}, promotion: { eligible: false, rule: null } };
  }
  const q = compareQuantity(a, b);
  const fields = {
    subject: compareEntity(a.subject, b.subject),
    predicate: comparePredicate(a.predicate, b.predicate),
    object: compareEntity(a.object ?? null, b.object ?? null),
    time: compareTime(a.time ?? null, b.time ?? null),
    quantity: q.quantity,
    unit: q.unit,
    qualifiers: compareQualifiers(a.qualifiers, b.qualifiers),
    polarity: exactOrConflict(a.polarity, b.polarity, 'different_polarity'),
    modality: exactOrConflict(a.modality, b.modality, 'different_modality'),
    relation: exactOrConflict(a.relation, b.relation, 'different_relation'),
    claimType: exactOrConflict(meta.claimTypeA, meta.claimTypeB, 'different_claim_type'),
    // Load-bearing is an LLM flag: a mismatch never proves anything, but it
    // blocks promotion (the existing identity merge also requires equality).
    loadBearing: meta.loadBearingA === meta.loadBearingB ? fieldResult(S.EXACT) : fieldResult(S.UNRESOLVED, 'different_load_bearing')
  };
  const statuses = Object.values(fields).map((f) => f.status);
  if (statuses.includes(S.CONFLICT)) {
    // Diagnostic signal only: same proposition skeleton, explicit conflict in a
    // value field. It is NOT authoritative and removes nothing from the existing
    // contradiction detector, which remains the only authority.
    const sameSkeleton = ['subject', 'predicate', 'object'].every((k) => fields[k].status === S.EXACT);
    const valueConflict = ['polarity', 'time', 'quantity', 'unit', 'modality'].some((k) => fields[k].status === S.CONFLICT);
    return {
      verdict: CONVERGENCE_VERDICT.DISTINCT, fields, promotion: { eligible: false, rule: null },
      contradictionCandidate: sameSkeleton && valueConflict
    };
  }
  // Promotion requires EVERY field to be exactly equal. COMPATIBLE / UNRESOLVED /
  // EQUIVALENT never promote: entity mismatch => no promotion.
  const deterministic = statuses.every((st) => st === S.EXACT);
  return {
    verdict: CONVERGENCE_VERDICT.CANDIDATE_SAME_FACT,
    fields,
    promotion: { eligible: deterministic, rule: deterministic ? PROMOTION_RULE.IDENTICAL_STRUCTURE : null }
  };
}

// ---- deterministic blocking ------------------------------------------------

/**
 * Blocking keys for one trusted claim. Two claims can only be compared when
 * they share at least one key. Keys use the raw (exact) entity strings: no alias
 * canonicalisation. Blocking only proposes pairs; the field comparison
 * (e.g. the inverse-predicate conflict win/defeat) decides whether a pair is a
 * candidate at all.
 */
export function blockingKeys(identity, claimType) {
  if (!validIdentity(identity)) return [];
  const cs = identity.subject;
  const co = identity.object ? identity.object : '';
  const keys = [];
  if (cs) keys.push(`S|${claimType}|${identity.predicate}|${cs}`);
  if (co) keys.push(`O|${claimType}|${identity.predicate}|${co}`);
  if (cs && co) keys.push(`SO|${claimType}|${cs}|${co}`);
  return keys;
}

/**
 * In-memory blocking index over claim rows created in one Research run.
 * Candidate retrieval is O(bucket) per claim instead of O(n) over all claims.
 * Iteration order is insertion order, so results are deterministic.
 */
export class ConvergenceIndex {
  constructor({ maxBucketSize = MAX_BUCKET_SIZE } = {}) {
    this.maxBucketSize = maxBucketSize;
    this.buckets = new Map();
    this.entries = new Map();
    this.overflowedKeys = 0;
  }

  add({ claimId, identity, claimType, isLoadBearing, sourceIds }) {
    const entry = { claimId, identity, claimType, isLoadBearing: !!isLoadBearing, sourceIds: new Set(sourceIds || []) };
    this.entries.set(claimId, entry);
    for (const key of blockingKeys(identity, claimType)) {
      const bucket = this.buckets.get(key) || [];
      bucket.push(entry);
      this.buckets.set(key, bucket);
    }
    return entry;
  }

  noteSource(claimId, sourceId) {
    const entry = this.entries.get(claimId);
    if (entry) entry.sourceIds.add(sourceId);
  }

  candidatesFor(identity, claimType) {
    const seen = new Set();
    const out = [];
    for (const key of blockingKeys(identity, claimType)) {
      const bucket = this.buckets.get(key);
      if (!bucket) continue;
      if (bucket.length > this.maxBucketSize) { this.overflowedKeys += 1; continue; }
      for (const entry of bucket) {
        if (!seen.has(entry.claimId)) { seen.add(entry.claimId); out.push(entry); }
      }
    }
    return out;
  }
}

/**
 * Evaluates one incoming trusted claim against the index.
 *
 * Promotion happens ONLY when exactly one candidate is promotion-eligible
 * (all fields exact or deterministically equivalent) and that candidate does
 * not already carry this source. Ambiguity (two eligible targets) fails
 * closed: no promotion. Candidates sharing the same source are skipped
 * (they add no independent evidence).
 *
 * @returns {{candidates: Array<{entry, comparison}>, promoted: null|{entry, comparison}, ambiguous: boolean}}
 */
export function evaluateConvergence(index, { identity, claimType, isLoadBearing, sourceId }) {
  const candidates = [];
  try {
    for (const entry of index.candidatesFor(identity, claimType)) {
      if (entry.sourceIds.has(sourceId)) continue;
      const comparison = compareClaimIdentities(entry.identity, identity, {
        claimTypeA: entry.claimType, claimTypeB: claimType,
        loadBearingA: entry.isLoadBearing, loadBearingB: !!isLoadBearing
      });
      if (comparison.verdict === CONVERGENCE_VERDICT.CANDIDATE_SAME_FACT) candidates.push({ entry, comparison });
    }
  } catch {
    return { candidates: [], promoted: null, ambiguous: false };
  }
  const eligible = candidates.filter((c) => c.comparison.promotion.eligible);
  if (eligible.length === 1) return { candidates, promoted: eligible[0], ambiguous: false };
  return { candidates, promoted: null, ambiguous: eligible.length > 1 };
}

/**
 * Observational counterpart to evaluateConvergence.  This deliberately reads
 * buckets rather than candidatesFor() so inspecting a run cannot increment the
 * index overflow counter or otherwise influence later convergence decisions.
 */
export function explainConvergence(index, { identity, claimType, isLoadBearing, sourceId }) {
  try {
    const keysChecked = blockingKeys(identity, claimType);
    const overflowedKeys = [];
    const sameSourceSkipped = [];
    const seen = new Set();
    const pairs = [];
    for (const key of keysChecked) {
      const bucket = index.buckets.get(key);
      if (!bucket) continue;
      if (bucket.length > index.maxBucketSize) { overflowedKeys.push(key); continue; }
      for (const entry of bucket) {
        if (seen.has(entry.claimId)) continue;
        seen.add(entry.claimId);
        if (entry.sourceIds.has(sourceId)) { sameSourceSkipped.push(entry.claimId); continue; }
        const comparison = compareClaimIdentities(entry.identity, identity, {
          claimTypeA: entry.claimType, claimTypeB: claimType,
          loadBearingA: entry.isLoadBearing, loadBearingB: !!isLoadBearing
        });
        const conflictFields = Object.entries(comparison.fields)
          .filter(([, value]) => value.status === S.CONFLICT || value.status === S.UNRESOLVED)
          .map(([field, value]) => `${field}:${value.detail ?? value.status}`);
        pairs.push({
          claimId: entry.claimId,
          sourceIds: [...entry.sourceIds],
          verdict: comparison.verdict,
          conflictFields,
          promotionEligible: comparison.promotion.eligible
        });
      }
    }
    return { keysChecked, overflowedKeys, sameSourceSkipped, pairs };
  } catch {
    return { error: true };
  }
}

// ---- self-contained / relevance signals (deterministic, prioritisation only) -

const VAGUE_OPENING = /^\s*(?:they|it|he|she|this|these|those|its|their|the\s+(?:team|company|winner|tournament|squad|club|player|firm|group|organization|organisation))\b/i;
const META_SOURCE_CLAIM = /\b(?:source|article|page|text|video|transcript|report)\b[^.]*\b(?:does\s+not|doesn['\u2019]t|did\s+not|do\s+not|not\s+(?:state|mention|specify|say|provide|name))\b/i;
const STOPWORDS = new Set(['the', 'a', 'an', 'of', 'in', 'on', 'at', 'to', 'for', 'and', 'or', 'is', 'was', 'were', 'are', 'be', 'been', 'did', 'does', 'do', 'what', 'who', 'when', 'where', 'which', 'how', 'why', 'that', 'this', 'with', 'by', 'from', 'it', 'as', 'than']);

export function isSelfContained(claimText) {
  return typeof claimText === 'string' && claimText.trim() !== '' && !VAGUE_OPENING.test(claimText);
}

export const CLAIM_RELEVANCE = Object.freeze({
  ANSWER_BEARING: 'ANSWER_BEARING',
  SUPPORTING: 'SUPPORTING',
  INCIDENTAL: 'INCIDENTAL',
  NON_CHECKWORTHY: 'NON_CHECKWORTHY',
  UNCLASSIFIED: 'UNCLASSIFIED' // classifier failed: fail-closed, treated as least trusted for convergence
});

function contentTokens(text) {
  return new Set(
    String(text).normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter((t) => t && !STOPWORDS.has(t))
  );
}

/**
 * Deterministic relevance / check-worthiness SIGNAL for a claim relative to
 * the research core question. It never deletes a claim and never influences
 * evidence_status; the pipeline only uses it to decide whether a claim is
 * worth candidate-convergence comparison and records it for observability.
 */
export function classifyClaimRelevance({ claim, claim_type: claimType, is_load_bearing: isLoadBearing }, coreQuestion) {
  try {
    if (typeof claim !== 'string' || claim.trim() === '') return { relevance: CLAIM_RELEVANCE.UNCLASSIFIED, reasons: ['empty_claim'], overlap: 0 };
    if (claimType === 'OPINION') return { relevance: CLAIM_RELEVANCE.NON_CHECKWORTHY, reasons: ['opinion'], overlap: 0 };
    if (META_SOURCE_CLAIM.test(claim)) return { relevance: CLAIM_RELEVANCE.INCIDENTAL, reasons: ['source_meta_claim'], overlap: 0 };
    const q = contentTokens(coreQuestion || '');
    const c = contentTokens(claim);
    const shared = [...q].filter((t) => c.has(t)).length;
    const overlap = q.size === 0 ? 0 : shared / q.size;
    if (isLoadBearing === true && overlap >= 0.4) return { relevance: CLAIM_RELEVANCE.ANSWER_BEARING, reasons: ['load_bearing', 'question_overlap'], overlap };
    if (isLoadBearing === true || overlap >= 0.2) return { relevance: CLAIM_RELEVANCE.SUPPORTING, reasons: [isLoadBearing === true ? 'load_bearing' : 'question_overlap'], overlap };
    return { relevance: CLAIM_RELEVANCE.INCIDENTAL, reasons: ['low_question_overlap'], overlap };
  } catch {
    return { relevance: CLAIM_RELEVANCE.UNCLASSIFIED, reasons: ['classifier_error'], overlap: 0 };
  }
}

const CONVERGENCE_ELIGIBLE_RELEVANCE = new Set([CLAIM_RELEVANCE.ANSWER_BEARING, CLAIM_RELEVANCE.SUPPORTING]);

/**
 * Convergence eligibility. A claim enters the convergence layer ONLY when every
 * condition can be established; any doubt => skip (the claim is still persisted
 * and graded by the ordinary Research pipeline; it just cannot act as a bridge).
 *
 *   1. extraction valid + claim structure valid (claim text / type / flag)
 *   2. normalization present and convergence-trusted (UNCHANGED verbatim /
 *      verified original, or a deterministically proven NORMALIZED rewrite)
 *   3. identity not derived from a rejected rewrite
 *   4. self-contained, check-worthy, relevant
 * (Same-source comparisons are excluded in evaluateConvergence.)
 *
 * @returns {{eligible:boolean, reason:string|null, relevance:object}}
 */
export function isConvergenceEligible(proposed, coreQuestion) {
  const rel = classifyClaimRelevance(proposed || {}, coreQuestion);
  const out = (reason) => ({ eligible: reason === null, reason, relevance: rel });
  if (!proposed || typeof proposed.claim !== 'string' || proposed.claim.trim() === '') return out('invalid_claim_text');
  if (typeof proposed.claim_type !== 'string' || typeof proposed.is_load_bearing !== 'boolean') return out('invalid_claim_structure');
  const n = proposed.normalization;
  if (!n || typeof n !== 'object') return out('normalization_status_missing');
  if (n.identityDiscarded === true) return out('identity_derived_from_rejected_normalization');
  if (n.convergenceTrusted !== true) return out(`normalization_not_trusted:${n.status ?? 'unknown'}:${n.reason ?? 'unknown'}`);
  if (!CONVERGENCE_ELIGIBLE_RELEVANCE.has(rel.relevance)) return out(`not_relevant:${rel.relevance}`);
  if (!isSelfContained(proposed.claim)) return out('not_self_contained');
  return out(null);
}
