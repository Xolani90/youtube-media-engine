import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { SqliteStorageDriver } from '../../src/storage/SqliteStorageDriver.js';
import { layer1ExactMatch, DEDUP_RESULT } from '../../src/discovery/dedup.js';
import discoveryPolicy from '../../config/discovery_policy.json' with { type: 'json' };
import {
  OUTCOME,
  IDENTITY_KIND,
  DiscoveryMemoryConfigError,
  DiscoveryMemoryReadError,
  DiscoveryMemoryWriteError,
  canonicalizeUrl,
  deriveIdentity,
  resolveCooldownMs,
  decideReconsideration,
  prepareDiscoveryMemory,
  recordDiscoveryOutcomes
} from '../../src/autonomous/discoveryMemory.js';

const HOUR = 3_600_000;
const T0 = Date.parse('2026-01-01T00:00:00.000Z');
const here = path.dirname(fileURLToPath(import.meta.url));
const read = (rel) => fs.readFileSync(path.resolve(here, rel), 'utf8').replace(/\r\n/g, '\n');

async function freshStorage() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'discovery-memory-'));
  const storage = new SqliteStorageDriver({ dbPath: path.join(dir, 't.db') });
  await storage.migrate();
  return { storage, cleanup: () => { storage.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

const obs = (over = {}) => ({
  title: 'Story', description: 'd', sourceUrl: 'https://example.test/a', sourceId: 'g1',
  feedUrl: 'https://feed.test/rss', ...over
});

// ---------------------------------------------------------------------------
// Canonicalization: exact behavioural equivalence with production dedup.js
// ---------------------------------------------------------------------------

function extractFunctionText(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `function ${name} not found`);
  let i = source.indexOf('{', start);
  let depth = 0;
  for (; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error('unbalanced');
}

test('local canonicalize() text is identical to production dedup.js canonicalize()', () => {
  const prod = extractFunctionText(read('../../src/discovery/dedup.js'), 'canonicalize');
  const local = extractFunctionText(read('../../src/autonomous/discoveryMemory.js'), 'canonicalize');
  assert.equal(local, prod);
});

test('local canonicalize() returns exactly the production output for a corpus of inputs', async () => {
  // Production canonicalize is module-private: evaluate its own extracted
  // source text so the comparison is against the production behaviour itself.
  const prodSrc = extractFunctionText(read('../../src/discovery/dedup.js'), 'canonicalize');
  const prodCanon = new Function(`${prodSrc}; return canonicalize;`)();
  const inputs = [
    undefined, null, '', 'https://example.test/a', 'https://example.test/a/', 'https://example.test',
    'https://example.test/?utm_source=x&utm_medium=y&utm_campaign=z&utm_term=t&utm_content=c',
    'https://example.test/a?b=1&utm_source=x#frag', 'https://example.test/a#frag',
    'HTTPS://EXAMPLE.TEST/A', 'https://example.test/a?utm_source=x&keep=1',
    'not a url', '/relative/path', 'ftp://example.test/x/', 'https://user:pw@example.test:8080/p/?q=1',
    'https://example.test/a?UTM_SOURCE=x', ' https://example.test/a '
  ];
  for (const input of inputs) {
    assert.equal(canonicalizeUrl(input), prodCanon(input), `mismatch for ${JSON.stringify(input)}`);
  }
});

test('identity relation agrees with production layer1ExactMatch on shared rungs (differential)', () => {
  const pairs = [
    [obs(), obs({ sourceId: 'g1', sourceUrl: 'https://other.test/', title: 'Other' })],
    [obs({ sourceId: null }), obs({ sourceId: null, sourceUrl: 'https://example.test/a/#x' })],
    [obs({ sourceId: null, sourceUrl: null }), obs({ sourceId: null, sourceUrl: null, title: '  STORY ' })],
    [obs({ sourceId: null, sourceUrl: 'https://a.test/1', title: 'A' }), obs({ sourceId: null, sourceUrl: 'https://a.test/2', title: 'B' })]
  ];
  for (const [a, b] of pairs) {
    const same = deriveIdentity(a).key === deriveIdentity(b).key;
    assert.equal(same, layer1ExactMatch(a, b) === DEDUP_RESULT.DUPLICATE);
  }
});

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

test('identity ladder: SOURCE_ID scoped to feed, then CANONICAL_URL, then TITLE, else null', () => {
  assert.equal(deriveIdentity(obs()).kind, IDENTITY_KIND.SOURCE_ID);
  assert.equal(deriveIdentity(obs()).scope, 'https://feed.test/rss');
  assert.equal(deriveIdentity(obs({ sourceId: null })).kind, IDENTITY_KIND.CANONICAL_URL);
  assert.equal(deriveIdentity(obs({ sourceId: null, sourceUrl: null })).kind, IDENTITY_KIND.TITLE);
  assert.equal(deriveIdentity(obs({ sourceId: null, sourceUrl: null, title: '   ' })), null);
  assert.equal(deriveIdentity(null), null);
});

test('same guid in different feeds is a different identity; unscoped guid is skipped, not global', () => {
  assert.notEqual(deriveIdentity(obs()).key, deriveIdentity(obs({ feedUrl: 'https://feed2.test/rss' })).key);
  const unscoped = deriveIdentity(obs({ feedUrl: undefined }));
  assert.equal(unscoped.kind, IDENTITY_KIND.CANONICAL_URL);
  assert.equal(deriveIdentity(obs({ feedUrl: undefined }), { sourceScope: 'src-1' }).kind, IDENTITY_KIND.SOURCE_ID);
});

test('identity is stable across text drift and never uses similarity', () => {
  assert.equal(deriveIdentity(obs()).key, deriveIdentity(obs({ title: 'Edited', description: 'changed' })).key);
  assert.notEqual(
    deriveIdentity(obs({ sourceId: null, sourceUrl: null, title: 'Openai ships model' })).key,
    deriveIdentity(obs({ sourceId: null, sourceUrl: null, title: 'OpenAI ships a model' })).key
  );
});

// ---------------------------------------------------------------------------
// Config + cooldown boundary (pure)
// ---------------------------------------------------------------------------

test('config/discovery_policy.json carries reconsideration.cooldownHours = 24', () => {
  assert.equal(discoveryPolicy.reconsideration.cooldownHours, 24);
  assert.equal(resolveCooldownMs(discoveryPolicy), 24 * HOUR);
});

test('missing or invalid cooldownHours fails closed with no default', () => {
  for (const p of [undefined, {}, { reconsideration: {} }, { reconsideration: { cooldownHours: '24' } },
    { reconsideration: { cooldownHours: -1 } }, { reconsideration: { cooldownHours: NaN } }]) {
    assert.throws(() => resolveCooldownMs(p), DiscoveryMemoryConfigError);
  }
});

const rowAt = (outcome, evaluatedMs) => ({
  evaluation_outcome: outcome,
  last_evaluated_at: evaluatedMs == null ? null : new Date(evaluatedMs).toISOString()
});
const cooldownMs = 24 * HOUR;

test('24h boundary: just before suppresses, exactly at and after admit', () => {
  const row = rowAt(OUTCOME.SCORED_NOT_SELECTED, T0);
  assert.equal(decideReconsideration(row, { nowMs: T0 + cooldownMs - 1, cooldownMs }).admit, false);
  assert.equal(decideReconsideration(row, { nowMs: T0 + cooldownMs, cooldownMs }).admit, true);
  assert.equal(decideReconsideration(row, { nowMs: T0 + cooldownMs + 1, cooldownMs }).admit, true);
  assert.equal(decideReconsideration(row, { nowMs: T0, cooldownMs }).admit, false);
});

test('NOT_SCORED_UNRESOLVED, NOT_EVALUATED and SELECTED are never suppressed by the cooldown', () => {
  for (const outcome of [OUTCOME.NOT_SCORED_UNRESOLVED, OUTCOME.NOT_EVALUATED, OUTCOME.SELECTED]) {
    for (const nowMs of [T0, T0 + 1, T0 + cooldownMs - 1]) {
      assert.equal(decideReconsideration(rowAt(outcome, T0), { nowMs, cooldownMs }).admit, true, outcome);
    }
  }
  assert.equal(decideReconsideration(undefined, { nowMs: T0, cooldownMs }).admit, true);
});

test('unparseable evaluation time never suppresses', () => {
  const row = { evaluation_outcome: OUTCOME.SCORED_NOT_SELECTED, last_evaluated_at: 'garbage' };
  assert.equal(decideReconsideration(row, { nowMs: T0, cooldownMs }).admit, true);
});

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

test('migration 0015 creates discovery_observations with unique identity_key and CHECKs', async () => {
  const { storage, cleanup } = await freshStorage();
  try {
    const cols = storage.all('PRAGMA table_info(discovery_observations)').map((c) => c.name);
    for (const c of ['id', 'identity_key', 'identity_kind', 'identity_scope', 'identity_value', 'first_seen_at',
      'last_seen_at', 'times_seen', 'last_evaluated_at', 'evaluation_outcome', 'opportunity_id']) {
      assert.ok(cols.includes(c), c);
    }
    assert.ok(!cols.some((c) => /suppress|status/i.test(c)), 'no suppress flag / copied downstream status');
    assert.ok(storage.get("SELECT 1 x FROM schema_migrations WHERE id = '0015_discovery_observations.sql'"));

    const ins = (over = {}) => {
      const r = { id: 'i' + Math.random(), key: 'k1', kind: 'TITLE', outcome: 'NOT_EVALUATED', evalAt: null, ...over };
      storage.run(
        `INSERT INTO discovery_observations (id, identity_key, identity_kind, identity_value, first_seen_at,
           last_seen_at, last_evaluated_at, evaluation_outcome) VALUES (?, ?, ?, 'v', 'a', 'a', ?, ?)`,
        [r.id, r.key, r.kind, r.evalAt, r.outcome]
      );
    };
    ins();
    assert.throws(() => ins(), /UNIQUE/);
    assert.throws(() => ins({ key: 'k2', kind: 'BOGUS' }), /CHECK/);
    assert.throws(() => ins({ key: 'k3', outcome: 'SUPPRESSED' }), /CHECK/);
    assert.throws(() => ins({ key: 'k4', outcome: 'SELECTED', evalAt: null }), /CHECK/);
    ins({ key: 'k5', outcome: 'SELECTED', evalAt: 'x' });
  } finally { cleanup(); }
});

// ---------------------------------------------------------------------------
// prepare / record lifecycle
// ---------------------------------------------------------------------------

const ledger = (storage) => storage.all('SELECT * FROM discovery_observations ORDER BY identity_value');
const clock = (ms) => () => new Date(ms);

test('prepare: new identities admitted and written NOT_EVALUATED; unidentified pass through unrecorded', async () => {
  const { storage, cleanup } = await freshStorage();
  try {
    const a = obs({ sourceId: 'a', title: 'A' });
    const b = obs({ sourceId: 'b', title: 'B' });
    const none = obs({ sourceId: null, sourceUrl: null, title: '' });
    const m = prepareDiscoveryMemory({ storage, observations: [a, none, b], discoveryPolicy, now: clock(T0) });
    assert.deepEqual(m.admitted, [a, none, b]);
    assert.equal(m.summary.unidentified, 1);
    const rows = ledger(storage);
    assert.equal(rows.length, 2);
    assert.ok(rows.every((r) => r.evaluation_outcome === 'NOT_EVALUATED' && r.last_evaluated_at === null && r.times_seen === 1));
  } finally { cleanup(); }
});

test('record: SELECTED / SCORED_NOT_SELECTED / NOT_SCORED_UNRESOLVED classified only from the return value', async () => {
  const { storage, cleanup } = await freshStorage();
  try {
    const sel = obs({ sourceId: 'sel' }), sc = obs({ sourceId: 'sc' }), un = obs({ sourceId: 'un' });
    const m = prepareDiscoveryMemory({ storage, observations: [sel, sc, un], discoveryPolicy, now: clock(T0) });
    // opportunity_id has an FK: create real opportunity rows for the ids we return
    const result = { selected: [{ observation: sel, id: 'opp-sel' }], scoredCandidates: [{ observation: sel, id: 'opp-sel' }, { observation: sc, id: 'opp-sc' }] };
    for (const id of ['opp-sel', 'opp-sc']) {
      storage.run(`INSERT INTO opportunities (id, title, source, source_url, discovered_at, status) VALUES (?, 't', 's', 'u', 'x', 'SCORED')`, [id]);
    }
    const rec = recordDiscoveryOutcomes({ storage, plan: m.plan, discoveryResult: result, now: clock(T0 + 1000) });
    assert.deepEqual(rec.recorded, { SELECTED: 1, SCORED_NOT_SELECTED: 1, NOT_SCORED_UNRESOLVED: 1 });
    const by = Object.fromEntries(ledger(storage).map((r) => [r.identity_value, r]));
    assert.equal(by.sel.evaluation_outcome, 'SELECTED');
    assert.equal(by.sel.opportunity_id, 'opp-sel');
    assert.equal(by.sc.evaluation_outcome, 'SCORED_NOT_SELECTED');
    assert.equal(by.un.evaluation_outcome, 'NOT_SCORED_UNRESOLVED');
    assert.equal(by.un.opportunity_id, null);
    assert.ok(Object.values(by).every((r) => r.last_evaluated_at === new Date(T0 + 1000).toISOString()));
  } finally { cleanup(); }
});

test('cooldown through prepare(): suppressed just before 24h, admitted at exactly 24h and after; suppression only bumps counters', async () => {
  const { storage, cleanup } = await freshStorage();
  try {
    const o = obs({ sourceId: 'x' });
    storage.run(`INSERT INTO opportunities (id, title, source, source_url, discovered_at, status) VALUES ('o1','t','s','u','x','SCORED')`);
    let m = prepareDiscoveryMemory({ storage, observations: [o], discoveryPolicy, now: clock(T0) });
    recordDiscoveryOutcomes({ storage, plan: m.plan, discoveryResult: { selected: [], scoredCandidates: [{ observation: o, id: 'o1' }] }, now: clock(T0) });

    m = prepareDiscoveryMemory({ storage, observations: [o], discoveryPolicy, now: clock(T0 + 24 * HOUR - 1) });
    assert.deepEqual(m.admitted, []);
    let row = ledger(storage)[0];
    assert.equal(row.evaluation_outcome, 'SCORED_NOT_SELECTED');
    assert.equal(row.last_evaluated_at, new Date(T0).toISOString(), 'suppression does not reset the cooldown clock');
    assert.equal(row.times_seen, 2);

    m = prepareDiscoveryMemory({ storage, observations: [o], discoveryPolicy, now: clock(T0 + 24 * HOUR) });
    assert.deepEqual(m.admitted, [o]);
    assert.equal(ledger(storage)[0].evaluation_outcome, 'NOT_EVALUATED');

    // re-evaluated again later: cooldown restarts from the new evaluation time
    recordDiscoveryOutcomes({ storage, plan: m.plan, discoveryResult: { selected: [], scoredCandidates: [{ observation: o, id: 'o1' }] }, now: clock(T0 + 24 * HOUR) });
    m = prepareDiscoveryMemory({ storage, observations: [o], discoveryPolicy, now: clock(T0 + 47 * HOUR) });
    assert.deepEqual(m.admitted, []);
    m = prepareDiscoveryMemory({ storage, observations: [o], discoveryPolicy, now: clock(T0 + 72 * HOUR) });
    assert.deepEqual(m.admitted, [o]);
  } finally { cleanup(); }
});

test('NOT_SCORED_UNRESOLVED and NOT_EVALUATED rows are re-admitted on the very next run', async () => {
  const { storage, cleanup } = await freshStorage();
  try {
    const o = obs({ sourceId: 'u' });
    let m = prepareDiscoveryMemory({ storage, observations: [o], discoveryPolicy, now: clock(T0) });
    // Discovery "did not complete": no record call. Row stays NOT_EVALUATED.
    m = prepareDiscoveryMemory({ storage, observations: [o], discoveryPolicy, now: clock(T0 + 1) });
    assert.deepEqual(m.admitted, [o]);
    assert.equal(ledger(storage)[0].evaluation_outcome, 'NOT_EVALUATED');
    recordDiscoveryOutcomes({ storage, plan: m.plan, discoveryResult: { selected: [], scoredCandidates: [] }, now: clock(T0 + 2) });
    assert.equal(ledger(storage)[0].evaluation_outcome, 'NOT_SCORED_UNRESOLVED');
    m = prepareDiscoveryMemory({ storage, observations: [o], discoveryPolicy, now: clock(T0 + 3) });
    assert.deepEqual(m.admitted, [o]);
    assert.equal(ledger(storage)[0].times_seen, 3);
  } finally { cleanup(); }
});

test('SELECTED is sticky: a later pass never converts it to SCORED_NOT_SELECTED or UNRESOLVED', async () => {
  const { storage, cleanup } = await freshStorage();
  try {
    const o = obs({ sourceId: 's' });
    storage.run(`INSERT INTO opportunities (id, title, source, source_url, discovered_at, status) VALUES ('o1','t','s','u','x','SCORED')`);
    let m = prepareDiscoveryMemory({ storage, observations: [o], discoveryPolicy, now: clock(T0) });
    recordDiscoveryOutcomes({ storage, plan: m.plan, discoveryResult: { selected: [{ observation: o, id: 'o1' }], scoredCandidates: [{ observation: o, id: 'o1' }] }, now: clock(T0) });

    m = prepareDiscoveryMemory({ storage, observations: [o], discoveryPolicy, now: clock(T0 + HOUR) });
    assert.equal(ledger(storage)[0].evaluation_outcome, 'SELECTED', 'prepare must not downgrade SELECTED');
    recordDiscoveryOutcomes({ storage, plan: m.plan, discoveryResult: { selected: [], scoredCandidates: [{ observation: o, id: 'o1' }] }, now: clock(T0 + HOUR) });
    const row = ledger(storage)[0];
    assert.equal(row.evaluation_outcome, 'SELECTED');
    assert.equal(row.opportunity_id, 'o1');
  } finally { cleanup(); }
});

test('duplicates of one identity in a batch count once for times_seen and share one outcome', async () => {
  const { storage, cleanup } = await freshStorage();
  try {
    const a1 = obs({ sourceId: 'd', title: 'One' }), a2 = obs({ sourceId: 'd', title: 'Two' });
    const m = prepareDiscoveryMemory({ storage, observations: [a1, a2], discoveryPolicy, now: clock(T0) });
    assert.equal(ledger(storage).length, 1);
    assert.equal(ledger(storage)[0].times_seen, 1);
    storage.run(`INSERT INTO opportunities (id, title, source, source_url, discovered_at, status) VALUES ('o2','t','s','u','x','SCORED')`);
    recordDiscoveryOutcomes({ storage, plan: m.plan, discoveryResult: { selected: [], scoredCandidates: [{ observation: a2, id: 'o2' }] }, now: clock(T0) });
    assert.equal(ledger(storage)[0].evaluation_outcome, 'SCORED_NOT_SELECTED');
  } finally { cleanup(); }
});

// ---------------------------------------------------------------------------
// Fail-closed behaviour
// ---------------------------------------------------------------------------

test('ledger read failure fails closed (nothing admitted, nothing written)', async () => {
  const { storage, cleanup } = await freshStorage();
  try {
    const broken = { all() { throw new Error('disk gone'); }, run() { throw new Error('should not write'); }, transaction() { throw new Error('should not write'); } };
    assert.throws(() => prepareDiscoveryMemory({ storage: broken, observations: [obs()], discoveryPolicy }), DiscoveryMemoryReadError);
  } finally { cleanup(); }
});

test('pre-Discovery ledger write failure fails closed', async () => {
  const { storage, cleanup } = await freshStorage();
  try {
    const wrapped = { all: (...a) => storage.all(...a), run: (...a) => storage.run(...a), transaction: () => { throw new Error('write denied'); } };
    assert.throws(() => prepareDiscoveryMemory({ storage: wrapped, observations: [obs()], discoveryPolicy }), DiscoveryMemoryWriteError);
  } finally { cleanup(); }
});

test('outcome write failure fails closed and rolls back the whole batch', async () => {
  const { storage, cleanup } = await freshStorage();
  try {
    const a = obs({ sourceId: 'a' }), b = obs({ sourceId: 'b' });
    const m = prepareDiscoveryMemory({ storage, observations: [a, b], discoveryPolicy, now: clock(T0) });
    storage.run(`INSERT INTO opportunities (id, title, source, source_url, discovered_at, status) VALUES ('oa','t','s','u','x','SCORED')`);
    // second group references a non-existent opportunity -> FK violation mid-transaction
    const result = { selected: [], scoredCandidates: [{ observation: a, id: 'oa' }, { observation: b, id: 'missing' }] };
    assert.throws(() => recordDiscoveryOutcomes({ storage, plan: m.plan, discoveryResult: result, now: clock(T0) }), DiscoveryMemoryWriteError);
    assert.ok(ledger(storage).every((r) => r.evaluation_outcome === 'NOT_EVALUATED'), 'partial outcomes rolled back');
  } finally { cleanup(); }
});

test('malformed discovery result records nothing', async () => {
  const { storage, cleanup } = await freshStorage();
  try {
    const m = prepareDiscoveryMemory({ storage, observations: [obs()], discoveryPolicy, now: clock(T0) });
    assert.throws(() => recordDiscoveryOutcomes({ storage, plan: m.plan, discoveryResult: {} }), DiscoveryMemoryWriteError);
    assert.equal(ledger(storage)[0].evaluation_outcome, 'NOT_EVALUATED');
  } finally { cleanup(); }
});

test('empty observation list is a no-op', async () => {
  const { storage, cleanup } = await freshStorage();
  try {
    const m = prepareDiscoveryMemory({ storage, observations: [], discoveryPolicy });
    assert.deepEqual(m.admitted, []);
    assert.equal(ledger(storage).length, 0);
  } finally { cleanup(); }
});
