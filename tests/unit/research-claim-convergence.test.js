import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as convergence from '../../src/research/claimConvergence.js';
import {
  compareClaimIdentities, blockingKeys, ConvergenceIndex, evaluateConvergence,
  classifyClaimRelevance, isConvergenceEligible, CONVERGENCE_VERDICT, CLAIM_RELEVANCE, FIELD_STATUS, PROMOTION_RULE
} from '../../src/research/claimConvergence.js';
import { applySafeNormalization, NORMALIZATION_STATUS } from '../../src/research/claimNormalization.js';
import { extractClaims, ExtractionFailureError, EXTRACTION_PARSE_OUTCOME } from '../../src/research/claims.js';

const id = (over = {}) => ({
  subject: 'spain', predicate: 'win', object: 'final', qualifiers: [], time: '2026', quantity: null, unit: null,
  polarity: 'AFFIRMED', modality: 'OCCURRED', relation: 'DESCRIPTIVE', ...over
});
const meta = { claimTypeA: 'FACT', claimTypeB: 'FACT', loadBearingA: true, loadBearingB: true };

function routerReturning(text) {
  return { async complete() { return { result: { text, model: 'm', finishReason: 'stop' }, providerUsed: 'stub' }; } };
}

// ---------------- entity aliasing is gone (Tests 1-4) ----------------

test('no entity alias mechanism exists: promotion rule set and exports', () => {
  assert.deepEqual(Object.values(PROMOTION_RULE), ['identical_structure']);
  assert.equal('canonicalEntity' in convergence, false);
  assert.equal(PROMOTION_RULE.ENTITY_SUFFIX_ALIAS, undefined);
});

test('Test 1. non-sporting win: "Spain" vs "Spain national football team" never converge', () => {
  const a = id({ object: 'wto trade dispute', time: null });
  const b = id({ object: 'wto trade dispute', time: null, subject: 'spain national football team' });
  const r = compareClaimIdentities(a, b, meta);
  assert.equal(r.promotion.eligible, false);
  assert.equal(r.promotion.rule, null);
  assert.notEqual(r.fields.subject.status, FIELD_STATUS.EXACT);
  assert.notEqual(r.fields.subject.status, FIELD_STATUS.EQUIVALENT);
  const index = new ConvergenceIndex();
  index.add({ claimId: 'x', identity: a, claimType: 'FACT', isLoadBearing: true, sourceIds: ['s1'] });
  const ev = evaluateConvergence(index, { identity: b, claimType: 'FACT', isLoadBearing: true, sourceId: 's2' });
  assert.equal(ev.promoted, null);
});

for (const [name, subject] of [
  ['Test 2. youth team', 'spain youth team'],
  ['Test 3. women\'s team', 'spain women national football team'],
  ['Test 4. U21', 'spain u21'],
  ['national team', 'spain national team'],
  ['national football team', 'spain national football team']
]) {
  test(`${name} does not converge with "spain" (compare + index)`, () => {
    const r = compareClaimIdentities(id(), id({ subject }), meta);
    assert.equal(r.promotion.eligible, false);
    assert.notEqual(r.fields.subject.status, FIELD_STATUS.EXACT);
    const index = new ConvergenceIndex();
    index.add({ claimId: 'x', identity: id(), claimType: 'FACT', isLoadBearing: true, sourceIds: ['s1'] });
    const ev = evaluateConvergence(index, { identity: id({ subject }), claimType: 'FACT', isLoadBearing: true, sourceId: 's2' });
    assert.equal(ev.promoted, null);
    assert.equal(ev.candidates.some((c) => c.comparison.promotion.eligible), false);
  });
}

test('only byte-identical structure is promotable', () => {
  const r = compareClaimIdentities(id(), id(), meta);
  assert.equal(r.promotion.eligible, true);
  assert.equal(r.promotion.rule, PROMOTION_RULE.IDENTICAL_STRUCTURE);
});

