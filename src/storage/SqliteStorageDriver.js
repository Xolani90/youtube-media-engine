import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { StorageDriver } from './StorageDriver.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export class SqliteStorageDriver extends StorageDriver {
  constructor({ dbPath }) {
    super();
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
  }

  async migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id TEXT PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
    `);
    const migrationsDir = path.resolve(__dirname, '..', 'db', 'migrations');
    const files = fs.existsSync(migrationsDir)
      ? fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort()
      : [];

    const applied = new Set(
      this.db.prepare('SELECT id FROM schema_migrations').all().map((r) => r.id)
    );

    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
      const applyMigration = this.db.transaction(() => {
        this.db.exec(sql);
        this.db
          .prepare('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)')
          .run(file, new Date().toISOString());
      });
      applyMigration();
    }
    return files;
  }

  run(sql, params = []) {
    const stmt = this.db.prepare(sql);
    return stmt.run(...params);
  }

  all(sql, params = []) {
    const stmt = this.db.prepare(sql);
    return stmt.all(...params);
  }

  get(sql, params = []) {
    const stmt = this.db.prepare(sql);
    return stmt.get(...params);
  }

  transaction(fn) {
    const wrapped = this.db.transaction(fn);
    return wrapped();
  }

  close() {
    this.db.close();
  }
}

export default SqliteStorageDriver;
