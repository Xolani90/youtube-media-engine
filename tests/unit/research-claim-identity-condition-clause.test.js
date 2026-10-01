import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveClaimIdentity } from '../../src/research/claimIdentity.js';

const identity = (over) => ({
  subject: 'Dots', predicate: 'perform', object: 'proactive research', qualifiers: [], time: null,
  quantity: null, unit: null, polarity: 'AFFIRMED', modality: 'OCCURRED', relation: 'DESCRIPTIVE', ...over
});
const fact = (claim, over) => ({ claim, claim_type: 'FACT', is_load_bearing: true, identity: identity(over) });

// Live run 36638966984 (Dots): pulse2, pcmag and zdnet all state this proposition, and each
// contains a negation only inside the "when you aren't actively working" clause.
test('negation inside a when/while/if clause does not veto a correctly AFFIRMED identity', () => {
  for (const claim of [
    "Proactive research lets a dot look for ways to help when you aren't actively working with it.",
    'A Dot performs proactive research when a user is not actively working with it.',
    "When you aren't actively working with it, a dot performs proactive research.",
    'A Dot keeps performing proactive research even when the user is not interacting with it.'
  ]) {
    const r = deriveClaimIdentity(fact(claim));
    assert.notEqual(r.fingerprint, null, `${claim} -> ${r.reason}`);
  }
});

test('the polarity veto stays two-way: mislabelling either way is still untrusted', () => {
  // clause-only negation labelled NEGATED is a mislabel
  assert.equal(deriveClaimIdentity(fact('A Dot performs proactive research when a user is not actively working.', { polarity: 'NEGATED' })).reason, 'polarity_text_mismatch');
  // main-clause negation labelled AFFIRMED is a mislabel, with or without a trailing clause
  assert.equal(deriveClaimIdentity(fact('OpenAI does not train on proactive research.')).reason, 'polarity_text_mismatch');
  assert.equal(deriveClaimIdentity(fact('Dots do not run when the laptop is offline.')).reason, 'polarity_text_mismatch');
  assert.equal(deriveClaimIdentity(fact("When the laptop is offline, Dots don't run.")).reason, 'polarity_text_mismatch');
  // genuinely negated and labelled NEGATED still gets a fingerprint
  assert.notEqual(deriveClaimIdentity(fact('OpenAI does not train on proactive research.', { polarity: 'NEGATED', subject: 'OpenAI' })).fingerprint, null);
});
