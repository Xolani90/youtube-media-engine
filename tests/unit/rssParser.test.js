import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFeed } from '../../src/discovery/rssParser.js';

const SAMPLE_RSS = `<?xml version="1.0"?>
<rss version="2.0"><channel>
<item>
  <title>AI startup launches new tool</title>
  <link>https://example.com/a</link>
  <description>A description of the tool.</description>
  <pubDate>Mon, 01 Jan 2024 00:00:00 GMT</pubDate>
  <guid>guid-1</guid>
</item>
<item>
  <title><![CDATA[Second Item & Title]]></title>
  <link>https://example.com/b</link>
  <description>Another item.</description>
  <pubDate>Tue, 02 Jan 2024 00:00:00 GMT</pubDate>
</item>
</channel></rss>`;

test('parses RSS 2.0 items with all fields', () => {
  const items = parseFeed(SAMPLE_RSS);
  assert.equal(items.length, 2);
  assert.equal(items[0].title, 'AI startup launches new tool');
  assert.equal(items[0].link, 'https://example.com/a');
  assert.equal(items[0].guid, 'guid-1');
});

test('decodes CDATA and entities', () => {
  const items = parseFeed(SAMPLE_RSS);
  assert.equal(items[1].title, 'Second Item & Title');
});

test('returns empty array for empty/malformed input', () => {
  assert.deepEqual(parseFeed(''), []);
  assert.deepEqual(parseFeed('not xml at all'), []);
  assert.deepEqual(parseFeed(null), []);
});
