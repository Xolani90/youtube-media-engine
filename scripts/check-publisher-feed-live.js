#!/usr/bin/env node
/**
 * READ-ONLY live check of the authorized publisher feed. Owner-run, local.
 *
 *   node scripts/check-publisher-feed-live.js [--feed-id openai-news]
 *
 * Makes exactly ONE plain GET (same code path as the annotation CLI:
 * fetchPublisherFeed) to the feed URL in config/publisher_feeds.json, then
 * prints: HTTP status, actual response byte count, validation result and
 * parsed item count. It opens NO database, imports no storage code, reads
 * no env vars and writes no files or annotations. Exit codes: 0 feed
 * valid, 1 usage/config error, 2 feed unavailable or invalid.
 */
import { isCliEntry } from '../src/publisherFeeds/cliEntry.js';
import { loadPublisherFeedConfig, findAuthorizedFeed, fetchPublisherFeed } from '../src/publisherFeeds/feedClient.js';

export async function main({ argv = process.argv.slice(2), out = console.log, fetchImpl = fetch, configPath } = {}) {
  let feedId = null;
  if (argv.length === 2 && argv[0] === '--feed-id' && argv[1] !== '' && !argv[1].startsWith('-')) feedId = argv[1];
  else if (argv.length !== 0) { out('usage: node scripts/check-publisher-feed-live.js [--feed-id <id>]'); return 1; }
  let feed;
  try { feed = findAuthorizedFeed(configPath ? loadPublisherFeedConfig(configPath) : loadPublisherFeedConfig(), { feedId }); } catch (e) { out(`CONFIG_ERROR ${e.message}`); return 1; }
  if (!feed) { out('FEED_NOT_AUTHORIZED'); return 1; }
  out(`feed_url=${feed.feedUrl}`);
  const r = await fetchPublisherFeed(feed, { fetchImpl });
  out(`http_status=${r.httpStatus ?? 'NONE'}`);
  out(`response_bytes=${r.bytes ?? 'UNKNOWN'}`);
  if (r.ok) {
    out('validation=PASS');
    out(`parsed_items=${r.items.length}`);
    out('writes=none database=none');
    return 0;
  }
  out(`validation=FAIL reason=${r.reason}${r.detail ? ` detail=${r.detail}` : ''}${r.error ? ` error=${r.error}` : ''}`);
  out('parsed_items=0');
  out('writes=none database=none');
  return 2;
}

if (isCliEntry(import.meta.url, process.argv[1])) {
  try { process.exitCode = await main(); } catch (e) { console.log(`ERROR ${e.message}`); process.exitCode = 1; }
}
