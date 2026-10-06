#!/usr/bin/env node
/**
 * Persisted-state integrity check for the unattended runner.
 *
 * The scheduled workflow carries run state between GitHub-hosted runners in
 * ONE cache entry: the SQLite file plus the local filesystem artifacts that
 * later stages read back. This script verifies the invariant that makes that
 * safe:
 *
 *   If SQLite says an item is ready for a later stage, every local file that
 *   stage needs must exist (and be non-empty) right now.
 *
 * It is READ-ONLY. It opens the database read-only, never writes, never
 * re-renders, never fabricates or repairs a missing file. It reports
 * divergence; the workflow decides what to do with it.
 *
 * What counts as "required" is derived from what the pipeline actually reads
 * (see the readers named below), not from "everything under data/":
 *
 *   media_artifacts.artifact_path        Gate 2 GC-001 hashes it; Publication
 *                                        step 4 existsSync()s it and the
 *                                        adapter uploads it.
 *   media_artifacts.narration_path       the short-form derivative is rendered
 *                                        FROM the long-form narration
 *                                        (src/media/pipeline.js). Required only
 *                                        until the short-form row exists.
 *   short_form_media_artifacts.artifact_path
 *                                        what youtube_shorts publishes.
 *   assets.location                      Media Production re-reads visual
 *                                        assets for any PRODUCED item with no
 *                                        media_artifacts row yet; a missing
 *                                        file is a RENDER_FAILED that spends
 *                                        the item's bounded-retry budget.
 *
 * NOT required (reported as warnings at most):
 *   media_artifacts.thumbnail_path       Publication regenerates a missing
 *                                        thumbnail (ensureThumbnailArtifact).
 *   productions.artifact_path            inspection-only manifest file; no
 *                                        later stage reads it (the manifest is
 *                                        read from productions.manifest_json).
 *
 * A run that produced nothing is healthy: no rows -> no required files -> OK.
 *
 * Usage:
 *   node scripts/check-persisted-state-integrity.js [--db <path>] [--report-only]
 *
 *   --db           database path (default: SQLITE_PATH, else data/media-engine.db)
 *   --report-only  print findings but always exit 0 (used right after restore,
 *                  to attribute divergence to the restore rather than the run)
 *
 * Exit codes: 0 = consistent (or --report-only), 1 = divergence found,
 *             2 = the check itself could not run (missing/unreadable DB).
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL, fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Pure-URI locations (provisioning validation rejects these, but a historical
// row must not crash the check): nothing on the local filesystem to verify.
const URI_LIKE = /^[a-z][a-z0-9+.-]*:\/\//i;

function hasTable(db, name) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}

function hasColumn(db, table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
}

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

/** @returns {{status: 'OK'|'MISSING'|'EMPTY'|'NOT_A_FILE', size?: number}} */
function inspectFile(filePath) {
  if (typeof filePath !== 'string' || filePath.length === 0) return { status: 'MISSING' };
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return { status: 'MISSING' };
  }
  if (!stat.isFile()) return { status: 'NOT_A_FILE' };
  if (stat.size <= 0) return { status: 'EMPTY', size: 0 };
  return { status: 'OK', size: stat.size };
}

/**
 * @param {{ dbPath: string }} opts
 * @returns {{ ok: boolean, violations: object[], warnings: object[], counts: object }}
 */
