import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSourceUrl, formatSourceDiagnostic } from '../../scripts/research-source-diagnostic.js';

test('parseSourceUrl splits a normal publisher URL into host and path+query', () => {
  const result = parseSourceUrl('https://bbc.com/news/example-article?ref=rss');
  assert.deepEqual(result, { host: 'bbc.com', path: '/news/example-article?ref=rss' });
});

test('parseSourceUrl splits a Google News RSS wrapper URL into host and path', () => {
  const result = parseSourceUrl('https://news.google.com/rss/articles/CBMi123?oc=5');
  assert.deepEqual(result, { host: 'news.google.com', path: '/rss/articles/CBMi123?oc=5' });
});

test('parseSourceUrl returns UNKNOWN/UNKNOWN for a null or missing URL', () => {
  assert.deepEqual(parseSourceUrl(null), { host: 'UNKNOWN', path: 'UNKNOWN' });
  assert.deepEqual(parseSourceUrl(undefined), { host: 'UNKNOWN', path: 'UNKNOWN' });
  assert.deepEqual(parseSourceUrl(''), { host: 'UNKNOWN', path: 'UNKNOWN' });
});

test('parseSourceUrl returns UNKNOWN/UNKNOWN for an unparseable URL rather than throwing', () => {
  assert.deepEqual(parseSourceUrl('not a url'), { host: 'UNKNOWN', path: 'UNKNOWN' });
});

test('formatSourceDiagnostic renders all required fields for a Google News wrapper source', () => {
  const block = formatSourceDiagnostic({
    projectId: 'proj-1',
    sourceId: 'src-1',
    url: 'https://news.google.com/rss/articles/CBMi123?oc=5',
    retrievalStatus: 'CONTENT_UNPARSEABLE',
    content: null
  });
  assert.equal(block, [
    '[research-source-diagnostic]',
    'project=proj-1',
    'source=src-1',
    'url_host=news.google.com',
    'url_path=/rss/articles/CBMi123?oc=5',
    'retrieval_status=CONTENT_UNPARSEABLE',
    'content_length=0'
  ].join('\n'));
});

test('formatSourceDiagnostic reports content_length from actual content, never the content itself', () => {
  const block = formatSourceDiagnostic({
    projectId: 'proj-2',
    sourceId: 'src-2',
    url: 'https://bbc.com/news/example-article',
    retrievalStatus: 'SUCCESS',
    content: 'twelve chars'
  });
  assert.match(block, /^content_length=12$/m);
  assert.doesNotMatch(block, /twelve chars/);
});

test('formatSourceDiagnostic falls back to UNKNOWN retrieval_status when none is stored', () => {
  const block = formatSourceDiagnostic({
    projectId: 'proj-3',
    sourceId: 'src-3',
    url: 'https://example.com/a',
    retrievalStatus: null,
    content: null
  });
  assert.match(block, /^retrieval_status=UNKNOWN$/m);
});