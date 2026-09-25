import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// GitHub Actions runs each `run:` block under `bash -eo pipefail` by
// default. If the "Run autonomous entrypoint" step just did
// `node src/index.js; code=$?`, a non-zero exit from node would terminate
// the step immediately (via `set -e`) before `code=$?` ever ran, and the
// step would fail without the subsequent diagnostic step (and whatever
// SQLite checkpoint/persistence src/index.js already performed before
// exiting) ever getting a chance to run. This guards against that
// regression: the entrypoint step must disable errexit around the node
// invocation, capture the exit code immediately, restore errexit, and
// defer the real pass/fail decision to a later step that runs after the
// diagnostic step -- so persistence/diagnostics always get a chance to run
// regardless of the application's exit code, while a genuine non-zero exit
// (anything other than the ADR-0024 refusal code, 3) still ultimately
// fails the job.

const workflowPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..', '..', '.github', 'workflows', 'scheduled-run.yml'
);

const yaml = readFileSync(workflowPath, 'utf8');

function stepBlock(name) {
  const startMarker = `- name: ${name}`;
  const start = yaml.indexOf(startMarker);
  assert.notEqual(start, -1, `workflow must contain a step named "${name}"`);
  const nextStep = yaml.indexOf('\n      - name:', start + startMarker.length);
  return yaml.slice(start, nextStep === -1 ? yaml.length : nextStep);
}

test('entrypoint step disables errexit before node and captures the exit code immediately', () => {
  const entrypoint = stepBlock('Run autonomous entrypoint (SIMULATION)');
  // The step's leading comment prose also mentions `set +e`/`set -e`
  // descriptively -- only the actual `run:` script (after the last
  // "run:" marker in this block) reflects real shell command order.
  const script = entrypoint.slice(entrypoint.lastIndexOf('run:'));

  const setPlusE = script.indexOf('set +e');
  const nodeCall = script.indexOf('node src/index.js');
  const captureCode = script.indexOf('code=$?');
  const setMinusE = script.indexOf('set -e', setPlusE + 'set +e'.length);

  assert.notEqual(setPlusE, -1, 'errexit must be disabled (set +e) before invoking node');
  assert.notEqual(nodeCall, -1, 'workflow must run the autonomous entrypoint');
  assert.notEqual(captureCode, -1, 'workflow must capture $? from the node invocation');
  assert.notEqual(setMinusE, -1, 'errexit must be restored (set -e) after capturing the exit code');

  assert.ok(setPlusE < nodeCall, 'set +e must come before node is invoked, or a non-zero exit could still abort the step early');
  assert.ok(nodeCall < captureCode, 'the exit code must be captured after node runs');
  assert.ok(
    captureCode < setMinusE,
    '$? must be captured immediately after node, before errexit is restored, or the captured value could be clobbered'
  );
});

test('entrypoint step exposes the captured exit code as a step output instead of failing the step', () => {
  const entrypoint = stepBlock('Run autonomous entrypoint (SIMULATION)');

  assert.match(entrypoint, /id:\s*run_app/, 'entrypoint step needs an id so later steps can read its output');
  assert.match(
    entrypoint,
    /echo\s+"code=\$code"\s*>>\s*"\$GITHUB_OUTPUT"/,
    'captured exit code must be written to GITHUB_OUTPUT'
  );

  // The old bug pattern re-exits the step with the raw application code
  // (`exit "$code"`), which fails the step and skips everything after it.
  // The fixed step must not do this any more.
  assert.doesNotMatch(
    entrypoint,
    /\n\s*exit\s+"\$code"\s*\n/,
    'entrypoint step must not exit non-zero on the application exit code -- that would skip the diagnostic/persistence steps below'
  );
});

test('exit code 3 (ADR-0024 refusal) is still recognized as expected, not a failure', () => {
  const entrypoint = stepBlock('Run autonomous entrypoint (SIMULATION)');
  assert.match(
    entrypoint,
    /\[\s*"\$code"\s*-eq\s*3\s*\]/,
    'exit code 3 (REFUSED_EXIT_CODE) must still be checked and treated as expected'
  );
});

test('diagnostic step runs unconditionally after the entrypoint step, before the final status is reported', () => {
  const entrypointIndex = yaml.indexOf('- name: Run autonomous entrypoint (SIMULATION)');
  const diagnosticIndex = yaml.indexOf('- name: Research source-level diagnostic');
  const reportIndex = yaml.indexOf('- name: Report application exit status');

  assert.notEqual(diagnosticIndex, -1, 'workflow must still run the research source-level diagnostic step');
  assert.notEqual(reportIndex, -1, 'workflow must have a final step that reports the application exit status');

  assert.ok(entrypointIndex < diagnosticIndex, 'diagnostic step must come after the entrypoint step');
  assert.ok(diagnosticIndex < reportIndex, 'final status report must come after the diagnostic step, not before it');

  const diagnosticBlock = stepBlock('Research source-level diagnostic');
  assert.doesNotMatch(
    diagnosticBlock,
    /\bif:\s*/,
    'diagnostic step should run under its normal (default) condition, since the entrypoint step no longer fails on its own'
  );
});

test('final status step runs with if: always() and re-emits any genuine non-zero exit code', () => {
  const reportBlock = stepBlock('Report application exit status');

  assert.match(reportBlock, /if:\s*always\(\)/, 'final report step must run even if an earlier step failed');
  assert.match(
    reportBlock,
    /steps\.run_app\.outputs\.code/,
    'final report step must read the exit code captured by the entrypoint step'
  );

  // Success (0) and the ADR-0024 refusal (3) must not fail the job...
  assert.match(reportBlock, /-eq\s*0.*-eq\s*3|eq\s*3.*eq\s*0/s, 'codes 0 and 3 must both be treated as success in the final step');
  // ...but any other non-zero code must still be re-emitted, not swallowed.
  assert.match(reportBlock, /exit\s+"\$code"/, 'final step must exit with the real application code for genuine failures');
});
