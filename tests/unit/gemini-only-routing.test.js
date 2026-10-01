import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { REGISTRY } from '../../src/providers/llm/candidates.js';
import { LLMRouter } from '../../src/providers/llm/router.js';

test('Groq is not a registered provider: no executable path can select it', async () => {
  assert.equal('groq-free' in REGISTRY, false);
  assert.ok(!Object.keys(REGISTRY).some((id) => /groq/i.test(id)));
  const router = new LLMRouter({ priority: ['groq-free'], allowPaidProviders: false });
  await assert.rejects(() => router.complete({ prompt: 'x' }), /Unknown LLM provider id.*groq-free/);
});

test('the code default for LLM_PROVIDER_PRIORITY is Gemini only', () => {
  // Read from source rather than `config`: config also honors a developer's
  // local, untracked .env, which must not make this test environment-dependent.
  const src = fs.readFileSync(new URL('../../src/config/index.js', import.meta.url), 'utf8');
  assert.match(src, /envList\('LLM_PROVIDER_PRIORITY', \['gemini-free'\]\)/);
  assert.ok(!/groq/i.test(src));
});

test('scheduled workflow pins Gemini-only priority and has no Groq key', () => {
  const wf = fs.readFileSync(new URL('../../.github/workflows/scheduled-run.yml', import.meta.url), 'utf8');
  assert.match(wf, /LLM_PROVIDER_PRIORITY:\s*'gemini-free'\s*$/m);
  assert.ok(!/groq/i.test(wf));
});
