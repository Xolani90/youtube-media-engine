import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import { main, parseArgs } from '../../scripts/annotate-blocked-sources.js';
import { annotateBlockedSources } from '../../src/publisherFeeds/annotate.js';
import { findAuthorizedFeed, loadPublisherFeedConfig } from '../../src/publisherFeeds/feedClient.js';
import { parseFeed } from '../../src/discovery/rssParser.js';
import { freshMigratedStorage, removeDb, seedProject, seedSource, feedXml } from '../helpers/publisherFeedsFixture.js';

const URL1 = 'https://openai.com/index/gpt-6-for-everyone';
const VALID_FEED = feedXml([{ link: URL1, title: 'GPT-6' }]);

function harness(xml = VALID_FEED) {
  const h = { calls: 0, lines: [] };
  h.fetchImpl = async () => { h.calls += 1; return new Response(xml, { status: 200 }); };
  h.out = (l) => h.lines.push(l);
  h.text = () => h.lines.join('\n');
  return h;
}
const tmpDir = (tag) => fs.mkdtempSync(path.join(os.tmpdir(), `${tag}-`));
const rowCount = (dbPath) => { const d = new Database(dbPath, { readonly: true }); try { return d.prepare('SELECT COUNT(*) n FROM publisher_feed_items').get().n; } finally { d.close(); } };

async function dbWithBlockedSource(tag) {
  const { storage, dbPath } = await freshMigratedStorage(tag);
  seedProject(storage);
  seedSource(storage, { url: URL1, error: 'HTTP 403' });
  return { storage, dbPath };
}

test('parseArgs: --db and --feed-id require a value; another option or an empty value is not a value', () => {
  for (const argv of [['--db'], ['--db', '--dry-run'], ['--db', ''], ['--db', '-x'], ['--feed-id'], ['--feed-id', '--json'], ['--db', 'x.db', '--feed-id'],
    ['--db', 'x.db', '--feed-id', '--apply-migration'], ['--feed-id', '']]) {
    assert.throws(() => parseArgs(argv), /requires a value/, JSON.stringify(argv));
  }
  assert.throws(() => parseArgs(['--bogus']), /unknown argument/);
  assert.throws(() => parseArgs(['positional.db']), /unknown argument/);
  assert.deepEqual(parseArgs(['--db', 'x.db', '--feed-id', 'openai-news', '--dry-run', '--json']),
    { db: 'x.db', dryRun: true, write: false, applyMigration: false, feedId: 'openai-news', json: true });
});

test('CLI: invalid arguments exit 1 with usage and make NO network request', async () => {
  for (const argv of [['--db'], ['--db', '--dry-run'], ['--db', 'x.db', '--feed-id'], ['--db', 'x.db', '--feed-id', '--json'], ['--bogus'], [], ['--dry-run']]) {
    const h = harness();
    const code = await main({ argv, env: {}, out: h.out, fetchImpl: h.fetchImpl });
    assert.equal(code, 1, JSON.stringify(argv));
    assert.match(h.text(), /usage/i, JSON.stringify(argv));
    assert.equal(h.calls, 0, `no fetch for ${JSON.stringify(argv)}`);
  }
});

test('CLI: unknown --feed-id exits 2 with no network request', async () => {
  const { storage, dbPath } = await dbWithBlockedSource('cli-feedid');
  try {
    const h = harness();
    assert.equal(await main({ argv: ['--db', dbPath, '--feed-id', 'nope'], env: {}, out: h.out, fetchImpl: h.fetchImpl }), 2);
    assert.equal(h.calls, 0);
  } finally { storage.close(); removeDb(dbPath); }
});

