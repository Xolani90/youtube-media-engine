import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { SqliteStorageDriver } from '../../src/storage/SqliteStorageDriver.js';
import { resolveShortFormMusic } from '../../src/media/shortMusic.js';
import { sha256File } from '../../src/media/artifactStore.js';

function setup(status = 'VERIFIED') {
  const dbPath = path.join(os.tmpdir(), `sfm-${Date.now()}-${Math.random()}.db`);
  const storage = new SqliteStorageDriver({ dbPath });
  storage.migrate();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sfm-files-'));
  const file = path.join(dir, 'bed.mp3'); fs.writeFileSync(file, 'music-bytes');
  const id = crypto.randomUUID();
  storage.run(`INSERT INTO assets (id, asset_type, location, checksum, origin, license, attribution_required, verification_status, imported_at, created_at) VALUES (?, 'music', ?, ?, 'o', 'full licence text', 0, ?, ?, ?)`, [id, file, sha256File(file), status, new Date().toISOString(), new Date().toISOString()]);
  const spec = { music: { asset_id: id, sha256: sha256File(file), duration_seconds: 120, params: { music_gain_db: -18 } }, narration: { duration_seconds: 64.5 } };
  const cleanup = () => { storage.close(); for (const f of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) fs.rmSync(f, { force: true }); fs.rmSync(dir, { recursive: true, force: true }); };
  return { storage, id, file, spec, cleanup };
}

test('short music: no music in the source spec means nothing to do and no reason', () => {
  const { storage, cleanup } = setup();
  try { assert.deepEqual(resolveShortFormMusic({ storage, sourceRenderSpec: { narration: { duration_seconds: 10 } } }), { music: null, assetId: null, reason: null }); } finally { cleanup(); }
});

test('short music: a verified, checksum-matching asset is mixed with the source params and full narration duration', () => {
  const { storage, spec, file, cleanup } = setup();
  try {
    const r = resolveShortFormMusic({ storage, sourceRenderSpec: spec, env: {} });
    assert.equal(r.reason, null);
    assert.deepEqual(r.music, { path: file, narrationDurationSeconds: 64.5, params: { music_gain_db: -18 } });
  } finally { cleanup(); }
});

test('short music: every failed re-check leaves the short narration-only with a reason', () => {
  for (const [label, mutate, expected] of [
    ['unverified', (c) => c.storage.run(`UPDATE assets SET verification_status = 'UNVERIFIED' WHERE id = ?`, [c.id]), 'verification_UNVERIFIED'],
    ['disputed', (c) => c.storage.run(`UPDATE assets SET verification_status = 'DISPUTED' WHERE id = ?`, [c.id]), 'verification_DISPUTED'],
    ['file gone', (c) => fs.rmSync(c.file), 'file_missing'],
    ['file changed', (c) => fs.writeFileSync(c.file, 'tampered'), 'checksum_mismatch'],
    ['asset deleted', (c) => c.storage.run(`DELETE FROM assets WHERE id = ?`, [c.id]), 'asset_missing'],
    ['spec incomplete', (c) => { delete c.spec.narration; }, 'render_spec_incomplete']
  ]) {
    const c = setup();
    try {
      mutate(c);
      const r = resolveShortFormMusic({ storage: c.storage, sourceRenderSpec: c.spec, env: {} });
      assert.equal(r.music, null, label);
      assert.equal(r.reason, expected, label);
    } finally { c.cleanup(); }
  }
});

test('short music: MUSIC_DUCKING=off keeps the short narration-only', () => {
  const { storage, spec, cleanup } = setup();
  try { assert.equal(resolveShortFormMusic({ storage, sourceRenderSpec: spec, env: { MUSIC_DUCKING: 'off' } }).reason, 'mixing_disabled'); } finally { cleanup(); }
});
