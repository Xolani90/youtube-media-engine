import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizePublisherUrl, isAuthorizedHost } from '../../src/publisherFeeds/urlMatch.js';

test('normalization ignores www, query, fragment and trailing slash but keeps path case', () => {
  const base = normalizePublisherUrl('https://openai.com/index/gpt-6-for-everyone');
  assert.equal(base, 'https://openai.com/index/gpt-6-for-everyone');
  for (const u of ['https://www.OpenAI.com/index/gpt-6-for-everyone?x=1#frag', 'https://openai.com/index/gpt-6-for-everyone//']) {
    assert.equal(normalizePublisherUrl(u), base, u);
  }
  assert.notEqual(normalizePublisherUrl('https://openai.com/index/GPT-6-for-everyone'), base);
});

test('non-http, empty and malformed URLs normalize to null', () => {
  for (const u of [null, undefined, '', '   ', 'ftp://openai.com/a', 'javascript:alert(1)', 'not a url']) {
    assert.equal(normalizePublisherUrl(u), null, String(u));
  }
});

test('host authorization is exact: no suffix, prefix or lookalike matches', () => {
  const hosts = ['openai.com'];
  assert.equal(isAuthorizedHost('https://openai.com/a', hosts), true);
  assert.equal(isAuthorizedHost('https://www.openai.com/a', hosts), true);
  for (const u of ['https://openai.com.evil.example/a', 'https://notopenai.com/a', 'https://api.openai.com/a', 'https://evil.example/openai.com']) {
    assert.equal(isAuthorizedHost(u, hosts), false, u);
  }
});
