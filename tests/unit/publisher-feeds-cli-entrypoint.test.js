import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { isCliEntry } from '../../src/publisherFeeds/cliEntry.js';

const root = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const LIVE = path.join(root, 'scripts/check-publisher-feed-live.js');
const ANN = path.join(root, 'scripts/annotate-blocked-sources.js');
const run = (args, env = {}) => spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8', env: { PATH: process.env.PATH, ...env }, timeout: 30000 });

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
