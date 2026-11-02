import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { main } from '../../scripts/annotate-blocked-sources.js';
import { planAnnotations } from '../../src/publisherFeeds/annotate.js';
import { normalizePublisherUrl, isAuthorizedHost } from '../../src/publisherFeeds/urlMatch.js';
import { freshMigratedStorage, removeDb, seedProject, seedSource, feedXml, provenance } from '../helpers/publisherFeedsFixture.js';

const FEED = { id: 'openai-news', feedUrl: 'https://openai.com/news/rss.xml', hosts: ['openai.com'] };
const plan = (sourceUrl, itemLink) => planAnnotations({
  sourceRows: [{ id: 's1', url: sourceUrl, retrieval_status: 'FAILED', notes: provenance({ error: 'HTTP 403', method: 'plain' }), research_project_id: 'p' }],
  feed: FEED, feedResult: { feedUrl: FEED.feedUrl, fetchedAt: 'T', items: [{ title: 't', link: itemLink, description: 'd', pubDate: null, guid: itemLink }] }, annotatedAt: 'A'
});

test('scheme decision: https source matches https item; http and https of the same host/path do NOT match each other', () => {
  assert.equal(plan('https://openai.com/index/a', 'https://openai.com/index/a').rows.length, 1);
  assert.equal(plan('http://openai.com/index/a', 'http://openai.com/index/a').rows.length, 1, 'same-scheme http still matches itself');
  assert.equal(plan('http://openai.com/index/a', 'https://openai.com/index/a').rows.length, 0, 'http source vs https item');
  assert.equal(plan('https://openai.com/index/a', 'http://openai.com/index/a').rows.length, 0, 'https source vs http item');
});

test('cross-scheme normalization cannot authorize a non-OpenAI host or a non-default port', () => {
  const hosts = ['openai.com'];
  for (const u of ['http://openai.com.evil.example/a', 'https://evilopenai.com/a', 'https://openai.com.evil.example/a', 'http://cdn.openai.com/a', 'https://openai.com:8443/a', 'http://openai.com:443/a', 'https://openai.com:80/a', 'http://u:p@openai.com/a', 'https://openai.com@evil.example/a']) {
    assert.equal(isAuthorizedHost(u, hosts), false, u);
    const n = normalizePublisherUrl(u);
    assert.ok(n === null || !/^https?:\/\/openai\.com\//.test(n), `${u} must not normalize to an openai.com key (${n})`);
    assert.equal(plan(u, 'https://openai.com/a').rows.length, 0, `source ${u}`);
    assert.equal(plan('https://openai.com/a', u).rows.length, 0, `item ${u}`);
  }
});

const tmp = (t) => fs.mkdtempSync(path.join(os.tmpdir(), `${t}-`));

test('dry-run refuses a database that changes while it is being copied (writer detector), writes nothing, and cleans its temp copy', async () => {
  const dir = tmp('dry-guard');
  const dbPath = path.join(dir, 'engine.db');
  const { storage, dbPath: made } = await freshMigratedStorage('dry-guard-src');
  seedProject(storage); seedSource(storage, { url: 'https://openai.com/index/a' });
  storage.close(); fs.copyFileSync(made, dbPath); removeDb(made);
  const privTmp = tmp('dry-guard-tmp'); const prev = process.env.TMPDIR; process.env.TMPDIR = privTmp;
  const lines = []; let fetched = 0;
  try {
    const before = fs.readdirSync(dir).sort();
    const code = await main({
      argv: ['--db', dbPath, '--dry-run'], env: {}, out: (l) => lines.push(l),
      fetchImpl: async () => { fetched += 1; return new Response(feedXml([{ link: 'https://openai.com/index/a' }]), { status: 200 }); },
      copyHook: (p) => fs.appendFileSync(p, Buffer.alloc(4096)) // simulate a concurrent writer during the copy
    });
    assert.equal(code, 1);
    assert.match(lines.join('\n'), /DATABASE_ERROR .*changed while being copied.*quiescent/);
    assert.equal(fetched, 0, 'no network request after a failed snapshot');
    assert.equal(fs.existsSync(`${dbPath}-wal`), false);
    assert.equal(fs.existsSync(`${dbPath}-shm`), false);
    assert.deepEqual(fs.readdirSync(dir).sort(), before);
    assert.deepEqual(fs.readdirSync(privTmp), [], 'temp copy removed on failure');
  } finally { if (prev === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = prev; fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(privTmp, { recursive: true, force: true }); }
});

test('dry-run on a quiescent database passes the detector (control)', async () => {
  const dir = tmp('dry-ok');
  const dbPath = path.join(dir, 'engine.db');
  const { storage, dbPath: made } = await freshMigratedStorage('dry-ok-src');
  seedProject(storage); seedSource(storage, { url: 'https://openai.com/index/a' });
  storage.close(); fs.copyFileSync(made, dbPath); removeDb(made);
  const lines = [];
  try {
    const code = await main({ argv: ['--db', dbPath, '--dry-run'], env: {}, out: (l) => lines.push(l), fetchImpl: async () => new Response(feedXml([{ link: 'https://openai.com/index/a' }]), { status: 200 }) });
    assert.equal(code, 0, lines.join('\n'));
    assert.match(lines.join('\n'), /planned_rows=1/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('SQLite backup API creates -wal/-shm beside a WAL source (why it is not used for dry-run)', async () => {
  const dir = tmp('backup-evidence');
  const src = path.join(dir, 'src.db');
  const w = new Database(src); w.pragma('journal_mode = WAL'); w.exec('CREATE TABLE t(a)'); w.close();
  fs.rmSync(`${src}-wal`, { force: true }); fs.rmSync(`${src}-shm`, { force: true });
  try {
    const ro = new Database(src, { readonly: true, fileMustExist: true });
    await ro.backup(path.join(dir, 'snap.db')); ro.close();
    assert.equal(fs.existsSync(`${src}-shm`) || fs.existsSync(`${src}-wal`), true, 'a sidecar appeared in the source directory');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
