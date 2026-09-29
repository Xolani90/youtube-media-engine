import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveClaimIdentity, normalizeClaimIdentity } from '../../src/research/claimIdentity.js';
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
