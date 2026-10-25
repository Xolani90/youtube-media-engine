import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DISCOVERY_OUTCOME as O, MAX_DIAGNOSTIC_FAILURES, MAX_DIAGNOSTIC_TEXT,
  sanitizeDiscoveryText, summarizeDiscovery, describeDiscoveryOutcome
} from '../../src/research/discoveryDiagnostics.js';
import { ResearchSourceProvider } from '../../src/research/ResearchSourceProvider.js';

const deepFreeze = (o) => { if (o && typeof o === 'object') { Object.values(o).forEach(deepFreeze); Object.freeze(o); } return o; };
const cands = (n) => Array.from({ length: n }, (_, i) => ({ url: `https://example.com/${i}` }));

// ------------------------------------------------------------ sanitization

test('sanitize: URLs are reduced to host+path (query string, fragment and userinfo are dropped)', () => {
  const out = sanitizeDiscoveryText('GET https://x.example/search?q=a&key=SECRET1&api_key=SECRET2#frag failed.');
  assert.equal(out, 'GET x.example/search failed.');
  assert.equal(sanitizeDiscoveryText('https://user:pw@host.example/p?token=SECRET3'), 'host.example/p');
  for (const leaked of ['SECRET1', 'SECRET2', 'SECRET3', 'pw@']) assert.ok(!out.includes(leaked));
});

test('sanitize: Bearer/Basic tokens and labelled credential pairs are redacted (key=, api_key=, JSON, token, password, authorization)', () => {
  const cases = [
    ['Authorization: Bearer abcDEF123.xyz', 'abcDEF123'],
    ['Authorization: Basic dXNlcjpwYXNz', 'dXNlcjpwYXNz'],
    ['failed with api_key=SECRETKEY and more', 'SECRETKEY'],
    ['{"apikey":"SECRETJSON","x":1}', 'SECRETJSON'],
    ["{'access_token': 'SECRETTOK'}", 'SECRETTOK'],
    ['password=hunter2&user=bob', 'hunter2'],
    ['client_secret: SECRETCLIENT', 'SECRETCLIENT'],
    ['x-signature=SECRETSIG', 'SECRETSIG']
  ];
  for (const [input, secret] of cases) {
    const out = sanitizeDiscoveryText(input);
    assert.ok(!out.includes(secret), `${input} -> ${out}`);
    assert.ok(out.includes('[REDACTED]'), `${input} -> ${out}`);
  }
});

test('sanitize: ordinary diagnostic wording survives', () => {
  const text = 'Google News RSS returned 100 parsed item(s) but all 100 were excluded as wrapper URLs; 0 usable candidates (parsed=100, wrapper=100)';
  assert.equal(sanitizeDiscoveryText(text, 1000), text);
});

test('sanitize: bounded length, single line, control characters removed, even for a huge input', () => {
  const started = Date.now();
  const out = sanitizeDiscoveryText(`line1\n\tline2\u0000\u0007 ${'x'.repeat(2_000_000)}`);
  assert.ok(Date.now() - started < 1000, 'must not be expensive on a multi-megabyte error body');
  assert.ok(out.length <= MAX_DIAGNOSTIC_TEXT + 1);
  assert.ok(!/[\u0000-\u001f]/.test(out));
  assert.ok(out.startsWith('line1 line2 '));
});

test('sanitize: a credential straddling the final length cap leaves no partial secret in the output', () => {
  // The label starts at char 290; the secret value would begin at char 298, i.e. inside the 300-char cap.
  const out = sanitizeDiscoveryText(`${'a '.repeat(145)}api_key=SECRETEDGE`);
  assert.ok(out.includes('api_key='), 'the label survives the cut');
  assert.ok(!out.includes('SECR'), `partial secret leaked: ${out.slice(-30)}`);
});

test('sanitize: DOCUMENTED LIMIT - well-known key prefixes and long opaque tokens are redacted; other unlabelled secrets are NOT (best-effort)', () => {
  assert.ok(!sanitizeDiscoveryText('echoed sk-bare-token-123 in prose').includes('sk-bare'));
  assert.ok(!sanitizeDiscoveryText('key tvly-ABCDEF1234567890XYZ rejected').includes('tvly-ABC'));
  assert.ok(!sanitizeDiscoveryText('opaque ' + 'a1B2c3D4'.repeat(6)).includes('a1B2c3D4a1B2'));
  // Still undetected: a short, unprefixed secret in prose.
  assert.equal(sanitizeDiscoveryText('the provider echoed hunter2 in prose'), 'the provider echoed hunter2 in prose');
});

test('sanitize: an HTTP status keeps the code and drops the raw response body', () => {
  assert.equal(sanitizeDiscoveryText('Tavily HTTP 401: {"detail":"invalid key"} trailing'), 'Tavily HTTP 401 (response body omitted)');
  assert.equal(sanitizeDiscoveryText('HTTP 503'), 'HTTP 503');
});

