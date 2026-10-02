import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractFigures, validateSectionFigures } from '../../src/script/claims.js';
import { generateScriptFields } from '../../src/script/generate.js';

const brief = { working_title: 't', core_question: 'q', hook: 'h', angle: 'a', narrative_structure: 'n' };
const router = (capture) => ({
  async complete({ prompt }) { capture.prompt = prompt; return { providerUsed: 'x', result: { text: '{}', model: 'm', estimatedCost: 0, isPaid: false } }; }
});

test('prompt includes claim text when eligibleClaims are supplied', async () => {
  const cap = {};
  await generateScriptFields({ brief, eligibleClaimIds: ['c1'], eligibleClaims: [{ id: 'c1', claim: 'Gemini 4 Argon scored 51.3% on the benchmark.' }], allowCallToAction: false }, router(cap));
  assert.match(cap.prompt, /"id":"c1","claim":"Gemini 4 Argon/);
  assert.match(cap.prompt, /51\.3%/);
});

test('prompt without claim text keeps the ids-only behaviour', async () => {
  const cap = {};
  await generateScriptFields({ brief, eligibleClaimIds: ['c1'], allowCallToAction: false }, router(cap));
  assert.doesNotMatch(cap.prompt, /"claim":/);
});

test('extractFigures ignores small integers and normalizes spacing', () => {
  assert.deepEqual([...extractFigures('3 steps, 51.3 %, $1,200 in 2026')].sort(), ['$1200', '2026', '51.3%'].sort());
});

test('grounded figures pass', () => {
  const m = new Map([['c1', 'It scored 51.3% in 2026.']]);
  assert.equal(validateSectionFigures([{ heading: 'H', content: 'It hit 51.3 % this year, 2026.', claim_ids: ['c1'] }], m).valid, true);
});

test('an invented figure is rejected', () => {
  const m = new Map([['c1', 'It scored 51.3% in 2026.']]);
  const r = validateSectionFigures([{ heading: 'H', content: 'It scored 72.8% overall.', claim_ids: ['c1'] }], m);
  assert.equal(r.valid, false);
  assert.equal(r.reason, 'UNGROUNDED_FIGURE_72.8%');
});

test('figure in Brief fields is allowed', () => {
  const m = new Map([['c1', 'text']]);
  assert.equal(validateSectionFigures([{ heading: 'H', content: 'Launched 2026.', claim_ids: ['c1'] }], m, 'hook about 2026').valid, true);
});

test('missing claim text skips the check (never rejects on a failed lookup)', () => {
  const r = validateSectionFigures([{ heading: 'H', content: 'It scored 99.9%.', claim_ids: ['missing'] }], new Map());
  assert.equal(r.valid, true);
});