// ---------------- retained field-level comparison ----------------

test('B. predicate caution: win vs defeat / lose is a conflict, never merged', () => {
  const r = compareClaimIdentities(id(), id({ subject: 'argentina', predicate: 'lose' }), meta);
  assert.equal(r.verdict, CONVERGENCE_VERDICT.DISTINCT);
  assert.equal(r.fields.predicate.status, FIELD_STATUS.CONFLICT);
  assert.equal(r.promotion.eligible, false);
  const inverse = compareClaimIdentities(id({ predicate: 'win' }), id({ predicate: 'defeat' }), meta);
  assert.equal(inverse.fields.predicate.detail, 'inverse_perspective_pair');
  const index = new ConvergenceIndex();
  index.add({ claimId: 'w', identity: id({ predicate: 'win' }), claimType: 'FACT', isLoadBearing: true, sourceIds: ['s1'] });
  const ev = evaluateConvergence(index, { identity: id({ predicate: 'defeat' }), claimType: 'FACT', isLoadBearing: true, sourceId: 's2' });
  assert.deepEqual(ev.candidates, []);
  assert.equal(ev.promoted, null);
});

test('C. time caution: disjoint periods conflict; granularity difference is compatible only (not promotable)', () => {
  assert.equal(compareClaimIdentities(id({ time: '2022' }), id({ time: '2026' }), meta).verdict, CONVERGENCE_VERDICT.DISTINCT);
  const gran = compareClaimIdentities(id({ time: '2026-07-19' }), id({ time: '2026' }), meta);
  assert.equal(gran.fields.time.status, FIELD_STATUS.COMPATIBLE);
  assert.equal(gran.promotion.eligible, false);
});

test('D. quantity caution: different quantity or unit conflicts', () => {
  const q = (n, u = 'goal') => id({ predicate: 'score', quantity: n, unit: u });
  assert.equal(compareClaimIdentities(q(2), q(3), meta).fields.quantity.status, FIELD_STATUS.CONFLICT);
  assert.equal(compareClaimIdentities(q(2), q(2, 'point'), meta).fields.unit.status, FIELD_STATUS.CONFLICT);
  assert.equal(compareClaimIdentities(q(2), q(2), meta).promotion.eligible, true);
});

test('E. qualifiers / E2. object specificity never promote', () => {
  assert.equal(compareClaimIdentities(id({ qualifiers: ['extra time'] }), id({ qualifiers: ['penalties'] }), meta).promotion.eligible, false);
  assert.equal(compareClaimIdentities(id({ qualifiers: ['2-1'] }), id({ qualifiers: ['3-1'] }), meta).fields.qualifiers.status, FIELD_STATUS.CONFLICT);
  const r = compareClaimIdentities(id({ object: '2026 fifa world cup final' }), id({ object: 'fifa world cup' }), meta);
  assert.equal(r.fields.object.status, FIELD_STATUS.COMPATIBLE);
  assert.equal(r.promotion.eligible, false);
});

test('polarity, modality, relation, claim type and load-bearing mismatches block promotion', () => {
  assert.equal(compareClaimIdentities(id(), id({ polarity: 'NEGATED' }), meta).verdict, CONVERGENCE_VERDICT.DISTINCT);
  assert.equal(compareClaimIdentities(id(), id({ modality: 'PLANNED' }), meta).verdict, CONVERGENCE_VERDICT.DISTINCT);
  assert.equal(compareClaimIdentities(id(), id({ relation: 'CAUSAL' }), meta).verdict, CONVERGENCE_VERDICT.DISTINCT);
  assert.equal(compareClaimIdentities(id(), id(), { ...meta, claimTypeB: 'INFERENCE' }).verdict, CONVERGENCE_VERDICT.DISTINCT);
  assert.equal(compareClaimIdentities(id(), id(), { ...meta, loadBearingB: false }).promotion.eligible, false);
});

