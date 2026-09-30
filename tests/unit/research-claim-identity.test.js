import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveClaimIdentity, normalizeClaimIdentity, summarizeIdentityCoverage } from '../../src/research/claimIdentity.js';
import { extractClaims } from '../../src/research/claims.js';
import { LLMRouter } from '../../src/providers/llm/router.js';

const ident = (over = {}) => ({
  subject: 'Acme', predicate: 'release', object: 'Widget', qualifiers: [], time: '2026-03',
  quantity: null, unit: null, polarity: 'AFFIRMED', modality: 'OCCURRED', relation: 'DESCRIPTIVE', ...over
});
const fp = (claim, identity, claim_type = 'FACT') => deriveClaimIdentity({ claim, claim_type, is_load_bearing: true, identity }).fingerprint;
const TEXT = 'Acme released Widget in March 2026.';

test('fingerprint is deterministic and insensitive to case, punctuation, corporate suffix and qualifier order', () => {
  const base = fp(TEXT, ident({ qualifiers: ['in Europe', 'Q1 focus'] }));
  assert.match(base, /^[0-9a-f]{64}$/);
  assert.equal(fp('Acme Inc. released the Widget in March 2026 (Europe, Q1 focus).', ident({ subject: 'ACME, Inc.', object: 'the widget', qualifiers: ['q1 focus', 'In Europe'] })), base);
});

test('release and launch converge; announce does NOT converge with release', () => {
  assert.equal(fp(TEXT, ident({ predicate: 'launch' })), fp(TEXT, ident({ predicate: 'release' })));
  assert.notEqual(fp('Acme announced Widget in March 2026.', ident({ predicate: 'announce' })), fp(TEXT, ident()));
});

test('every material field changes the fingerprint', () => {
  const base = fp(TEXT, ident());
  const variants = [
    ident({ subject: 'Globex' }), ident({ object: 'Gadget' }), ident({ time: '2026-04' }), ident({ time: null }),
    ident({ qualifiers: ['in Europe'] }), ident({ modality: 'PLANNED' }), ident({ relation: 'ASSOCIATIVE' })
  ];
  for (const v of variants) {
    // Use text that does not trip the text-consistency guard, to isolate the field.
    const fpv = deriveClaimIdentity({ claim: 'Acme released Widget.', claim_type: 'FACT', identity: v }).fingerprint;
    assert.notEqual(fpv, base);
  }
});

test('non-FACT claims and missing/invalid identities get no fingerprint', () => {
  assert.equal(fp(TEXT, ident(), 'INFERENCE'), null);
  assert.equal(fp(TEXT, ident(), 'OPINION'), null);
  assert.equal(fp(TEXT, null), null);
  assert.equal(fp(TEXT, ident({ polarity: 'MAYBE' })), null);
  assert.equal(fp(TEXT, ident({ time: 'March' })), null);
  assert.equal(fp(TEXT, ident({ subject: '  ' })), null);
  assert.equal(fp(TEXT, ident({ quantity: 5, unit: null })), null);
  assert.equal(fp(TEXT, ident({ quantity: NaN, unit: 'usd' })), null);
  assert.equal(normalizeClaimIdentity([]).ok, false);
});

test('identity that disagrees with its own claim text is untrusted (fail closed)', () => {
  const rev = (q) => ident({ predicate: 'report', object: 'revenue', time: '2025', quantity: q, unit: 'USD' });
  assert.ok(fp('Acme reported $1 billion revenue in 2025.', rev(1e9)));
  assert.equal(fp('Acme reported $2 billion revenue in 2025.', rev(1e9)), null, 'number mismatch');
  assert.equal(fp('Acme reported 1,000 million dollars revenue in 2025.', rev(1e9)), fp('Acme reported $1 billion revenue in 2025.', rev(1e9)), '1,000 million is exactly 1 billion');
  assert.equal(fp('Acme reported $1 billion revenue in 2025 across 40 stores.', rev(1e9)), null, 'unaccounted number');
  assert.equal(fp('Acme reported two billion in revenue in 2025.', rev(2e9)), null, 'spelled number is unverifiable');
  assert.equal(fp('Acme did not release Widget in March 2026.', ident()), null, 'negation cue but AFFIRMED');
  assert.equal(fp('Acme released Widget in April 2026.', ident()), null, 'month mismatch');
  assert.equal(fp('Acme released Widget in March 2026.', ident({ time: '2025-03' })), null, 'year mismatch');
  assert.equal(fp('Acme may release Widget in March 2026.', ident({ modality: 'OCCURRED' })), null, 'hedge but OCCURRED');
  assert.equal(fp('Acme reported more than $1 billion revenue in 2025.', rev(1e9)), null, 'bound but OCCURRED');
  assert.equal(fp('Widget sales rose because Acme released Widget.', ident({ time: null })), null, 'causal cue but DESCRIPTIVE');
  assert.equal(fp('Widget was linked to sales.', ident({ time: null })), null, 'association cue but DESCRIPTIVE');
  assert.equal(fp('Acme released Widget in the third quarter of 2026.', ident({ time: '2026-Q2' })), null, 'quarter mismatch');
  assert.ok(fp('Acme released Widget in the third quarter of 2026.', ident({ time: '2026-Q3' })));
});

