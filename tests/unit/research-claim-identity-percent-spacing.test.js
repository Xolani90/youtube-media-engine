import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { IDENTITY_VERSION, deriveClaimIdentity, identityGroundingConflict, normalizeClaimIdentity } from '../../src/research/claimIdentity.js';

// Pass 17: "51.3%" and "51.3 %" are one spelling of the same percentage. The
// percent sign is kept as part of a token while "." is not, so the two used to
// tokenize as ["51","3%"] vs ["51","3","%"]: a claim and its own identity that
// differed only in that whitespace failed grounding and fingerprinted
// differently. The rule is exactly: ASCII digit + whitespace + "%" -> digit + "%".
// It deliberately does NOT touch "$", "percent"/"pct"/"per cent" (distinct unit
// spellings), a "%" in front of a number, or digits separated from each other.
const ident = (over = {}) => ({
  subject: 'Argon', predicate: 'score', object: null, qualifiers: [], time: null,
  quantity: null, unit: null, polarity: 'AFFIRMED', modality: 'OCCURRED', relation: 'DESCRIPTIVE', ...over
});
const derive = (claim, identity) => deriveClaimIdentity({ claim, claim_type: 'FACT', is_load_bearing: true, identity });
const norm = (raw) => normalizeClaimIdentity(raw).identity;
const HEX = /^[0-9a-f]{64}$/;

// Whitespace forms repository text normalization already treats as whitespace.
const SPACED = ['51.3 %', '51.3  %', '51.3\t%', '51.3\u00A0%', '51.3\u2009%', '51.3\n%'];

// ---- Grounding symmetry --------------------------------------------------

test('object: spaced identity grounds against unspaced claim text, and the reverse', () => {
  const a = derive('Argon scored 51.3% overall.', ident({ object: '51.3 %' }));
  assert.equal(a.reason, null);
  assert.match(a.fingerprint, HEX);
  const b = derive('Argon scored 51.3 % overall.', ident({ object: '51.3%' }));
  assert.equal(b.reason, null);
  assert.match(b.fingerprint, HEX);
  // the exported grounding helper agrees, independent of the other validators
  assert.equal(identityGroundingConflict('Argon scored 51.3% overall.', norm(ident({ object: '51.3 %' })), null), null);
  assert.equal(identityGroundingConflict('Argon scored 51.3 % overall.', norm(ident({ object: '51.3%' })), null), null);
});

test('object: every whitespace form grounds against the unspaced form, in both directions', () => {
  for (const spaced of SPACED) {
    const forward = derive('Argon scored 51.3% overall.', ident({ object: spaced }));
    assert.equal(forward.reason, null, JSON.stringify(spaced));
    const reverse = derive(`Argon scored ${spaced} overall.`, ident({ object: '51.3%' }));
    assert.equal(reverse.reason, null, JSON.stringify(spaced));
    assert.equal(forward.fingerprint, reverse.fingerprint);
  }
});

test('qualifier: spaced identity grounds against unspaced claim text, and the reverse', () => {
  const a = derive('Argon topped the 51.3% tier.', ident({ predicate: 'top', qualifiers: ['the 51.3 % tier'] }));
  assert.equal(a.reason, null);
  assert.match(a.fingerprint, HEX);
  const b = derive('Argon topped the 51.3 % tier.', ident({ predicate: 'top', qualifiers: ['the 51.3% tier'] }));
  assert.equal(b.reason, null);
  assert.match(b.fingerprint, HEX);
  assert.equal(a.fingerprint, b.fingerprint);
  assert.equal(identityGroundingConflict('Argon topped the 51.3% tier.', norm(ident({ predicate: 'top', qualifiers: ['51.3 % tier'] })), null), null);
  assert.equal(identityGroundingConflict('Argon topped the 51.3 % tier.', norm(ident({ predicate: 'top', qualifiers: ['51.3% tier'] })), null), null);
});

test('subject: spaced identity grounds against unspaced claim text, and the reverse', () => {
  const a = derive('The 51.3% benchmark improved.', ident({ subject: '51.3 % benchmark', predicate: 'improve' }));
  assert.equal(a.reason, null);
  assert.match(a.fingerprint, HEX);
  const b = derive('The 51.3 % benchmark improved.', ident({ subject: '51.3% benchmark', predicate: 'improve' }));
  assert.equal(b.reason, null);
  assert.match(b.fingerprint, HEX);
  assert.equal(a.fingerprint, b.fingerprint);
  assert.equal(identityGroundingConflict('The 51.3% benchmark improved.', norm(ident({ subject: '51.3 % benchmark', predicate: 'improve' })), null), null);
  assert.equal(identityGroundingConflict('The 51.3 % benchmark improved.', norm(ident({ subject: '51.3% benchmark', predicate: 'improve' })), null), null);
});

