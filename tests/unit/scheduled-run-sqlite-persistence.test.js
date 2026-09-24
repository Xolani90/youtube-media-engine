import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, mkdtempSync, writeFileSync, chmodSync, existsSync, statSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import Database from 'better-sqlite3';

// The scheduled workflow persists data/media-engine.db between GitHub
// Actions runs through the Actions cache. The cache is only a carrier
// between runs -- not a permanent external database -- so a miss must be
// survivable and a hit/miss must be visible in the log. These tests pin:
//   - restore happens before the autonomous entrypoint and targets the
//     configured SQLITE_PATH;
//   - a WAL checkpoint (TRUNCATE) happens before the save, and the save
//     happens after the run;
//   - checkpoint and save run under always(), so they still run after a
//     non-zero application exit (Step 1 records that exit code as a step
//     output instead of failing the entrypoint step);
//   - an incomplete checkpoint never results in a save.
// The checkpoint / entrypoint / report scripts are extracted from the
// workflow file and executed for real (POSIX shell required; skipped on
// win32, like the other shell-dependent tests in this repo).

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const yaml = readFileSync(path.join(REPO, '.github', 'workflows', 'scheduled-run.yml'), 'utf8');

const SKIP_NO_POSIX = process.platform === 'win32' ? 'requires a POSIX shell (bash)' : false;

const ENTRYPOINT = 'Run autonomous entrypoint (SIMULATION)';
const DIAGNOSTIC = 'Research source-level diagnostic';
const RESTORE = 'Restore SQLite state cache';
const RESTORE_REPORT = 'Report SQLite cache restore result';
const CHECKPOINT = 'Checkpoint SQLite WAL before saving';
const SAVE = 'Save SQLite state cache';
const FINAL_REPORT = 'Report application exit status';

function stepBlock(name) {
  const startMarker = `- name: ${name}`;
  const start = yaml.indexOf(startMarker);
  assert.notEqual(start, -1, `workflow must contain a step named "${name}"`);
  const nextStep = yaml.indexOf('\n      - name:', start + startMarker.length);
  return yaml.slice(start, nextStep === -1 ? yaml.length : nextStep);
}

// The step's `run: |` script, de-indented the way GitHub Actions hands it
// to the shell (block scalar indentation of 10 spaces for step-level run).
function runScript(name) {
  const block = stepBlock(name);
  const marker = '\n        run: |\n';
  const at = block.indexOf(marker);
  assert.notEqual(at, -1, `step "${name}" must have a multi-line run script`);
  return block
    .slice(at + marker.length)
    .split('\n')
    .map((line) => (line.startsWith('          ') ? line.slice(10) : line.trimStart()))
    .join('\n') + '\n';
}

function runBash(script, { env = {}, path: pathPrefix } = {}) {
  const mergedEnv = { ...process.env, ...env };
  if (pathPrefix) mergedEnv.PATH = `${pathPrefix}${path.delimiter}${process.env.PATH}`;
  // GitHub Actions' default shell for `run:` is `bash -e {0}` (and -o pipefail
  // when shell is unspecified). Use the same flags.
  return spawnSync('bash', ['-eo', 'pipefail', '-c', script], { cwd: REPO, env: mergedEnv, encoding: 'utf8' });
}

function tempDir() {
  return mkdtempSync(path.join(tmpdir(), 'sqlite-persist-'));
}

function outputsOf(file) {
  return existsSync(file) ? readFileSync(file, 'utf8') : '';
}

// ---------------------------------------------------------------- structure

test('steps are ordered: restore -> entrypoint -> diagnostic -> checkpoint -> save -> final status', () => {
  const idx = (n) => yaml.indexOf(`- name: ${n}`);
  const order = [RESTORE, RESTORE_REPORT, ENTRYPOINT, DIAGNOSTIC, CHECKPOINT, SAVE, FINAL_REPORT].map(idx);
  order.forEach((i, n) => assert.notEqual(i, -1, `missing step #${n}`));
  for (let i = 1; i < order.length; i += 1) {
    assert.ok(order[i - 1] < order[i], `step ${i} must come after step ${i - 1}`);
  }
});

