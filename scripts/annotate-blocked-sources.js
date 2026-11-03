#!/usr/bin/env node
/**
 * Blocked-source annotation audit (Phase 1 publisher RSS metadata isolation).
 *
 *   node scripts/annotate-blocked-sources.js --db <path> [--dry-run | --write] [--apply-migration] [--feed-id openai-news]
 *
 * Reads FAILED rows from `sources` (SELECT only), fetches ONE Owner-authorized
 * feed with plain Node fetch, and records matching feed items as
 * NON-EVIDENTIARY metadata in `publisher_feed_items`. It never writes to
 * `sources`, `claims`, `claim_sources` or `decision_log`, never retries or
 * replaces direct retrieval, and fails closed: if the feed cannot be used,
 * nothing is written.
 *
 * DEFAULT MODE IS DRY-RUN: nothing is written unless --write is passed explicitly. --write requires an
 * explicit --db (SQLITE_PATH is honoured for dry-run only). --dry-run and --write are mutually exclusive.
 *
 * --write            records the planned annotations in publisher_feed_items (the only table ever written).
 * --dry-run          REQUIRES A QUIESCENT DATABASE (no concurrent writer; see openDb). Reads a private temp COPY of the database (and its -wal/-journal) and writes nothing to
 *                    the source database or its directory (no -wal/-shm sidecars are created there). It does
 *                    create and remove a temp directory under os.tmpdir(); it is NOT free of all filesystem
 *                    activity. --apply-migration is ignored. See openDb().
 * --apply-migration  executes only the idempotent 0032 SQL when the table is missing.
 * Without it, a missing table is reported and nothing is written.
 *
 * Exit codes: 0 ok, 1 usage/config/database/internal error, 2 feed unavailable (nothing written), 3 table missing.
 * Local validation (args, config, database, schema) always runs BEFORE any network request.
 */
import fs from 'node:fs';
import os from 'node:os';
import nodePath from 'node:path';
import Database from 'better-sqlite3';
import { createStorage } from '../src/storage/index.js';
import { isCliEntry } from '../src/publisherFeeds/cliEntry.js';
import { loadPublisherFeedConfig, findAuthorizedFeed, fetchPublisherFeed } from '../src/publisherFeeds/feedClient.js';
import { annotateBlockedSources, tableExists } from '../src/publisherFeeds/annotate.js';
import { FEED_LABEL, FEED_FAILURE } from '../src/publisherFeeds/constants.js';

const MIGRATION_URL = new URL('../src/db/migrations/0032_publisher_feed_items.sql', import.meta.url);

const USAGE = 'usage: node scripts/annotate-blocked-sources.js --db <path> [--dry-run | --write] [--apply-migration] [--feed-id <id>] [--json]';
const REQUIRED_SOURCE_COLUMNS = ['id', 'research_project_id', 'url', 'retrieval_status', 'notes', 'retrieved_at'];

export function parseArgs(argv) {
  const o = { db: null, dryRun: true, write: false, applyMigration: false, feedId: null, json: false };
  let sawDryRun = false;
  const value = (name, i) => {
    const v = argv[i + 1];
    if (v === undefined || v === '' || v.startsWith('-')) throw new Error(`${name} requires a value`);
    return v;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--db') { o.db = value(a, i); i += 1; }
    else if (a === '--feed-id') { o.feedId = value(a, i); i += 1; }
    else if (a === '--dry-run') sawDryRun = true;
    else if (a === '--write') o.write = true;
    else if (a === '--apply-migration') o.applyMigration = true;
    else if (a === '--json') o.json = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  if (sawDryRun && o.write) throw new Error('--dry-run and --write are mutually exclusive');
  // Dry-run is the default: a write happens ONLY when --write was passed explicitly.
  o.dryRun = !o.write;
  return o;
}

/** Checks the file is a SQLite database with a usable `sources` table. Throws a descriptive Error. */
function checkSchema(all) {
  const cols = all('PRAGMA table_info(sources)', []).map((c) => c.name);
  if (cols.length === 0) throw new Error('schema invalid: table `sources` not found');
  const missing = REQUIRED_SOURCE_COLUMNS.filter((c) => !cols.includes(c));
  if (missing.length) throw new Error(`schema invalid: sources is missing columns: ${missing.join(', ')}`);
}

/**
 * Opens the database. Write mode uses the shared storage driver (which sets
 * journal_mode = WAL). Dry-run NEVER opens the source database file: SQLite
 * creates -wal/-shm sidecars beside a WAL database even for a read-only
 * connection, so dry-run reads a private copy (database + any -wal/-journal)
 * placed in a fresh temp directory, which is removed on close. The source
 * directory is not touched. The copy is a point-in-time file copy; it is
 * only as consistent as a plain file copy of a database that another
 * process is writing to. OPERATIONAL REQUIREMENT: dry-run must be run
 * against a QUIESCENT database (no writer active). SQLite's online backup
 * API would give a transactional snapshot, but it must open the source
 * database, and that creates -wal/-shm sidecars beside a WAL database
 * (verified), which dry-run exists to avoid. A size/mtime check around the
 * copy rejects the run if the source changed during the copy; it detects
 * some concurrent writes and proves nothing about snapshot consistency.
 */
const statKey = (f) => { try { const st = fs.statSync(f); return `${st.size}:${st.mtimeMs}`; } catch { return 'absent'; } };

function openDb(path, { write, copyHook = null }) {
  if (!fs.existsSync(path)) throw new Error(`database not found: ${path}`);
  if (!fs.statSync(path).isFile()) throw new Error(`database path is not a file: ${path}`);
  if (!write) {
    const tmp = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'annotate-dryrun-'));
    const copy = nodePath.join(tmp, 'copy.db');
    let db;
    try {
      const sidecars = ['', '-wal', '-journal'];
      const before = sidecars.map((sfx) => statKey(`${path}${sfx}`));
      for (const sfx of sidecars) {
        if (fs.existsSync(`${path}${sfx}`)) fs.copyFileSync(`${path}${sfx}`, `${copy}${sfx}`);
      }
      copyHook?.(path);
      // Best-effort writer detector, NOT a snapshot guarantee: if any source file changed while it was
      // being copied the copy may be torn, so refuse rather than report on it.
      const after = sidecars.map((sfx) => statKey(`${path}${sfx}`));
      if (before.some((b, i) => b !== after[i])) throw new Error('source database changed while being copied; dry-run requires a quiescent database');
      db = new Database(copy, { fileMustExist: true });
      const all = (sql, p = []) => db.prepare(sql).all(...p);
      all('SELECT 1', []);
      return { all, close: () => { try { db.close(); } finally { fs.rmSync(tmp, { recursive: true, force: true }); } } };
    } catch (e) {
      try { db?.close(); } catch { /* ignore */ }
      fs.rmSync(tmp, { recursive: true, force: true });
      throw e;
    }
  }
  const storage = createStorage({ storageDriver: 'sqlite', sqlitePath: path });
  return {
    all: (sql, p = []) => storage.all(sql, p), run: (sql, p = []) => storage.run(sql, p),
    transaction: (fn) => storage.transaction(fn), exec: (sql) => storage.db.exec(sql), close: () => storage.close()
  };
}

