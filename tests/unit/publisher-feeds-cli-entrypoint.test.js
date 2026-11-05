import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { isCliEntry } from '../../src/publisherFeeds/cliEntry.js';

const root = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const LIVE = path.join(root, 'scripts/check-publisher-feed-live.js');
const ANN = path.join(root, 'scripts/annotate-blocked-sources.js');
// Isolation from the developer's local .env: src/config/index.js calls process.loadEnvFile(<repo>/.env) when it is
// imported, which would inject e.g. SQLITE_PATH into the child. The child therefore gets only PATH plus a --import
// shim (written to a private temp dir) that turns loadEnvFile into a no-op. The real .env is never read, moved,
// renamed or modified by this test, and no database path is supplied.
const isolationDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ame-cli-test-'));
const noEnvShim = path.join(isolationDir, 'no-env-file.mjs');
fs.writeFileSync(noEnvShim, 'process.loadEnvFile = () => {};\n');
after(() => { fs.rmSync(isolationDir, { recursive: true, force: true }); });
const ISOLATED_ENV = { PATH: process.env.PATH, NODE_OPTIONS: `--import ${pathToFileURL(noEnvShim).href}` };
const run = (args, env = {}) => spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8', env: { ...ISOLATED_ENV, ...env }, timeout: 30000 });

test('live-check script, launched by Node, runs main(): usage error, exit 1, no request', () => {
  const r = run([LIVE, '--bogus']);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /usage: node scripts\/check-publisher-feed-live\.js/);
});

test('annotation CLI, launched by Node, runs main(): usage output, exit 1 (no --db, no SQLITE_PATH)', () => {
  const r = run([ANN]);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /usage: node scripts\/annotate-blocked-sources\.js/);
  const bad = run([ANN, '--db']);
  assert.equal(bad.status, 1);
  assert.match(bad.stdout, /--db requires a value/);
});

test('entrypoint detection also works with a relative path and a non-normalized path', () => {
  assert.equal(run(['scripts/check-publisher-feed-live.js', '--bogus']).status, 1);
  assert.equal(run([path.join(root, 'scripts', '..', 'scripts', 'annotate-blocked-sources.js')]).status, 1);
});

test('importing either script as a module does NOT run its CLI (no output, no exit code, process ends 0)', () => {
  for (const f of [LIVE, ANN]) {
    const r = run(['--input-type=module', '-e', `const m = await import(${JSON.stringify(pathToFileURL(f).href)}); if (typeof m.main !== 'function') process.exit(9);`]);
    assert.equal(r.status, 0, `${f}: ${r.stderr}`);
    assert.equal(r.stdout, '', `${f} printed on import`);
  }
});

test('isCliEntry with Windows path semantics (drive letters, backslashes, spaces, case, ..)', () => {
  const w = { windows: true };
  assert.equal(isCliEntry('file:///C:/repo/scripts/x.js', 'C:\\repo\\scripts\\x.js', w), true);
  assert.equal(isCliEntry('file:///C:/repo/scripts/x.js', 'c:\\REPO\\scripts\\x.js', w), true, 'case-insensitive on Windows');
  assert.equal(isCliEntry('file:///C:/repo/scripts/x.js', 'C:\\repo\\scripts\\..\\scripts\\x.js', w), true);
  assert.equal(isCliEntry('file:///C:/my%20repo/scripts/x.js', 'C:\\my repo\\scripts\\x.js', w), true, 'spaces / percent-encoding');
  assert.equal(isCliEntry('file:///C:/repo/scripts/x.js', 'C:\\repo\\scripts\\y.js', w), false);
  assert.equal(isCliEntry('file:///C:/repo/scripts/x.js', 'D:\\repo\\scripts\\x.js', w), false, 'different drive');
  assert.equal(isCliEntry('file:///C:/repo/scripts/x.js', undefined, w), false);
  // the old string comparison fails exactly these Windows cases
  assert.notEqual('file:///C:/repo/scripts/x.js', 'file://C:\\repo\\scripts\\x.js');
});

test('isCliEntry with POSIX semantics is case-sensitive and rejects other files', () => {
  const p = { windows: false };
  assert.equal(isCliEntry('file:///a/b/x.js', '/a/b/x.js', p), true);
  assert.equal(isCliEntry('file:///a/b/x.js', '/a/B/x.js', p), false);
  assert.equal(isCliEntry('file:///a/b/x.js', '/a/b/y.js', p), false);
  assert.equal(isCliEntry('not a url', '/a/b/x.js', p), false);
});

test('isolation: the child never loads the repository .env (a local SQLITE_PATH cannot leak into it)', () => {
  const cfg = pathToFileURL(path.join(root, 'src', 'config', 'index.js')).href;
  const r = run(['--input-type=module', '-e', `await import(${JSON.stringify(cfg)}); process.stdout.write(process.env.SQLITE_PATH === undefined ? 'unset' : 'LEAKED');`]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, 'unset');
});

test('isolation: the no-database usage path neither creates nor touches the real application database', () => {
  const dataDir = path.join(root, 'data');
  const realDb = path.join(dataDir, 'media-engine.db');
  const snap = () => ({ dir: fs.existsSync(dataDir), db: fs.existsSync(realDb) ? fs.statSync(realDb).mtimeMs : null });
  const before = snap();
  const r = run([ANN]);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /usage: node scripts\/annotate-blocked-sources\.js/);
  assert.doesNotMatch(r.stdout, /DATABASE_ERROR|database not found/);
  assert.deepEqual(snap(), before);
});