test('extractClaims passes the raw identity through, asks for it for FACT claims only, and never lets it replace claim text', async () => {
  let captured = null;
  const registry = {
    'cap-stub': () => ({
      id: 'cap-stub', isPaid: false,
      async healthCheck() { return true; },
      async complete({ prompt }) {
        captured = prompt;
        return {
          text: JSON.stringify([
            { claim: TEXT, claim_type: 'FACT', is_load_bearing: true, identity: ident() },
            { claim: 'Analysts liked it.', claim_type: 'OPINION', is_load_bearing: false },
            { claim: 'Bad shape.', claim_type: 'FACT', is_load_bearing: false, identity: ['not', 'an', 'object'] }
          ]),
          model: 'cap-stub', requestId: null, inputTokens: 1, outputTokens: 1, estimatedCost: 0, isPaid: false
        };
      }
    })
  };
  const router = new LLMRouter({ priority: ['cap-stub'], allowPaidProviders: false, registry });
  const { claims } = await extractClaims({ sourceText: 'x', coreQuestion: 'q' }, router);
  assert.equal(claims[0].claim, TEXT);
  assert.deepEqual(claims[0].identity, ident());
  assert.equal(claims[1].identity, null);
  assert.equal(claims[2].identity, null);
  assert.match(captured, /"identity"/);
  assert.match(captured, /FACT claims ONLY/);
  assert.match(captured, /not.*evidence/i);
});

test('scale words are bound to the exact scale in the text (billion != million)', () => {
  const rev = (q) => ident({ predicate: 'report', object: 'revenue', time: '2025', quantity: q, unit: 'USD' });
  assert.ok(fp('Acme reported $2 billion revenue in 2025.', rev(2e9)));
  assert.ok(fp('Acme reported $2B revenue in 2025.', rev(2e9)));
  assert.ok(fp('Acme reported $1.2 billion revenue in 2025.', rev(1.2e9)));
  assert.ok(fp('Acme reported 1,200 dollars revenue in 2025.', rev(1200)));
  assert.equal(fp('Acme reported $2 billion revenue in 2025.', rev(2e6)), null, 'billion labelled as million');
  assert.equal(fp('Acme reported $2 million revenue in 2025.', rev(2e9)), null, 'million labelled as billion');
  assert.equal(fp('Acme reported $2 revenue in 2025.', rev(2e9)), null, 'bare number scaled up');
});

// ---- Deterministic canonicalization (v2): same proposition, different surface form ----
const REV_TEXT = 'Acme reported $1 billion revenue in 2025.';
const rev = (over = {}) => ident({ predicate: 'report', object: 'revenue', time: '2025', quantity: 1e9, unit: 'USD', ...over });

test('C1. legitimate paraphrases with lexical variance share one identity', () => {
  const base = fp(TEXT, ident());
  assert.equal(fp('Widget was launched by Acme Inc. in March 2026.', ident({ subject: "Acme Inc.", predicate: 'launched', object: 'the Widget' })), base);
  assert.equal(fp(TEXT, ident({ subject: "ACME'S", predicate: 'Releases', object: 'A Widget' })), base);
  assert.equal(fp(TEXT, ident({ predicate: 'Launching' })), base);
  assert.equal(fp(TEXT, ident({ qualifiers: ['in Europe'] })), fp(TEXT, ident({ qualifiers: ['Europe'] })));
});

