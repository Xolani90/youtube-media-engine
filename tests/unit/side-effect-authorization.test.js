import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config } from '../../src/config/index.js';
import {
  assertExternalActionAllowed,
  isActionAuthorized,
  SideEffectDeniedError
} from '../../src/state/SideEffectAuthorization.js';

/**
 * D-C2 guard tests, against the production API's ONLY authorization
 * source: config.authorizedExternalActionsPath. Neither
 * assertExternalActionAllowed nor isActionAuthorized accepts a path
 * parameter (that was the fixed defect — see the regression test at
 * the bottom of this file), so every test here points
 * config.authorizedExternalActionsPath itself at a temp fixture for
 * its duration and restores the original value afterward. This is
 * the same config object every real caller reads — not a parallel
 * test-only path.
 */

function withTempAuthFile(actions, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dc2-'));
  const filePath = path.join(dir, 'authorized_external_actions.json');
  fs.writeFileSync(filePath, JSON.stringify(actions));
  const original = config.authorizedExternalActionsPath;
  config.authorizedExternalActionsPath = filePath;
  try {
    return fn(filePath);
  } finally {
    config.authorizedExternalActionsPath = original;
  }
}

// Case A — authorized LIVE action
test('LIVE + autonomous enabled + action authorized -> allowed', () => {
  withTempAuthFile(['publish:youtube:abc123'], () => {
    assert.doesNotThrow(() =>
      assertExternalActionAllowed({ action: 'publish:youtube:abc123', mode: 'LIVE', autonomousEnabled: true })
    );
  });
});

// Case B — unauthorized LIVE action
test('LIVE + autonomous enabled + action NOT authorized -> denied', () => {
  withTempAuthFile(['publish:youtube:some-other-video'], () => {
    assert.throws(
      () => assertExternalActionAllowed({ action: 'publish:youtube:abc123', mode: 'LIVE', autonomousEnabled: true }),
      SideEffectDeniedError
    );
  });
});

// Case C — SIMULATION overrides authorization
test('SIMULATION + autonomous enabled + action authorized -> still denied', () => {
  withTempAuthFile(['publish:youtube:abc123'], () => {
    assert.throws(
      () =>
        assertExternalActionAllowed({ action: 'publish:youtube:abc123', mode: 'SIMULATION', autonomousEnabled: true }),
      SideEffectDeniedError
    );
  });
});

// Case D — autonomous operation disabled
test('LIVE + autonomous disabled + action authorized -> denied', () => {
  withTempAuthFile(['publish:youtube:abc123'], () => {
    assert.throws(
      () => assertExternalActionAllowed({ action: 'publish:youtube:abc123', mode: 'LIVE', autonomousEnabled: false }),
      SideEffectDeniedError
    );
  });
});

// Case E — caller attempts self-authorization via a boolean/flag
test('a caller-supplied `authorized: true` cannot turn a denied action into an allowed one', () => {
  withTempAuthFile([], () => {
    assert.throws(
      () =>
        assertExternalActionAllowed({
          action: 'publish:youtube:abc123',
          mode: 'LIVE',
          autonomousEnabled: true,
          authorized: true // not a real parameter — must be silently ignored
        }),
      SideEffectDeniedError
    );
  });
});

// Case E (regression) — caller attempts self-authorization via a substitute file/path
test('REGRESSION: a caller cannot substitute the authorization source via a path-like option', () => {
  // The Owner's real (current) authorization source denies the action.
  withTempAuthFile([], () => {
    // An attacker-controlled file that DOES contain the action.
    const attackerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dc2-attacker-'));
    const attackerFile = path.join(attackerDir, 'attacker.json');
    fs.writeFileSync(attackerFile, JSON.stringify(['publish:youtube:abc123']));

    // Neither function accepts a path-like option at all, so passing
    // one (under any plausible name an attacker might guess) must have
    // zero effect on the outcome — the guard must still consult only
    // config.authorizedExternalActionsPath and deny.
    for (const bogusOptions of [
      { filePath: attackerFile },
      { path: attackerFile },
      { authorizationFilePath: attackerFile },
      { source: attackerFile }
    ]) {
      assert.throws(
        () =>
          assertExternalActionAllowed({
            action: 'publish:youtube:abc123',
            mode: 'LIVE',
            autonomousEnabled: true,
            ...bogusOptions
          }),
        SideEffectDeniedError,
        `expected denial to be unaffected by caller-supplied ${JSON.stringify(bogusOptions)}`
      );
      assert.equal(
        isActionAuthorized('publish:youtube:abc123', bogusOptions),
        false,
        `expected isActionAuthorized to ignore caller-supplied ${JSON.stringify(bogusOptions)}`
      );
    }

    // Confirm the API surface itself: assertExternalActionAllowed and
    // isActionAuthorized are called with exactly one/zero arguments in
    // production; there is no second parameter through which a path
    // could be threaded even if a caller tried a correctly-named one,
    // because isActionAuthorized's signature takes only `action`.
    assert.equal(isActionAuthorized.length, 1, 'isActionAuthorized must take only `action` — no source override');
  });
});

