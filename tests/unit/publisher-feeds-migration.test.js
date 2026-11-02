import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { SqliteStorageDriver } from '../../src/storage/SqliteStorageDriver.js';
import { freshMigratedStorage, removeDb, tmpDbPath } from '../helpers/publisherFeedsFixture.js';

const MIGRATION = new URL('../../src/db/migrations/0032_publisher_feed_items.sql', import.meta.url);
const SQL = fs.readFileSync(MIGRATION, 'utf8');

test('0032 is purely additive: only CREATE TABLE/INDEX IF NOT EXISTS on publisher_feed_items', () => {
  const stripped = SQL.replace(/--.*$/gm, '');
  const statements = stripped.split(';').map((s) => s.trim()).filter(Boolean);
  assert.equal(statements.length, 2);
  assert.match(statements[0], /^CREATE TABLE IF NOT EXISTS publisher_feed_items\b/);
  assert.match(statements[1], /^CREATE INDEX IF NOT EXISTS \w+ ON publisher_feed_items\b/);
  assert.doesNotMatch(stripped, /\b(DROP|ALTER|INSERT|UPDATE|DELETE|REFERENCES|TRIGGER)\b/i);
});

test('runner applies 0032 on a fresh database without an FK-toggle entry', async () => {
  const { storage, dbPath } = await freshMigratedStorage('mig-fresh');
  try {
    const ids = storage.all('SELECT id FROM schema_migrations ORDER BY id').map((r) => r.id);
    assert.ok(ids.includes('0032_publisher_feed_items.sql'));
    assert.equal(ids[ids.length - 1], '0032_publisher_feed_items.sql');
    assert.equal(storage.all("SELECT name FROM sqlite_master WHERE name = 'publisher_feed_items'").length, 1);
    assert.equal(storage.all('PRAGMA foreign_key_list(publisher_feed_items)').length, 0, 'no FK out of the feed table');
    for (const t of storage.all("SELECT name, sql FROM sqlite_master WHERE type='table' AND name != 'publisher_feed_items'")) {
      assert.doesNotMatch(t.sql ?? '', /publisher_feed_items/, `${t.name} must not reference the feed table`);
    }
  } finally { storage.close(); removeDb(dbPath); }
});

test('upgrading an existing database (0001..0031 applied) applies only 0032 and keeps all data', async () => {
  const { storage, dbPath } = await freshMigratedStorage('mig-upgrade');
  try {
    storage.run("INSERT INTO opportunities (id, title, source, discovered_at, status) VALUES ('o1','T','rss','2026-10-22T00:00:00.000Z','NEW')");
    storage.run('DROP INDEX idx_publisher_feed_items_blocked_source');
    storage.run('DROP TABLE publisher_feed_items');
    storage.run("DELETE FROM schema_migrations WHERE id = '0032_publisher_feed_items.sql'");
    const before = storage.all('SELECT id FROM schema_migrations ORDER BY id').length;
    await storage.migrate();
    assert.equal(storage.all('SELECT id FROM schema_migrations').length, before + 1);
    assert.equal(storage.get("SELECT COUNT(*) n FROM opportunities").n, 1);
    assert.equal(storage.all("SELECT name FROM sqlite_master WHERE name = 'publisher_feed_items'").length, 1);
  } finally { storage.close(); removeDb(dbPath); }
});

test('the SQL is idempotent: executing it again (explicit --apply-migration, then the runner) is harmless', async () => {
  const { storage, dbPath } = await freshMigratedStorage('mig-idem');
  try {
    storage.db.exec(SQL);
    storage.db.exec(SQL);
    storage.run("DELETE FROM schema_migrations WHERE id = '0032_publisher_feed_items.sql'");
    await storage.migrate();
    assert.equal(storage.all("SELECT name FROM sqlite_master WHERE name = 'publisher_feed_items'").length, 1);
  } finally { storage.close(); removeDb(dbPath); }
});

test('CHECK constraints make evidentiary or foreign-origin rows unrepresentable', async () => {
  const { storage, dbPath } = await freshMigratedStorage('mig-check');
  try {
    const base = ['id','f','k','g','l','n','t','s','h','p','2026','2026','sid','url','proj','FAILED','plain','HTTP 403',403];
    const ins = (cls, origin, evid) => storage.run(
      `INSERT INTO publisher_feed_items (id, feed_url, item_key, item_guid, item_link, item_url_normalized, title, summary_text, summary_sha256,
         published_at_feed, feed_fetched_at, annotated_at, blocked_source_id, blocked_source_url, research_project_id,
         blocked_retrieval_status, blocked_retrieval_method, blocked_error_text, blocked_http_status, failure_class, origin, evidentiary)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [...base, cls, origin, evid]);
    assert.throws(() => ins('host_access_denied', 'rss_feed_metadata', 1), /CHECK/);
    assert.throws(() => ins('host_access_denied', 'direct_retrieval', 0), /CHECK/);
    assert.throws(() => ins('tls_fingerprint_block', 'rss_feed_metadata', 0), /CHECK/);
    ins('host_access_denied', 'rss_feed_metadata', 0);
    assert.equal(storage.get('SELECT COUNT(*) n FROM publisher_feed_items').n, 1);
  } finally { storage.close(); removeDb(dbPath); }
});

test('a database file migrated by the runner twice is stable (no-op second run)', async () => {
  const dbPath = tmpDbPath('mig-twice');
  const s = new SqliteStorageDriver({ dbPath });
  try { await s.migrate(); const a = s.all('SELECT id FROM schema_migrations').length; await s.migrate(); assert.equal(s.all('SELECT id FROM schema_migrations').length, a); }
  finally { s.close(); removeDb(dbPath); }
});
