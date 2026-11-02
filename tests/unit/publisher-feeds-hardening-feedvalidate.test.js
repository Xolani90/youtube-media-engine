import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchPublisherFeed } from '../../src/publisherFeeds/feedClient.js';
import { validateFeedStructure, parseFeedStrict } from '../../src/publisherFeeds/feedValidate.js';
import { FEED_FAILURE } from '../../src/publisherFeeds/constants.js';
import { feedXml } from '../helpers/publisherFeedsFixture.js';

const FEED = { id: 'openai-news', feedUrl: 'https://openai.com/news/rss.xml', hosts: ['openai.com'] };
const ok = (xml) => async () => new Response(xml, { status: 200 });
const L1 = 'https://openai.com/index/a';
const L2 = 'https://openai.com/index/b';
const item = (link, extra = '') => `<item><title>T</title><link>${link}</link><guid>${link}</guid>${extra}</item>`;
const rss = (body, tail = '</channel></rss>') => `<?xml version="1.0"?><rss version="2.0"><channel><title>X</title>${body}${tail}`;

async function rejected(xml, label) {
  const r = await fetchPublisherFeed(FEED, { fetchImpl: ok(xml) });
  assert.equal(r.ok, false, `${label}: must be rejected`);
  assert.equal(r.reason, FEED_FAILURE.MALFORMED_FEED, `${label}: reason`);
  assert.equal(r.items, undefined, `${label}: no partial items are returned`);
  return r;
}

test('control: well-formed feeds (CDATA with markup, comments, PI, guid-less items) are accepted unchanged', async () => {
  const xml = feedXml([{ link: L1, description: 'a <b>bold</b> summary & more' }, { link: L2, guid: null }]);
  const r = await fetchPublisherFeed(FEED, { fetchImpl: ok(xml) });
  assert.equal(r.ok, true);
  assert.equal(r.items.length, 2);
  const withComment = rss(`<!-- c -->${item(L1)}`);
  assert.equal((await fetchPublisherFeed(FEED, { fetchImpl: ok(withComment) })).ok, true);
});

test('truncated feeds are rejected as a whole: cut mid-item, mid-tag, before </rss>, before </channel>', async () => {
  const full = rss(item(L1) + item(L2));
  assert.equal((await fetchPublisherFeed(FEED, { fetchImpl: ok(full) })).ok, true, 'control');
  await rejected(full.slice(0, full.indexOf('<item>', full.indexOf('<item>') + 1) + 20), 'cut inside second item');
  await rejected(full.slice(0, full.length - 3), 'cut inside </rss>');
  await rejected(full.replace('</rss>', ''), 'missing </rss>');
  await rejected(full.replace('</channel></rss>', ''), 'missing channel and rss close');
  await rejected(rss(item(L1) + `<item><title>T</title><link>${L2}</link>`), 'unclosed final <item> still ends the document');
  await rejected(rss(item(L1) + `<item><title>T</title><link>${L2}</link>`, ''), 'document ends inside final item');
});

test('malformed markup is rejected: mismatched, crossed, unterminated comment/CDATA/PI, stray <, text after root, extra root', async () => {
  await rejected(rss(`<item><title>T</title><link>${L1}</link></itm>`), 'mismatched close tag');
  await rejected(rss(`<item><title>T<link>${L1}</link></title></item>`).replace('</title></item>', '</item></title>'), 'crossed tags');
  await rejected(rss(`${item(L1)}<!-- never closed`), 'unterminated comment');
  await rejected(rss(`<item><title><![CDATA[never closed</title><link>${L1}</link></item>`), 'unterminated CDATA');
  await rejected(rss(`<?pi never closed ${item(L1)}`), 'unterminated PI');
  await rejected(rss(`<item><title>a < b</title><link>${L1}</link></item>`), 'stray < in text');
  await rejected(rss(item(L1)) + 'trailing garbage', 'text after root');
  await rejected(rss(item(L1)) + '<rss></rss>', 'second root');
  await rejected(rss(item(L1)) + `<item>${L2}</item>`, 'element after root closed');
  await rejected('<rss><channel><item><title>T</title><link>' + L1, 'cut during link text');
});