test('cache restore happens before the entrypoint and targets the configured SQLITE_PATH', () => {
  assert.match(
    yaml,
    /\n {6}SQLITE_PATH: \$\{\{ github\.workspace \}\}\/data\/media-engine\.db\n/,
    'job-level SQLITE_PATH convention must remain data/media-engine.db in the workspace'
  );
  const restore = stepBlock(RESTORE);
  assert.match(restore, /uses:\s*actions\/cache\/restore@v4/, 'restore must use the restore-only action so save can be a separate always() step');
  assert.match(restore, /path:\s*\$\{\{ env\.SQLITE_PATH \}\}/, 'restore path must be the configured SQLITE_PATH, not a second hard-coded path');
  assert.match(restore, /key:\s*media-engine-sqlite-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/, 'key must be unique per run/attempt (cache entries are immutable)');
  assert.match(restore, /restore-keys:\s*\|\s*\n\s*media-engine-sqlite-\s*$/m, 'restore-keys must fall back to the most recent entry with the shared prefix');
  assert.ok(yaml.indexOf(`- name: ${RESTORE}`) < yaml.indexOf(`- name: ${ENTRYPOINT}`));
});

test('cache save uses the same path and key scheme, after the run, and only when a checkpointed DB exists', () => {
  const restore = stepBlock(RESTORE);
  const save = stepBlock(SAVE);
  assert.match(save, /uses:\s*actions\/cache\/save@v4/);
  assert.match(save, /path:\s*\$\{\{ env\.SQLITE_PATH \}\}/);
  const key = (b) => b.match(/\n {10}key:\s*(.+)/)?.[1].trim();
  assert.equal(key(save), key(restore), 'save must write the key scheme that restore-keys reads');
  assert.match(save, /if:\s*always\(\)\s*&&\s*steps\.sqlite_checkpoint\.outputs\.saveable\s*==\s*'true'/, 'save must run under always() but only after a successful checkpoint');
  assert.ok(yaml.indexOf(`- name: ${ENTRYPOINT}`) < yaml.indexOf(`- name: ${SAVE}`));
});

test('checkpoint step runs under always() and is the step that gates the save', () => {
  const checkpoint = stepBlock(CHECKPOINT);
  assert.match(checkpoint, /id:\s*sqlite_checkpoint/);
  assert.match(checkpoint, /\n {8}if:\s*always\(\)\s*\n/, 'checkpoint must run even if an earlier step failed');
  assert.match(checkpoint, /wal_checkpoint\(TRUNCATE\)/, 'WAL must be folded into the main file and truncated before the file is cached');
  assert.match(checkpoint, /if ! node --input-type=module/, 'node failure must be handled explicitly, not left to bash -e');
  const script = runScript(CHECKPOINT);
  const failBranchExit = script.indexOf('exit 1', script.indexOf('\nthen\n'));
  const saveableTrue = script.indexOf('saveable=true');
  assert.ok(failBranchExit !== -1 && failBranchExit < saveableTrue, 'the failure branch must exit 1 before saveable=true is ever written');
});

test('cache hit/miss is reported in the log, using the outputs that distinguish prefix restores', () => {
  const report = stepBlock(RESTORE_REPORT);
  assert.match(report, /steps\.sqlite_cache_restore\.outputs\.cache-matched-key/, 'a restore-keys hit is only visible through cache-matched-key');
  assert.match(report, /steps\.sqlite_cache_restore\.outputs\.cache-hit/);
  assert.match(report, /SQLite cache: HIT/);
  assert.match(report, /SQLite cache: MISS/);
});

test('Step 1 is preserved: entrypoint still records (not raises) the app exit code; final step still decides job status', () => {
  const entrypoint = stepBlock(ENTRYPOINT);
  assert.match(entrypoint, /id:\s*run_app/);
  assert.match(entrypoint, /echo\s+"code=\$code"\s*>>\s*"\$GITHUB_OUTPUT"/);
  assert.doesNotMatch(entrypoint, /\n\s*exit\s+"\$code"\s*\n/);
  const finalStep = stepBlock(FINAL_REPORT);
  assert.match(finalStep, /if:\s*always\(\)/);
  assert.match(finalStep, /exit\s+"\$code"/);
  assert.equal(
    yaml.indexOf('\n      - name:', yaml.indexOf(`- name: ${FINAL_REPORT}`)),
    -1,
    'the final status step must remain the last step in the job'
  );
});

