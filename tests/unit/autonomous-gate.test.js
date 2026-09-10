import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertRunAllowed, AutonomousDisabledError } from '../../src/state/SystemRun.js';

test('SIMULATION run is always allowed regardless of autonomous switch', () => {
  assert.doesNotThrow(() => assertRunAllowed({ mode: 'SIMULATION', autonomousEnabled: false }));
  assert.doesNotThrow(() => assertRunAllowed({ mode: 'SIMULATION', autonomousEnabled: true }));
});

test('LIVE run is refused when autonomous operation is disabled', () => {
  assert.throws(() => assertRunAllowed({ mode: 'LIVE', autonomousEnabled: false }), AutonomousDisabledError);
});

test('LIVE run is allowed when autonomous operation is enabled', () => {
  assert.doesNotThrow(() => assertRunAllowed({ mode: 'LIVE', autonomousEnabled: true }));
});
