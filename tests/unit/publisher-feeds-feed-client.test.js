import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchPublisherFeed, findAuthorizedFeed, loadPublisherFeedConfig } from '../../src/publisherFeeds/feedClient.js';
import { FEED_FAILURE } from '../../src/publisherFeeds/constants.js';
import { feedXml, okFetch } from '../helpers/publisherFeedsFixture.js';

const feed = findAuthorizedFeed(loadPublisherFeedConfig(), { feedId: 'openai-news' });
const goodXml = feedXml([{ link: 'https://openai.com/index/a' }]);

test('authorization config lists exactly the one approved feed', () => {
  const cfg = loadPublisherFeedConfig();
  assert.deepEqual(cfg.feeds.map((f) => f.feedUrl), ['https://openai.com/news/rss.xml']);
  assert.equal(findAuthorizedFeed(cfg, { feedUrl: 'https://blog.google/rss/' }), null);
});

test('success path parses items and sends a plain fetch: no custom headers, no redirect following', async () => {
  const f = okFetch(goodXml);
  const r = await fetchPublisherFeed(feed, { fetchImpl: f, now: () => 'T' });
  assert.equal(r.ok, true);
  assert.equal(r.items.length, 1);
  assert.equal(r.fetchedAt, 'T');
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].url, 'https://openai.com/news/rss.xml');
  assert.equal(f.calls[0].init.redirect, 'manual');
  assert.equal('headers' in f.calls[0].init, false, 'no header customisation or impersonation');
});

test('an unauthorized or missing feed is refused without any request', async () => {
  const f = okFetch(goodXml);
  assert.equal((await fetchPublisherFeed(null, { fetchImpl: f })).reason, FEED_FAILURE.NOT_AUTHORIZED);
  assert.equal(f.calls.length, 0);
});

test('HTTP errors fail closed with explicit class and status (401/403/429/500)', async () => {
  const expect = { 401: 'host_access_denied', 403: 'host_access_denied', 429: 'host_rate_limited', 500: 'host_http_error' };
  for (const [code, cls] of Object.entries(expect)) {
    const r = await fetchPublisherFeed(feed, { fetchImpl: okFetch('', Number(code)) });
    assert.equal(r.ok, false);
    assert.equal(r.reason, FEED_FAILURE.HTTP_ERROR);
    assert.equal(r.httpStatus, Number(code));
    assert.equal(r.failureClass, cls);
  }
});

test('a redirect is reported, never followed', async () => {
  const f = okFetch('', 308);
  const r = await fetchPublisherFeed(feed, { fetchImpl: f });
  assert.equal(r.reason, FEED_FAILURE.REDIRECT_NOT_FOLLOWED);
  assert.equal(f.calls.length, 1);
});

test('network error, timeout, non-feed 200, empty feed and oversize all fail closed', async () => {
  const boom = async () => { throw new Error('fetch failed'); };
  assert.equal((await fetchPublisherFeed(feed, { fetchImpl: boom })).reason, FEED_FAILURE.NETWORK_ERROR);

  const hang = (_u, { signal }) => new Promise((_res, rej) => signal.addEventListener('abort', () => { const e = new Error('aborted'); e.name = 'AbortError'; rej(e); }));
  assert.equal((await fetchPublisherFeed(feed, { fetchImpl: hang, timeoutMs: 20 })).reason, FEED_FAILURE.TIMEOUT);

  assert.equal((await fetchPublisherFeed(feed, { fetchImpl: okFetch('<html><body>Just a moment...</body></html>') })).reason, FEED_FAILURE.NOT_A_FEED);
  assert.equal((await fetchPublisherFeed(feed, { fetchImpl: okFetch('<rss version="2.0"><channel></channel></rss>') })).reason, FEED_FAILURE.NO_ITEMS);
  assert.equal((await fetchPublisherFeed(feed, { fetchImpl: okFetch('<rss>' + 'x'.repeat(8 * 1024 * 1024 + 1)) })).reason, FEED_FAILURE.TOO_LARGE);
});
