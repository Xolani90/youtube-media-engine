import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveOriginalityText, hasNoRepresentation, NO_REPRESENTATION } from '../../src/originality/representation.js';
import { tokenize, jaccardSimilarity } from '../../src/discovery/similarity.js';

function structuredBody(overrides = {}) {
  return JSON.stringify({
    hook: 'A hook sentence.',
    narrative: 'A narrative paragraph.',
    sections: [
      { heading: 'First heading', content: 'First section content.', claim_ids: ['c1'] },
      { heading: 'Second heading', content: 'Second section content.', claim_ids: [] }
    ],
    counterpoints: 'Some counterpoints.',
    conclusion: 'A conclusion.',
    call_to_action: null,
    ...overrides
  });
}

// T-01 — Structured representation uses exactly the five defined sources.
test('T-01: structured representation is built from exactly hook, narrative, section content, counterpoints, conclusion', () => {
  const text = deriveOriginalityText(structuredBody());
  assert.equal(
    text,
    'A hook sentence. A narrative paragraph. First section content. Second section content. Some counterpoints. A conclusion.'
  );
});

// T-02 — Section content order is preserved.
test('T-02: section content appears in persisted array order', () => {
  const body = structuredBody({
    sections: [
      { heading: 'H1', content: 'ALPHA', claim_ids: [] },
      { heading: 'H2', content: 'BETA', claim_ids: [] },
      { heading: 'H3', content: 'GAMMA', claim_ids: [] }
    ]
  });
  const text = deriveOriginalityText(body);
  assert.ok(text.indexOf('ALPHA') < text.indexOf('BETA'));
  assert.ok(text.indexOf('BETA') < text.indexOf('GAMMA'));
});

// T-03 — Heading exclusion.
test('T-03: changing a section heading does not change the representation', () => {
  const a = deriveOriginalityText(structuredBody({ sections: [{ heading: 'Heading One', content: 'Same content.', claim_ids: [] }] }));
  const b = deriveOriginalityText(structuredBody({ sections: [{ heading: 'Totally Different Heading', content: 'Same content.', claim_ids: [] }] }));
  assert.equal(a, b);
});

// T-04 — Serialization-format invariance.
test('T-04: compact vs indented JSON produce equivalent Originality Text', () => {
  const obj = JSON.parse(structuredBody());
  const compact = JSON.stringify(obj);
  const indented = JSON.stringify(obj, null, 2);
  assert.equal(deriveOriginalityText(compact), deriveOriginalityText(indented));
});

test('T-04: whitespace between JSON tokens does not change Originality Text', () => {
  const compact = '{"hook":"H.","narrative":"N.","sections":[{"heading":"S","content":"C.","claim_ids":[]}],"counterpoints":"P.","conclusion":"Cn.","call_to_action":null}';
  const spaced = '{ "hook" : "H." , "narrative" : "N." , "sections" : [ { "heading" : "S" , "content" : "C." , "claim_ids" : [ ] } ] , "counterpoints" : "P." , "conclusion" : "Cn." , "call_to_action" : null }';
  assert.equal(deriveOriginalityText(compact), deriveOriginalityText(spaced));
});

test('T-04: equivalent JSON escaping decodes to equivalent Originality Text', () => {
  const escaped = '{"hook":"H\\u0041.","narrative":"N.","sections":[{"heading":"S","content":"C.","claim_ids":[]}],"counterpoints":"P.","conclusion":"Cn.","call_to_action":null}';
  const literal = '{"hook":"HA.","narrative":"N.","sections":[{"heading":"S","content":"C.","claim_ids":[]}],"counterpoints":"P.","conclusion":"Cn.","call_to_action":null}';
  assert.equal(deriveOriginalityText(escaped), deriveOriginalityText(literal));
});

// T-05 — Claim-ID exclusion.
test('T-05: changing claim_ids does not change the representation', () => {
  const a = deriveOriginalityText(structuredBody({ sections: [{ heading: 'H', content: 'Same content.', claim_ids: ['x', 'y'] }] }));
  const b = deriveOriginalityText(structuredBody({ sections: [{ heading: 'H', content: 'Same content.', claim_ids: ['completely-different-marker'] }] }));
  assert.equal(a, b);
});

// T-06 — CTA exclusion.
test('T-06: changing call_to_action does not change the representation', () => {
  const withNullCta = deriveOriginalityText(structuredBody({ call_to_action: null }));
  const withCta = deriveOriginalityText(structuredBody({ call_to_action: 'Subscribe now for more unique marker text zzqx.' }));
  assert.equal(withNullCta, withCta);
});

