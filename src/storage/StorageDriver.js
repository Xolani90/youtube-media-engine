/**
 * StorageDriver is the abstract boundary between application/business
 * services and whatever persistence technology is actually in use.
 *
 * M0 implementation: SqliteStorageDriver.
 * Future: any driver implementing this same interface (e.g. Postgres,
 * hosted DB) can be swapped in via config.storageDriver without changing
 * any business logic that depends on StorageDriver.
 *
 * This is intentionally minimal for M0 — just enough to run migrations
 * and perform parameterized reads/writes/transactions.
 */
export class StorageDriver {
  /** Run pending migrations. */
  async migrate() {
    throw new Error('not implemented');
  }

  /** Run a write statement (INSERT/UPDATE/DELETE). Returns { changes, lastInsertRowid }. */
  run(sql, params = []) {
    throw new Error('not implemented');
  }

  /** Run a read statement, return all matching rows. */
  all(sql, params = []) {
    throw new Error('not implemented');
  }

  /** Run a read statement, return the first matching row or undefined. */
  get(sql, params = []) {
    throw new Error('not implemented');
  }

  /** Run a function inside a transaction. */
  transaction(fn) {
    throw new Error('not implemented');
  }

  close() {
    throw new Error('not implemented');
  }
}

export default StorageDriver;
