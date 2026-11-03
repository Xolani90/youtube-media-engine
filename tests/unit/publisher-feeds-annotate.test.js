import { test } from 'node:test';
import assert from 'node:assert/strict';
import { annotateBlockedSources, tableExists, itemKeyOf } from '../../src/publisherFeeds/annotate.js';
import { parseFeed } from '../../src/discovery/rssParser.js';
import { findAuthorizedFeed, loadPublisherFeedConfig } from '../../src/publisherFeeds/feedClient.js';
import { freshMigratedStorage, removeDb, seedProject, seedSource, feedXml, provenance, snapshotResearchTables } from '../helpers/publisherFeedsFixture.js';

const feed = findAuthorizedFeed(loadPublisherFeedConfig(), { feedId: 'openai-news' });
const URL1 = 'https://openai.com/index/gpt-6-for-everyone';
const mkFeed = (items, fetchedAt = '2026-10-31T10:00:00.000Z') => ({ ok: true, feedUrl: feed.feedUrl, fetchedAt, items: parseFeed(feedXml(items)) });
const rows = (storage) => storage.all('SELECT * FROM publisher_feed_items ORDER BY blocked_source_id, item_key');

test('a blocked openai.com page is annotated with feed provenance and failure details preserved', async () => {
  const { storage, dbPath } = await freshMigratedStorage('ann-basic');
  try {
    seedProject(storage);
    const sid = seedSource(storage, { url: URL1, error: 'HTTP 403' });
    const s = annotateBlockedSources({ db: storage, feed, feedResult: mkFeed([{ link: `${URL1}/`, title: 'GPT-6 for everyone', description: 'Summary.' }]), now: () => '2026-10-31T10:05:00.000Z' });
    assert.equal(s.inserted, 1);
    const r = rows(storage)[0];
    assert.equal(r.blocked_source_id, sid);
    assert.equal(r.blocked_source_url, URL1, 'original publisher URL preserved unmodified');
    assert.equal(r.item_link, `${URL1}/`);
    assert.equal(r.feed_url, 'https://openai.com/news/rss.xml');
    assert.equal(r.item_guid, `${URL1}/`);
    assert.equal(r.published_at_feed, 'Thu, 29 Oct 2026 17:00:00 GMT');
    assert.equal(r.annotated_at, '2026-10-31T10:05:00.000Z');
    assert.equal(r.feed_fetched_at, '2026-10-31T10:00:00.000Z');
    assert.equal(r.failure_class, 'host_access_denied');
    assert.equal(r.blocked_http_status, 403);
    assert.equal(r.blocked_error_text, 'HTTP 403');
    assert.equal(r.blocked_retrieval_method, 'plain');
    assert.equal(r.origin, 'rss_feed_metadata');
    assert.equal(r.evidentiary, 0);
  } finally { storage.close(); removeDb(dbPath); }
});

test('only FAILED rows on the authorized host are considered; SUCCESS, off-host and unmatched rows are not annotated', async () => {
  const { storage, dbPath } = await freshMigratedStorage('ann-scope');
  try {
    seedProject(storage);
    seedSource(storage, { url: URL1, retrievalStatus: 'SUCCESS', content: 'real text', notes: provenance({ error: null, status: 'SUCCESS' }) });
    seedSource(storage, { url: 'https://example.com/index/gpt-6-for-everyone', error: 'HTTP 403' });
    seedSource(storage, { url: 'https://openai.com/index/not-in-feed', error: 'HTTP 429' });
    const s = annotateBlockedSources({ db: storage, feed, feedResult: mkFeed([{ link: URL1 }]) });
    assert.equal(s.inserted, 0);
    assert.equal(s.blockedSourcesConsidered, 2);
    assert.equal(s.byFailureClass.host_rate_limited, 1);
    assert.equal(rows(storage).length, 0);
  } finally { storage.close(); removeDb(dbPath); }
});

