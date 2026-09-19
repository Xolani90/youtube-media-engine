import { test } from 'node:test';
import assert from 'node:assert/strict';

import { scriptBodyToNarrationText, ScriptBodyContractError } from '../../src/media/scriptText.js';
import { segmentCaptions } from '../../src/media/captionTiming.js';
import { validateGeneratedScript } from '../../src/script/generate.js';

// A generated script exactly as the Script stage produces it: the parsed
// LLM object is validated by validateGeneratedScript(), then persisted as
// JSON.stringify({hook, narrative, sections, counterpoints, conclusion,
// call_to_action}) -- see src/script/pipeline.js.
const generated = {
  hook: 'Did you know octopuses have three hearts?',
  narrative: 'A short story about cephalopods',
  sections: [
    { heading: 'The hearts', content: 'Two pump blood to the gills, one to the body.', claim_ids: ['c1'] },
    { heading: 'Why it matters', content: 'Cold water carries less oxygen.', claim_ids: ['c2', 'c3'] }
  ],
  counterpoints: 'Some sources dispute the exact figures.',
  conclusion: 'Nature is strange.',
  call_to_action: null
};

function persistedBody(overrides = {}) {
  const g = { ...generated, ...overrides };
  return JSON.stringify({
    hook: g.hook,
    narrative: g.narrative,
    sections: g.sections,
    counterpoints: g.counterpoints,
    conclusion: g.conclusion,
    call_to_action: g.call_to_action
  });
}

test('fixture is a valid generated script per the Script stage\'s own validator', () => {
  assert.equal(validateGeneratedScript(generated, { allowCallToAction: false }).valid, true);
  assert.equal(
    validateGeneratedScript({ ...generated, call_to_action: 'Subscribe.' }, { allowCallToAction: true }).valid,
    true
  );
});

// --- Test 1: structured script -> narration text -----

test('Test 1: structured script body converts to human-readable narration prose, not JSON', () => {
  const text = scriptBodyToNarrationText(persistedBody());
  assert.equal(typeof text, 'string');
  for (const jsonSyntax of ['{', '}', '[', ']', '":', '"hook"', '"sections"', 'claim_ids', 'call_to_action']) {
    assert.ok(!text.includes(jsonSyntax), `narration text must not contain JSON syntax ${JSON.stringify(jsonSyntax)}`);
  }
  assert.ok(text.includes('Did you know octopuses have three hearts?'));
});

// --- Test 2: structured script -> caption text -----

test('Test 2: segmentCaptions over the converted text yields prose captions, no JSON syntax', () => {
  const captions = segmentCaptions(scriptBodyToNarrationText(persistedBody()), 80);
  assert.ok(captions.length > 0);
  for (const caption of captions) {
    assert.ok(!/[{}[\]]|":|\\"/.test(caption), `caption contains JSON syntax: ${JSON.stringify(caption)}`);
  }
  assert.equal(captions[0], 'Did you know octopuses have three hearts?');
});

test('Test 2 (regression proof): the SAME body passed unconverted reproduces the audited defect', () => {
  // Documents the pre-fix behavior at the exact boundary that was defective.
  const raw = segmentCaptions(persistedBody(), 80);
  assert.ok(raw.some((c) => c.includes('{"hook"') || c.includes('\\"') || c.includes('":')));
});

// --- Test 3: content preservation and order -----

test('Test 3: every generated field survives conversion, in generated order', () => {
  const text = scriptBodyToNarrationText(persistedBody());
  const markers = [
    'Did you know octopuses have three hearts?',                 // hook
    'A short story about cephalopods.',                          // narrative (terminal "." added)
    'The hearts.',                                               // section 1 heading
    'Two pump blood to the gills, one to the body.',             // section 1 content
    'Why it matters.',                                           // section 2 heading
    'Cold water carries less oxygen.',                           // section 2 content
    'Some sources dispute the exact figures.',                   // counterpoints
    'Nature is strange.'                                         // conclusion
  ];
  let cursor = -1;
  for (const marker of markers) {
    const at = text.indexOf(marker);
    assert.ok(at > cursor, `expected ${JSON.stringify(marker)} after position ${cursor}, found at ${at}`);
    cursor = at;
  }
});