test('sanitize: long hyphenated words and URL slugs are not mistaken for tokens', () => {
  const t = 'see example.com/how-to-build-a-widget-in-five-easy-steps-today';
  assert.equal(sanitizeDiscoveryText(t), t);
});

test('sanitize: null/undefined -> null; non-strings coerced; hostile objects never throw', () => {
  assert.equal(sanitizeDiscoveryText(null), null);
  assert.equal(sanitizeDiscoveryText(undefined), null);
  assert.equal(sanitizeDiscoveryText(42), '42');
  const hostile = { toString() { throw new Error('nope'); } };
  assert.doesNotThrow(() => sanitizeDiscoveryText(hostile));
  assert.equal(sanitizeDiscoveryText(hostile), '[unavailable]');
});

// ------------------------------------------------------------ outcomes

test('summarize: candidates returned (partial provider failures are still counted and kept)', () => {
  const s = summarizeDiscovery({ provider: { id: 'p1' }, discovery: { candidates: cands(3), failures: [{ error: 'one feed failed' }] } });
  assert.equal(s.outcome, O.CANDIDATES_RETURNED);
  assert.equal(s.provider, 'p1');
  assert.equal(s.candidateCount, 3);
  assert.equal(s.failureCount, 1);
  assert.deepEqual(s.failures, [{ kind: null, error: 'one feed failed' }]);
});

test('summarize: genuinely empty result (no candidates, no failures, no malformation)', () => {
  for (const discovery of [{ candidates: [], failures: [] }, { candidates: [] }, {}]) {
    const s = summarizeDiscovery({ provider: { id: 'p1' }, discovery });
    assert.equal(s.outcome, O.EMPTY_RESULT, JSON.stringify(discovery));
    assert.equal(s.failureCount, 0);
    assert.deepEqual(s.malformed, []);
  }
});

test('summarize: provider-reported failure with zero candidates', () => {
  const s = summarizeDiscovery({ provider: { id: 'p1' }, discovery: { candidates: [], failures: [{ error: 'Tavily HTTP 401 (response body omitted)' }] } });
  assert.equal(s.outcome, O.PROVIDER_REPORTED_FAILURE);
  assert.equal(s.failureCount, 1);
  assert.equal(s.failures[0].error, 'Tavily HTTP 401 (response body omitted)');
});

test('summarize: failures are bounded (count and length) but failureCount is the true total', () => {
  const failures = Array.from({ length: 40 }, (_, i) => ({ error: `f${i} ${'y'.repeat(1000)}` }));
  const s = summarizeDiscovery({ provider: { id: 'p1' }, discovery: { candidates: [], failures } });
  assert.equal(s.failureCount, 40);
  assert.equal(s.failures.length, MAX_DIAGNOSTIC_FAILURES);
  assert.equal(s.failuresTruncated, true);
  assert.ok(s.failures.every((f) => f.error.length <= MAX_DIAGNOSTIC_TEXT + 1));
});

test('summarize: failure entries may be strings, objects without error text, null, or hostile; none throws', () => {
  const hostile = { get error() { throw new Error('getter'); } };
  const s = summarizeDiscovery({ provider: { id: 'p1' }, discovery: { candidates: [], failures: ['plain text', {}, null, 7, hostile] } });
  assert.equal(s.outcome, O.PROVIDER_REPORTED_FAILURE);
  assert.equal(s.failures.length, 5);
  assert.equal(s.failures[0].error, 'plain text');
  assert.equal(s.failures[1].error, null);
  assert.equal(s.failures[4].error, null);
});

test('summarize: provider-supplied `kind` is kept only when it is a short safe token', () => {
  const s = summarizeDiscovery({ provider: { id: 'p1' }, discovery: { candidates: [], failures: [
    { kind: 'HTTP_ERROR', error: 'a' }, { kind: 'has space; DROP', error: 'b' }, { kind: 'k'.repeat(100), error: 'c' }, { kind: 5, error: 'd' }
  ] } });
  assert.deepEqual(s.failures.map((f) => f.kind), ['HTTP_ERROR', null, null, null]);
});

// ------------------------------------------------------------ malformed provider output