// Case F — fresh authorization (not cached/stale)
test('changing the Owner-controlled authorization file before the check is respected', () => {
  withTempAuthFile([], () => {
    assert.throws(
      () => assertExternalActionAllowed({ action: 'publish:youtube:abc123', mode: 'LIVE', autonomousEnabled: true }),
      SideEffectDeniedError
    );

    // Owner authorizes the action after the first (denied) check, by
    // editing the very file config.authorizedExternalActionsPath points at.
    fs.writeFileSync(config.authorizedExternalActionsPath, JSON.stringify(['publish:youtube:abc123']));

    assert.doesNotThrow(() =>
      assertExternalActionAllowed({ action: 'publish:youtube:abc123', mode: 'LIVE', autonomousEnabled: true })
    );

    // And revoking it again is respected immediately too.
    fs.writeFileSync(config.authorizedExternalActionsPath, JSON.stringify([]));

    assert.throws(
      () => assertExternalActionAllowed({ action: 'publish:youtube:abc123', mode: 'LIVE', autonomousEnabled: true }),
      SideEffectDeniedError
    );
  });
});

// Case G — retry requires a fresh check each time, not a reused result
test('each retry attempt performs its own independent authorization check', () => {
  withTempAuthFile(['publish:youtube:abc123'], () => {
    const attempt = () =>
      assertExternalActionAllowed({ action: 'publish:youtube:abc123', mode: 'LIVE', autonomousEnabled: true });

    // First attempt succeeds (simulating an external call that then fails
    // for an unrelated network reason, prompting a retry).
    assert.doesNotThrow(attempt);

    // Owner revokes authorization between attempt 1 and the retry.
    fs.writeFileSync(config.authorizedExternalActionsPath, JSON.stringify([]));

    // The retry must re-check, not reuse attempt 1's ALLOW.
    assert.throws(attempt, SideEffectDeniedError);
  });
});

test('isActionAuthorized reflects the file contents directly, with no caching', () => {
  withTempAuthFile(['action-a'], () => {
    assert.equal(isActionAuthorized('action-a'), true);
    assert.equal(isActionAuthorized('action-b'), false);

    fs.writeFileSync(config.authorizedExternalActionsPath, JSON.stringify(['action-b']));
    assert.equal(isActionAuthorized('action-a'), false);
    assert.equal(isActionAuthorized('action-b'), true);
  });
});

test('a missing authorization file means nothing is authorized (safe default)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dc2-missing-'));
  const original = config.authorizedExternalActionsPath;
  config.authorizedExternalActionsPath = path.join(dir, 'does-not-exist.json');
  try {
    assert.equal(isActionAuthorized('anything'), false);
    assert.throws(
      () => assertExternalActionAllowed({ action: 'anything', mode: 'LIVE', autonomousEnabled: true }),
      SideEffectDeniedError
    );
  } finally {
    config.authorizedExternalActionsPath = original;
  }
});

test('per-action exact matching: an Owner entry does not authorize a caller-extended action id', () => {
  withTempAuthFile(['publish:youtube'], () => {
    assert.throws(
      () =>
        assertExternalActionAllowed({
          action: 'publish:youtube:anything-the-caller-wants',
          mode: 'LIVE',
          autonomousEnabled: true
        }),
      SideEffectDeniedError
    );
  });
});

test('requires a non-empty string action identifier', () => {
  assert.throws(() => assertExternalActionAllowed({ mode: 'LIVE', autonomousEnabled: true }), /non-empty string/);
  assert.throws(
    () => assertExternalActionAllowed({ action: '', mode: 'LIVE', autonomousEnabled: true }),
    /non-empty string/
  );
});
