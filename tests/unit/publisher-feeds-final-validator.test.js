import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFeedStrict, MAX_DEPTH } from '../../src/publisherFeeds/feedValidate.js';
import { fetchPublisherFeed } from '../../src/publisherFeeds/feedClient.js';
import { FEED_FAILURE } from '../../src/publisherFeeds/constants.js';

const L = 'https://openai.com/index/a';
const L2 = 'https://openai.com/index/b';
const item = (l = L, extra = '') => `<item><title>T</title><link>${l}</link>${extra}</item>`;
const rss = (body) => `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>X</title>${body}</channel></rss>`;
const atom = (body) => `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>X</title>${body}</feed>`;
const entry = (links, extra = '') => `<entry><title>T</title>${links}<id>urn:x</id>${extra}</entry>`;

function mustReject(xml, label) {
  const r = parseFeedStrict(xml);
  assert.equal(r.ok, false, `${label}: accepted`);
  assert.equal(r.items, undefined, `${label}: no partial items`);
  assert.ok(r.detail, `${label}: detail`);
}
const mustAccept = (xml, label) => { const r = parseFeedStrict(xml); assert.equal(r.ok, true, `${label}: ${r.detail}`); return r; };

test('valid RSS with CDATA, comments, PIs, predefined and numeric entities is accepted and decoded', () => {
  const r = mustAccept(rss(`<!-- c --><?pi data?>${item(L, '<description><![CDATA[<b>x</b> & y]]></description><guid>g1</guid>')}<item><title>A &amp; B &lt;c&gt; &quot;q&quot; &apos;s&apos; &#65;&#x42;</title><link>${L2}</link></item>`), 'rich');
  assert.equal(r.items[0].description, '<b>x</b> & y');
  assert.equal(r.items[1].title, `A & B <c> "q" 's' AB`);
});

test('RSS root/channel/item structure: wrong root, no channel, two channels, items outside channel, nested item', () => {
  mustReject(`<?xml version="1.0"?><html><body/></html>`, 'html root');
  mustReject(`<rss version="2.0">${item()}</rss>`, 'item directly under rss');
  mustReject(`<rss version="2.0"></rss>`, 'rss without channel');
  mustReject(`<rss version="2.0"><channel>${item()}</channel><channel>${item(L2)}</channel></rss>`, 'two channels');
  mustReject(rss(`<wrapper>${item()}</wrapper>`), 'item inside wrapper');
  mustReject(rss(`<item><title>T</title><link>${L}</link>${item(L2)}</item>`), 'nested item');
  mustReject(`<rss version="2.0"><channel><title>t</title></channel>${item()}</rss>`, 'item after channel');
});

test('undefined and invalid entity references are rejected', () => {
  for (const [label, frag] of [['html nbsp', '&nbsp;'], ['custom', '&foo;'], ['bare amp', 'a & b'], ['amp no semicolon', '&amp'], ['num too big', '&#1114112;'], ['num zero', '&#0;'], ['control ref', '&#1;'], ['surrogate ref', '&#xD800;'], ['empty ref', '&#;'], ['bad hex', '&#xZZ;']]) {
    mustReject(rss(`<item><title>${frag}</title><link>${L}</link></item>`), `text ${label}`);
    mustReject(rss(`<item><title>t</title><link>${L}</link><category term="${frag}"/></item>`), `attr ${label}`);
  }
});

test('malformed attributes: unquoted, unterminated, missing value, missing space, "<" in value, bad name', () => {
  for (const [label, attrs] of [['unquoted', 'a=b'], ['unterminated', 'a="b'], ['no value', 'a'], ['no equals value', 'a='], ['lt in value', 'a="<"'], ['bad name', '1a="b"'], ['mixed quotes', `a="b'`]]) {
    mustReject(rss(`<item><title>T</title><link>${L}</link><category ${attrs}/></item>`), label);
  }
  mustReject(rss(`<item><title>T</title><link>${L}</link><category a="1"b="2"/></item>`), 'no whitespace between attributes');
});

test('duplicate attributes are rejected (also on the root and on atom links)', () => {
  mustReject(rss(`<item><title>T</title><link>${L}</link><category a="1" a="2"/></item>`), 'dup attr');
  mustReject(`<rss version="2.0" version="2.0"><channel>${item()}</channel></rss>`, 'dup on root');
  mustReject(atom(entry(`<link href="${L}" href="${L2}"/>`)), 'dup href');
});

test('Atom: rel=self without an alternate is rejected; self+alternate uses only the alternate', () => {
  mustReject(atom(entry(`<link rel="self" href="${L}"/>`)), 'self only');
  mustReject(atom(entry(`<link rel="enclosure" href="${L}"/>`)), 'enclosure only');
  const r = mustAccept(atom(entry(`<link rel="self" href="https://openai.com/feed.xml"/><link rel="alternate" href="${L}"/><link rel="enclosure" href="https://evil.example/x.mp3"/>`)), 'self+alt+enclosure');
  assert.equal(r.items[0].link, L);
});

