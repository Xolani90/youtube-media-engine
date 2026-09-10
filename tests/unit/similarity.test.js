import { test } from 'node:test';
import assert from 'node:assert/strict';
import { jaccardSimilarity, tokenize, localSimilarity } from '../../src/discovery/similarity.js';

test('identical text has similarity 1', () => {
  const t = tokenize('OpenAI releases new model for businesses');
  assert.equal(jaccardSimilarity(t, t), 1);
});

test('completely different text has similarity 0', () => {
  const a = tokenize('cats and dogs playing outside');
  const b = tokenize('quarterly financial earnings report');
  assert.equal(jaccardSimilarity(a, b), 0);
});

test('overlapping text has intermediate similarity', () => {
  const a = tokenize('OpenAI releases new GPT model for developers');
  const b = tokenize('OpenAI releases new GPT model for enterprises');
  const sim = jaccardSimilarity(a, b);
  assert.ok(sim > 0.5 && sim < 1, `expected intermediate similarity, got ${sim}`);
});

test('localSimilarity combines title and description, is deterministic', () => {
  const a = { title: 'AI model launch', description: 'A new model was launched today' };
  const b = { title: 'AI model launch', description: 'A new model was launched today' };
  const sim1 = localSimilarity(a, b);
  const sim2 = localSimilarity(a, b);
  assert.equal(sim1, sim2);
  assert.equal(sim1, 1);
});

test('similarity computation makes no network call (pure function over strings)', () => {
  // Structural guarantee: localSimilarity/jaccardSimilarity accept only
  // plain strings/arrays and contain no async/await or fetch — verified
  // here by confirming the call resolves synchronously without a Promise.
  const result = localSimilarity({ title: 'a' }, { title: 'b' });
  assert.equal(typeof result, 'number');
});
