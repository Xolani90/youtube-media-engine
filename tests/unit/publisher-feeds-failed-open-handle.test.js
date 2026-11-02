// Regression: a database that fails to open (not a SQLite file) must not leave a file handle behind.
// Root cause of the Windows EBUSY on not-a-db.db: SqliteStorageDriver's constructor created a better-sqlite3
// handle, then `pragma journal_mode = WAL` threw ("file is not a database"); the half-built driver was discarded
// with the handle still open until garbage collection, so removing the file (or its directory) failed on Windows.
//
// Detection: Linux/macOS-with-procfs check the process fd table directly (a deleted-while-open file would not
// fail there). Everywhere, the file must be removable immediately, which is the Windows failure itself.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SqliteStorageDriver } from '../../src/storage/SqliteStorageDriver.js';
import { main } from '../../scripts/annotate-blocked-sources.js';

const FD_DIR = '/proc/self/fd';
const procfs = fs.existsSync(FD_DIR);
function openHandlesOn(file) {
  if (!procfs) return null;
  const base = path.basename(file);
  return fs.readdirSync(FD_DIR).filter((n) => { try { return fs.readlinkSync(path.join(FD_DIR, n)).includes(base); } catch { return false; } }).length;
}
function notSqlite(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${tag}-`));
  // unique file name per call: a handle leaked by an earlier test must not be mistaken for this test's
  const file = path.join(dir, `${path.basename(dir)}-not-a-db.db`);
  fs.writeFileSync(file, 'this is not sqlite');
  return { dir, file };
}
function assertReleased(file, dir, label) {
  const n = openHandlesOn(file);
  if (n !== null) assert.equal(n, 0, `${label}: no open handle may remain on the file`);
  fs.rmSync(dir, { recursive: true, force: false }); // must succeed immediately (EBUSY on Windows if a handle leaked)
  assert.equal(fs.existsSync(dir), false, label);
}

test('SqliteStorageDriver: a constructor failure closes the handle it opened', () => {
  const { dir, file } = notSqlite('drv-fail');
  assert.throws(() => new SqliteStorageDriver({ dbPath: file }), /not a database/i);
  assertReleased(file, dir, 'driver constructor failure');
});

for (const mode of [['--write'], ['--dry-run']]) {
  test(`annotate CLI ${mode[0]} on a non-SQLite file: DATABASE_ERROR, no fetch, no handle left behind`, async () => {
    const { dir, file } = notSqlite('cli-fail');
    let fetched = 0; const lines = [];
    const code = await main({ argv: ['--db', file, ...mode], env: {}, out: (l) => lines.push(l), fetchImpl: async () => { fetched += 1; throw new Error('must not fetch'); } });
    assert.equal(code, 1);
    assert.match(lines.join('\n'), /DATABASE_ERROR/);
    assert.equal(fetched, 0);
    assert.equal(fs.readFileSync(file, 'utf8'), 'this is not sqlite', 'source file untouched');
    assertReleased(file, dir, `CLI ${mode[0]}`);
  });
}
