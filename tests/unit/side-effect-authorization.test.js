import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  assertExternalActionAllowed,
  isActionAuthorized,
  SideEffectDeniedError
} from '../../src/state/SideEffectAuthorization.js';

/**
 * D-C2 guard tests. Each test uses its own temp authorization file so
 * tests never depend on, or mutate, the repo's real
 * config/authorized_external_actions.json.
 */

function tempAuthFile(actions) {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dc2-')), 'authorized_external_actions.json');
  fs.writeFileSync(p, JSON.stringify(actions));
  return p;
}

// Case A — authorized LIVE action
test('LIVE + autonomous enabled + action authorized -> allowed', () => {
  const filePath = tempAuthFile(['publish:youtube:abc123']);
  assert.doesNotThrow(() =>
    assertExternalActionAllowed({
      action: 'publish:youtube:abc123',
      mode: 'LIVE',
      autonomousEnabled: true,
      filePath
    })
  );
});

// Case B — unauthorized LIVE action
test('LIVE + autonomous enabled + action NOT authorized -> denied', () => {
  const filePath = tempAuthFile(['publish:youtube:some-other-video']);
  assert.throws(
    () =>
      assertExternalActionAllowed({
        action: 'publish:youtube:abc123',
        mode: 'LIVE',
        autonomousEnabled: true,
        filePath
      }),
    SideEffectDeniedError
  );
});

// Case C — SIMULATION overrides authorization
test('SIMULATION + autonomous enabled + action authorized -> still denied', () => {
  const filePath = tempAuthFile(['publish:youtube:abc123']);
  assert.throws(
    () =>
      assertExternalActionAllowed({
        action: 'publish:youtube:abc123',
        mode: 'SIMULATION',
        autonomousEnabled: true,
        filePath
      }),
    SideEffectDeniedError
  );
});

// Case D — autonomous operation disabled
test('LIVE + autonomous disabled + action authorized -> denied', () => {
  const filePath = tempAuthFile(['publish:youtube:abc123']);
  assert.throws(
    () =>
      assertExternalActionAllowed({
        action: 'publish:youtube:abc123',
        mode: 'LIVE',
        autonomousEnabled: false,
        filePath
      }),
    SideEffectDeniedError
  );
});

// Case E — caller attempts self-authorization
test('a caller-supplied `authorized: true` cannot turn a denied action into an allowed one', () => {
  const filePath = tempAuthFile([]); // nothing Owner-authorized
  assert.throws(
    () =>
      assertExternalActionAllowed({
        action: 'publish:youtube:abc123',
        mode: 'LIVE',
        autonomousEnabled: true,
        authorized: true, // not a real parameter — must be silently ignored
        filePath
      }),
    SideEffectDeniedError
  );
});

// Case F — fresh authorization (not cached/stale)
test('changing the Owner-controlled authorization file before the check is respected', () => {
  const filePath = tempAuthFile([]);

  assert.throws(
    () =>
      assertExternalActionAllowed({
        action: 'publish:youtube:abc123',
        mode: 'LIVE',
        autonomousEnabled: true,
        filePath
      }),
    SideEffectDeniedError
  );

  // Owner authorizes the action after the first (denied) check.
  fs.writeFileSync(filePath, JSON.stringify(['publish:youtube:abc123']));

  assert.doesNotThrow(() =>
    assertExternalActionAllowed({
      action: 'publish:youtube:abc123',
      mode: 'LIVE',
      autonomousEnabled: true,
      filePath
    })
  );

  // And revoking it again is respected immediately too.
  fs.writeFileSync(filePath, JSON.stringify([]));

  assert.throws(
    () =>
      assertExternalActionAllowed({
        action: 'publish:youtube:abc123',
        mode: 'LIVE',
        autonomousEnabled: true,
        filePath
      }),
    SideEffectDeniedError
  );
});

// Case G — retry requires a fresh check each time, not a reused result
test('each retry attempt performs its own independent authorization check', () => {
  const filePath = tempAuthFile(['publish:youtube:abc123']);

  const attempt = () =>
    assertExternalActionAllowed({
      action: 'publish:youtube:abc123',
      mode: 'LIVE',
      autonomousEnabled: true,
      filePath
    });

  // First attempt succeeds (simulating an external call that then fails
  // for an unrelated network reason, prompting a retry).
  assert.doesNotThrow(attempt);

  // Owner revokes authorization between attempt 1 and the retry.
  fs.writeFileSync(filePath, JSON.stringify([]));

  // The retry must re-check, not reuse attempt 1's ALLOW.
  assert.throws(attempt, SideEffectDeniedError);
});

test('isActionAuthorized reflects the file contents directly, with no caching', () => {
  const filePath = tempAuthFile(['action-a']);
  assert.equal(isActionAuthorized('action-a', { filePath }), true);
  assert.equal(isActionAuthorized('action-b', { filePath }), false);

  fs.writeFileSync(filePath, JSON.stringify(['action-b']));
  assert.equal(isActionAuthorized('action-a', { filePath }), false);
  assert.equal(isActionAuthorized('action-b', { filePath }), true);
});

test('a missing authorization file means nothing is authorized (safe default)', () => {
  const filePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dc2-missing-')), 'does-not-exist.json');
  assert.equal(isActionAuthorized('anything', { filePath }), false);
  assert.throws(
    () =>
      assertExternalActionAllowed({
        action: 'anything',
        mode: 'LIVE',
        autonomousEnabled: true,
        filePath
      }),
    SideEffectDeniedError
  );
});

test('requires a non-empty string action identifier', () => {
  assert.throws(() => assertExternalActionAllowed({ mode: 'LIVE', autonomousEnabled: true }), /non-empty string/);
  assert.throws(
    () => assertExternalActionAllowed({ action: '', mode: 'LIVE', autonomousEnabled: true }),
    /non-empty string/
  );
});