test('contradictionCandidate is diagnostic only: exposed, never removes anything, never promotes', () => {
  const r = compareClaimIdentities(id(), id({ polarity: 'NEGATED' }), meta);
  assert.equal(r.contradictionCandidate, true);
  assert.equal(r.promotion.eligible, false);
  assert.equal(compareClaimIdentities(id(), id({ subject: 'brazil' }), meta).contradictionCandidate, false);
});

test('malformed identities are INCOMPARABLE and never throw', () => {
  for (const bad of [null, undefined, {}, { subject: 'x' }, 'str']) {
    assert.equal(compareClaimIdentities(bad, id(), meta).verdict, CONVERGENCE_VERDICT.INCOMPARABLE);
  }
});

test('blocking is bucketed and uses exact entity strings; oversized buckets fail closed', () => {
  assert.ok(!blockingKeys(id(), 'FACT').some((k) => blockingKeys(id({ subject: 'spain national football team' }), 'FACT').includes(k) && k.startsWith('S|')));
  const index = new ConvergenceIndex({ maxBucketSize: 5 });
  for (let n = 0; n < 300; n++) index.add({ claimId: `c${n}`, identity: id({ subject: `team${n}` }), claimType: 'FACT', isLoadBearing: true, sourceIds: [`s${n}`] });
  assert.deepEqual(index.candidatesFor(id({ subject: 'team7' }), 'FACT').map((e) => e.claimId), ['c7']);
  const crowded = new ConvergenceIndex({ maxBucketSize: 2 });
  for (let n = 0; n < 4; n++) crowded.add({ claimId: `d${n}`, identity: id(), claimType: 'FACT', isLoadBearing: true, sourceIds: [`s${n}`] });
  assert.deepEqual(crowded.candidatesFor(id(), 'FACT'), []);
  assert.ok(crowded.overflowedKeys > 0);
});

test('evaluateConvergence: ambiguity (two identical targets) and same-source targets never promote', () => {
  const index = new ConvergenceIndex();
  index.add({ claimId: 'x1', identity: id(), claimType: 'FACT', isLoadBearing: true, sourceIds: ['s1'] });
  index.add({ claimId: 'x2', identity: id(), claimType: 'FACT', isLoadBearing: true, sourceIds: ['s2'] });
  const incoming = { identity: id(), claimType: 'FACT', isLoadBearing: true, sourceId: 's3' };
  const amb = evaluateConvergence(index, incoming);
  assert.equal(amb.ambiguous, true);
  assert.equal(amb.promoted, null);
  const same = evaluateConvergence(index, { ...incoming, sourceId: 's1' });
  assert.ok(!same.candidates.some((c) => c.entry.claimId === 'x1'));
  const single = new ConvergenceIndex();
  single.add({ claimId: 'y', identity: id(), claimType: 'FACT', isLoadBearing: true, sourceIds: ['s1'] });
  assert.equal(evaluateConvergence(single, { ...incoming, sourceId: 's1' }).promoted, null);
  assert.equal(evaluateConvergence(single, incoming).promoted.entry.claimId, 'y');
});

test('relevance: opinion non-checkworthy, unrelated incidental, classifier failure UNCLASSIFIED', () => {
  const q = 'Who won the 2026 final?';
  assert.equal(classifyClaimRelevance({ claim: 'It was a thrilling final.', claim_type: 'OPINION', is_load_bearing: false }, q).relevance, CLAIM_RELEVANCE.NON_CHECKWORTHY);
  assert.equal(classifyClaimRelevance({ claim: 'The stadium sells hot dogs.', claim_type: 'FACT', is_load_bearing: false }, q).relevance, CLAIM_RELEVANCE.INCIDENTAL);
  assert.equal(classifyClaimRelevance({ claim: 'Spain won the 2026 final.', claim_type: 'FACT', is_load_bearing: true }, q).relevance, CLAIM_RELEVANCE.ANSWER_BEARING);
  assert.equal(classifyClaimRelevance({ claim: null, claim_type: 'FACT' }, q).relevance, CLAIM_RELEVANCE.UNCLASSIFIED);
});