// ---------------------------------------------------------------- behavior

// A DB in WAL mode whose committed rows still live only in the -wal file,
// held open by this process (as if the application had not closed cleanly).
function makeDbWithUncheckpointedWal(dir) {
  const dbPath = path.join(dir, 'data', 'media-engine.db');
  rmSync(path.join(dir, 'data'), { recursive: true, force: true });
  spawnSync('mkdir', ['-p', path.dirname(dbPath)]);
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('wal_autocheckpoint = 0');
  db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
  const ins = db.prepare('INSERT INTO t (v) VALUES (?)');
  for (let i = 0; i < 50; i += 1) ins.run(`row-${i}`);
  return { db, dbPath };
}

test('checkpoint step folds the WAL into the main file so the main file alone carries all committed rows', { skip: SKIP_NO_POSIX }, () => {
  const dir = tempDir();
  const { db, dbPath } = makeDbWithUncheckpointedWal(dir);
  try {
    assert.ok(statSync(`${dbPath}-wal`).size > 0, 'precondition: committed data is only in the WAL');

    const out = path.join(dir, 'gh-output');
    const res = runBash(runScript(CHECKPOINT), { env: { SQLITE_PATH: dbPath, GITHUB_OUTPUT: out } });
    assert.equal(res.status, 0, `checkpoint step must succeed: ${res.stderr}`);
    assert.match(res.stdout, /\[sqlite-persistence\] wal_checkpoint\(TRUNCATE\): busy=0/);
    assert.match(outputsOf(out), /^saveable=true$/m);

    const walSize = existsSync(`${dbPath}-wal`) ? statSync(`${dbPath}-wal`).size : 0;
    assert.equal(walSize, 0, 'WAL must be truncated after the checkpoint');

    // What the cache would carry: the main file only.
    const copy = path.join(dir, 'restored.db');
    copyFileSync(dbPath, copy);
    const restored = new Database(copy, { readonly: true });
    assert.equal(restored.prepare('SELECT COUNT(*) AS n FROM t').get().n, 50);
    restored.close();
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('checkpoint step with no database reports saveable=false, warns, and does not fail', { skip: SKIP_NO_POSIX }, () => {
  const dir = tempDir();
  try {
    const out = path.join(dir, 'gh-output');
    const res = runBash(runScript(CHECKPOINT), { env: { SQLITE_PATH: path.join(dir, 'data', 'missing.db'), GITHUB_OUTPUT: out } });
    assert.equal(res.status, 0);
    assert.match(res.stdout, /::warning::No SQLite database at SQLITE_PATH=/);
    assert.match(outputsOf(out), /^saveable=false$/m);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an incomplete (busy) checkpoint fails the step and never marks the database saveable', { skip: SKIP_NO_POSIX }, () => {
  const dir = tempDir();
  const { db, dbPath } = makeDbWithUncheckpointedWal(dir);
  // A reader holding an older snapshot while newer frames exist blocks a
  // TRUNCATE checkpoint from completing.
  const reader = new Database(dbPath);
  const writer = new Database(dbPath);
  try {
    const it = reader.prepare('SELECT id FROM t ORDER BY id').iterate();
    it.next();
    writer.pragma('wal_autocheckpoint = 0');
    writer.prepare('INSERT INTO t (v) VALUES (?)').run('newer-than-reader');

    const out = path.join(dir, 'gh-output');
    const res = runBash(runScript(CHECKPOINT), { env: { SQLITE_PATH: dbPath, GITHUB_OUTPUT: out } });
    assert.notEqual(res.status, 0, 'busy checkpoint must fail the step');
    assert.match(res.stdout + res.stderr, /busy=1|database busy/);
    assert.doesNotMatch(outputsOf(out), /saveable=true/, 'an incomplete checkpoint must not unlock the save');
    assert.match(outputsOf(out), /^saveable=false$/m);
    it.return();
  } finally {
    writer.close();
    reader.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}, { timeout: 30000 });

test('a node/SQLite failure during checkpoint (unreadable database) fails the step and never marks the database saveable', { skip: SKIP_NO_POSIX }, () => {
  const dir = tempDir();
  try {
    const dbPath = path.join(dir, 'media-engine.db');
    writeFileSync(dbPath, 'this is not a sqlite database'.repeat(100));
    const out = path.join(dir, 'gh-output');
    const res = runBash(runScript(CHECKPOINT), { env: { SQLITE_PATH: dbPath, GITHUB_OUTPUT: out } });
    assert.notEqual(res.status, 0, 'a failing checkpoint command must fail the step under bash -e');
    assert.match(res.stdout, /::error::SQLite WAL checkpoint did not complete/);
    assert.doesNotMatch(outputsOf(out), /saveable=true/);
    assert.match(outputsOf(out), /^saveable=false$/m);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('after a NON-ZERO application exit the entrypoint step still succeeds, and checkpoint/save gating still proceeds', { skip: SKIP_NO_POSIX }, () => {
  const dir = tempDir();
  const { db, dbPath } = makeDbWithUncheckpointedWal(dir);
  try {
    // `node` stand-in that exits 1 for the application invocation only.
    const bin = path.join(dir, 'bin');
    spawnSync('mkdir', ['-p', bin]);
    writeFileSync(path.join(bin, 'node'), '#!/bin/sh\nexit 1\n');
    chmodSync(path.join(bin, 'node'), 0o755);

    const out = path.join(dir, 'gh-output');
    const env = { SQLITE_PATH: dbPath, GITHUB_OUTPUT: out };

    const entry = runBash(runScript(ENTRYPOINT), { env, path: bin });
    assert.equal(entry.status, 0, 'Step 1: the entrypoint step itself must not fail on a non-zero app exit');
    assert.match(outputsOf(out), /^code=1$/m, 'Step 1: the app exit code is still captured as the step output');

    // The next steps (diagnostic aside) still run: checkpoint under always().
    const cp = runBash(runScript(CHECKPOINT), { env });
    assert.equal(cp.status, 0, `checkpoint must still run and succeed after the failed app run: ${cp.stderr}`);
    assert.match(outputsOf(out), /^saveable=true$/m, 'save is unlocked despite the non-zero app exit');

    // And the job still ultimately fails with the real code (Step 1).
    const finalStep = runBash(runScript(FINAL_REPORT).replace('${{ steps.run_app.outputs.code }}', '1'));
    assert.equal(finalStep.status, 1, 'Step 1: the final step re-emits the real application exit code');
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('restore report prints HIT with the matched key and file size, and MISS when nothing matched', { skip: SKIP_NO_POSIX }, () => {
  const dir = tempDir();
  try {
    const dbPath = path.join(dir, 'media-engine.db');
    writeFileSync(dbPath, 'x'.repeat(123));
    const script = runScript(RESTORE_REPORT);

    const hit = runBash(script, { env: { SQLITE_PATH: dbPath, CACHE_HIT: 'false', CACHE_MATCHED_KEY: 'media-engine-sqlite-42-1' } });
    assert.equal(hit.status, 0);
    assert.match(hit.stdout, /SQLite cache: HIT \(matched key: media-engine-sqlite-42-1; exact-key hit: false\)/);
    assert.match(hit.stdout, new RegExp(`Restored database at SQLITE_PATH=${dbPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\(123 bytes\\)`));

    const miss = runBash(script, { env: { SQLITE_PATH: dbPath, CACHE_HIT: '', CACHE_MATCHED_KEY: '' } });
    assert.equal(miss.status, 0);
    assert.match(miss.stdout, /SQLite cache: MISS/);
    assert.doesNotMatch(miss.stdout, /HIT/);

    const ghost = runBash(script, { env: { SQLITE_PATH: path.join(dir, 'gone.db'), CACHE_HIT: 'false', CACHE_MATCHED_KEY: 'media-engine-sqlite-1-1' } });
    assert.match(ghost.stdout, /::warning::SQLite cache reported a hit but no file exists at SQLITE_PATH=/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
