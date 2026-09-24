#!/usr/bin/env node
/**
 * Source-level Research retrieval diagnostic, read from the existing
 * SQLite database after an autonomous run completes.
 *
 * Purpose: the entrypoint's aggregate `[research-diagnostic]` line
 * (project/opportunity/status/stop_reason/sources={STATUS=count}) does not
 * say *which* source produced a given retrieval_status, so a CI log alone
 * cannot confirm whether a specific guard (e.g. the Google News wrapper
 * guard in src/research/retrieval.js) fired for a real source or whether
 * an unrelated retrieval failure did. This script closes that gap by
 * reading the sources rows the pipeline already persists (see
 * src/research/pipeline.js#insertSource, sources.url /
 * sources.retrieval_status / sources.content, migration
 * 0003_research_subsystem.sql) and printing one small, greppable
 * diagnostic block per source.
 *
 * Deliberately NOT a general logging framework and NOT a schema/behavior
 * change: read-only queries against the existing `sources` /
 * `research_projects` tables, via the existing StorageDriver interface
 * (src/storage/index.js#createStorage), same DB path resolution the app
 * already uses (config.sqlitePath / SQLITE_PATH env var).
 *
 * Prints metadata only -- project id, source id, URL host/path, retrieval
 * status, content length. Never prints source content, API keys, tokens,
 * env vars, headers, or cookies.
 *
 *   node scripts/research-source-diagnostic.js
 */
import { createStorage } from '../src/storage/index.js';

/**
 * Splits a source URL into a hostname and a path (+ query string), the
 * minimum needed to tell a Google News RSS wrapper
 * (news.google.com + /rss/articles/...) apart from a normal publisher URL
 * at a glance. Returns 'UNKNOWN'/'UNKNOWN' for a missing or unparseable
 * URL rather than throwing -- a source can be persisted with url = NULL
 * (see sources.url, nullable) or malformed input, and the diagnostic
 * should stay usable either way.
 */
export function parseSourceUrl(url) {
  if (typeof url !== 'string' || !url) return { host: 'UNKNOWN', path: 'UNKNOWN' };
  try {
    const parsed = new URL(url);
    return { host: parsed.hostname, path: `${parsed.pathname}${parsed.search}` };
  } catch {
    return { host: 'UNKNOWN', path: 'UNKNOWN' };
  }
}

/**
 * Formats one [research-source-diagnostic] block from a single sources
 * row (already joined to its research_projects.id). Pure/testable in
 * isolation from the database.
 */
export function formatSourceDiagnostic({ projectId, sourceId, url, retrievalStatus, content }) {
  const { host, path } = parseSourceUrl(url);
  const contentLength = typeof content === 'string' ? content.length : 0;
  return [
    '[research-source-diagnostic]',
    `project=${projectId}`,
    `source=${sourceId}`,
    `url_host=${host}`,
    `url_path=${path}`,
    `retrieval_status=${retrievalStatus ?? 'UNKNOWN'}`,
    `content_length=${contentLength}`
  ].join('\n');
}

/**
 * Reads every sources row (joined to its research project) and prints a
 * diagnostic block for each, oldest project/source first. Missing
 * database file or missing tables (e.g. the entrypoint failed before
 * migrate()) is reported as a single line and treated as non-fatal --
 * this is an observability aid, not a pipeline stage, and should never
 * fail a CI job on its own.
 */
export function runDiagnostic(storage = createStorage()) {
  let rows;
  try {
    rows = storage.all(`
      SELECT rp.id AS project_id, s.id AS source_id, s.url AS url,
             s.retrieval_status AS retrieval_status, s.content AS content
      FROM sources s
      JOIN research_projects rp ON s.research_project_id = rp.id
      ORDER BY rp.created_at, s.retrieved_at
    `);
  } catch (err) {
    console.log(`[research-source-diagnostic] unavailable: ${err.message}`);
    return;
  } finally {
    storage.close();
  }

  if (rows.length === 0) {
    console.log('[research-source-diagnostic] no sources found in this run');
    return;
  }

  for (const row of rows) {
    console.log(formatSourceDiagnostic({
      projectId: row.project_id,
      sourceId: row.source_id,
      url: row.url,
      retrievalStatus: row.retrieval_status,
      content: row.content
    }));
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runDiagnostic();
}