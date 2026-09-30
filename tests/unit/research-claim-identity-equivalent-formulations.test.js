import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveClaimIdentity } from '../../src/research/claimIdentity.js';

const identity = (over) => ({
  subject: 'invideo', predicate: 'produce', object: 'custom effects', qualifiers: ['GPT-6 Astra', 'daily'], time: null,
  quantity: 50, unit: 'custom effects', polarity: 'AFFIRMED', modality: 'OCCURRED', relation: 'DESCRIPTIVE', ...over
});
const fact = (claim, over) => ({ claim, claim_type: 'FACT', is_load_bearing: true, identity: identity(over) });
const fp = (claim, over) => deriveClaimIdentity(fact(claim, over)).fingerprint;

// Live run (research projects f13f6db4 / 94d76aaa): these two claims state the same proposition
// but were phrased with different per-day qualifiers and different verbs.
const DAILY = 'invideo uses GPT-6 Astra to generate 50 custom effects daily';
const IN_ONE_DAY = 'Invideo produces 50 custom effects in one day using GPT-6 Astra.';

test('Invideo: "daily", "in one day" and "within a single day" resolve to one qualifier', () => {
  const base = fp(DAILY, { predicate: 'generate', qualifiers: ['GPT-6 Astra', 'daily'] });
  assert.notEqual(base, null);
  for (const q of ['in one day', 'In a single day', 'within a single day', 'within one day', 'per day', 'each day', 'every day', 'a day']) {
    assert.equal(fp(IN_ONE_DAY, { predicate: 'produce', qualifiers: ['GPT-6 Astra', q] }), base, q);
  }
});

test('Invideo: generate/generates and produce/produces converge; inflected forms too', () => {
  const base = fp(IN_ONE_DAY, { predicate: 'produce' });
  for (const p of ['produces', 'produced', 'generate', 'generates', 'generated']) {
    assert.equal(fp(IN_ONE_DAY, { predicate: p }), base, p);
  }
});

test('day-frequency normalization is whole-qualifier only and does not merge different scopes', () => {
  const base = fp(IN_ONE_DAY, { qualifiers: ['GPT-6 Astra', 'daily'] });
  for (const q of ['weekly', 'monthly', 'in one day of testing', 'one day', 'single day', 'in two days', 'per week', 'on Mondays']) {
    assert.notEqual(fp(IN_ONE_DAY, { qualifiers: ['GPT-6 Astra', q] }), base, q);
  }
});

test('numeric, entity, polarity and modality safeguards still separate look-alike claims', () => {
  const base = fp(IN_ONE_DAY, {});
  assert.notEqual(fp('Invideo produces 60 custom effects in one day using GPT-6 Astra.', { quantity: 60 }), base);
  assert.notEqual(fp('Globex produces 50 custom effects in one day using GPT-6 Astra.', { subject: 'Globex' }), base);
  assert.notEqual(fp('Invideo does not produce 50 custom effects in one day.', { polarity: 'NEGATED' }), base);
  assert.notEqual(fp('Invideo plans to produce 50 custom effects in one day.', { modality: 'PLANNED' }), base);
  assert.notEqual(fp('Invideo produces 50 custom effects in one day.', { predicate: 'announce' }), base);
  // a dropped or changed number is still untrusted
  assert.equal(deriveClaimIdentity(fact(IN_ONE_DAY, { quantity: 5 })).reason, 'number_not_accounted');
});

test('"as many as 50" is an upper bound: it cannot be labelled OCCURRED, so it never merges with an exact 50', () => {
  const upTo = 'The integration of GPT-6 Astra allows invideo to produce as many as 50 custom effects within a single day.';
  assert.equal(deriveClaimIdentity(fact(upTo, { qualifiers: ['GPT-6 Astra', 'within a single day'] })).reason, 'modality_text_mismatch');
  const bounded = fp(upTo, { qualifiers: ['GPT-6 Astra', 'within a single day'], modality: 'ESTIMATED' });
  assert.notEqual(bounded, null);
  assert.notEqual(bounded, fp(IN_ONE_DAY, { qualifiers: ['GPT-6 Astra', 'in one day'] }));
});

// ---- Dots: negation inside a subject relative clause ----------------------------------------
const dots = (claim, over) => deriveClaimIdentity({
  claim, claim_type: 'FACT', is_load_bearing: true,
  identity: {
    subject: 'Dots', predicate: 'scan', object: 'connected apps', qualifiers: ['using read-only tools that cannot send messages'],
    time: null, quantity: null, unit: null, polarity: 'AFFIRMED', modality: 'OCCURRED', relation: 'DESCRIPTIVE', ...over
  }
});
const DOTS = "In proactive research mode, Dots scan a user's connected apps for ways to help using read-only tools that can't send messages, edit content, or control a computer.";

test('Dots: negation inside a subject relative clause carried by the identity does not veto AFFIRMED', () => {
  const r = dots(DOTS);
  assert.notEqual(r.fingerprint, null, r.reason);
  assert.notEqual(dots("Dots scan connected apps using read-only tools that don't send messages.").fingerprint, null);
  assert.notEqual(dots('Dots scan connected apps using read-only tools which cannot send messages.').fingerprint, null);
});

test('Dots: the relative-clause negation must be carried by the identity, else the veto still applies', () => {
  assert.equal(dots(DOTS, { qualifiers: [] }).reason, 'polarity_text_mismatch');
  assert.equal(dots(DOTS, { qualifiers: ['using read-only tools'] }).reason, 'polarity_text_mismatch');
  // the carried restriction is part of the fingerprint: it is not the same claim as plain "read-only tools"
  assert.notEqual(dots(DOTS).fingerprint, dots('Dots scan connected apps using read-only tools.', { qualifiers: ['using read-only tools'] }).fingerprint);
});

test('Dots: complementizer "that" and main-clause negations are NOT treated as relative clauses', () => {
  // "that it can't" -> complementizer; the negation is the main proposition's
  const reported = 'OpenAI confirmed that it can\'t send messages from Dots.';
  assert.equal(dots(reported, { qualifiers: ['can\'t send messages'] }).reason, 'polarity_text_mismatch');
  // relative-clause negation must not hide a genuine main-clause negation
  assert.equal(dots('Dots do not use read-only tools that can\'t send messages.').reason, 'polarity_text_mismatch');
  assert.equal(dots('Read-only tools that can\'t send messages do not require login.', { qualifiers: ['tools that cannot send messages'] }).reason, 'polarity_text_mismatch');
  // genuinely NEGATED and labelled NEGATED still fingerprints
  assert.notEqual(dots('Dots do not use read-only tools that can\'t send messages.', { polarity: 'NEGATED' }).fingerprint, null);
});