test('C2. capitalization / punctuation / whitespace do not change identity', () => {
  const base = fp(TEXT, ident({ subject: 'Johnson & Johnson' }));
  assert.equal(fp(TEXT, ident({ subject: '  JOHNSON   and   JOHNSON. ' })), base);
  assert.equal(fp(TEXT, ident({ object: 'GPT-5' })), fp(TEXT, ident({ object: 'gpt 5' })));
});

test('C3. equivalent date forms converge; every accepted form is unambiguous', () => {
  const t = (time, text = TEXT) => fp(text, ident({ time }));
  const month = t('2026-03');
  for (const v of ['March 2026', 'mar 2026', '2026/03', '2026-3', 'March, 2026']) assert.equal(t(v), month, v);
  const dayText = 'Acme released Widget on March 15, 2026.';
  const day = t('2026-03-15', dayText);
  assert.ok(day);
  for (const v of ['March 15, 2026', '15 March 2026', '15th of March 2026', 'Mar 15th, 2026', '2026/3/15']) assert.equal(t(v, dayText), day, v);
  const qText = 'Acme released Widget in the third quarter of 2026.';
  const q = t('2026-Q3', qText);
  assert.ok(q);
  for (const v of ['Q3 2026', '2026 Q3', '2026q3', 'third quarter of 2026', '3Q 2026']) assert.equal(t(v, qText), q, v);
  const hText = 'Acme released Widget in 2026 H1.';
  assert.equal(t('first half of 2026', hText), t('H1 2026', hText));
  // Granularity is part of the proposition: month != day.
  assert.notEqual(month, fp('Acme released Widget on March 15, 2026.', ident({ time: '2026-03-15' })));
  // Ambiguous or impossible dates are rejected, never guessed.
  assert.equal(t('03/04/2026', 'Acme released Widget on 03/04/2026.'), null);
  assert.equal(t('2026-02-30', 'Acme released Widget on 2026-02-30.'), null);
  assert.equal(t('March'), null);
});

test('C4. equivalent unit representations converge (scale folded into quantity)', () => {
  const base = fp(REV_TEXT, rev());
  assert.ok(base);
  assert.equal(fp(REV_TEXT, rev({ unit: '$' })), base);
  assert.equal(fp(REV_TEXT, rev({ unit: 'US dollars' })), base);
  assert.equal(fp(REV_TEXT, rev({ unit: 'usd' })), base);
  assert.equal(fp(REV_TEXT, rev({ quantity: 1, unit: 'billion USD' })), base);
  assert.equal(fp('Acme reported 1,000 million dollars revenue in 2025.', rev({ quantity: 1000, unit: 'million dollars' })), base);
  const emp = (q, u) => fp('Acme employed 500 employees in 2025.', ident({ predicate: 'employ', object: null, time: '2025', quantity: q, unit: u }));
  assert.ok(emp(500, 'employees'));
  assert.equal(emp(500, 'employees'), emp(500, 'Employee'));
  const pct = (u) => fp('Acme raised prices 5% in 2025.', ident({ predicate: 'raise', object: 'prices', time: '2025', quantity: 5, unit: u }));
  assert.ok(pct('%'));
  assert.equal(pct('%'), pct('percent'));
  assert.equal(pct('%'), pct('pct'));
  // Different unit stays different; percentage points are not percent.
  assert.notEqual(pct('%'), pct('percentage points'));
  assert.notEqual(fp('Acme employed 500 employees in 2025.', ident({ predicate: 'employ', object: null, time: '2025', quantity: 500, unit: 'contractors' })), emp(500, 'employees'));
});

test('C5. different number => different identity (and a mis-scaled unit is untrusted, not merged)', () => {
  assert.ok(fp('Acme reported $2 billion revenue in 2025.', rev({ quantity: 2e9 })));
  assert.notEqual(fp('Acme reported $2 billion revenue in 2025.', rev({ quantity: 2e9 })), fp(REV_TEXT, rev()));
  assert.equal(fp(REV_TEXT, rev({ quantity: 1e9, unit: 'billion USD' })), null, 'double-scaled quantity disagrees with text');
  assert.equal(fp('Acme reported $1 million revenue in 2025.', rev()), null, 'million text vs billion quantity');
});

test('C6. different date => different identity', () => {
  assert.notEqual(fp('Acme released Widget in April 2026.', ident({ time: 'April 2026' })), fp(TEXT, ident({ time: 'March 2026' })));
  assert.notEqual(fp(TEXT, ident({ time: '2026-03' })), fp('Acme released Widget in March 2025.', ident({ time: '2025-03' })));
  assert.notEqual(fp('Acme released Widget in Q3 2026.', ident({ time: 'Q3 2026' })), fp('Acme released Widget in Q2 2026.', ident({ time: 'Q2 2026' })));
});

