import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RssSource } from '../../src/providers/opportunity/RssSource.js';
import { RSS_ADMISSION } from '../../src/discovery/constants.js';

// ADR-0038: RSS admission workload bounds -- per-feed cap 50, global cap 100,
// configured feed order, no redistribution of unused per-feed capacity.

function feedXml(n, { prefix = 'item' } = {}) {
  const items = Array.from({ length: n }, (_, i) => (
    `<item><title>${prefix} ${i}</title><link>https://example.com/${prefix}-${i}</link>` +
    `<description>d</description><guid>${prefix}-${i}</guid></item>`
  )).join('\n');
  return `<?xml version="1.0"?><rss version="2.0"><channel>${items}</channel></rss>`;
}

function stubFetch(feedContents) {
  return async (url) => ({
    ok: true,
    async text() {
      if (!(url in feedContents)) throw new Error(`unexpected fetch for ${url}`);
      return feedContents[url];
    }
  });
}

test('per-feed cap: a feed with MORE than 50 items admits exactly 50 and reports the ceiling', async () => {
  const feedUrl = 'https://feed.test/a';
  const source = new RssSource({
    feedUrls: [feedUrl],
    fetchImpl: stubFetch({ [feedUrl]: feedXml(75) })
  });

  const { candidates, ceilings } = await source.fetchCandidates();
  assert.equal(candidates.length, RSS_ADMISSION.PER_FEED_CAP);
  assert.equal(candidates[0].title, 'item 0', 'within-feed order preserved (parser/document order)');
  assert.equal(candidates.at(-1).title, 'item 49');
  assert.deepEqual(ceilings.perFeedCapReached, [feedUrl]);
  assert.equal(ceilings.globalCapReached, false);
});

test('exact-cap edge case: a feed with EXACTLY 50 items admits all 50 and reports NO ceiling event', async () => {
  const feedUrl = 'https://feed.test/exact';
  const source = new RssSource({
    feedUrls: [feedUrl],
    fetchImpl: stubFetch({ [feedUrl]: feedXml(50) })
  });

  const { candidates, ceilings } = await source.fetchCandidates();
  assert.equal(candidates.length, 50);
  assert.deepEqual(ceilings.perFeedCapReached, [], 'nothing was actually excluded, so no ceiling event fires');
  assert.equal(ceilings.globalCapReached, false);
});

test('global cap with no redistribution: global cap binds mid-sequence across 4 under-per-feed-cap feeds (20/20/10/0=50)', async () => {
  // PER_FEED_CAP (50) === GLOBAL_CAP (50), so a feed that individually
  // exceeds the per-feed cap would also single-handedly exhaust the whole
  // global budget -- that scenario is covered separately by the per-feed
  // cap test above. This test instead uses four feeds that each stay
  // UNDER the per-feed cap, so it isolates global-cap behavior: partial
  // admission mid-feed when the global cap is reached, no redistribution
  // of a later feed's configured order to backfill unused capacity, and
  // a feed after the one that exhausts the cap never being counted at all.
  const feeds = ['openai', 'google', 'techcrunch', 'arstechnica'].map((n) => `https://feed.test/${n}`);
  const raw = { [feeds[0]]: 20, [feeds[1]]: 20, [feeds[2]]: 20, [feeds[3]]: 20 };
  const contents = Object.fromEntries(feeds.map((f) => [f, feedXml(raw[f], { prefix: f })]));

  const source = new RssSource({ feedUrls: feeds, fetchImpl: stubFetch(contents) });
  const { candidates, ceilings } = await source.fetchCandidates();

  const byFeed = Object.fromEntries(feeds.map((f) => [f, candidates.filter((c) => c.feedUrl === f).length]));
  assert.deepEqual(byFeed, {
    [feeds[0]]: 20,
    [feeds[1]]: 20,
    [feeds[2]]: 10,
    [feeds[3]]: 0
  }, 'sequential configured-feed order; techcrunch is cut off mid-feed by the global cap, and arstechnica -- never redistributed any capacity -- is not fetched at all');
  assert.equal(candidates.length, RSS_ADMISSION.GLOBAL_CAP);
  assert.deepEqual(ceilings.perFeedCapReached, [], 'no individual feed exceeded the per-feed cap; the ceiling that bound here was the global cap');
  assert.equal(ceilings.globalCapReached, true);
});

test('global cap reached mid-run: a later configured feed is never processed at all', async () => {
  // PER_FEED_CAP (50) === GLOBAL_CAP (50) now, so a single feed that
  // exceeds the per-feed cap would also exhaust the entire global budget
  // by itself, collapsing the "two feeds combine to cross it" scenario
  // this test previously exercised. To still isolate "a later configured
  // feed must never be fetched once the global cap is reached" from any
  // per-feed-cap interaction, two feeds are used that each stay UNDER the
  // per-feed cap and sum to exactly the global cap (25 + 25 = 50), so the
  // global cap is reached precisely at a feed boundary.
  const feedA = 'https://feed.test/first';
  const feedB = 'https://feed.test/second';
  const feedC = 'https://feed.test/third';
  let feedCFetched = false;
  const source = new RssSource({
    feedUrls: [feedA, feedB, feedC],
    fetchImpl: async (url) => {
      if (url === feedC) feedCFetched = true;
      return { ok: true, async text() { return feedXml(25, { prefix: url }); } };
    }
  });

  const { candidates, ceilings } = await source.fetchCandidates();
  assert.equal(candidates.length, RSS_ADMISSION.GLOBAL_CAP);
  assert.equal(feedCFetched, false, 'the third feed must never be processed once the global cap is reached');
  assert.deepEqual(ceilings.perFeedCapReached, [], 'neither feed individually exceeded the per-feed cap; only the global cap bound here');
  assert.equal(ceilings.globalCapReached, true);
});

test('broken-feed isolation is unaffected by admission caps: a failing feed does not block a later feed\'s admission', async () => {
  const badFeed = 'https://feed.test/bad';
  const goodFeed = 'https://feed.test/good';
  const source = new RssSource({
    feedUrls: [badFeed, goodFeed],
    fetchImpl: async (url) => {
      if (url === badFeed) return { ok: false, status: 500, async text() { return ''; } };
      return { ok: true, async text() { return feedXml(5); } };
    }
  });

  const { candidates, failures, ceilings } = await source.fetchCandidates();
  assert.equal(failures.length, 1);
  assert.equal(failures[0].feedUrl, badFeed);
  assert.equal(candidates.length, 5);
  assert.deepEqual(ceilings.perFeedCapReached, []);
  assert.equal(ceilings.globalCapReached, false);
});