test('CLI: malformed, unreadable or wrongly shaped config exits 1 (CONFIG_ERROR), writes nothing, makes NO network request', async () => {
  const { storage, dbPath } = await dbWithBlockedSource('cli-config');
  const dir = tmpDir('cli-config-files');
  try {
    const good = JSON.parse(fs.readFileSync(new URL('../../config/publisher_feeds.json', import.meta.url), 'utf8'));
    const variants = {
      'not json': '{ not json',
      'empty file': '',
      'null': 'null',
      'feeds not array': JSON.stringify({ feeds: {} }),
      'feed missing id': JSON.stringify({ feeds: [{ feedUrl: good.feeds[0].feedUrl, hosts: ['openai.com'] }] }),
      'feedUrl not a url': JSON.stringify({ feeds: [{ id: 'a', feedUrl: 'nope', hosts: ['openai.com'] }] }),
      'feedUrl with port': JSON.stringify({ feeds: [{ id: 'a', feedUrl: 'https://openai.com:8443/rss.xml', hosts: ['openai.com'] }] }),
      'hosts empty': JSON.stringify({ feeds: [{ id: 'a', feedUrl: good.feeds[0].feedUrl, hosts: [] }] }),
      'hosts non-string': JSON.stringify({ feeds: [{ id: 'a', feedUrl: good.feeds[0].feedUrl, hosts: [1] }] })
    };
    const paths = Object.entries(variants).map(([name, body]) => { const p = path.join(dir, `${name.replace(/\W/g, '_')}.json`); fs.writeFileSync(p, body); return [name, p]; });
    paths.push(['missing file', path.join(dir, 'does-not-exist.json')]);
    paths.push(['directory', dir]);
    for (const [name, configPath] of paths) {
      const h = harness();
      const code = await main({ argv: ['--db', dbPath, '--write'], env: {}, out: h.out, fetchImpl: h.fetchImpl, configPath });
      assert.equal(code, 1, name);
      assert.match(h.text(), /CONFIG_ERROR/, name);
      assert.match(h.text(), /written=0/, name);
      assert.equal(h.calls, 0, `no fetch for config case: ${name}`);
    }
    assert.equal(rowCount(dbPath), 0);
    // control: the real config still loads and is the authorized feed, unchanged
    assert.equal(findAuthorizedFeed(loadPublisherFeedConfig(), { feedId: 'openai-news' }).feedUrl, 'https://openai.com/news/rss.xml');
  } finally { storage.close(); removeDb(dbPath); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('CLI: invalid database path or schema exits nonzero and makes NO network request (dry-run and write)', async () => {
  const dir = tmpDir('cli-baddb');
  try {
    const notDb = path.join(dir, 'not-a-db.db'); fs.writeFileSync(notDb, 'this is not sqlite');
    const noSources = path.join(dir, 'no-sources.db'); { const d = new Database(noSources); d.exec('CREATE TABLE other (x)'); d.close(); }
    const wrongCols = path.join(dir, 'wrong-cols.db'); { const d = new Database(wrongCols); d.exec('CREATE TABLE sources (id TEXT, url TEXT)'); d.close(); }
    const cases = { missing: path.join(dir, 'missing.db'), directory: dir, 'not sqlite': notDb, 'no sources table': noSources, 'sources missing columns': wrongCols };
    for (const [name, dbPath] of Object.entries(cases)) {
      for (const mode of [['--write'], ['--dry-run']]) {
        const h = harness();
        const code = await main({ argv: ['--db', dbPath, ...mode], env: {}, out: h.out, fetchImpl: h.fetchImpl });
        assert.equal(code, 1, `${name} ${mode}`);
        assert.match(h.text(), /DATABASE_ERROR/, `${name} ${mode}`);
        assert.equal(h.calls, 0, `no fetch for db case: ${name} ${mode}`);
      }
    }
    assert.equal(fs.existsSync(cases.missing), false, 'a missing database is never created');
    assert.equal(fs.readFileSync(notDb, 'utf8'), 'this is not sqlite', 'a non-sqlite file is untouched');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('CLI: missing feed table without --apply-migration exits 3 BEFORE any network request', async () => {
  const { storage, dbPath } = await freshMigratedStorage('cli-notable');
  try {
    storage.run('DROP INDEX idx_publisher_feed_items_blocked_source'); storage.run('DROP TABLE publisher_feed_items');
    storage.close();
    const h = harness();
    assert.equal(await main({ argv: ['--db', dbPath, '--write'], env: {}, out: h.out, fetchImpl: h.fetchImpl }), 3);
    assert.equal(h.calls, 0);
    // dry-run with the table absent is still fine and fetches once
    const d = harness();
    assert.equal(await main({ argv: ['--db', dbPath, '--dry-run'], env: {}, out: d.out, fetchImpl: d.fetchImpl }), 0);
    assert.equal(d.calls, 1);
  } finally { removeDb(dbPath); }
});

test('CLI: a valid invocation makes exactly one network request and annotates; a feed failure after local validation writes nothing', async () => {
  const { storage, dbPath } = await dbWithBlockedSource('cli-valid');
  try {
    const h = harness();
    assert.equal(await main({ argv: ['--db', dbPath, '--write'], env: {}, out: h.out, fetchImpl: h.fetchImpl }), 0);
    assert.equal(h.calls, 1);
    assert.equal(rowCount(dbPath), 1);
    const bad = harness('<rss><channel><item><title>T</title><link>' + URL1);
    assert.equal(await main({ argv: ['--db', dbPath, '--write'], env: {}, out: bad.out, fetchImpl: bad.fetchImpl }), 2);
    assert.match(bad.text(), /reason=feed_malformed/);
    assert.match(bad.text(), /written=0/);
  } finally { storage.close(); removeDb(dbPath); }
});

test('malformed feed through the CLI cannot produce partial annotations (valid matching first item, then truncated)', async () => {
  const { storage, dbPath } = await dbWithBlockedSource('cli-partial');
  try {
    const good = feedXml([{ link: URL1, title: 'GPT-6' }, { link: 'https://openai.com/index/other', title: 'Other' }]);
    for (const xml of [good.slice(0, good.lastIndexOf('<item>') + 15), good.replace('</channel></rss>', ''), good.replace(/<\/item>(?![\s\S]*<\/item>)/, '</itemx>')]) {
      const h = harness(xml);
      assert.equal(await main({ argv: ['--db', dbPath, '--write'], env: {}, out: h.out, fetchImpl: h.fetchImpl }), 2);
      assert.equal(rowCount(dbPath), 0, 'zero rows after a malformed feed');
    }
  } finally { storage.close(); removeDb(dbPath); }
});

test('droppedNoKey is reported: in the summary object and in the CLI line', async () => {
  const { storage, dbPath } = await freshMigratedStorage('cli-dropped');
  try {
    seedProject(storage); seedSource(storage, { url: URL1 });
    const feed = findAuthorizedFeed(loadPublisherFeedConfig(), { feedId: 'openai-news' });
    const items = [...parseFeed(feedXml([{ link: URL1 }, { link: 'https://elsewhere.example/x' }])), { title: 'no link no guid', link: null, guid: null }, { title: 'blank', link: '', guid: '  ' }];
    const s = annotateBlockedSources({ db: storage, feed, feedResult: { ok: true, feedUrl: feed.feedUrl, fetchedAt: 'x', items }, dryRun: true });
    assert.equal(s.feedItemsDroppedNoKey, 2);
    assert.equal(s.feedItemsOffHost, 1);
    storage.close();
    const h = harness();
    assert.equal(await main({ argv: ['--db', dbPath, '--dry-run'], env: {}, out: h.out, fetchImpl: h.fetchImpl }), 0);
    assert.match(h.text(), /feed_items_dropped_no_key=0/);
    assert.match(h.text(), /feed_items_off_host=0/);
  } finally { removeDb(dbPath); }
});

const listing = (dir) => fs.readdirSync(dir).sort().map((n) => { const s = fs.statSync(path.join(dir, n)); return `${n}:${s.size}:${s.mtimeMs}`; });
const restoreTmp = (v) => { if (v === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = v; };
const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

test('dry-run: source directory gets NO -wal/-shm sidecars and the database is byte-identical (WAL-mode database, closed)', async () => {
  const dir = tmpDir('cli-dry-closed');
  const dbPath = path.join(dir, 'engine.db');
  const { storage, dbPath: made } = await dbWithBlockedSource('cli-dry-src');
  storage.close();
  fs.copyFileSync(made, dbPath); removeDb(made);
  for (const s of ['-wal', '-shm']) fs.rmSync(`${dbPath}${s}`, { force: true });
  const checkDb = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    assert.equal(checkDb.pragma('journal_mode', { simple: true }), 'wal');
  } finally {
    checkDb.close();
  }
  for (const s of ['-wal', '-shm']) fs.rmSync(`${dbPath}${s}`, { force: true });
  const privTmp = tmpDir('cli-dry-tmp'); const prevTmp = process.env.TMPDIR; process.env.TMPDIR = privTmp;
  try {
    const before = listing(dir); const hash = sha(dbPath);
    const h = harness();
    assert.equal(await main({ argv: ['--db', dbPath, '--dry-run'], env: {}, out: h.out, fetchImpl: h.fetchImpl }), 0);
    assert.deepEqual(listing(dir), before, 'directory listing (names, sizes, mtimes) unchanged');
    assert.equal(sha(dbPath), hash);
    assert.equal(fs.existsSync(`${dbPath}-wal`), false);
    assert.equal(fs.existsSync(`${dbPath}-shm`), false);
    assert.deepEqual(fs.readdirSync(privTmp), [], 'the temp copy is removed afterwards');
    assert.match(h.text(), /dry_run=true/);
    assert.match(h.text(), /planned_rows=1/);
  } finally { restoreTmp(prevTmp); fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(privTmp, { recursive: true, force: true }); }
});

test('dry-run: a live WAL database (open writer, data only in the -wal) is read including WAL content, and the source is not touched', async () => {
  const dir = tmpDir('cli-dry-live');
  const dbPath = path.join(dir, 'engine.db');
  const { storage, dbPath: made } = await freshMigratedStorage('cli-dry-live-src');
  storage.close(); fs.copyFileSync(made, dbPath); removeDb(made);
  const writer = new Database(dbPath);
  writer.pragma('journal_mode = WAL'); writer.pragma('wal_autocheckpoint = 0');
  const now = '2026-10-22T00:00:00.000Z';
  writer.prepare("INSERT INTO opportunities (id, title, source, discovered_at, status) VALUES ('o','T','rss',?, 'HANDED_TO_RESEARCH')").run(now);
  const cols = writer.prepare('PRAGMA table_info(research_projects)').all().map((c) => c.name);
  const rp = { id: 'p', opportunity_id: 'o', status: 'RESEARCHING', created_at: now }; const use = Object.keys(rp).filter((k) => cols.includes(k));
  writer.prepare(`INSERT INTO research_projects (${use.join(',')}) VALUES (${use.map(() => '?').join(',')})`).run(...use.map((k) => rp[k]));
  writer.prepare(`INSERT INTO sources (id, research_project_id, url, source_type, role, quality_tier, retrieval_status, retrieved_at, notes)
    VALUES ('wal-only','p',?, 'article','primary_authoritative','UNUSABLE','FAILED',?,?)`).run(URL1, now, JSON.stringify({ schema: 'source_provenance/v1', retrieval: { status: 'FAILED', method: 'plain', error: 'HTTP 403' } }));
  const privTmp = tmpDir('cli-dry-live-tmp'); const prevTmp = process.env.TMPDIR; process.env.TMPDIR = privTmp;
  try {
    assert.ok(fs.existsSync(`${dbPath}-wal`) && fs.statSync(`${dbPath}-wal`).size > 0, 'precondition: row exists only in the WAL');
    const before = listing(dir);
    const h = harness();
    assert.equal(await main({ argv: ['--db', dbPath, '--dry-run', '--json'], env: {}, out: h.out, fetchImpl: h.fetchImpl }), 0);
    const summary = JSON.parse(h.lines[0]);
    assert.equal(summary.blockedSourcesConsidered, 1, 'the WAL-only source is seen');
    assert.equal(summary.sourcesWithMatch, 1);
    assert.deepEqual(listing(dir), before, 'no file created, resized or touched in the source directory');
    assert.deepEqual(fs.readdirSync(privTmp), []);
  } finally { writer.close(); restoreTmp(prevTmp); fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(privTmp, { recursive: true, force: true }); }
});

test('dry-run NEGATIVE control: write mode does create the feed rows, so the dry-run guarantee above is not vacuous', async () => {
  const { storage, dbPath } = await dbWithBlockedSource('cli-dry-control');
  try {
    const h = harness();
    assert.equal(await main({ argv: ['--db', dbPath, '--write'], env: {}, out: h.out, fetchImpl: h.fetchImpl }), 0);
    assert.equal(rowCount(dbPath), 1);
    const d = harness();
    assert.equal(await main({ argv: ['--db', dbPath, '--dry-run'], env: {}, out: d.out, fetchImpl: d.fetchImpl }), 0);
    assert.equal(rowCount(dbPath), 1, 'dry-run adds nothing');
    assert.match(d.text(), /inserted=0/);
  } finally { storage.close(); removeDb(dbPath); }
});