test('Atom: multiple alternates are ambiguous and rejected; entries outside feed are rejected', () => {
  mustReject(atom(entry(`<link href="${L}"/><link rel="alternate" href="${L2}"/>`)), 'two alternates');
  mustReject(atom(entry(`<link href="${L}"/><link href="${L2}"/>`)), 'two default-rel');
  mustReject(atom(`<wrap>${entry(`<link href="${L}"/>`)}</wrap>`), 'entry in wrapper');
  mustReject(atom(entry(`<link href="/relative"/>`)), 'relative href');
  mustReject(atom(entry(`<link href="https://openai.com:8443/x"/>`)), 'port href');
  mustReject(atom(entry(`<link href="https://u:p@openai.com/x"/>`)), 'userinfo href');
});

test('nested or misplaced link elements: link inside link, link under another child, child elements inside link', () => {
  mustReject(rss(`<item><title>T</title><link>${L}<link>${L2}</link></link></item>`), 'link inside link');
  mustReject(rss(`<item><title>T</title><x><link>${L}</link></x></item>`), 'link only nested under x (no direct link)');
  mustReject(rss(`<item><title>T</title><link><b>${L}</b></link></item>`), 'child element inside link');
  mustReject(rss(`<item><link>${L}</link><x><link>${L2}</link></x><link>${L2}</link></item>`), 'two direct links even with a nested one');
  const r = mustAccept(rss(`<item><title>T</title><link>${L}</link><x><link>${L2}</link></x></item>`), 'nested extra link ignored, direct used');
  assert.equal(r.items[0].link, L);
});

test('malformed but balanced markup is rejected', () => {
  for (const [label, frag] of [['bad tag name', '<1x>y</1x>'], ['space in end tag name', '<a>y</a b>'], ['stray lt', '<a>1 < 2</a>'], ['empty tag', '<>y'], ['bad PI', '<?xml version="1.0"?>'], ['comment double dash', '<!-- a -- b -->'], ['cdata end in text', 'a ]]> b'], ['doctype inside', '<!DOCTYPE x>'], ['entity decl', '<!ENTITY a "b">'], ['nul char', 'a\u0000b'], ['control char', 'a\u0001b'], ['lone surrogate', 'a\ud800b'], ['fffe', 'a\ufffeb']]) {
    mustReject(rss(`${item()}<z>${frag}</z>`), label);
  }
  mustReject(rss(`${item()}<a><b></a></b>`), 'crossed tags');
  mustReject(`<rss version="2.0"><channel>${item()}</channel></rss></rss>`, 'extra close');
});

test('prolog and encoding rules: BOM ok, declaration only at start, UTF-8 only, version 1.0 only, DOCTYPE refused', () => {
  mustAccept('\ufeff' + rss(item()), 'BOM');
  mustAccept(`<rss version="2.0"><channel>${item()}</channel></rss>`, 'no declaration');
  mustReject(` <?xml version="1.0"?><rss><channel>${item()}</channel></rss>`, 'declaration not at start');
  mustReject(`<?xml version="1.0" encoding="ISO-8859-1"?><rss><channel>${item()}</channel></rss>`, 'non-utf8 encoding');
  mustReject(`<?xml version="1.1"?><rss><channel>${item()}</channel></rss>`, 'version 1.1');
  mustReject(`<?xml version="1.0"?><!DOCTYPE rss><rss><channel>${item()}</channel></rss>`, 'doctype');
  mustReject(`<?xml version="1.0"?><!DOCTYPE rss [<!ENTITY x "y">]><rss><channel>${item()}</channel></rss>`, 'doctype+entity (billion laughs vector)');
  mustReject(`<rss><channel>${item()}</channel></rss><![CDATA[x]]>`, 'cdata after root');
});

test('truncation anywhere in a valid document is rejected: EVERY proper prefix fails closed with no items', () => {
  const full = rss(item(L, '<guid>g</guid>') + `<item><title>T &amp; U</title><link>${L2}</link><description><![CDATA[x]]></description></item>`);
  assert.equal(parseFeedStrict(full).ok, true);
  let accepted = 0;
  for (let n = 0; n < full.length; n += 1) {
    const r = parseFeedStrict(full.slice(0, n));
    if (r.ok) accepted += 1;
    assert.equal(r.ok, false, `prefix of ${n} chars was accepted`);
    assert.equal(r.items, undefined);
  }
  assert.equal(accepted, 0);
});

test('nesting depth is bounded', () => {
  const deep = '<a>'.repeat(MAX_DEPTH + 5) + '</a>'.repeat(MAX_DEPTH + 5);
  mustReject(rss(`${item()}${deep}`), 'too deep');
});

test('one bad item rejects the whole feed through fetchPublisherFeed (no partial annotations)', async () => {
  const FEED = { id: 'openai-news', feedUrl: 'https://openai.com/news/rss.xml', hosts: ['openai.com'] };
  const xml = rss(item(L) + '<item><title>bad</title></item>' + item(L2));
  const r = await fetchPublisherFeed(FEED, { fetchImpl: async () => new Response(xml, { status: 200 }) });
  assert.equal(r.reason, FEED_FAILURE.MALFORMED_FEED);
  assert.equal(r.items, undefined);
});

test('stated limits are real: undeclared namespace prefixes are accepted (namespaces are not enforced)', () => {
  mustAccept(rss(`<item><title>T</title><link>${L}</link><foo:bar>x</foo:bar></item>`), 'undeclared prefix accepted, documented limitation');
});
