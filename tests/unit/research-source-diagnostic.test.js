import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSourceUrl, formatSourceDiagnostic, formatDiscoveryDiagnostic, runDiscoveryDiagnostic } from '../../scripts/research-source-diagnostic.js';

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

test('formatDiscoveryDiagnostic reports ZERO_RESULTS with no failures for a genuine empty feed', () => {
  const block = formatDiscoveryDiagnostic({
    projectId: 'proj-1',
    decision: 'ZERO_RESULTS',
    reason: JSON.stringify({ provider: 'google-news-rss', query: 'test query', candidatesConsidered: 0, failures: [] })
  });
  assert.equal(block, [
    '[research-discovery-diagnostic]',
    'project=proj-1',
    'decision=ZERO_RESULTS',
    'provider=google-news-rss query="test query" candidates=0 failures=[]'
  ].join('\n'));
});

test('formatDiscoveryDiagnostic surfaces the provider-reported failure detail for PROVIDER_REPORTED_FAILURE', () => {
  const block = formatDiscoveryDiagnostic({
    projectId: 'proj-2',
    decision: 'PROVIDER_REPORTED_FAILURE',
    reason: JSON.stringify({
      provider: 'google-news-rss', query: 'test query', candidatesConsidered: 0,
      failures: [{ error: 'Google News RSS HTTP 503' }]
    })
  });
  assert.match(block, /^decision=PROVIDER_REPORTED_FAILURE$/m);
  assert.match(block, /Google News RSS HTTP 503/);
});

test('formatDiscoveryDiagnostic falls back to the raw reason for an unparseable/legacy reason value', () => {
  const block = formatDiscoveryDiagnostic({ projectId: 'proj-3', decision: 'FAILED', reason: 'discovery unreachable' });
  assert.match(block, /^reason=discovery unreachable$/m);
});

test('runDiscoveryDiagnostic prints one block per SOURCE_DISCOVERY decision_log row', () => {
  const printed = [];
  const origLog = console.log;
  console.log = (msg) => printed.push(msg);
  const fakeStorage = {
    all: (sql) => {
      assert.match(sql, /SOURCE_DISCOVERY/);
      return [{
        project_id: 'proj-9',
        decision: 'ZERO_RESULTS',
        reason: JSON.stringify({ provider: 'google-news-rss', query: 'q', candidatesConsidered: 0, failures: [] })
      }];
    }
  };
  try {
    runDiscoveryDiagnostic(fakeStorage);
  } finally {
    console.log = origLog;
  }
  assert.equal(printed.length, 1);
  assert.match(printed[0], /project=proj-9/);
  assert.match(printed[0], /decision=ZERO_RESULTS/);
});

test('runDiscoveryDiagnostic reports when no SOURCE_DISCOVERY decisions exist', () => {
  const printed = [];
  const origLog = console.log;
  console.log = (msg) => printed.push(msg);
  const fakeStorage = { all: () => [] };
  try {
    runDiscoveryDiagnostic(fakeStorage);
  } finally {
    console.log = origLog;
  }
  assert.equal(printed.length, 1);
  assert.match(printed[0], /no SOURCE_DISCOVERY decisions found/);
});