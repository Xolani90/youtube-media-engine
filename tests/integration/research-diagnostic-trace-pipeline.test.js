import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConvergenceIndex, explainConvergence, CONVERGENCE_VERDICT } from '../../src/research/claimConvergence.js';

const identity = (quantity) => ({
  subject: 'spain', predicate: 'score', object: 'final', qualifiers: [], time: '2026', quantity, unit: 'goal',
  polarity: 'AFFIRMED', modality: 'OCCURRED', relation: 'DESCRIPTIVE'
});

test('research diagnostic trace: explainConvergence returns distinct quantity pairs without mutating overflow state', () => {
  const index = new ConvergenceIndex();
  index.add({ claimId: 'first', identity: identity(2), claimType: 'FACT', isLoadBearing: true, sourceIds: ['source-a'] });
  const overflowedBefore = index.overflowedKeys;
  const explained = explainConvergence(index, { identity: identity(3), claimType: 'FACT', isLoadBearing: true, sourceId: 'source-b' });
  assert.equal(index.overflowedKeys, overflowedBefore);
  assert.equal(explained.pairs.length, 1);
  assert.equal(explained.pairs[0].verdict, CONVERGENCE_VERDICT.DISTINCT);
  assert.ok(explained.pairs[0].conflictFields.includes('quantity:different_quantity'));
});
