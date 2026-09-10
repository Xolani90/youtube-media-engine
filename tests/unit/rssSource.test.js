import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { RssSource } from '../../src/providers/opportunity/RssSource.js';

const FEED_XML = `<?xml version="1.0"?><rss version="2.0"><channel>
<item><title>Test Item One</title><link>https://example.com/1</link><description>Desc one</description><pubDate>Mon, 01 Jan 2024 00:00:00 GMT</pubDate><guid>g1</guid></item>
</channel></rss>`;

function startLocalFeedServer({ fail = false } = {}) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (fail) {
        res.writeHead(500);
        res.end('server error');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/rss+xml' });
      res.end(FEED_XML);
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

test('fetches and parses a real (local) RSS feed, preserving provenance', async () => {
  const server = await startLocalFeedServer();
  const port = server.address().port;
  const source = new RssSource({ feedUrls: [`http://127.0.0.1:${port}/feed`] });

  const { candidates, failures } = await source.fetchCandidates();
  assert.equal(failures.length, 0);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].title, 'Test Item One');
  assert.equal(candidates[0].feedUrl, `http://127.0.0.1:${port}/feed`);
  assert.ok(candidates[0].retrievedAt);

  const normalized = source.normalize(candidates[0]);
  assert.equal(normalized.sourceUrl, 'https://example.com/1');
  assert.equal(normalized.sourceId, 'g1');
  assert.equal(normalized.sourceType, 'rss');
  assert.ok(normalized.discoveredAt);

  server.close();
});

test('isolates a failing feed without affecting other successful feeds', async () => {
  const goodServer = await startLocalFeedServer({ fail: false });
  const badServer = await startLocalFeedServer({ fail: true });
  const goodPort = goodServer.address().port;
  const badPort = badServer.address().port;

  const source = new RssSource({
    feedUrls: [`http://127.0.0.1:${badPort}/feed`, `http://127.0.0.1:${goodPort}/feed`]
  });

  const { candidates, failures } = await source.fetchCandidates();
  assert.equal(candidates.length, 1, 'the good feed must still produce candidates despite the bad feed failing');
  assert.equal(failures.length, 1);
  assert.equal(failures[0].feedUrl, `http://127.0.0.1:${badPort}/feed`);

  goodServer.close();
  badServer.close();
});

test('a feed with zero items is a successful-but-empty result, not a failure', async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/rss+xml' });
    res.end('<?xml version="1.0"?><rss version="2.0"><channel></channel></rss>');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const source = new RssSource({ feedUrls: [`http://127.0.0.1:${port}/empty`] });

  const { candidates, failures } = await source.fetchCandidates();
  assert.equal(candidates.length, 0);
  assert.equal(failures.length, 0, 'zero items from a valid feed is success-but-empty, not a failure');

  server.close();
});
