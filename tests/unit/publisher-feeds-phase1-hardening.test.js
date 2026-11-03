import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as fx from '../helpers/publisherFeedsFixture.js';
import { main, parseArgs } from '../../scripts/annotate-blocked-sources.js';
import { classifyRetrievalFailure, classifySourceFailure } from '../../src/publisherFeeds/failureClass.js';
import { annotateBlockedSources, planAnnotations } from '../../src/publisherFeeds/annotate.js';
import { FAILURE_CLASS, FAILURE_UNCLASSIFIED, MAX_FEED_BYTES } from '../../src/publisherFeeds/constants.js';
import { parseFeedStrict, MAX_ELEMENTS, MAX_ITEMS } from '../../src/publisherFeeds/feedValidate.js';
import { fetchPublisherFeed } from '../../src/publisherFeeds/feedClient.js';
import { SqliteStorageDriver } from '../../src/storage/SqliteStorageDriver.js';

const SCRIPT = fileURLToPath(new URL('../../scripts/annotate-blocked-sources.js', import.meta.url));
const TARGET = 'https://openai.com/index/gpt-6-for-everyone';
const FEED = { id: 't', feedUrl: 'https://openai.com/news/rss.xml', hosts: ['openai.com'] };
const goodXml = fx.feedXml([{ link: TARGET }]);

async function disposableDb(tag, { error = 'HTTP 403' } = {}) {
  const { storage, dbPath } = await fx.freshMigratedStorage(tag);
  fx.seedProject(storage, 'proj-1');
  const sourceId = fx.seedSource(storage, { projectId: 'proj-1', url: TARGET, error });
  storage.close();
  return { dbPath, sourceId };
}
const feedRows = (dbPath) => { const s = new SqliteStorageDriver({ dbPath }); try { return s.all('SELECT * FROM publisher_feed_items'); } finally { s.close(); } };
const fileHash = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const run = async (argv, { env = {}, xml = goodXml } = {}) => {
  const lines = []; const fetchImpl = fx.okFetch(xml);
  const code = await main({ argv, env, out: (l) => lines.push(String(l)), fetchImpl });
  return { code, lines, text: lines.join('\n'), requests: fetchImpl.calls.length };
};

// ------------------------------------------------------------------ Phase 2: writes are opt-in
test('parseArgs: the default is dry-run; only an explicit --write selects write', () => {
  assert.deepEqual([parseArgs([]).dryRun, parseArgs([]).write], [true, false]);
  assert.deepEqual([parseArgs(['--db', 'p']).dryRun, parseArgs(['--db', 'p']).write], [true, false]);
  assert.deepEqual([parseArgs(['--db', 'p', '--dry-run']).dryRun, parseArgs(['--db', 'p', '--dry-run']).write], [true, false]);
  assert.deepEqual([parseArgs(['--db', 'p', '--write']).dryRun, parseArgs(['--db', 'p', '--write']).write], [false, true]);
});

test('parseArgs: --write with --dry-run is rejected in either order; near-miss flags are never write authorization', () => {
  assert.throws(() => parseArgs(['--db', 'p', '--write', '--dry-run']), /mutually exclusive/);
  assert.throws(() => parseArgs(['--db', 'p', '--dry-run', '--write']), /mutually exclusive/);
  for (const bad of ['--writes', '--write=true', '--write=1', '-w', '--apply', '--yes', 'write', '--WRITE']) {
    assert.throws(() => parseArgs(['--db', 'p', bad]), /unknown argument/, bad);
  }
});

test('main: no arguments and no SQLITE_PATH is a usage error, makes no request', async () => {
  const r = await run([]);
  assert.equal(r.code, 1); assert.match(r.text, /usage:/); assert.equal(r.requests, 0);
});

test('main: --db alone and --db --dry-run cannot write (database byte-identical, no rows)', async () => {
  for (const argv of [['--db'], ['--db', '--dry-run']]) {
    const { dbPath } = await disposableDb('p1h-default');
    try {
      const before = fileHash(dbPath);
      const r = await run([argv[0], dbPath, ...argv.slice(1)]);
      assert.equal(r.code, 0, r.text);
      assert.equal(r.requests, 1);
      assert.match(r.text, /dry_run=true/); assert.match(r.text, /planned_rows=1 inserted=0/);
      assert.match(r.text, /nothing was written; re-run with --write/);
      assert.equal(fileHash(dbPath), before, 'database file unchanged');
      assert.equal(feedRows(dbPath).length, 0);
    } finally { fx.removeDb(dbPath); }
  }
});