// ---------------- convergence eligibility gate ----------------

const Q = 'Who won the 2026 final?';
const trustedNorm = { status: 'UNCHANGED', reason: 'claim_verbatim_in_source', convergenceTrusted: true, identityDiscarded: false };
const good = (over = {}) => ({ claim: 'Spain won the 2026 final.', claim_type: 'FACT', is_load_bearing: true, normalization: trustedNorm, ...over });

test('eligibility: a fully trusted claim is eligible; every missing trust condition makes it ineligible', () => {
  assert.equal(isConvergenceEligible(good(), Q).eligible, true);
  assert.equal(isConvergenceEligible(good({ normalization: undefined }), Q).eligible, false);
  assert.equal(isConvergenceEligible(good({ normalization: { ...trustedNorm, convergenceTrusted: false, status: 'UNVERIFIED_ORIGIN' } }), Q).eligible, false);
  assert.equal(isConvergenceEligible(good({ normalization: { ...trustedNorm, convergenceTrusted: 'yes' } }), Q).eligible, false);
  const discarded = isConvergenceEligible(good({ normalization: { ...trustedNorm, identityDiscarded: true } }), Q);
  assert.equal(discarded.eligible, false);
  assert.equal(discarded.reason, 'identity_derived_from_rejected_normalization');
  assert.equal(isConvergenceEligible(good({ claim: null }), Q).eligible, false);
  assert.equal(isConvergenceEligible(good({ is_load_bearing: null }), Q).eligible, false);
  assert.equal(isConvergenceEligible(good({ claim: 'They won the 2026 final.' }), Q).eligible, false);
  assert.equal(isConvergenceEligible(good({ claim_type: 'OPINION' }), Q).eligible, false);
});

// ---------------- normalization (Tests 5, 6, 7, 9) ----------------

const AMBIG = 'Spain beat Argentina. They lifted the trophy.';
const SOLE = 'Spain won. They lifted the trophy.';

test('Test 5. ambiguous pronoun: "Argentina lifted the trophy." is NOT accepted', () => {
  const r = applySafeNormalization({ claim: 'Argentina lifted the trophy.', originalClaim: 'They lifted the trophy.', sourceText: AMBIG });
  assert.equal(r.status, NORMALIZATION_STATUS.RETAINED_ORIGINAL);
  assert.equal(r.claim, 'They lifted the trophy.');
  assert.equal(r.convergenceTrusted, false);
  assert.equal(r.discardIdentity, true);
  assert.match(r.reason, /^antecedent_not_unambiguous/);
  // even the "right" referent is not provable when two candidates exist
  const spain = applySafeNormalization({ claim: 'Spain lifted the trophy.', originalClaim: 'They lifted the trophy.', sourceText: AMBIG });
  assert.equal(spain.status, NORMALIZATION_STATUS.RETAINED_ORIGINAL);
});

test('Test 6. invented / wrong referent is rejected (name present in source or not)', () => {
  for (const wrong of ['England lifted the trophy.', 'Argentina lifted the trophy.']) {
    const r = applySafeNormalization({ claim: wrong, originalClaim: 'They lifted the trophy.', sourceText: AMBIG });
    assert.equal(r.status, NORMALIZATION_STATUS.RETAINED_ORIGINAL, wrong);
    assert.equal(r.claim, 'They lifted the trophy.');
    assert.equal(r.discardIdentity, true);
  }
  // Even with a single-candidate antecedent, a different entity is not a mechanical substitution.
  const mismatch = applySafeNormalization({ claim: 'England lifted the trophy.', originalClaim: 'They lifted the trophy.', sourceText: SOLE });
  assert.equal(mismatch.status, NORMALIZATION_STATUS.RETAINED_ORIGINAL);
  assert.equal(mismatch.reason, 'rewrite_not_mechanical_substitution_of_antecedent');
  // arbitrary source-word substitution
  const swap = applySafeNormalization({ claim: 'Won lifted the trophy.', originalClaim: 'They lifted the trophy.', sourceText: SOLE });
  assert.equal(swap.status, NORMALIZATION_STATUS.RETAINED_ORIGINAL);
});