/**
 * Exit codes: 0 ok, 1 usage / config / database / internal error,
 * 2 feed unavailable (nothing written), 3 table missing.
 * Order: arguments -> config -> database path + schema -> (network) feed -> annotate.
 * No network request is made until every local check has passed.
 */
export async function main({ argv = process.argv.slice(2), env = process.env, out = console.log, fetchImpl = fetch, now, configPath, copyHook } = {}) {
  let db;
  try {
    let opts;
    try { opts = parseArgs(argv); } catch (e) { out(`usage error: ${e.message}`); out(USAGE); return 1; }
    // A write must name its database explicitly: SQLITE_PATH is honoured for dry-run only.
    const dbPath = opts.write ? opts.db : (opts.db ?? env.SQLITE_PATH);
    if (!dbPath) { if (opts.write) out('usage error: --write requires an explicit --db <path>'); out(USAGE); return 1; }

    let feed;
    try {
      feed = findAuthorizedFeed(configPath ? loadPublisherFeedConfig(configPath) : loadPublisherFeedConfig(), { feedId: opts.feedId });
    } catch (e) {
      out(`[publisher-feed-annotation] CONFIG_ERROR ${e.message} written=0`);
      return 1;
    }
    if (!feed) { out(`[publisher-feed-annotation] FEED_UNAVAILABLE reason=${FEED_FAILURE.NOT_AUTHORIZED} written=0`); return 2; }

    try {
      db = openDb(dbPath, { write: opts.write === true, copyHook });
      checkSchema(db.all);
    } catch (e) {
      out(`[publisher-feed-annotation] DATABASE_ERROR ${e.message} written=0`);
      return 1;
    }
    if (!opts.dryRun && !tableExists(db.all) && !opts.applyMigration) {
      out('[publisher-feed-annotation] TABLE_MISSING publisher_feed_items; re-run with --apply-migration (executes only the idempotent 0032 SQL) written=0');
      return 3;
    }

    const feedResult = await fetchPublisherFeed(feed, { fetchImpl, ...(now ? { now } : {}) });
    if (!feedResult.ok) {
      out(`[publisher-feed-annotation] FEED_UNAVAILABLE reason=${feedResult.reason} http_status=${feedResult.httpStatus ?? 'NONE'}${feedResult.detail ? ` detail=${feedResult.detail}` : ''} written=0`);
      return 2;
    }

    if (!opts.dryRun && !tableExists(db.all)) db.exec(fs.readFileSync(MIGRATION_URL, 'utf8'));
    const summary = annotateBlockedSources({ db, feed, feedResult, dryRun: opts.write !== true, ...(now ? { now } : {}) });
    if (opts.json) { out(JSON.stringify(summary)); return 0; }
    out(`[publisher-feed-annotation] label=${FEED_LABEL} feed=${feed.feedUrl} dry_run=${summary.dryRun}`);
    out(`feed_items_parsed=${summary.feedItemsParsed} feed_items_off_host=${summary.feedItemsOffHost} feed_items_dropped_no_key=${summary.feedItemsDroppedNoKey} blocked_sources=${summary.blockedSourcesConsidered} sources_with_match=${summary.sourcesWithMatch} planned_rows=${summary.plannedRows} inserted=${summary.inserted} duplicates=${summary.duplicates}`);
    out(`by_failure_class=${JSON.stringify(summary.byFailureClass)}`);
    for (const e of summary.entries) {
      out(`source=${e.sourceId} url=${e.url} failure_class=${e.failureClass} http_status=${e.httpStatus ?? 'NONE'} error=${e.originalError ?? 'NONE'} matched_items=${e.matchedItemKeys.length}${e.skipped ? ` skipped=${e.skipped}` : ''}`);
    }
    if (summary.dryRun) out('[publisher-feed-annotation] dry-run: nothing was written; re-run with --write and an explicit --db to record annotations');
    return 0;
  } catch (e) {
    out(`[publisher-feed-annotation] ERROR ${e.message}`);
    return 1;
  } finally {
    try { db?.close(); } catch { /* ignore close errors */ }
  }
}

if (isCliEntry(import.meta.url, process.argv[1])) {
  try { process.exitCode = await main(); } catch (e) { console.log(`[publisher-feed-annotation] ERROR ${e.message}`); process.exitCode = 1; }
}
