import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { SqliteStorageDriver } from '../../src/storage/SqliteStorageDriver.js';

export function tmpDbPath(tag = 'pubfeeds') {
  return path.join(os.tmpdir(), `${tag}-${Date.now()}-${Math.random().toString(16).slice(2)}.db`);
}

export function removeDb(dbPath) {
  for (const s of ['', '-wal', '-shm']) fs.rmSync(`${dbPath}${s}`, { force: true });
}

export async function freshMigratedStorage(tag) {
  const dbPath = tmpDbPath(tag);
  const storage = new SqliteStorageDriver({ dbPath });
  await storage.migrate();
  return { storage, dbPath };
}

export function provenance({ error = 'HTTP 403', status = 'FAILED', method = 'plain' } = {}) {
  return JSON.stringify({
    schema: 'source_provenance/v1', url: 'x',
    retrieval: { retrievedAt: '2026-10-22T11:10:55.028Z', method, status, error, fallback: null, contentAssessment: null }
  });
}

export function seedProject(storage, id = 'proj-1') {
  const oppId = `opp-${id}`;
  storage.run(
    `INSERT INTO opportunities (id, title, source, discovered_at, status) VALUES (?, 'T', 'rss', ?, 'HANDED_TO_RESEARCH')`,
    [oppId, '2026-10-22T00:00:00.000Z']);
  const cols = storage.all('PRAGMA table_info(research_projects)').map((c) => c.name);
  const row = { id, opportunity_id: oppId, status: 'RESEARCHING', created_at: '2026-10-22T00:00:00.000Z' };
  const use = Object.keys(row).filter((k) => cols.includes(k));
  storage.run(`INSERT INTO research_projects (${use.join(',')}) VALUES (${use.map(() => '?').join(',')})`, use.map((k) => row[k]));
  return id;
}

export function seedSource(storage, { projectId = 'proj-1', url, retrievalStatus = 'FAILED', error = 'HTTP 403', notes, content = null, retrievedAt = '2026-10-22T11:10:55.028Z', id = crypto.randomUUID() }) {
  storage.run(
    `INSERT INTO sources (id, research_project_id, url, source_type, role, quality_tier, retrieval_status, content, retrieved_at, notes)
     VALUES (?, ?, ?, 'article', 'primary_authoritative', 'UNUSABLE', ?, ?, ?, ?)`,
    [id, projectId, url, retrievalStatus, content, retrievedAt, notes ?? provenance({ error, status: retrievalStatus })]);
  return id;
}

export function feedXml(items) {
  const body = items.map((i) => `
    <item>
      <title><![CDATA[${i.title ?? 'Title'}]]></title>
      <description><![CDATA[${i.description ?? 'A one sentence summary.'}]]></description>
      <link>${i.link}</link>
      ${i.guid === null ? '' : `<guid isPermaLink="true">${i.guid ?? i.link}</guid>`}
      <pubDate>${i.pubDate ?? 'Thu, 29 Oct 2026 17:00:00 GMT'}</pubDate>
    </item>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>OpenAI News</title>${body}</channel></rss>`;
}

export function okFetch(xml, status = 200) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    return new Response(xml === '' ? null : xml, { status });
  };
  impl.calls = calls;
  return impl;
}

/** Deterministic dump of every table EXCEPT the new feed table and the migration ledger. */
export function snapshotResearchTables(storage) {
  const tables = storage.all("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .map((t) => t.name).filter((n) => n !== 'publisher_feed_items' && n !== 'schema_migrations');
  const snap = {};
  for (const t of tables) {
    const rows = storage.all(`SELECT * FROM "${t}"`);
    snap[t] = rows.map((r) => JSON.stringify(r)).sort();
  }
  return snap;
}