test('summarize: malformed provider output is classified, never thrown on', () => {
  for (const discovery of ['a string', 42, true, [], [{ url: 'x' }]]) {
    const s = summarizeDiscovery({ provider: { id: 'p1' }, discovery });
    assert.equal(s.outcome, O.MALFORMED_RESPONSE, JSON.stringify(discovery));
    assert.deepEqual(s.malformed, ['response']);
  }
  const badCandidates = summarizeDiscovery({ provider: { id: 'p1' }, discovery: { candidates: { length: 3 }, failures: [] } });
  assert.equal(badCandidates.outcome, O.MALFORMED_RESPONSE);
  assert.deepEqual(badCandidates.malformed, ['candidates']);
  const badFailures = summarizeDiscovery({ provider: { id: 'p1' }, discovery: { candidates: [], failures: 'boom' } });
  assert.equal(badFailures.outcome, O.MALFORMED_RESPONSE);
  assert.deepEqual(badFailures.malformed, ['failures']);
});

test('summarize: malformed `failures` alongside real candidates is flagged but does not hide the candidates', () => {
  const s = summarizeDiscovery({ provider: { id: 'p1' }, discovery: { candidates: cands(2), failures: 'boom' } });
  assert.equal(s.outcome, O.CANDIDATES_RETURNED);
  assert.equal(s.candidateCount, 2);
  assert.deepEqual(s.malformed, ['failures']);
});

// ------------------------------------------------------------ thrown discovery

test('summarize: thrown discovery is sanitized and bounded; name is kept only if it is a safe token', () => {
  const s = summarizeDiscovery({ provider: { id: 'p1' }, thrown: Object.assign(new TypeError('failed GET https://h.example/p?api_key=SECRET9'), {}) });
  assert.equal(s.outcome, O.DISCOVERY_THREW);
  assert.equal(s.thrown, 'TypeError: failed GET h.example/p');
  assert.ok(!JSON.stringify(s).includes('SECRET9'));
  assert.equal(summarizeDiscovery({ thrown: 'a bare string' }).thrown, 'Error: a bare string');
  assert.equal(summarizeDiscovery({ thrown: Object.assign(new Error('m'), { name: 'bad name\n<x>' }) }).thrown, 'Error: m');
});

test('summarize: a thrown value with a throwing message getter still yields a summary', () => {
  const evil = { get message() { throw new Error('getter'); }, name: 'Error' };
  const s = summarizeDiscovery({ provider: { id: 'p1' }, thrown: evil });
  assert.equal(s.outcome, O.DISCOVERY_THREW);
  assert.equal(typeof s.thrown, 'string');
});

// ------------------------------------------------------------ robustness

test('summarize: a throwing provider.id getter (unimplemented base class) degrades to provider=null', () => {
  const s = summarizeDiscovery({ provider: new ResearchSourceProvider(), discovery: { candidates: [], failures: [] } });
  assert.equal(s.provider, null);
  assert.equal(s.outcome, O.EMPTY_RESULT);
});

test('summarize: an unsafe provider id is dropped, not stored', () => {
  assert.equal(summarizeDiscovery({ provider: { id: 'bad id; DROP TABLE' }, discovery: {} }).provider, null);
});

test('summarize: a discovery object whose properties throw yields DIAGNOSTICS_UNAVAILABLE, never an exception', () => {
  const evil = { get candidates() { throw new Error('x'); } };
  let s;
  assert.doesNotThrow(() => { s = summarizeDiscovery({ provider: { id: 'p1' }, discovery: evil }); });
  assert.equal(s.outcome, O.DIAGNOSTICS_UNAVAILABLE);
  assert.equal(s.candidateCount, 0);
});

test('summarize: never mutates the provider result it inspects', () => {
  const discovery = deepFreeze({ candidates: [{ url: 'https://a.example/' }], failures: [{ error: 'e', kind: 'K' }] });
  const before = JSON.stringify(discovery);
  summarizeDiscovery({ provider: { id: 'p1' }, discovery });
  assert.equal(JSON.stringify(discovery), before);
});

test('summarize: the result is plain JSON (round-trips through JSON.stringify exactly)', () => {
  const s = summarizeDiscovery({ provider: { id: 'p1' }, discovery: { candidates: [], failures: [{ error: 'e' }] } });
  assert.deepEqual(JSON.parse(JSON.stringify(s)), s);
});

test('describeDiscoveryOutcome: always a non-empty string (decision_log.reason is NOT NULL), even for garbage', () => {
  for (const input of [undefined, null, 5, 'x', {}, { outcome: 7 }, { outcome: O.EMPTY_RESULT }]) {
    const r = describeDiscoveryOutcome(input);
    assert.equal(typeof r, 'string');
    assert.ok(r.length > 0);
  }
  assert.match(describeDiscoveryOutcome(summarizeDiscovery({ provider: { id: 'p' }, discovery: { candidates: [], failures: [{ error: 'HTTP 503' }] } })), /^provider_reported_failure \(failures=1\): HTTP 503$/);
  assert.match(describeDiscoveryOutcome(summarizeDiscovery({ provider: { id: 'p' }, thrown: new Error('boom') })), /^discovery_threw \(failures=0\): Error: boom$/);
});