test('feed items on a foreign host are ignored even if their link matches nothing authorized', async () => {
  const { storage, dbPath } = await freshMigratedStorage('ann-foreign');
  try {
    seedProject(storage);
    seedSource(storage, { url: 'https://openai.com/index/x', error: 'HTTP 403' });
    const s = annotateBlockedSources({ db: storage, feed, feedResult: mkFeed([{ link: 'https://openai.com.evil.example/index/x' }]) });
    assert.equal(s.inserted, 0);
    assert.equal(s.feedItemsOffHost, 1);
  } finally { storage.close(); removeDb(dbPath); }
});

test('idempotency: repeated runs create no duplicates and never alter the first-recorded row', async () => {
  const { storage, dbPath } = await freshMigratedStorage('ann-idem');
  try {
    seedProject(storage);
    seedSource(storage, { url: URL1, error: 'HTTP 403' });
    const first = annotateBlockedSources({ db: storage, feed, feedResult: mkFeed([{ link: URL1, title: 'v1' }]), now: () => '2026-10-31T10:00:00.000Z' });
    const snap1 = rows(storage);
    const second = annotateBlockedSources({ db: storage, feed, feedResult: mkFeed([{ link: URL1, title: 'v2 changed' }], '2026-11-02T00:00:00.000Z'), now: () => '2026-11-02T00:00:01.000Z' });
    const third = annotateBlockedSources({ db: storage, feed, feedResult: mkFeed([{ link: URL1, title: 'v1' }]), now: () => '2026-11-03T00:00:00.000Z' });
    assert.equal(first.inserted, 1);
    assert.equal(second.inserted, 0); assert.equal(second.duplicates, 1);
    assert.equal(third.inserted, 0);
    assert.deepEqual(rows(storage), snap1, 'row content, ids and annotated_at are unchanged by re-runs');
  } finally { storage.close(); removeDb(dbPath); }
});

test('dedup key is the guid, else the normalized link', () => {
  assert.equal(itemKeyOf({ guid: ' g-1 ', link: 'https://openai.com/a' }), 'guid:g-1');
  assert.equal(itemKeyOf({ guid: '', link: 'https://www.openai.com/a/?q=1' }), 'url:https://openai.com/a');
  assert.equal(itemKeyOf({ guid: null, link: null }), null);
});

test('dry-run plans and reports but writes nothing, even when the table is absent', async () => {
  const { storage, dbPath } = await freshMigratedStorage('ann-dry');
  try {
    seedProject(storage);
    seedSource(storage, { url: URL1, error: 'HTTP 403' });
    storage.run('DROP INDEX idx_publisher_feed_items_blocked_source');
    storage.run('DROP TABLE publisher_feed_items');
    assert.equal(tableExists((q, p) => storage.all(q, p)), false);
    const s = annotateBlockedSources({ db: storage, feed, feedResult: mkFeed([{ link: URL1 }]), dryRun: true });
    assert.equal(s.plannedRows, 1); assert.equal(s.inserted, 0);
    assert.equal(tableExists((q, p) => storage.all(q, p)), false);
  } finally { storage.close(); removeDb(dbPath); }
});

test('50 feed items matching one blocked source produce 50 distinct metadata rows and no change to any research table', async () => {
  const { storage, dbPath } = await freshMigratedStorage('ann-50');
  try {
    seedProject(storage);
    seedSource(storage, { url: URL1, error: 'HTTP 403' });
    const items = Array.from({ length: 50 }, (_, i) => ({ link: URL1, guid: `https://openai.com/index/gpt-6-for-everyone#g${i}`, title: `t${i}` }));
    const before = snapshotResearchTables(storage);
    const s = annotateBlockedSources({ db: storage, feed, feedResult: mkFeed(items) });
    assert.equal(s.inserted, 50);
    assert.deepEqual(snapshotResearchTables(storage), before);
  } finally { storage.close(); removeDb(dbPath); }
});