test('DOCTYPE / entity declarations are rejected', async () => {
  await rejected(`<?xml version="1.0"?><!DOCTYPE rss [<!ENTITY x "y">]><rss><channel>${item(L1)}</channel></rss>`, 'doctype with entity');
});

test('invalid item/link structures are rejected: missing, empty, duplicate, relative, wrong scheme, userinfo, port', async () => {
  await rejected(rss('<item><title>No link here</title></item>'), 'item without link');
  await rejected(rss(`${item(L1)}<item><title>No link</title><guid>g</guid></item>`), 'second item without link');
  await rejected(rss('<item><title>T</title><link></link></item>'), 'empty link');
  await rejected(rss('<item><title>T</title><link>   </link></item>'), 'blank link');
  await rejected(rss(`<item><title>T</title><link>${L1}</link><link>${L2}</link></item>`), 'two links');
  await rejected(rss('<item><title>T</title><link>/index/relative</link></item>'), 'relative link');
  await rejected(rss('<item><title>T</title><link>javascript:alert(1)</link></item>'), 'javascript link');
  await rejected(rss('<item><title>T</title><link>ftp://openai.com/x</link></item>'), 'ftp link');
  await rejected(rss('<item><title>T</title><link>https://u:p@openai.com/x</link></item>'), 'userinfo link');
  await rejected(rss('<item><title>T</title><link>https://openai.com:8443/x</link></item>'), 'alternate-port link');
  await rejected(rss(`<item><title>T</title><link>${L1}</link><guid></guid></item>`), 'empty guid');
});

test('one bad item rejects the whole feed: a valid matching first item yields no partial result', async () => {
  const r = await rejected(rss(item(L1) + '<item><title>bad</title></item>' + item(L2)), 'valid, invalid, valid');
  assert.ok(r.detail);
});

test('Atom: single alternate link accepted; rel=self is ignored, never used as the item link', async () => {
  const entry = (l) => `<entry><title>T</title><link href="${l}"/><id>${l}</id></entry>`;
  const atom = (b) => `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>X</title>${b}</feed>`;
  assert.equal((await fetchPublisherFeed(FEED, { fetchImpl: ok(atom(entry(L1))) })).ok, true);
  const selfPlusAlt = await fetchPublisherFeed(FEED, { fetchImpl: ok(atom(`<entry><title>T</title><link rel="self" href="https://openai.com/feed"/><link rel="alternate" href="${L1}"/><id>x</id></entry>`)) });
  assert.equal(selfPlusAlt.ok, true);
  assert.equal(selfPlusAlt.items[0].link, L1);
  await rejected(atom(`<entry><title>T</title><link rel="self" href="https://openai.com/feed"/><id>x</id></entry>`), 'self-only entry has no usable link');
  await rejected(atom(`<entry><title>T</title><link href="${L1}"/><link rel="alternate" href="${L2}"/><id>x</id></entry>`), 'two alternates are ambiguous');
  await rejected(atom(`<entry><title>T</title><id>x</id></entry>`), 'atom entry without link');
});

test('non-feed documents keep their existing classifications; zero items stays no_items', async () => {
  assert.equal((await fetchPublisherFeed(FEED, { fetchImpl: ok('<html><body>challenge</body></html>') })).reason, FEED_FAILURE.NOT_A_FEED);
  assert.equal((await fetchPublisherFeed(FEED, { fetchImpl: ok(rss(''))})).reason, FEED_FAILURE.NO_ITEMS);
});

test('validateFeedStructure: unit-level negatives for empty and non-string input', () => {
  for (const v of ['', '   ', null, undefined, 5]) assert.equal(validateFeedStructure(v).ok, false);
});