test('main: a database path from SQLITE_PATH alone is still dry-run', async () => {
  const { dbPath } = await disposableDb('p1h-env');
  try {
    const r = await run([], { env: { SQLITE_PATH: dbPath } });
    assert.equal(r.code, 0, r.text); assert.match(r.text, /dry_run=true/); assert.match(r.text, /inserted=0/);
    assert.equal(feedRows(dbPath).length, 0);
  } finally { fx.removeDb(dbPath); }
});

test('main: --write alone (even with SQLITE_PATH set) is refused: --write requires an explicit --db, no request, no write', async () => {
  const { dbPath } = await disposableDb('p1h-envwrite');
  try {
    const before = fileHash(dbPath);
    const r = await run(['--write'], { env: { SQLITE_PATH: dbPath } });
    assert.equal(r.code, 1); assert.match(r.text, /--write requires an explicit --db/); assert.equal(r.requests, 0);
    assert.equal(fileHash(dbPath), before); assert.equal(feedRows(dbPath).length, 0);
  } finally { fx.removeDb(dbPath); }
});

test('main: --db <path> --write records the intended annotation (non-evidentiary) and only that', async () => {
  const { dbPath, sourceId } = await disposableDb('p1h-write');
  try {
    const r = await run(['--db', dbPath, '--write']);
    assert.equal(r.code, 0, r.text); assert.match(r.text, /dry_run=false/); assert.match(r.text, /planned_rows=1 inserted=1/);
    const rows = feedRows(dbPath);
    assert.equal(rows.length, 1);
    assert.deepEqual([rows[0].evidentiary, rows[0].origin, rows[0].blocked_source_id, rows[0].failure_class], [0, 'rss_feed_metadata', sourceId, 'host_access_denied']);
  } finally { fx.removeDb(dbPath); }
});

test('main: --write with --dry-run fails safely before any request or write', async () => {
  const { dbPath } = await disposableDb('p1h-conflict');
  try {
    const before = fileHash(dbPath);
    for (const argv of [['--db', dbPath, '--write', '--dry-run'], ['--db', dbPath, '--dry-run', '--write']]) {
      const r = await run(argv);
      assert.equal(r.code, 1); assert.match(r.text, /mutually exclusive/); assert.equal(r.requests, 0);
    }
    assert.equal(fileHash(dbPath), before); assert.equal(feedRows(dbPath).length, 0);
  } finally { fx.removeDb(dbPath); }
});

test('main: a missing database fails safely in both modes and a write never creates the file', async () => {
  const missing = fx.tmpDbPath('p1h-missing');
  for (const argv of [['--db', missing], ['--db', missing, '--dry-run'], ['--db', missing, '--write']]) {
    const r = await run(argv);
    assert.equal(r.code, 1, argv.join(' ')); assert.match(r.text, /DATABASE_ERROR database not found/); assert.equal(r.requests, 0);
    assert.equal(fs.existsSync(missing), false, 'no database file may be created');
  }
});

test('CLI process exit codes: usage, conflict, missing database and missing --db are non-zero', () => {
  const missing = fx.tmpDbPath('p1h-exit');
  const exec = (args, env = {}) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', env: { ...process.env, SQLITE_PATH: '', ...env }, timeout: 30000 });
  for (const args of [[], ['--write'], ['--db', missing, '--write', '--dry-run'], ['--db', missing], ['--db', missing, '--write'], ['--db', missing, '--bogus']]) {
    const r = exec(args);
    assert.equal(r.status, 1, `${args.join(' ')} -> ${r.stdout}${r.stderr}`);
    assert.equal(fs.existsSync(missing), false);
  }
});

// ------------------------------------------------------------------ Phase 3: failure classification
const cls = (t) => classifyRetrievalFailure(t);

