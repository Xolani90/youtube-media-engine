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

test('global cap with no redistribution: matches the ADR measurement evidence across 4 feeds (50/20/20/10=100)', async () => {
  const feeds = ['openai', 'google', 'techcrunch', 'arstechnica'].map((n) => `https://feed.test/${n}`);
  const raw = { [feeds[0]]: 1215, [feeds[1]]: 20, [feeds[2]]: 20, [feeds[3]]: 20 };
  const contents = Object.fromEntries(feeds.map((f) => [f, feedXml(raw[f], { prefix: f })]));

  const source = new RssSource({ feedUrls: feeds, fetchImpl: stubFetch(contents) });
  const { candidates, ceilings } = await source.fetchCandidates();

  const byFeed = Object.fromEntries(feeds.map((f) => [f, candidates.filter((c) => c.feedUrl === f).length]));
  assert.deepEqual(byFeed, {
    [feeds[0]]: 50,
    [feeds[1]]: 20,
    [feeds[2]]: 20,
    [feeds[3]]: 10
  }, 'sequential configured-feed order, no redistribution of the OpenAI feed\'s unused capacity to Ars Technica');
  assert.equal(candidates.length, RSS_ADMISSION.GLOBAL_CAP);
  assert.deepEqual(ceilings.perFeedCapReached, [feeds[0]], 'only the feed that actually exceeded 50 reports a per-feed ceiling');
  assert.equal(ceilings.globalCapReached, true);
});

test('global cap reached mid-run: a later configured feed is never processed at all', async () => {
  // Per-feed cap (50) means no single feed can reach the global cap (100)
  // alone -- two feeds of 60 each (50 admitted from each) are needed to
  // cross it, at which point the third configured feed must never be
  // fetched at all.
  const feedA = 'https://feed.test/first';
  const feedB = 'https://feed.test/second';
  const feedC = 'https://feed.test/third';
  let feedCFetched = false;
  const source = new RssSource({
    feedUrls: [feedA, feedB, feedC],
    fetchImpl: async (url) => {
      if (url === feedC) feedCFetched = true;
      return { ok: true, async text() { return feedXml(60, { prefix: url }); } };
    }
  });

  const { candidates, ceilings } = await source.fetchCandidates();
  assert.equal(candidates.length, RSS_ADMISSION.GLOBAL_CAP);
  assert.equal(feedCFetched, false, 'the third feed must never be processed once the global cap is reached');
  assert.deepEqual(ceilings.perFeedCapReached, [feedA, feedB]);
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