test('accepted normalization: sole unambiguous antecedent in the immediately preceding sentence', () => {
  const r = applySafeNormalization({ claim: 'Spain lifted the trophy.', originalClaim: 'They lifted the trophy.', sourceText: SOLE });
  assert.equal(r.status, NORMALIZATION_STATUS.NORMALIZED);
  assert.equal(r.claim, 'Spain lifted the trophy.');
  assert.equal(r.originalClaim, 'They lifted the trophy.');
  assert.equal(r.convergenceTrusted, true);
  assert.equal(r.discardIdentity, false);
});

test('rewrites are rejected when the antecedent is not provably unique or adjacent', () => {
  const rej = (sourceText, claim = 'Spain lifted the trophy.', originalClaim = 'They lifted the trophy.') => applySafeNormalization({ claim, originalClaim, sourceText });
  assert.equal(rej('Spain won.\nThey lifted the trophy.').status, NORMALIZATION_STATUS.RETAINED_ORIGINAL);          // paragraph/line break
  assert.equal(rej('Spain won the final. They lifted the trophy.').status, NORMALIZATION_STATUS.RETAINED_ORIGINAL); // possible 2nd noun phrase
  assert.equal(rej('Spain won, Argentina lost. They lifted the trophy.').status, NORMALIZATION_STATUS.RETAINED_ORIGINAL);
  assert.equal(rej('Spain won. Argentina lost. They lifted the trophy.').status, NORMALIZATION_STATUS.RETAINED_ORIGINAL); // adjacent sentence names someone else
  assert.equal(rej('They lifted the trophy.').status, NORMALIZATION_STATUS.RETAINED_ORIGINAL);                      // no antecedent at all
  assert.equal(rej('Spain won. They lifted the trophy. Later, Spain won. They lifted the trophy.').status, NORMALIZATION_STATUS.RETAINED_ORIGINAL); // non-unique sentence
  assert.equal(rej('Dr. Smith won. They lifted the trophy.', 'Smith lifted the trophy.').status, NORMALIZATION_STATUS.RETAINED_ORIGINAL);
  assert.equal(rej('Spain won. They did not lift the trophy.', 'Spain lifted the trophy.', 'They did not lift the trophy.').status, NORMALIZATION_STATUS.RETAINED_ORIGINAL); // negation dropped
  assert.equal(rej('Spain won. It lifted the trophy.', 'Spain lifted the trophy.', 'It lifted the trophy.').status, NORMALIZATION_STATUS.RETAINED_ORIGINAL); // only "They" is supported
});