test('HTTP failures keep their established classes (including wrapper prefixes, case and surrounding whitespace)', () => {
  const expect = (text, failureClass, httpStatus) => {
    const c = cls(text); assert.equal(c.failureClass, failureClass, text); assert.equal(c.httpStatus, httpStatus, text); assert.equal(c.originalError, text);
  };
  expect('HTTP 403', FAILURE_CLASS.HOST_ACCESS_DENIED, 403);
  expect('HTTP 401', FAILURE_CLASS.HOST_ACCESS_DENIED, 401);
  expect('HTTP 429', FAILURE_CLASS.HOST_RATE_LIMITED, 429);
  expect('HTTP 404', FAILURE_CLASS.HOST_HTTP_ERROR, 404);
  expect('HTTP 503', FAILURE_CLASS.HOST_HTTP_ERROR, 503);
  expect('reader HTTP 403', FAILURE_CLASS.HOST_ACCESS_DENIED, 403);
  expect('reader fallback failed: HTTP 503', FAILURE_CLASS.HOST_HTTP_ERROR, 503);
  expect('http 403', FAILURE_CLASS.HOST_ACCESS_DENIED, 403);
  expect('  HTTP 403\n', FAILURE_CLASS.HOST_ACCESS_DENIED, 403);
});

test('known no-response failures (network, timeout) stay internal_retrieval_failure and say why', () => {
  for (const t of ['fetch failed', 'Fetch Failed', '  fetch failed  ', 'reader failed: fetch failed']) {
    const c = cls(t); assert.equal(c.failureClass, FAILURE_CLASS.INTERNAL_RETRIEVAL_FAILURE, t); assert.equal(c.detail, 'no_http_response:network_error'); assert.equal(c.httpStatus, null); assert.equal(c.originalError, t);
  }
  for (const t of ['This operation was aborted', 'the operation was aborted', 'The operation was aborted due to timeout', ' THE OPERATION WAS ABORTED DUE TO TIMEOUT. ', 'reader failed: This operation was aborted']) {
    const c = cls(t); assert.equal(c.failureClass, FAILURE_CLASS.INTERNAL_RETRIEVAL_FAILURE, t); assert.equal(c.detail, 'no_http_response:timeout'); assert.equal(c.originalError, t);
  }
});

test('absent or unrecognised error text is unclassified, never internal_retrieval_failure', () => {
  for (const t of [null, undefined, '', 'terminated', 'ECONNRESET', 'reader returned no text', 'reader fallback not configured', 'some brand new failure',
    'HTTP 200', 'HTTP 302', 'HTTP 99', 'HTTP 600', 'HTTP  403']) {
    const c = cls(t);
    assert.equal(c.failureClass, FAILURE_UNCLASSIFIED, String(t)); assert.equal(c.failureClass, 'unclassified'); assert.equal(c.httpStatus, null);
    assert.equal(c.detail, t ? 'unrecognized_error_text' : 'no_error_recorded', String(t));
  }
});

test('similar-looking messages do not match: whole-message matching only, nothing mid-string', () => {
  for (const t of ['prefetch failed', 'fetch failed to parse the page', 'the fetch failed because the CDN returned garbage', 'proxy said HTTP 403: fetch failed',
    'upstream returned HTTP 403', 'error: HTTP 403', 'This operation was aborted by the user script', 'operation aborted', 'fetch failed: ECONNRESET', 'reader failed: terminated']) {
    assert.equal(cls(t).failureClass, FAILURE_UNCLASSIFIED, t);
  }
});

test('classifySourceFailure: missing, empty, unreadable or foreign notes are unclassified with an explicit detail', () => {
  for (const notes of [null, undefined, '', 'not json', '{"schema":"other/v1"}', '{"schema":"source_provenance/v1"}']) {
    const c = classifySourceFailure(notes);
    assert.equal(c.failureClass, FAILURE_UNCLASSIFIED, String(notes)); assert.equal(c.detail, 'provenance_unreadable'); assert.equal(c.originalError, null);
  }
  const noError = classifySourceFailure(fx.provenance({ error: null }));
  assert.equal(noError.failureClass, FAILURE_UNCLASSIFIED); assert.equal(noError.detail, 'no_error_recorded');
  assert.equal(classifySourceFailure(fx.provenance({ error: 'HTTP 403' })).failureClass, FAILURE_CLASS.HOST_ACCESS_DENIED);
  assert.equal(classifySourceFailure(fx.provenance({ error: 'fetch failed' })).failureClass, FAILURE_CLASS.INTERNAL_RETRIEVAL_FAILURE);
});

