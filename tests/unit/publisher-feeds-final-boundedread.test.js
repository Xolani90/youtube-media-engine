import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchPublisherFeed, readBoundedText } from '../../src/publisherFeeds/feedClient.js';
import { FEED_FAILURE, MAX_FEED_BYTES } from '../../src/publisherFeeds/constants.js';
import { feedXml } from '../helpers/publisherFeedsFixture.js';

const FEED = { id: 'openai-news', feedUrl: 'https://openai.com/news/rss.xml', hosts: ['openai.com'] };
const enc = new TextEncoder();
const GOOD = feedXml([{ link: 'https://openai.com/index/a', title: 'Caf\u00e9 \u4e16\u754c \ud83d\ude00' }]);

/** A Response-like whose body is an instrumented stream: counts pulled chunks and records cancel. */
function streamed(chunks, { headers = {}, status = 200, hang = false } = {}) {
  const st = { pulled: 0, cancelled: false, calls: 0 };
  let i = 0;
  const body = new ReadableStream({
    pull(c) {
      if (i >= chunks.length) { if (hang) return new Promise(() => {}); c.close(); return undefined; }
      st.pulled += 1; c.enqueue(chunks[i++]); return undefined;
    },
    cancel() { st.cancelled = true; }
  }, { highWaterMark: 0 });
  const impl = async () => { st.calls += 1; return new Response(body, { status, headers }); };
  impl.st = st;
  return impl;
}
const split = (bytes, n) => { const out = []; for (let i = 0; i < bytes.length; i += n) out.push(bytes.slice(i, i + n)); return out; };

test('MAX_FEED_BYTES is enforced on bytes: multibyte text under the char count but over the byte cap is rejected', async () => {
  // 3-byte characters: character length is a third of the byte length
  const text = `<rss><channel>${'\u4e16'.repeat(40)}</channel></rss>`;
  const bytes = enc.encode(text);
  assert.ok(text.length < bytes.length);
  const cap = Math.floor((text.length + bytes.length) / 2);
  assert.ok(text.length <= cap && bytes.length > cap, 'char length passes, byte length fails');
  const r = await fetchPublisherFeed(FEED, { fetchImpl: streamed([bytes]), maxBytes: cap });
  assert.equal(r.reason, FEED_FAILURE.TOO_LARGE);
});

test('exactly maxBytes is accepted; one byte more is rejected', async () => {
  const bytes = enc.encode(GOOD);
  assert.equal((await fetchPublisherFeed(FEED, { fetchImpl: streamed([bytes]), maxBytes: bytes.length })).ok, true);
  assert.equal((await fetchPublisherFeed(FEED, { fetchImpl: streamed([bytes]), maxBytes: bytes.length - 1 })).reason, FEED_FAILURE.TOO_LARGE);
});

test('default cap is 8 MiB of bytes', async () => {
  assert.equal(MAX_FEED_BYTES, 8 * 1024 * 1024);
  const f = streamed([new Uint8Array(MAX_FEED_BYTES + 1)]);
  assert.equal((await fetchPublisherFeed(FEED, { fetchImpl: f })).reason, FEED_FAILURE.TOO_LARGE);
});

test('oversized Content-Length is refused BEFORE any body byte is read, and the body is cancelled', async () => {
  const f = streamed([enc.encode(GOOD)], { headers: { 'content-length': String(MAX_FEED_BYTES + 1) } });
  const r = await fetchPublisherFeed(FEED, { fetchImpl: f });
  assert.equal(r.reason, FEED_FAILURE.TOO_LARGE);
  assert.equal(f.st.pulled, 0, 'no chunk was pulled');
  assert.equal(f.st.cancelled, true);
});

test('missing Content-Length: the limit is enforced while streaming, the body is cancelled, and the rest is never pulled', async () => {
  const chunks = Array.from({ length: 50 }, () => new Uint8Array(100));
  const f = streamed(chunks);
  const r = await fetchPublisherFeed(FEED, { fetchImpl: f, maxBytes: 450 });
  assert.equal(r.reason, FEED_FAILURE.TOO_LARGE);
  assert.equal(f.st.cancelled, true);
  assert.ok(f.st.pulled <= 6, `pulled ${f.st.pulled} chunks of 50; buffering stopped at the cap`);
});

test('a lying (too small) Content-Length does not bypass the streaming limit', async () => {
  const f = streamed(Array.from({ length: 20 }, () => new Uint8Array(100)), { headers: { 'content-length': '10' } });
  const r = await fetchPublisherFeed(FEED, { fetchImpl: f, maxBytes: 500 });
  assert.equal(r.reason, FEED_FAILURE.TOO_LARGE);
  assert.equal(f.st.cancelled, true);
});