// T-07 — Unknown-property exclusion.
test('T-07: an unlisted property does not change the representation or similarity', () => {
  const a = deriveOriginalityText(structuredBody());
  const b = deriveOriginalityText(structuredBody({ extra_unlisted_field: 'zzqx marker text that would change tokens if included' }));
  assert.equal(a, b);
  assert.equal(jaccardSimilarity(tokenize(a), tokenize(b)), 1);
});

// T-08 — Field coverage.
test('T-08: each of the five defined content sources contributes to the Originality Text', () => {
  const base = structuredBody();
  const baseText = deriveOriginalityText(base);
  const fields = ['hook', 'narrative', 'counterpoints', 'conclusion'];
  for (const field of fields) {
    const changed = deriveOriginalityText(structuredBody({ [field]: 'UNIQUEMARKERZZQX' }));
    assert.notEqual(changed, baseText, `expected changing ${field} to change the representation`);
    assert.ok(changed.includes('UNIQUEMARKERZZQX'), `expected ${field} to contribute to the representation`);
  }
  const sectionChanged = deriveOriginalityText(structuredBody({ sections: [{ heading: 'H', content: 'UNIQUEMARKERZZQX', claim_ids: [] }] }));
  assert.ok(sectionChanged.includes('UNIQUEMARKERZZQX'), 'expected section content to contribute to the representation');
});

// T-09 — Substantive field-change measurement with controlled fixtures.
test('T-09: replacing one field with unique marker vocabulary produces an exact, sub-1.0 Jaccard result', () => {
  const original = structuredBody({
    hook: 'alpha bravo charlie',
    narrative: 'delta echo foxtrot',
    sections: [{ heading: 'H', content: 'golf hotel india', claim_ids: [] }],
    counterpoints: 'juliet kilo lima',
    conclusion: 'mike november oscar'
  });
  const changed = structuredBody({
    hook: 'papa quebec romeo',
    narrative: 'delta echo foxtrot',
    sections: [{ heading: 'H', content: 'golf hotel india', claim_ids: [] }],
    counterpoints: 'juliet kilo lima',
    conclusion: 'mike november oscar'
  });

  const originalTokens = tokenize(deriveOriginalityText(original));
  const changedTokens = tokenize(deriveOriginalityText(changed));
  const sim = jaccardSimilarity(originalTokens, changedTokens);

  // 15 tokens each, 3 replaced (hook) -> 12 shared, union = 15+15-12=18.
  assert.equal(sim, 12 / 18);
  assert.ok(sim < 1.0);
});

// T-10 — Legacy prose.
test('T-10: a non-structured body is treated as legacy prose, unchanged', () => {
  const body = 'This is a plain legacy prose script body, not JSON at all.';
  assert.equal(deriveOriginalityText(body), body);
});

// T-11 — Array-start classification.
test('T-11: a body beginning with "[" has no representation and is never legacy prose', () => {
  const body = '["not", "an", "object"]';
  assert.equal(deriveOriginalityText(body), NO_REPRESENTATION);
  assert.ok(hasNoRepresentation(body));
});

// T-12 — Invalid structured candidate.
test('T-12: malformed JSON beginning with "{" has no representation and does not fall back to prose', () => {
  const body = '{ this is not valid JSON ';
  assert.equal(deriveOriginalityText(body), NO_REPRESENTATION);
});

test('T-12: a "{" body that parses but fails Structured Form validation has no representation', () => {
  const missingHook = JSON.stringify({
    narrative: 'N',
    sections: [{ heading: 'H', content: 'C', claim_ids: [] }],
    counterpoints: 'P',
    conclusion: 'Cn'
  });
  assert.equal(deriveOriginalityText(missingHook), NO_REPRESENTATION);

  const emptySections = JSON.stringify({
    hook: 'H', narrative: 'N', sections: [], counterpoints: 'P', conclusion: 'Cn'
  });
  assert.equal(deriveOriginalityText(emptySections), NO_REPRESENTATION);

  const invalidClaimIds = JSON.stringify({
    hook: 'H', narrative: 'N',
    sections: [{ heading: 'H', content: 'C', claim_ids: 'not-an-array' }],
    counterpoints: 'P', conclusion: 'Cn'
  });
  assert.equal(deriveOriginalityText(invalidClaimIds), NO_REPRESENTATION);
});

// Empty body classification.
test('empty body has no representation', () => {
  assert.equal(deriveOriginalityText(''), NO_REPRESENTATION);
  assert.equal(deriveOriginalityText('   '), NO_REPRESENTATION);
});

// Tokenizer boundary (T-20 supporting check at the unit level): this
// module never touches src/discovery/similarity.js's exports beyond
// calling them as an ordinary consumer, same as before this ADR.
test('representation module does not alter tokenizer behavior for legacy prose', () => {
  const body = 'OpenAI releases new model for businesses';
  assert.deepEqual(tokenize(deriveOriginalityText(body)), tokenize(body));
});