test('an unclassified failure is reported but never becomes an annotation; established failures still do', () => {
  const feedResult = { ok: true, feedUrl: FEED.feedUrl, fetchedAt: 'x', items: [{ title: 't', link: TARGET, guid: TARGET, description: 'd', pubDate: 'p' }] };
  const mk = (id, error) => ({ id, research_project_id: 'proj-1', url: TARGET, retrieval_status: 'FAILED', notes: fx.provenance({ error }) });
  const plan = planAnnotations({ sourceRows: [mk('s-unknown', 'some brand new failure'), mk('s-none', null), mk('s-net', 'fetch failed'), mk('s-403', 'HTTP 403')], feed: FEED, feedResult, annotatedAt: 'now' });
  assert.deepEqual(plan.rows.map((r) => [r.blocked_source_id, r.failure_class]), [['s-net', 'internal_retrieval_failure'], ['s-403', 'host_access_denied']]);
  const skipped = Object.fromEntries(plan.entries.map((e) => [e.sourceId, [e.failureClass, e.skipped]]));
  assert.deepEqual(skipped['s-unknown'], ['unclassified', 'failure_unclassified']);
  assert.deepEqual(skipped['s-none'], ['unclassified', 'failure_unclassified']);
});

test('a write run with an unclassified failure inserts nothing, does not violate the CHECK, and reports the count', async () => {
  const { dbPath } = await disposableDb('p1h-unclassified', { error: 'some brand new failure' });
  try {
    const r = await run(['--db', dbPath, '--write', '--json']);
    assert.equal(r.code, 0, r.text);
    const summary = JSON.parse(r.lines.at(-1));
    assert.equal(summary.plannedRows, 0); assert.equal(summary.inserted, 0); assert.equal(summary.byFailureClass.unclassified, 1);
    assert.equal(summary.entries[0].skipped, 'failure_unclassified');
    assert.equal(feedRows(dbPath).length, 0);
  } finally { fx.removeDb(dbPath); }
});

test('summary lists every persisted class plus unclassified, all zero when nothing failed', async () => {
  const { storage, dbPath } = await fx.freshMigratedStorage('p1h-summary');
  try {
    const s = annotateBlockedSources({ db: storage, feed: FEED, feedResult: { ok: true, feedUrl: FEED.feedUrl, fetchedAt: 'x', items: [] }, dryRun: true });
    assert.deepEqual(Object.keys(s.byFailureClass).sort(), [...Object.values(FAILURE_CLASS), 'unclassified'].sort());
  } finally { storage.close(); fx.removeDb(dbPath); }
});

// ------------------------------------------------------------------ Phase 4: element / item bounds
const rssWithItems = (n) => `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel>${Array.from({ length: n }, (_, i) => `<item><link>https://openai.com/i/${i}</link></item>`).join('')}</channel></rss>`;
const atomWithEntries = (n) => `<feed>${Array.from({ length: n }, (_, i) => `<entry><link href="https://openai.com/e/${i}"/></entry>`).join('')}</feed>`;
// 4 elements: rss, channel, item, link. `extra` more elements are added, so total = 4 + extra.
const rssWithElementTotal = (total, filler = '<x/>') => `<rss><channel><item><link>${TARGET}</link></item>${filler.repeat(total - 4)}</channel></rss>`;

test('limits are explicit, documented constants with headroom over the real feed (1,341 items)', () => {
  assert.equal(MAX_ITEMS, 10000); assert.equal(MAX_ELEMENTS, 200000);
  assert.ok(MAX_ITEMS > 1341 * 5, 'at least 5x the current feed');
  assert.ok(MAX_ELEMENTS >= MAX_ITEMS * 2 + 4, 'the element cap never rejects a feed that is exactly at the item cap');
});

test('item cap: below and at the limit accepted; one above rejected as too_many_items (RSS and Atom)', () => {
  assert.equal(parseFeedStrict(rssWithItems(MAX_ITEMS - 1)).items.length, MAX_ITEMS - 1);
  assert.equal(parseFeedStrict(rssWithItems(MAX_ITEMS)).items.length, MAX_ITEMS);
  const over = parseFeedStrict(rssWithItems(MAX_ITEMS + 1));
  assert.deepEqual([over.ok, over.detail, over.items], [false, 'too_many_items', undefined]);
  assert.equal(parseFeedStrict(atomWithEntries(MAX_ITEMS)).items.length, MAX_ITEMS);
  assert.equal(parseFeedStrict(atomWithEntries(MAX_ITEMS + 1)).detail, 'too_many_items');
});

