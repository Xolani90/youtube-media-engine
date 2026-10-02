import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectSourceWindow, verifyClaimAgainstSource, VERIFICATION_RESULT } from '../../src/research/evidenceVerification.js';

const claim = 'Google announced Gemini 4 Argon on September 30, 2026.';
const filler = (n) => Array.from({ length: n }, (_, i) => `Unrelated paragraph ${i} about weather and sports results.`).join('\n\n');
const key = 'Google announced Gemini 4 Argon on September 30, 2026 at its developer event.';

test('short source is returned unchanged', () => {
  assert.equal(selectSourceWindow('short text', claim, 24000), 'short text');
});

test('long source keeps the relevant passage that sits past the head cutoff', () => {
  const text = `${filler(900)}\n\n${key}\n\n${filler(50)}`;
  assert.ok(text.indexOf(key) > 24000);
  const w = selectSourceWindow(text, claim, 24000);
  assert.ok(w.length <= 24000);
  assert.ok(w.includes(key));
});

test('window is deterministic and preserves document order', () => {
  const text = `${filler(900)}\n\n${key}\n\n${filler(50)}`;
  assert.equal(selectSourceWindow(text, claim, 24000), selectSourceWindow(text, claim, 24000));
  const small = selectSourceWindow(`A1 start.\n\n${filler(900)}\n\n${key}`, claim, 3000);
  assert.ok(small.indexOf(key) >= 0);
});

test('verifier sees deep passage and accepted quote is validated against full source', async () => {
  const content = `${filler(900)}\n\n${key}\n\n${filler(50)}`;
  let seenPrompt = '';
  const llmRouter = { complete: async ({ prompt }) => { seenPrompt = prompt; return { providerUsed: 'x', result: { model: 'm', text: JSON.stringify({ result: 'SUPPORTS', quote: key }) } }; } };
  const d = await verifyClaimAgainstSource({ claim, source: { id: 's1', url: 'https://example.com/a', content }, llmRouter });
  assert.ok(seenPrompt.includes(key));
  assert.equal(d.result, VERIFICATION_RESULT.SUPPORTS);
  assert.equal(d.quoteAccepted, true);
});

test('a quote not in the full source is still rejected', async () => {
  const content = `${filler(900)}\n\n${key}`;
  const llmRouter = { complete: async () => ({ result: { text: JSON.stringify({ result: 'SUPPORTS', quote: 'Google announced a completely invented sentence here.' }) } }) };
  const d = await verifyClaimAgainstSource({ claim, source: { id: 's1', url: 'https://example.com/a', content }, llmRouter });
  assert.equal(d.quoteAccepted, false);
  assert.equal(d.result, VERIFICATION_RESULT.UNCERTAIN);
});
