import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { main } from '../../scripts/check-publisher-feed-live.js';
import { feedXml } from '../helpers/publisherFeedsFixture.js';

const run = async (impl, argv = []) => { const lines = []; const code = await main({ argv, out: (l) => lines.push(l), fetchImpl: impl }); return { code, text: lines.join('\n') }; };

test('live check prints status, byte count, PASS and item count for a valid feed; one request; no DB', async () => {
  const xml = feedXml([{ link: 'https://openai.com/a' }, { link: 'https://openai.com/b' }]);
  let calls = 0;
  const r = await run(async (u, init) => { calls += 1; assert.equal(u, 'https://openai.com/news/rss.xml'); assert.equal('headers' in init, false); return new Response(xml, { status: 200 }); });
  assert.equal(r.code, 0);
  assert.match(r.text, /http_status=200/);
  assert.match(r.text, new RegExp(`response_bytes=${Buffer.byteLength(xml)}\\b`));
  assert.match(r.text, /validation=PASS/);
  assert.match(r.text, /parsed_items=2/);
  assert.equal(calls, 1);
});

test('live check reports FAIL with reason for truncated/malformed/HTTP-error feeds and exits 2', async () => {
  const xml = feedXml([{ link: 'https://openai.com/a' }]);
  const t = await run(async () => new Response(xml.slice(0, xml.length - 10), { status: 200 }));
  assert.equal(t.code, 2); assert.match(t.text, /validation=FAIL reason=feed_malformed/); assert.match(t.text, /response_bytes=\d+/);
  const h = await run(async () => new Response('no', { status: 403 }));
  assert.equal(h.code, 2); assert.match(h.text, /http_status=403/); assert.match(h.text, /reason=feed_http_error/);
});

test('live check usage errors make no request; script has no database or storage imports and no file writes', async () => {
  let calls = 0;
  for (const argv of [['--db', 'x'], ['--feed-id'], ['--feed-id', '--x'], ['extra']]) assert.equal((await run(async () => { calls += 1; return new Response(''); }, argv)).code, 1);
  assert.equal((await run(async () => { calls += 1; return new Response(''); }, ['--feed-id', 'nope'])).code, 1);
  assert.equal(calls, 0);
  const src = fs.readFileSync(new URL('../../scripts/check-publisher-feed-live.js', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(src, /better-sqlite3|storage|SQLITE|writeFile|appendFile|createWriteStream|process\.env/);
});
