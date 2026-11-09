import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { SqliteStorageDriver } from '../../src/storage/SqliteStorageDriver.js';

// Runs the REAL scripts/collect-analytics-windows.js as a child process against a disposable
// SQLite file, with global fetch replaced by tests/helpers/stub-analytics-fetch.mjs (no network).
// Asserts the actual process exit code. Publications are dated 2020 so every window is settled.
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SCRIPT = path.join(ROOT, 'scripts/collect-analytics-windows.js');
const STUB = path.join(ROOT, 'tests/helpers/stub-analytics-fetch.mjs');
const PUBLISHED_AT = '2020-01-01T10:00:00.000Z';

async function freshDb() {
  const dbPath = path.join(os.tmpdir(), `exit-${process.pid}-${Math.random()}.db`);
  const storage = new SqliteStorageDriver({ dbPath });
  await storage.migrate();
  storage.run('PRAGMA foreign_keys = OFF');
  for (const n of [1, 2]) {
    storage.run(`INSERT INTO system_runs (id, mode, autonomous_enabled, started_at, config_snapshot) VALUES (?, 'LIVE', 1, ?, '{}')`, [`run${n}`, PUBLISHED_AT]);
    storage.run(`INSERT INTO publications (id, content_version_id, media_artifact_id, provider, status, request_json, provider_item_id, result_json, created_at, updated_at)
      VALUES (?, ?, ?, 'youtube', 'PUBLISHED', ?, ?, ?, ?, ?)`, [`pub${n}`, `cv${n}`, `ma${n}`, JSON.stringify({ requestedPublishAt: null }), `vidAAAAAA${n}`, JSON.stringify({ confirmedVisibility: 'public' }), PUBLISHED_AT, PUBLISHED_AT]);
    storage.run(`INSERT INTO decision_log (id, run_id, subject_type, subject_id, decision, reason, created_at) VALUES (?, ?, 'content_version', ?, 'PUBLISHED', ?, ?)`, [`dl${n}`, `run${n}`, `cv${n}`, `publication_pub${n}_persisted`, PUBLISHED_AT]);
  }
  storage.close();
  return { dbPath, cleanup: () => { for (const s of ['', '-wal', '-shm']) fs.rmSync(dbPath + s, { force: true }); } };
}
function runScript(dbPath, scenario, args = ['--run']) {
  const lock = path.join(os.tmpdir(), `exit-lock-${process.pid}-${Math.random()}`);
  const r = spawnSync(process.execPath, ['--import', pathToFileURL(STUB).href, SCRIPT, ...args], {
    cwd: ROOT, encoding: 'utf8', timeout: 60000,
    env: { ...process.env, SQLITE_PATH: dbPath, STUB_SCENARIO: scenario, RUN_MODE: 'SIMULATION', AUTONOMOUS_ENABLED: 'false',
      YOUTUBE_CLIENT_ID: 'c', YOUTUBE_CLIENT_SECRET: 's', YOUTUBE_REFRESH_TOKEN: 'r' }
  });
  fs.rmSync(lock, { force: true });
  return r;
}

test('exit code 0: scalar and audience both succeed', async () => {
  const db = await freshDb();
  try {
    const r = runScript(db.dbPath, 'OK');
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /Result: OK \(scalar\); audience OK; overall OK/);
  } finally { db.cleanup(); }
});

test('exit code 1: scalar success + audience failure (scalar line still says OK)', async () => {
  const db = await freshDb();
  try {
    const r = runScript(db.dbPath, 'AUDIENCE_400');
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /Result: OK \(scalar\); audience FAILED; overall PARTIAL/);
  } finally { db.cleanup(); }
});

test('exit code 1: scalar failure + audience success (scalar line says FAILED)', async () => {
  const db = await freshDb();
  try {
    const r = runScript(db.dbPath, 'SCALAR_400');
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /Result: FAILED \(scalar\); audience OK; overall PARTIAL/);
  } finally { db.cleanup(); }
});

test('exit code 1: both fail', async () => {
  const db = await freshDb();
  try {
    const r = runScript(db.dbPath, 'BOTH_400');
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /Result: FAILED \(scalar\); audience FAILED; overall FAILED/);
  } finally { db.cleanup(); }
});

test('audience cooldown: first run fails (exit 1), immediate re-run is DEFERRED, exit 0, nothing attempted', async () => {
  const db = await freshDb();
  try {
    const r1 = runScript(db.dbPath, 'AUDIENCE_403');
    assert.equal(r1.status, 1, r1.stdout + r1.stderr);
    const r2 = runScript(db.dbPath, 'AUDIENCE_403');
    assert.equal(r2.status, 0, r2.stdout + r2.stderr);
    assert.match(r2.stdout, /audience DEFERRED: account_level_failure_cooling_down/);
    assert.match(r2.stdout, /audience DEFERRED; overall OK/);
  } finally { db.cleanup(); }
});

test('plan-only (no --run) exits 0 and calls no network', async () => {
  const db = await freshDb();
  try {
    const r = runScript(db.dbPath, 'AUDIENCE_400', []);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /Plan only/);
  } finally { db.cleanup(); }
});

const resultJson = (r) => JSON.parse(r.stdout.split('\n').find((l) => l.startsWith('RESULT_JSON ')).slice('RESULT_JSON '.length));

test('machine-readable result: OK vs DEFERRED are distinguishable; DEFERRED exits 0, attempts nothing; FAILED exits 1', async () => {
  const ok = await freshDb();
  const def = await freshDb();
  try {
    const rOk = runScript(ok.dbPath, 'OK');
    assert.equal(rOk.status, 0);
    const jOk = resultJson(rOk);
    assert.equal(jOk.audienceStatus, 'OK');
    assert.equal(jOk.audienceDeferred, false);
    assert.equal(jOk.audienceCollectionAttempted, true);

    const r1 = runScript(def.dbPath, 'AUDIENCE_403');
    assert.equal(r1.status, 1);
    assert.equal(resultJson(r1).audienceStatus, 'FAILED');
    assert.equal(resultJson(r1).exitCode, 1);
    const r2 = runScript(def.dbPath, 'AUDIENCE_403');
    assert.equal(r2.status, 0);
    const j2 = resultJson(r2);
    assert.equal(j2.audienceStatus, 'DEFERRED');
    assert.equal(j2.audienceDeferred, true);
    assert.equal(j2.audienceReason, 'account_level_failure_cooling_down');
    assert.equal(j2.audienceCollectionAttempted, false, 'cool-down: no collection attempted, not a success');
    assert.equal(j2.exitCode, 0);
    assert.notDeepEqual(j2, jOk);
    // no retry loop: the DEFERRED run made no audience HTTP request
    assert.doesNotMatch(r2.stdout, /audience: \d+ requested/);
  } finally { ok.cleanup(); def.cleanup(); }
});
