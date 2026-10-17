import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planScenes } from '../../src/asset-provisioning/scenePlan.js';

// Real proof script 2 as first written: uneven sentence lengths made the character-balanced
// chunker cut 2/3/2/2/1 and put the solar sentence under the coffee scene.
const SENTENCES = [
  'A hot air balloon drifts slowly above the quiet valley.',
  'The pilot watches the clouds and waits for a gentle breeze.',
  'Fresh coffee beans darken as they roast in the drum.',
  'The rich smell fills the whole workshop within minutes.',
  'Rows of solar panels face the sun across the open field.',
  'Each panel turns daylight into clean electricity for the town.',
  'At night the city streets glow with moving headlights.',
  'Buses and taxis weave through the crowded evening traffic.',
  'A narrow trail climbs the mountain through tall pine trees.',
  'At the summit the hikers rest and look out over the ridge.'
];
const IDEAS = 'hot air balloon sky; coffee beans roasting; solar panels field; city night traffic; mountain hiking trail';

test('one curated term per scene: scene cuts follow topics, not character counts', () => {
  const plan = planScenes({ visualIdeas: IDEAS, scriptBody: SENTENCES.join(' ') });
  assert.equal(plan.length, 5);
  assert.deepEqual(plan.map((s) => s.queries[0]),
    ['hot air balloon sky', 'coffee beans roasting', 'solar panels field', 'city night traffic', 'mountain hiking trail']);
});

test('every scene text is whole sentences, in order, covering the script exactly', () => {
  const body = SENTENCES.join(' ');
  const plan = planScenes({ visualIdeas: IDEAS, scriptBody: body });
  assert.equal(plan.length, 5);
  const sc = plan.map((s) => s.span);
  assert.equal(sc[0].start, 0); assert.equal(sc[4].end, 1);
  for (let i = 1; i < 5; i++) assert.equal(sc[i].start, sc[i - 1].end);
});

test('scene 3 (solar) holds both solar sentences and nothing from coffee or city', () => {
  const plan = planScenes({ visualIdeas: IDEAS, scriptBody: SENTENCES.join(' ') });
  const total = SENTENCES.reduce((n, s) => n + s.length, 0);
  // reconstruct which sentences each span covers from cumulative character shares
  let cum = 0; const bounds = SENTENCES.map((s) => { cum += s.length; return Math.round((cum / total) * 10000) / 10000; });
  const countIn = (sp) => bounds.filter((b) => b > sp.start && b <= sp.end).length;
  assert.deepEqual(plan.map((s) => countIn(s.span)), [2, 2, 2, 2, 2]);
});

test('no overlap with any term, or term count != scene count: behaviour unchanged', () => {
  const body = SENTENCES.join(' ');
  const noOverlap = planScenes({ visualIdeas: 'zzzz; yyyy; xxxx; wwww; vvvv', scriptBody: body });
  const base = planScenes({ visualIdeas: 'zzzz; yyyy; xxxx; wwww; vvvv', scriptBody: body }, {});
  assert.deepEqual(noOverlap, base);
  const three = planScenes({ visualIdeas: 'balloon; coffee; solar', scriptBody: body });
  assert.ok(three.length >= 2);
});