test('C7. negated vs affirmed => different identity, and mislabelling either way is untrusted', () => {
  const affirmed = fp(TEXT, ident());
  const negated = fp('Acme did not release Widget in March 2026.', ident({ polarity: 'NEGATED' }));
  assert.ok(affirmed && negated);
  assert.notEqual(affirmed, negated);
  assert.equal(fp('Acme did not release Widget in March 2026.', ident()), null);
  assert.equal(fp(TEXT, ident({ polarity: 'NEGATED' })), null);
});

test('C8. causal vs associative vs descriptive => different identity', () => {
  const causal = fp('Widget sales rose because Acme released Widget.', ident({ time: null, relation: 'CAUSAL' }));
  const assoc = fp('Widget sales rose, associated with Acme releasing Widget.', ident({ time: null, relation: 'ASSOCIATIVE' }));
  const desc = fp('Widget sales rose after Acme released Widget.', ident({ time: null }));
  assert.ok(causal && assoc && desc);
  assert.equal(new Set([causal, assoc, desc]).size, 3);
});

test('C9. planned / estimated / announced vs occurred => different identity', () => {
  const occurred = fp(TEXT, ident());
  const planned = fp('Acme plans to release Widget in March 2026.', ident({ modality: 'PLANNED' }));
  const possible = fp('Acme may release Widget in March 2026.', ident({ modality: 'POSSIBLE' }));
  assert.ok(occurred && planned && possible);
  assert.equal(new Set([occurred, planned, possible]).size, 3);
  assert.equal(fp('Acme plans to release Widget in March 2026.', ident()), null, 'hedged text labelled OCCURRED is untrusted');
});

test('C10. different entity / object / materially different predicate => different identity', () => {
  const base = fp(TEXT, ident());
  assert.notEqual(fp(TEXT, ident({ subject: 'Globex' })), base);
  assert.notEqual(fp(TEXT, ident({ subject: 'Acme Labs' })), base);
  assert.notEqual(fp(TEXT, ident({ object: 'Widget Pro' })), base);
  assert.notEqual(fp(TEXT, ident({ predicate: 'acquire' })), base);
  assert.notEqual(fp(TEXT, ident({ predicate: 'announced' })), base, 'announce != release');
  // Only whitelisted verbs are lemmatized; unlisted forms must match exactly.
  assert.notEqual(fp(TEXT, ident({ predicate: 'acquisition' })), fp(TEXT, ident({ predicate: 'acquire' })));
  assert.notEqual(fp(TEXT, ident({ predicate: 'unveiled' })), base);
});

test('D1. summarizeIdentityCoverage classifies every FACT claim exactly once; non-FACT is ignored; unchanged fail-closed behavior', () => {
  const claims = [
    { claim: TEXT, claim_type: 'FACT', identity: ident() },                                   // fingerprinted
    { claim: 'Acme released Gadget in March 2026.', claim_type: 'FACT', identity: null },     // missing
    { claim: 'Acme released Widget in 2026.', claim_type: 'FACT', identity: ident({ polarity: 'MAYBE' }) }, // malformed
    { claim: 'Acme did not release Widget in March 2026.', claim_type: 'FACT', identity: ident() },          // inconsistent (negation)
    { claim: 'Analysts liked it.', claim_type: 'OPINION', identity: ident() },                // ignored
    { claim: 'It may follow.', claim_type: 'INFERENCE', identity: null }                      // ignored
  ];
  assert.deepEqual(summarizeIdentityCoverage(claims), {
    factClaims: 4, fingerprinted: 1, missing: 1, malformed: 1, inconsistent: 1,
    reasons: { identity_missing: 1, identity_polarity_invalid: 1, polarity_text_mismatch: 1 }
  });
  assert.deepEqual(summarizeIdentityCoverage(null), { factClaims: 0, fingerprinted: 0, missing: 0, malformed: 0, inconsistent: 0, reasons: {} });
  // The summary reports; it never changes derivation.
  assert.equal(deriveClaimIdentity(claims[1]).fingerprint, null);
  assert.equal(deriveClaimIdentity(claims[4]).fingerprint, null);
});
