import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractClaims } from '../../src/research/claims.js';
import { LLMRouter } from '../../src/providers/llm/router.js';

// Pass 11 prompt pinning. The extraction prompt carries a GROUNDING RULE for
// `identity`. It must NOT tell the model that the publication-context resolver
// will supply a missing year: resolvePublicationYear() only vouches for a year
// the model already proposed (it rejects a disagreement and cannot create one),
// so that instruction would contradict the downstream contract.

async function capturePrompt() {
  let captured = null;
  const registry = {
    'capture-stub': () => ({
      id: 'capture-stub',
      isPaid: false,
      async healthCheck() { return true; },
      async complete({ prompt }) {
        captured = prompt;
        return { text: '[]', model: 'capture-stub', requestId: null, inputTokens: 1, outputTokens: 1, estimatedCost: 0, isPaid: false };
      }
    })
  };
  const router = new LLMRouter({ priority: ['capture-stub'], allowPaidProviders: false, registry });
  await extractClaims({ sourceText: 'Acme released Widget in March.', coreQuestion: 'q' }, router);
  // Prompt lines are joined with \n; compare on single-space text so the pins
  // do not depend on where a sentence wraps.
  return captured.replace(/\s+/g, ' ');
}

test('Pass 11: retained grounding instructions are present in the extraction prompt', async () => {
  const p = await capturePrompt();
  for (const needle of [
    'GROUNDING RULE for identity',
    "supported by wording that is actually present in THIS claim's own text",
    'never by the article\'s topic, headline or neighbouring sentences',
    'copy the words as the claim writes them',
    'the subject is "Argon", not "Gemini 4 Argon"',
    '"qualifiers": each entry must use the claim\'s own wording; do not paraphrase or summarise',
    '"time": must be grounded in the claim\'s own wording',
    'Never infer or copy a year from publication or headline context.',
    '"quantity" holds ONE number',
    'if the claim has two different scaled figures, set identity to null',
    'use null for that field, or null for the whole identity, rather than infer a value'
  ]) {
    assert.ok(p.includes(needle), `missing retained instruction: ${needle}`);
  }
});

test('Pass 11: the month-only / publication-resolver instruction is absent', async () => {
  const p = await capturePrompt();
  for (const banned of [
    /preserve the month/i,
    /month but no year/i,
    /without inventing a year/i,
    /publication-context resolver/i,
    /resolver may supply/i,
    /supply the year downstream/i
  ]) {
    assert.doesNotMatch(p, banned);
  }
});