test('junk Content-Length values are ignored (the stream limit still applies), never trusted', async () => {
  for (const v of ['abc', '-5', '1e9', '']) {
    const f = streamed([enc.encode(GOOD)], { headers: { 'content-length': v } });
    assert.equal((await fetchPublisherFeed(FEED, { fetchImpl: f })).ok, true, v);
  }
});

test('body reading is covered by the timeout: a stalled body times out and the stream is cancelled', async () => {
  const f = streamed([enc.encode(GOOD.slice(0, 40))], { hang: true });
  const t0 = Date.now();
  const r = await fetchPublisherFeed(FEED, { fetchImpl: f, timeoutMs: 50 });
  assert.equal(r.reason, FEED_FAILURE.TIMEOUT);
  assert.equal(f.st.cancelled, true);
  assert.ok(Date.now() - t0 < 2000);
});

test('headers arrive in time but the body is slow (trickle): total time is bounded by the timeout', async () => {
  const bytes = enc.encode(GOOD);
  let i = 0;
  const body = new ReadableStream({ async pull(c) { await new Promise((r) => setTimeout(r, 30)); if (i < bytes.length) c.enqueue(bytes.slice(i, i += 5)); else c.close(); } });
  const r = await fetchPublisherFeed(FEED, { fetchImpl: async () => new Response(body, { status: 200 }), timeoutMs: 100 });
  assert.equal(r.reason, FEED_FAILURE.TIMEOUT);
});

test('multibyte UTF-8 split across every chunk boundary decodes correctly (1-byte chunks)', async () => {
  const r = await fetchPublisherFeed(FEED, { fetchImpl: streamed(split(enc.encode(GOOD), 1)) });
  assert.equal(r.ok, true);
  assert.equal(r.items[0].title, 'Caf\u00e9 \u4e16\u754c \ud83d\ude00');
  const r2 = await fetchPublisherFeed(FEED, { fetchImpl: streamed(split(enc.encode(GOOD), 2)) });
  assert.equal(r2.items[0].title, 'Caf\u00e9 \u4e16\u754c \ud83d\ude00');
});

test('invalid UTF-8 (bad byte, or a truncated multibyte sequence at the end) is rejected as malformed, no items', async () => {
  const bad = Uint8Array.from([...enc.encode('<rss><channel><item><title>'), 0xff, ...enc.encode('</title><link>https://openai.com/a</link></item></channel></rss>')]);
  const r = await fetchPublisherFeed(FEED, { fetchImpl: streamed([bad]) });
  assert.equal(r.reason, FEED_FAILURE.MALFORMED_FEED);
  assert.equal(r.items, undefined);
  const trunc = Uint8Array.from([...enc.encode(GOOD), 0xe4, 0xb8]);
  assert.equal((await fetchPublisherFeed(FEED, { fetchImpl: streamed([trunc]) })).reason, FEED_FAILURE.MALFORMED_FEED);
});

test('a response with no readable body stream is an error; res.text() is never used as a fallback', async () => {
  let textCalled = false;
  const fake = async () => ({ ok: true, status: 200, headers: { get: () => null }, text: async () => { textCalled = true; return GOOD; } });
  const r = await fetchPublisherFeed(FEED, { fetchImpl: fake });
  assert.equal(r.ok, false);
  assert.equal(r.reason, FEED_FAILURE.NETWORK_ERROR);
  assert.equal(textCalled, false);
});

test('non-2xx and redirect responses never read the body (cancelled instead)', async () => {
  for (const status of [403, 500, 308]) {
    const f = streamed([enc.encode(GOOD)], { status });
    const r = await fetchPublisherFeed(FEED, { fetchImpl: f });
    assert.equal(r.ok, false);
    assert.equal(f.st.pulled, 0, String(status));
  }
});

test('request identity is unchanged: one plain fetch(url, {signal, redirect:"manual"}), no headers, no other client', async () => {
  const seen = [];
  const impl = async (url, init) => { seen.push({ url, keys: Object.keys(init).sort() }); return new Response(GOOD, { status: 200 }); };
  const r = await fetchPublisherFeed(FEED, { fetchImpl: impl });
  assert.equal(r.ok, true);
  assert.deepEqual(seen, [{ url: 'https://openai.com/news/rss.xml', keys: ['redirect', 'signal'] }]);
});

test('success reports the actual byte count read', async () => {
  const bytes = enc.encode(GOOD);
  const r = await fetchPublisherFeed(FEED, { fetchImpl: streamed(split(bytes, 7)) });
  assert.equal(r.bytes, bytes.length);
});

test('readBoundedText is exported and honours an already-aborted signal', async () => {
  const c = new AbortController(); c.abort();
  await assert.rejects(() => readBoundedText(new Response('x'), { signal: c.signal }), (e) => e.name === 'AbortError');
});
