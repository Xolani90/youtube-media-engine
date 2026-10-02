import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveClaimIdentity, normalizeClaimIdentity } from '../../src/research/claimIdentity.js';

// Pass 13: a possessive marker inside a qualifier is presentation, not identity.
// Qualifier normalization must not leave a stray "s" token that the claim-side
// grounding tokens never contain, while an absent qualifier stays rejected.
const ident = (over = {}) => ({
  subject: 'Argon', predicate: 'rank', object: null, qualifiers: [], time: null,
  quantity: null, unit: null, polarity: 'AFFIRMED', modality: 'OCCURRED', relation: 'DESCRIPTIVE', ...over
});
const derive = (claim, identity) => deriveClaimIdentity({ claim, claim_type: 'FACT', is_load_bearing: true, identity });

const CURLY = 'On AutomationBench, Zapier\u2019s benchmark measuring end-to-end execution across core business functions, Argon ranks #1 with a score of 51.3%.';
const STRAIGHT = CURLY.replace('\u2019', "'");
const AB = {
  subject: 'argon', predicate: 'ranks', object: '1 with a score of 51 3%', time: null, quantity: 51.3, unit: 'percent'
};
const QUAL = (apos) => `on AutomationBench, Zapier${apos}s benchmark measuring end-to-end execution across core business functions`;

test('A. curly possessive in claim and qualifier grounds and fingerprints', () => {
  const r = derive('Argon beat Zapier\u2019s benchmark.', ident({ qualifiers: ['Zapier\u2019s benchmark'], predicate: 'beat' }));
  assert.equal(r.reason, null);
  assert.match(r.fingerprint, /^[0-9a-f]{64}$/);
});

test('B. straight possessive in claim and qualifier grounds and fingerprints', () => {
  const r = derive("Argon beat Zapier's benchmark.", ident({ qualifiers: ["Zapier's benchmark"], predicate: 'beat' }));
  assert.equal(r.reason, null);
  assert.match(r.fingerprint, /^[0-9a-f]{64}$/);
});

test('C. no possessive anywhere still grounds', () => {
  const r = derive('Argon beat the Zapier benchmark.', ident({ qualifiers: ['Zapier benchmark'], predicate: 'beat' }));
  assert.equal(r.reason, null);
  assert.match(r.fingerprint, /^[0-9a-f]{64}$/);
});

test('curly, straight and possessive-free qualifier forms normalize to one qualifier', () => {
  const q = (x) => normalizeClaimIdentity(ident({ qualifiers: [x] })).identity.qualifiers;
  assert.deepEqual(q('Zapier\u2019s benchmark'), ['zapier benchmark']);
  assert.deepEqual(q("Zapier's benchmark"), ['zapier benchmark']);
  assert.deepEqual(q('Zapier benchmark'), ['zapier benchmark']);
  assert.deepEqual(q('ZAPIER\u2019S  Benchmark'), ['zapier benchmark']);
});

test('D. a qualifier genuinely absent from the claim is still rejected (possessive or not)', () => {
  assert.equal(derive('Argon beat Zapier\u2019s benchmark.', ident({ qualifiers: ['Acme\u2019s leaderboard'], predicate: 'beat' })).reason, 'qualifier_not_grounded');
  assert.equal(derive('Argon beat Zapier\u2019s benchmark.', ident({ qualifiers: ['on penalties'], predicate: 'beat' })).reason, 'qualifier_not_grounded');
  assert.equal(derive('Argon beat a benchmark.', ident({ qualifiers: ['Zapier\u2019s benchmark'], predicate: 'beat' })).reason, 'qualifier_not_grounded');
});

test('E. a possessive does not make the qualifier substring-loose or reorder-tolerant', () => {
  assert.equal(derive('Argon beat Zapier\u2019s benchmark.', ident({ qualifiers: ['benchmark Zapier\u2019s'], predicate: 'beat' })).reason, 'qualifier_not_grounded');
});

test('AutomationBench identity: the qualifier is no longer the rejection reason', () => {
  for (const [claim, apos] of [[CURLY, '\u2019'], [STRAIGHT, "'"]]) {
    const r = derive(claim, { ...AB, qualifiers: [QUAL(apos)], polarity: 'AFFIRMED', modality: 'OCCURRED', relation: 'DESCRIPTIVE' });
    assert.notEqual(r.reason, 'qualifier_not_grounded');
    assert.equal(r.reason, null);
    assert.match(r.fingerprint, /^[0-9a-f]{64}$/);
  }
});
