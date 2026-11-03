import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatSourceDiagnostic } from '../../scripts/research-source-diagnostic.js';
import { run as explainRun } from '../../scripts/explain-research-evidence.js';
import { annotateBlockedSources } from '../../src/publisherFeeds/annotate.js';
import { readFeedAnnotations, formatAnnotationBlock } from '../../src/publisherFeeds/report.js';
import { parseFeed } from '../../src/discovery/rssParser.js';
import { findAuthorizedFeed, loadPublisherFeedConfig } from '../../src/publisherFeeds/feedClient.js';
import { freshMigratedStorage, removeDb, seedProject, seedSource, feedXml, provenance } from '../helpers/publisherFeedsFixture.js';

const feed = findAuthorizedFeed(loadPublisherFeedConfig(), { feedId: 'openai-news' });
const URL1 = 'https://openai.com/index/gpt-6-for-everyone';

test('diagnostic block is byte-identical when no notes are supplied (existing callers unchanged)', () => {
  const args = { projectId: 'p', sourceId: 's', url: URL1, retrievalStatus: 'FAILED', content: null };
  assert.equal(formatSourceDiagnostic(args).includes('failure_class'), false);
});

test('FAILED diagnostic blocks gain explicit failure_class, http_status and the original error; non-FAILED do not', () => {
  const failed = formatSourceDiagnostic({ projectId: 'p', sourceId: 's', url: URL1, retrievalStatus: 'FAILED', content: null, notes: provenance({ error: 'HTTP 403' }) });
  assert.match(failed, /^failure_class=host_access_denied$/m);
  assert.match(failed, /^http_status=403$/m);
  assert.match(failed, /^retrieval_error=HTTP 403$/m);
  const ok = formatSourceDiagnostic({ projectId: 'p', sourceId: 's', url: URL1, retrievalStatus: 'SUCCESS', content: 'x', notes: provenance({ error: null, status: 'SUCCESS' }) });
  assert.equal(ok.includes('failure_class'), false);
  const internal = formatSourceDiagnostic({ projectId: 'p', sourceId: 's', url: URL1, retrievalStatus: 'FAILED', content: null, notes: provenance({ error: 'fetch failed' }) });
  assert.match(internal, /^failure_class=internal_retrieval_failure$/m);
  assert.match(internal, /^http_status=NONE$/m);
});

test('annotation blocks are labelled non-evidentiary and carry URL, feed, item, date and annotation time', async () => {
  const { storage, dbPath } = await freshMigratedStorage('rep');
  try {
    seedProject(storage);
    seedSource(storage, { url: URL1, error: 'HTTP 403' });
    annotateBlockedSources({ db: storage, feed, now: () => '2026-10-31T10:05:00.000Z',
      feedResult: { ok: true, feedUrl: feed.feedUrl, fetchedAt: 'T', items: parseFeed(feedXml([{ link: URL1, title: 'X' }])) } });
    const block = formatAnnotationBlock(readFeedAnnotations((q, p) => storage.all(q, p))[0]);
    for (const re of [/^\[publisher-feed-metadata\]$/m, /^label=non_evidentiary_publisher_metadata$/m, new RegExp(`^publisher_url=${URL1}$`, 'm'),
      /^feed_url=https:\/\/openai\.com\/news\/rss\.xml$/m, /^feed_item=/m, /^feed_published_at=Thu, 29 Oct 2026/m, /^annotated_at=2026-10-31T10:05:00.000Z$/m, /^failure_class=host_access_denied$/m]) {
      assert.match(block, re);
    }
    assert.doesNotMatch(block, /summary|VERIFIED|evidence_status/i);
  } finally { storage.close(); removeDb(dbPath); }
});

test('explain-research-evidence prints annotations only after, and apart from, the evidence explanation; absent table prints nothing extra', async () => {
  const { storage, dbPath } = await freshMigratedStorage('rep2');
  try {
    seedProject(storage);
    seedSource(storage, { url: URL1, error: 'HTTP 403' });
    storage.close();
    const lines = []; explainRun(dbPath, (l) => lines.push(l));
    assert.deepEqual(lines, ['[research-evidence] no load-bearing claims']);
  } finally { removeDb(dbPath); }
});
