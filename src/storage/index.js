import { SqliteStorageDriver } from './SqliteStorageDriver.js';
import { config } from '../config/index.js';

const DRIVERS = {
  sqlite: (cfg) => new SqliteStorageDriver({ dbPath: cfg.sqlitePath })
};

/**
 * Returns the configured storage driver instance.
 * Business services must depend on this factory / the StorageDriver
 * interface only — never on better-sqlite3 or any driver-specific API.
 */
export function createStorage(cfg = config) {
  const factory = DRIVERS[cfg.storageDriver];
  if (!factory) {
    throw new Error(`Unknown storage driver: ${cfg.storageDriver}`);
  }
  return factory(cfg);
}

export default createStorage;