test('the relative-negation accounting path is symmetric too (it also compares normalized text)', () => {
  const text = (p) => `Argon has a rate that isn't above 51${p} today`;
  const id = (p) => ident({ predicate: 'have', object: 'rate', qualifiers: [`isn't above 51${p} today`] });
  const base = derive(text('%'), id('%'));
  assert.equal(base.reason, null);
  for (const [t, i] of [[' %', ' %'], [' %', '%'], ['%', ' %']]) {
    const r = derive(text(t), id(i));
    assert.equal(r.reason, null, `claim ${JSON.stringify(t)} / identity ${JSON.stringify(i)}`);
    assert.equal(r.fingerprint, base.fingerprint);
  }
});

// ---- Canonical fingerprint equivalence ------------------------------------

test('spaced and unspaced percentages normalize to one canonical identity string', () => {
  const unspaced = norm(ident({ object: '51.3%', quantity: 51.3, unit: '%' }));
  assert.equal(unspaced.object, '51 3%');
  for (const spaced of SPACED) {
    assert.deepEqual(norm(ident({ object: spaced, quantity: 51.3, unit: '%' })), unspaced, JSON.stringify(spaced));
    assert.deepEqual(norm(ident({ qualifiers: [spaced] })).qualifiers, ['51 3%'], JSON.stringify(spaced));
    assert.equal(norm(ident({ subject: spaced })).subject, '51 3%', JSON.stringify(spaced));
  }
});

test('identities that differ only in digit<whitespace>% produce the same fingerprint', () => {
  const unspaced = derive('Argon scored 51.3% overall.', ident({ object: '51.3%', quantity: 51.3, unit: '%' }));
  assert.equal(unspaced.reason, null);
  for (const spaced of SPACED) {
    const r = derive(`Argon scored ${spaced} overall.`, ident({ object: spaced, quantity: 51.3, unit: '%' }));
    assert.equal(r.reason, null, JSON.stringify(spaced));
    assert.equal(r.fingerprint, unspaced.fingerprint, JSON.stringify(spaced));
  }
  // claim and identity spelled differently still land on the very same fingerprint
  assert.equal(derive('Argon scored 51.3 % overall.', ident({ object: '51.3%', quantity: 51.3, unit: '%' })).fingerprint, unspaced.fingerprint);
  assert.equal(derive('Argon scored 51.3% overall.', ident({ object: '51.3 %', quantity: 51.3, unit: '%' })).fingerprint, unspaced.fingerprint);
});

test('the fingerprint is the documented canonical construction over the canonicalized fields', () => {
  const expected = crypto.createHash('sha256').update(JSON.stringify([
    IDENTITY_VERSION, 'argon', 'score', '51 3%', [], null, 51.3, 'percent', 'AFFIRMED', 'OCCURRED', 'DESCRIPTIVE'
  ])).digest('hex');
  assert.equal(derive('Argon scored 51.3% overall.', ident({ object: '51.3%', quantity: 51.3, unit: '%' })).fingerprint, expected);
  assert.equal(derive('Argon scored 51.3 % overall.', ident({ object: '51.3 %', quantity: 51.3, unit: '%' })).fingerprint, expected);
});

// ---- Negative cases: nothing else collapses -------------------------------

const NEGATIVES = ['51.3 percent', '51.3 pct', '51.3 per cent', '%51.3', '5 1.3%'];

test('percent / pct / per cent, a leading %, and split digits stay distinct from 51.3%', () => {
  const base = norm(ident({ object: '51.3%' })).object;
  assert.equal(base, '51 3%');
  const seen = new Set([base]);
  for (const n of NEGATIVES) {
    const o = norm(ident({ object: n })).object;
    assert.notEqual(o, base, n);
    assert.ok(!seen.has(o), `${n} collapsed into another spelling`);
    seen.add(o);
  }
  assert.deepEqual(NEGATIVES.map((n) => norm(ident({ object: n })).object), ['51 3 percent', '51 3 pct', '51 3 per cent', '%51 3', '5 1 3%']);
  // and the fingerprints stay distinct as well (self-consistent claim + identity)
  const fps = ['51.3%', '51.3 %', ...NEGATIVES].map((o) => derive(`Argon scored ${o} overall.`, ident({ object: o })).fingerprint);
  assert.ok(fps.every((f) => HEX.test(f)));
  assert.equal(new Set(fps).size, fps.length - 1, 'only 51.3% and 51.3 % may share a fingerprint');
  assert.equal(fps[0], fps[1]);
});