export function checkPersistedStateIntegrity({ dbPath }) {
  if (!dbPath || !fs.existsSync(dbPath)) {
    const err = new Error(`SQLite database not found at ${dbPath}`);
    err.code = 'DB_MISSING';
    throw err;
  }

  const violations = [];
  const warnings = [];
  const counts = { mediaArtifacts: 0, shortFormArtifacts: 0, pendingRenderAssets: 0, filesChecked: 0, bytesChecked: 0 };

  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const requireFile = (kind, subject, filePath, { checksum = null } = {}) => {
      counts.filesChecked += 1;
      const info = inspectFile(filePath);
      if (info.status !== 'OK') {
        violations.push({ code: `${kind}_FILE_${info.status}`, subject, path: filePath ?? null });
        return;
      }
      counts.bytesChecked += info.size;
      // Catches a truncated/corrupt cache restore, not just an absent file.
      if (checksum) {
        const actual = sha256File(filePath);
        if (actual !== checksum) {
          violations.push({ code: `${kind}_CHECKSUM_MISMATCH`, subject, path: filePath, expected: checksum, actual });
        }
      }
    };

    // --- long-form media artifacts (+ short-form narration source) ---
    if (hasTable(db, 'media_artifacts')) {
      const shortForm = hasTable(db, 'short_form_media_artifacts')
        ? new Set(db.prepare('SELECT content_version_id FROM short_form_media_artifacts').all().map((r) => r.content_version_id))
        : new Set();
      const thumbCol = hasColumn(db, 'media_artifacts', 'thumbnail_path');
      const rows = db
        .prepare(`SELECT id, content_version_id, artifact_path, artifact_checksum, narration_path${thumbCol ? ', thumbnail_path' : ''} FROM media_artifacts`)
        .all();
      counts.mediaArtifacts = rows.length;
      for (const row of rows) {
        const subject = `media_artifact:${row.id} content_version:${row.content_version_id}`;
        requireFile('MEDIA', subject, row.artifact_path, { checksum: row.artifact_checksum });
        if (!shortForm.has(row.content_version_id)) {
          requireFile('NARRATION', subject, row.narration_path);
        }
        if (thumbCol && row.thumbnail_path && inspectFile(row.thumbnail_path).status !== 'OK') {
          warnings.push({ code: 'THUMBNAIL_FILE_NOT_OK', subject, path: row.thumbnail_path, note: 'regenerated at publication time; not required' });
        }
      }
    }

    // --- short-form derivative artifacts ---
    if (hasTable(db, 'short_form_media_artifacts')) {
      const rows = db
        .prepare('SELECT id, content_version_id, artifact_path, artifact_checksum FROM short_form_media_artifacts')
        .all();
      counts.shortFormArtifacts = rows.length;
      for (const row of rows) {
        requireFile('SHORT_FORM', `short_form_media_artifact:${row.id} content_version:${row.content_version_id}`, row.artifact_path, {
          checksum: row.artifact_checksum
        });
      }
    }

    // --- assets needed by items that have not rendered yet ---
    if (hasTable(db, 'assets') && hasTable(db, 'asset_usages') && hasTable(db, 'content_versions') && hasTable(db, 'media_artifacts')) {
      const pending = db
        .prepare(
          `SELECT DISTINCT a.id AS asset_id, a.location, cv.id AS content_version_id
             FROM content_versions cv
             JOIN asset_usages u ON u.content_version_id = cv.id
             JOIN assets a ON a.id = u.asset_id
            WHERE cv.state = 'PRODUCED'
              AND cv.id NOT IN (SELECT content_version_id FROM media_artifacts)
              AND a.verification_status <> 'DISPUTED'`
        )
        .all();
      for (const row of pending) {
        if (URI_LIKE.test(row.location ?? '')) continue;
        counts.pendingRenderAssets += 1;
        requireFile('ASSET', `asset:${row.asset_id} content_version:${row.content_version_id}`, row.location);
      }
    }
  } finally {
    db.close();
  }

  return { ok: violations.length === 0, violations, warnings, counts };
}

function parseArgs(argv) {
  const args = { dbPath: null, reportOnly: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--db') args.dbPath = argv[++i];
    else if (argv[i] === '--report-only') args.reportOnly = true;
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const dbPath = args.dbPath || process.env.SQLITE_PATH || path.join(REPO_ROOT, 'data', 'media-engine.db');
  let result;
  try {
    result = checkPersistedStateIntegrity({ dbPath });
  } catch (err) {
    console.error(`[state-integrity] cannot run: ${err.message}`);
    process.exitCode = args.reportOnly ? 0 : 2;
    return;
  }
  const { counts } = result;
  console.log(
    `[state-integrity] db=${dbPath} media_artifacts=${counts.mediaArtifacts} short_form=${counts.shortFormArtifacts} ` +
      `pending_render_assets=${counts.pendingRenderAssets} files_checked=${counts.filesChecked} bytes_checked=${counts.bytesChecked}`
  );
  for (const w of result.warnings) console.log(`[state-integrity] WARN ${w.code} ${w.subject} path=${w.path}`);
  for (const v of result.violations) {
    console.error(`[state-integrity] VIOLATION ${v.code} ${v.subject} path=${v.path}`);
  }
  if (result.ok) {
    console.log('[state-integrity] OK: persisted database state and filesystem artifacts agree.');
    return;
  }
  console.error(`[state-integrity] FAILED: ${result.violations.length} divergence(s) between SQLite state and local files.`);
  process.exitCode = args.reportOnly ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