test('element cap: exactly at the limit accepted; one above rejected as too_many_elements; self-closing and nested elements count', () => {
  const at = parseFeedStrict(rssWithElementTotal(MAX_ELEMENTS - 1));
  assert.equal(at.ok, true);
  assert.equal(parseFeedStrict(rssWithElementTotal(MAX_ELEMENTS)).ok, true);
  const over = parseFeedStrict(rssWithElementTotal(MAX_ELEMENTS + 1));
  assert.deepEqual([over.ok, over.detail, over.items], [false, 'too_many_elements', undefined]);
  // nested groups of 3 elements each: <g><x/><x/></g>; 4 + 3k elements in total
  const nested = (k) => `<rss><channel><item><link>${TARGET}</link></item>${'<g><x/><x/></g>'.repeat(k)}</channel></rss>`;
  const k = Math.floor((MAX_ELEMENTS - 4) / 3);
  assert.equal(parseFeedStrict(nested(k)).ok, true);
  assert.equal(parseFeedStrict(nested(k + 1)).detail, 'too_many_elements');
});

test('malformed input is still rejected whether or not the caps are involved', () => {
  assert.equal(parseFeedStrict(rssWithItems(5).replace('</channel>', '</chanel>')).ok, false);
  assert.equal(parseFeedStrict(rssWithItems(5).slice(0, -20)).ok, false);
  const overAndMalformed = parseFeedStrict(rssWithElementTotal(MAX_ELEMENTS + 10).replace('</rss>', ''));
  assert.equal(overAndMalformed.ok, false); assert.equal(overAndMalformed.items, undefined);
  assert.equal(parseFeedStrict(rssWithItems(3).replace('<channel>', '<channel><a><b>')).ok, false);
});

test('the real-world size passes: 1,341 items stay valid with all items returned', () => {
  const r = parseFeedStrict(fx.feedXml(Array.from({ length: 1341 }, (_, i) => ({ link: `https://openai.com/index/a-${i}` }))));
  assert.equal(r.ok, true); assert.equal(r.items.length, 1341);
});

test('byte cap and element cap are independent: each trips alone, with distinct evidence', async () => {
  // many elements, few bytes (well under 8 MiB): rejected by the element cap, not the byte cap
  const manyElements = rssWithElementTotal(MAX_ELEMENTS + 1);
  assert.ok(Buffer.byteLength(manyElements) < MAX_FEED_BYTES / 4);
  const a = await fetchPublisherFeed(FEED, { fetchImpl: fx.okFetch(manyElements) });
  assert.deepEqual([a.ok, a.reason, a.detail], [false, 'feed_too_large', 'too_many_elements']);
  // few elements, bytes over a small cap: rejected by the byte cap alone (no parser detail)
  const b = await fetchPublisherFeed(FEED, { fetchImpl: fx.okFetch(goodXml), maxBytes: 100 });
  assert.equal(b.ok, false); assert.equal(b.reason, 'feed_too_large'); assert.equal(b.detail, undefined);
  // both caps leave a normal feed alone
  const c = await fetchPublisherFeed(FEED, { fetchImpl: fx.okFetch(goodXml) });
  assert.equal(c.ok, true);
  assert.equal(MAX_FEED_BYTES, 8 * 1024 * 1024);
});

test('an over-cap feed through the CLI writes nothing (no partial annotations) and exits 2', async () => {
  const { dbPath } = await disposableDb('p1h-overcap');
  try {
    const before = fileHash(dbPath);
    const r = await run(['--db', dbPath, '--write'], { xml: rssWithItems(MAX_ITEMS + 1).replace('</channel>', `<item><link>${TARGET}</link></item></channel>`) });
    assert.equal(r.code, 2, r.text); assert.match(r.text, /FEED_UNAVAILABLE reason=feed_too_large/); assert.match(r.text, /detail=too_many_items/); assert.match(r.text, /written=0/);
    assert.equal(feedRows(dbPath).length, 0); assert.equal(fileHash(dbPath), before);
  } finally { fx.removeDb(dbPath); }
});