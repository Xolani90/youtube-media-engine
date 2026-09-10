import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectDiversePortfolio } from '../../src/discovery/diversity.js';

test('selects top-K distinct candidates, ranking precedes diversity', () => {
  const ranked = [
    { id: 'a', overallScore: 90, observation: { title: 'AI model launch for enterprises' }, underlyingEventId: 'e1' },
    { id: 'b', overallScore: 85, observation: { title: 'Quarterly earnings beat expectations' }, underlyingEventId: 'e2' },
    { id: 'c', overallScore: 80, observation: { title: 'New coffee shop opens downtown' }, underlyingEventId: 'e3' }
  ];
  const { selected } = selectDiversePortfolio(ranked, 2);
  assert.deepEqual(selected.map((s) => s.id), ['a', 'b']);
});

test('excludes a candidate sharing underlying_event_id with an already-selected one', () => {
  const ranked = [
    { id: 'a', overallScore: 90, observation: { title: 'AI model launch for enterprises' }, underlyingEventId: 'e1' },
    { id: 'b', overallScore: 87, observation: { title: 'AI model launch for enterprises (different angle text)' }, underlyingEventId: 'e1' },
    { id: 'c', overallScore: 80, observation: { title: 'Unrelated topic entirely different words' }, underlyingEventId: 'e2' }
  ];
  const { selected, excluded } = selectDiversePortfolio(ranked, 2);
  assert.deepEqual(selected.map((s) => s.id), ['a', 'c']);
  assert.equal(excluded.find((e) => e.candidate.id === 'b').reason.startsWith('TOO_SIMILAR_TO_SELECTED'), true);
});

test('diversity selection NEVER modifies overallScore of excluded candidates', () => {
  const ranked = [
    { id: 'a', overallScore: 87, observation: { title: 'AI model launch for enterprises' }, underlyingEventId: 'e1' },
    { id: 'b', overallScore: 84, observation: { title: 'AI model launch for enterprises variant text' }, underlyingEventId: 'e1' }
  ];
  const { excluded } = selectDiversePortfolio(ranked, 1);
  const excludedB = excluded.find((e) => e.candidate.id === 'b');
  assert.equal(excludedB.candidate.overallScore, 84, 'excluded candidate must retain its original computed score, unmodified by diversity');
});

test('candidates beyond top-K are excluded with TOP_K_REACHED, distinct from a diversity exclusion', () => {
  const ranked = [
    { id: 'a', overallScore: 90, observation: { title: 'Topic one about business software' }, underlyingEventId: 'e1' },
    { id: 'b', overallScore: 80, observation: { title: 'Topic two about cooking recipes' }, underlyingEventId: 'e2' },
    { id: 'c', overallScore: 70, observation: { title: 'Topic three about space exploration' }, underlyingEventId: 'e3' }
  ];
  const { selected, excluded } = selectDiversePortfolio(ranked, 2);
  assert.equal(selected.length, 2);
  assert.equal(excluded.find((e) => e.candidate.id === 'c').reason, 'TOP_K_REACHED');
});
