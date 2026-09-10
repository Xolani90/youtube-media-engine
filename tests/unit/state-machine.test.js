import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canTransition, transition, InvalidTransitionError } from '../../src/state/ContentStateMachine.js';

test('allows sequential forward transition', () => {
  assert.equal(transition('DISCOVERED', 'SCORED'), 'SCORED');
});

test('rejects skipping states', () => {
  assert.equal(canTransition('DISCOVERED', 'RESEARCHING'), false);
  assert.throws(() => transition('DISCOVERED', 'RESEARCHING'), InvalidTransitionError);
});

test('rejects backward transition', () => {
  assert.equal(canTransition('SCORED', 'DISCOVERED'), false);
});

test('allows transition into a failure state from any state', () => {
  assert.equal(canTransition('SCRIPT_DRAFT', 'REJECTED'), true);
  assert.equal(canTransition('DISCOVERED', 'BLOCKED'), true);
});