test('a different spelling in the identity still fails grounding against 51.3%, in both directions', () => {
  const expected = { '51.3 percent': 'object_not_grounded', '51.3 pct': 'object_not_grounded', '51.3 per cent': 'object_not_grounded', '%51.3': 'object_not_grounded', '5 1.3%': 'number_not_accounted' };
  for (const n of NEGATIVES) {
    const forward = derive('Argon scored 51.3% overall.', ident({ object: n }));
    assert.equal(forward.fingerprint, null, n);
    assert.equal(forward.reason, expected[n], n);
    const reverse = derive(`Argon scored ${n} overall.`, ident({ object: '51.3%' }));
    assert.equal(reverse.fingerprint, null, n);
    assert.ok(reverse.reason, n);
  }
});

test('"$" is not canonicalized by this rule', () => {
  assert.notEqual(norm(ident({ object: '$ 5' })).object, norm(ident({ object: '$5' })).object);
  assert.notEqual(norm(ident({ object: '$5' })).object, norm(ident({ object: '5' })).object);
  assert.equal(norm(ident({ object: '$5 %' })).object, '$5%'); // only the digit<ws>% adjacency is collapsed
});

test('only a literal digit<whitespace>% adjacency collapses; punctuation between them is not whitespace', () => {
  assert.equal(norm(ident({ object: '(5)%' })).object, '5 %'); // unchanged from before this fix
  assert.notEqual(norm(ident({ object: '(5)%' })).object, norm(ident({ object: '5%' })).object);
  assert.notEqual(norm(ident({ object: 'a %' })).object, norm(ident({ object: 'a%' })).object); // not preceded by a digit
});

// ---- Numeric safety -------------------------------------------------------

test('the correct structured quantity still passes, with either spelling', () => {
  for (const sp of ['%', ' %']) {
    for (const unit of ['%', 'percent']) {
      const r = derive(`Argon scored 51.3${sp} overall.`, ident({ object: 'overall', quantity: 51.3, unit }));
      assert.equal(r.reason, null, `${sp}/${unit}`);
      assert.equal(r.identity.quantity, 51.3);
      assert.equal(r.identity.unit, 'percent');
    }
  }
  assert.equal(norm(ident({ quantity: 51.3, unit: '%' })).unit, 'percent');
  assert.equal(norm(ident({ quantity: 51.3, unit: '%' })).quantity, 51.3);
});

test('a missing number still fails, with either spelling', () => {
  for (const sp of ['%', ' %']) {
    assert.equal(derive(`Argon scored 51.3${sp} overall.`, ident({ object: 'overall' })).reason, 'number_not_accounted', sp);
  }
});

test('a wrong number still fails, with either spelling', () => {
  for (const sp of ['%', ' %']) {
    assert.equal(derive(`Argon scored 51.3${sp} overall.`, ident({ object: 'overall', quantity: 52.3, unit: '%' })).reason, 'number_not_accounted', `qty ${sp}`);
    assert.equal(derive(`Argon scored 51.3${sp} overall.`, ident({ object: `52.3${sp}` })).reason, 'number_not_accounted', `object ${sp}`);
  }
});

// ---- Existing behavior ----------------------------------------------------

test('Pass 13 possessive behavior and the pinned "score of 51 3%" form are unchanged', () => {
  const CURLY = 'On AutomationBench, Zapier\u2019s benchmark measuring end-to-end execution across core business functions, Argon ranks #1 with a score of 51.3%.';
  const STRAIGHT = CURLY.replace('\u2019', "'");
  const AB = { subject: 'argon', predicate: 'ranks', object: '1 with a score of 51 3%', time: null, quantity: 51.3, unit: 'percent' };
  const QUAL = (apos) => `on AutomationBench, Zapier${apos}s benchmark measuring end-to-end execution across core business functions`;
  const PINNED = '1 with a score of 51 3%';
  // the pinned normalized form is stable, and the spaced raw spelling lands on exactly that form
  assert.equal(norm({ ...AB, qualifiers: [], polarity: 'AFFIRMED', modality: 'OCCURRED', relation: 'DESCRIPTIVE' }).object, PINNED);
  for (const raw of ['#1 with a score of 51.3%', '#1 with a score of 51.3 %']) {
    assert.equal(norm({ ...AB, object: raw, qualifiers: [], polarity: 'AFFIRMED', modality: 'OCCURRED', relation: 'DESCRIPTIVE' }).object, PINNED, raw);
  }
  let first = null;
  for (const [claim, apos] of [[CURLY, '\u2019'], [STRAIGHT, "'"]]) {
    for (const object of [AB.object, '#1 with a score of 51.3 %']) {
      const r = derive(claim, { ...AB, object, qualifiers: [QUAL(apos)], polarity: 'AFFIRMED', modality: 'OCCURRED', relation: 'DESCRIPTIVE' });
      assert.equal(r.reason, null);
      assert.match(r.fingerprint, HEX);
      first ??= r.fingerprint;
      assert.equal(r.fingerprint, first);
    }
  }
  assert.equal(norm(ident({ qualifiers: ['Zapier\u2019s benchmark'] })).qualifiers[0], 'zapier benchmark');
});
