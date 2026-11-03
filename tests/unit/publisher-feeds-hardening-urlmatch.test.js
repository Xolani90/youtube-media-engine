import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePublisherUrl, normalizePublisherUrl, isAuthorizedHost } from '../../src/publisherFeeds/urlMatch.js';

const HOSTS = ['openai.com'];
const GOOD = 'https://openai.com/index/gpt-6';

test('URL match: accepted forms normalize to the same key', () => {
  for (const u of [GOOD, `${GOOD}/`, 'https://www.openai.com/index/gpt-6', 'HTTPS://OPENAI.COM/index/gpt-6',
    `${GOOD}?utm=1#frag`, 'https://openai.com:443/index/gpt-6']) {
    assert.equal(normalizePublisherUrl(u), 'https://openai.com/index/gpt-6', u);
    assert.equal(isAuthorizedHost(u, HOSTS), true, u);
  }
  // Scheme is part of the key (decision): http and https never share a key; the host is still authorized.
  for (const u of ['http://openai.com/index/gpt-6', 'http://openai.com:80/index/gpt-6']) {
    assert.equal(normalizePublisherUrl(u), 'http://openai.com/index/gpt-6', u);
    assert.notEqual(normalizePublisherUrl(u), normalizePublisherUrl(GOOD), u);
  }
  assert.deepEqual(parsePublisherUrl(GOOD), { scheme: 'https', host: 'openai.com', path: '/index/gpt-6' });
});

test('URL match NEGATIVE: nonstandard ports never match (effective port must be the scheme default)', () => {
  for (const u of ['https://openai.com:8443/index/gpt-6', 'http://openai.com:8080/index/gpt-6', 'https://openai.com:80/index/gpt-6',
    'http://openai.com:443/index/gpt-6', 'https://openai.com:1/index/gpt-6', 'https://openai.com:65535/index/gpt-6']) {
    assert.equal(parsePublisherUrl(u), null, u);
    assert.equal(normalizePublisherUrl(u), null, u);
    assert.equal(isAuthorizedHost(u, HOSTS), false, u);
  }
});

test('URL match NEGATIVE: userinfo never matches', () => {
  for (const u of ['https://user@openai.com/index/gpt-6', 'https://user:pw@openai.com/index/gpt-6', 'https://:pw@openai.com/index/gpt-6',
    'https://openai.com@evil.com/index/gpt-6', 'https://evil.com@openai.com/index/gpt-6']) {
    assert.equal(normalizePublisherUrl(u), null, u);
    assert.equal(isAuthorizedHost(u, HOSTS), false, u);
  }
});

test('URL match NEGATIVE: lookalike domains and subdomains never match', () => {
  for (const u of ['https://openai.com.evil.com/x', 'https://evilopenai.com/x', 'https://openai.co/x', 'https://openai.com.cn/x',
    'https://news.openai.com/x', 'https://a.b.openai.com/x', 'https://notopenai.com/x', 'https://openai-com.example/x',
    'https://openai.com./x', 'https://xn--penai-rze.com/x', 'https://evil.com/openai.com/x', 'https://evil.com/?u=https://openai.com/x']) {
    assert.equal(isAuthorizedHost(u, HOSTS), false, u);
  }
  // a subdomain of an authorized host is not authorized unless listed itself
  assert.equal(isAuthorizedHost('https://news.openai.com/x', ['news.openai.com']), true);
});

test('URL match NEGATIVE: non-http schemes, relative, empty and non-string inputs never match', () => {
  for (const u of ['ftp://openai.com/x', 'javascript:alert(1)', 'file:///etc/passwd', 'data:text/plain,openai.com', '//openai.com/x', '/index/x',
    'openai.com/index/x', '', '   ', null, undefined, 42, {}]) {
    assert.equal(normalizePublisherUrl(u), null, String(u));
    assert.equal(isAuthorizedHost(u, HOSTS), false, String(u));
  }
});

test('URL match: host list must be exact; non-array or empty list matches nothing', () => {
  assert.equal(isAuthorizedHost(GOOD, []), false);
  assert.equal(isAuthorizedHost(GOOD, null), false);
  assert.equal(isAuthorizedHost(GOOD, 'openai.com'), false);
});