test('Test 7. missing / malformed / unverifiable original_claim => not convergence-trusted, claim still kept', () => {
  // rewritten claim, no original_claim
  const missing = applySafeNormalization({ claim: 'Spain lifted the trophy.', originalClaim: undefined, sourceText: SOLE });
  assert.equal(missing.status, NORMALIZATION_STATUS.UNVERIFIED_ORIGIN);
  assert.equal(missing.convergenceTrusted, false);
  assert.equal(missing.claim, 'Spain lifted the trophy.');
  assert.equal(isConvergenceEligible(good({ claim: missing.claim, normalization: { status: missing.status, reason: missing.reason, convergenceTrusted: missing.convergenceTrusted, identityDiscarded: missing.discardIdentity } }), Q).eligible, false);
  // malformed
  for (const bad of [42, '', '   ', {}, []]) {
    const r = applySafeNormalization({ claim: 'Spain lifted the trophy.', originalClaim: bad, sourceText: SOLE });
    assert.equal(r.convergenceTrusted, false, JSON.stringify(bad));
    assert.equal(r.claim, 'Spain lifted the trophy.');
  }
  // original that is not in the source cannot be verified
  const fake = applySafeNormalization({ claim: 'Spain lifted the trophy.', originalClaim: 'They lifted the cup.', sourceText: SOLE });
  assert.equal(fake.status, NORMALIZATION_STATUS.UNVERIFIED_ORIGIN);
  assert.equal(fake.convergenceTrusted, false);
  // verbatim claim with no original is the source wording: trusted
  const verbatim = applySafeNormalization({ claim: 'Spain won.', originalClaim: undefined, sourceText: SOLE });
  assert.equal(verbatim.status, NORMALIZATION_STATUS.UNCHANGED);
  assert.equal(verbatim.convergenceTrusted, true);
  assert.doesNotThrow(() => applySafeNormalization({}));
  assert.doesNotThrow(() => applySafeNormalization());
  assert.equal(applySafeNormalization({ claim: 'Spain won.', originalClaim: 'They won.', sourceText: '' }).convergenceTrusted, false);
});

test('extractClaims: rejected rewrite keeps ORIGINAL text and DISCARDS the rewrite identity; accepted keeps both; zero-claim and garbage unchanged', async () => {
  const spainId = { subject: 'Spain', predicate: 'lift', object: 'the trophy', qualifiers: [], time: null, quantity: null, unit: null, polarity: 'AFFIRMED', modality: 'OCCURRED', relation: 'DESCRIPTIVE' };
  const text = JSON.stringify([
    { claim: 'Spain lifted the trophy.', original_claim: 'They lifted the trophy.', claim_type: 'FACT', is_load_bearing: true, identity: spainId }
  ]);
  const rejected = await extractClaims({ sourceText: AMBIG, coreQuestion: 'q' }, routerReturning(text));
  assert.equal(rejected.claims[0].claim, 'They lifted the trophy.');
  assert.equal(rejected.claims[0].identity, null);
  assert.equal(rejected.claims[0].original_claim, 'They lifted the trophy.');
  assert.equal(rejected.claims[0].normalization.status, NORMALIZATION_STATUS.RETAINED_ORIGINAL);
  assert.equal(rejected.claims[0].normalization.proposedClaim, 'Spain lifted the trophy.');
  assert.equal(rejected.claims[0].normalization.identityDiscarded, true);
  assert.equal(rejected.claims[0].normalization.convergenceTrusted, false);
  const accepted = await extractClaims({ sourceText: SOLE, coreQuestion: 'q' }, routerReturning(text));
  assert.equal(accepted.claims[0].claim, 'Spain lifted the trophy.');
  assert.deepEqual(accepted.claims[0].identity, spainId);
  assert.equal(accepted.claims[0].normalization.convergenceTrusted, true);
  const zero = await extractClaims({ sourceText: SOLE, coreQuestion: 'q' }, routerReturning('[]'));
  assert.equal(zero.diagnostics.parseOutcome, EXTRACTION_PARSE_OUTCOME.PARSED_ZERO_CLAIMS);
  await assert.rejects(() => extractClaims({ sourceText: SOLE, coreQuestion: 'q' }, routerReturning('{not json')), ExtractionFailureError);
});

test('extractClaims: missing original_claim on a non-verbatim claim does not fail the run and is untrusted', async () => {
  const text = JSON.stringify([{ claim: 'Spain lifted the trophy.', claim_type: 'FACT', is_load_bearing: true, identity: null }]);
  const out = await extractClaims({ sourceText: SOLE, coreQuestion: 'q' }, routerReturning(text));
  assert.equal(out.claims.length, 1);
  assert.equal(out.claims[0].claim, 'Spain lifted the trophy.');
  assert.equal(out.claims[0].normalization.convergenceTrusted, false);
  assert.equal(out.claims[0].normalization.status, NORMALIZATION_STATUS.UNVERIFIED_ORIGIN);
});
