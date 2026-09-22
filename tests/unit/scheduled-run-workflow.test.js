import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Media Production's narration step (src/media/narration.js) unconditionally
// spawns the `espeak-ng` binary via execFileSync -- in SIMULATION and LIVE
// alike, with no fallback (see README "System prerequisite: espeak-ng").
// The scheduled GitHub Actions run (.github/workflows/scheduled-run.yml,
// ADR-0035) runs on a stock ubuntu-latest runner, which does not have
// espeak-ng preinstalled. Any autonomous invocation that reaches Media
// Production without it fails with ENOENT. This guards against that
// regression by asserting the workflow installs it before running the
// entrypoint.

const workflowPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..', '..', '.github', 'workflows', 'scheduled-run.yml'
);

test('scheduled-run.yml installs espeak-ng before running the autonomous entrypoint', () => {
  const yaml = readFileSync(workflowPath, 'utf8');

  const espeakInstallIndex = yaml.indexOf('espeak-ng');
  assert.notEqual(espeakInstallIndex, -1, 'workflow must install espeak-ng (required by Media Production narration)');

  const entrypointRunIndex = yaml.indexOf('node src/index.js');
  assert.notEqual(entrypointRunIndex, -1, 'workflow must run the autonomous entrypoint');

  assert.ok(
    espeakInstallIndex < entrypointRunIndex,
    'espeak-ng must be installed before the autonomous entrypoint runs'
  );

  assert.match(yaml, /apt-get install -y espeak-ng/, 'must use the same install command documented in README');
});