test('Test 3: call_to_action is spoken last when present, and absent when null', () => {
  const withCta = scriptBodyToNarrationText(persistedBody({ call_to_action: 'Subscribe for more' }));
  assert.ok(withCta.trimEnd().endsWith('Subscribe for more.'));
  assert.ok(withCta.indexOf('Nature is strange.') < withCta.indexOf('Subscribe for more.'));

  const withoutCta = scriptBodyToNarrationText(persistedBody({ call_to_action: null }));
  assert.ok(withoutCta.trimEnd().endsWith('Nature is strange.'));
});

test('Test 3: existing terminal punctuation is preserved, missing punctuation gets exactly one "."', () => {
  const text = scriptBodyToNarrationText(persistedBody({ hook: 'Wow!', conclusion: 'The end' }));
  assert.ok(text.startsWith('Wow!\n\n'));
  assert.ok(text.includes('The end.'));
  assert.ok(!text.includes('Wow!.'));
});

test('conversion is deterministic and no field fuses into the next sentence', () => {
  const body = persistedBody();
  assert.equal(scriptBodyToNarrationText(body), scriptBodyToNarrationText(body));
  const captions = segmentCaptions(scriptBodyToNarrationText(body), 200);
  assert.ok(captions.includes('A short story about cephalopods.'));
  assert.ok(captions.includes('The hearts.'));
});

test('claim_ids are provenance metadata and are not spoken', () => {
  assert.ok(!scriptBodyToNarrationText(persistedBody()).includes('c1'));
});

// --- Invalid / malformed stored script handling -----

test('malformed JSON-looking body fails explicitly and is never passed through', () => {
  assert.throws(() => scriptBodyToNarrationText('{"hook":"truncated'), (err) => {
    assert.ok(err instanceof ScriptBodyContractError);
    assert.equal(err.reason, 'SCRIPT_BODY_MALFORMED_JSON');
    return true;
  });
});

test('valid JSON that violates the producer contract fails with a specific reason', () => {
  const cases = [
    [JSON.stringify({ ...generated, hook: '' }), 'SCRIPT_BODY_MISSING_OR_EMPTY_FIELD_hook'],
    [JSON.stringify({ ...generated, narrative: undefined }), 'SCRIPT_BODY_MISSING_OR_EMPTY_FIELD_narrative'],
    [JSON.stringify({ ...generated, sections: [] }), 'SCRIPT_BODY_MISSING_OR_EMPTY_SECTIONS'],
    [JSON.stringify({ ...generated, sections: [{ heading: 'h', claim_ids: [] }] }), 'SCRIPT_BODY_MISSING_SECTION_CONTENT_0'],
    [JSON.stringify({ ...generated, sections: [{ content: 'c', claim_ids: [] }] }), 'SCRIPT_BODY_MISSING_SECTION_HEADING_0'],
    [JSON.stringify({ ...generated, conclusion: '  ' }), 'SCRIPT_BODY_MISSING_OR_EMPTY_FIELD_conclusion'],
    [JSON.stringify({ ...generated, call_to_action: '' }), 'SCRIPT_BODY_INVALID_CALL_TO_ACTION'],
    [JSON.stringify([1, 2, 3]), 'SCRIPT_BODY_NOT_AN_OBJECT']
  ];
  for (const [body, reason] of cases) {
    assert.throws(() => scriptBodyToNarrationText(body), (err) => {
      assert.ok(err instanceof ScriptBodyContractError, `expected ScriptBodyContractError for ${reason}`);
      assert.equal(err.reason, reason);
      return true;
    });
  }
});

test('empty or non-string bodies fail explicitly', () => {
  for (const body of ['', '   ', null, undefined, 42]) {
    assert.throws(() => scriptBodyToNarrationText(body), (err) => err instanceof ScriptBodyContractError && err.reason === 'SCRIPT_BODY_EMPTY');
  }
});

test('a body that is already plain prose is returned unchanged (pre-rendered / seeded scripts)', () => {
  const prose = 'This is a short narration script for the test video.';
  assert.equal(scriptBodyToNarrationText(prose), prose);
});