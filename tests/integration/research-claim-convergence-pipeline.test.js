import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { SqliteStorageDriver } from '../../src/storage/SqliteStorageDriver.js';
import { LLMRouter } from '../../src/providers/llm/router.js';
import { ResearchSourceProvider } from '../../src/research/ResearchSourceProvider.js';
import { runResearchProject } from '../../src/research/pipeline.js';
import researchPolicy from '../../config/research_policy.json' with { type: 'json' };

// Convergence safety pipeline tests. Local + deterministic: temp SQLite DB,
// stub source provider, stub LLM router, injected fetch. No network, no real API.

function freshStorage() {
  const dbPath = path.join(os.tmpdir(), `claim-convergence-${Date.now()}-${Math.random()}.db`);
  return { storage: new SqliteStorageDriver({ dbPath }), dbPath };
}
function cleanup(storage, dbPath) {
  storage.close();
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(`${dbPath}${suffix}`, { force: true });
}
function seedOpportunity(storage) {
  const id = crypto.randomUUID();
  const proposition = {
    subject: 's', target_audience: 'a', audience_problem: 'p', core_question: 'Who won the final in 2026?',
    gap: 'g', angle: 'a', differentiation: 'd', commercial_relevance: 'c', core_question_type: 'FACTUAL'
  };
  storage.run(
    `INSERT INTO opportunities (id, title, source, discovered_at, status, opportunity_proposition)
     VALUES (?, 'Test opportunity', 'rss', ?, 'HANDED_TO_RESEARCH', ?)`,
    [id, new Date().toISOString(), JSON.stringify(proposition)]
  );
  return id;
}
class UrlListProvider extends ResearchSourceProvider {
  constructor(urls) { super(); this.urls = urls; }
  get id() { return 'url-list-stub'; }
  async healthCheck() { return true; }
  async discoverCandidates() { return { candidates: this.urls.map((url, i) => ({ url, title: `t${i}`, snippet: 's' })) }; }
}
const marker = (url) => `MARK_${url.replace(/\W/g, '_')}`;
// `bodies[url]` is the source wording the claims are extracted from.
function fakeFetch(bodies) {
  return async (url) => ({
    ok: true, status: 200, headers: { get: () => 'text/html' },
    text: async () => `<html><body><p>${marker(url)} independent report covering the final in some detail.</p><p>${bodies[url] ?? ''}</p></body></html>`
  });
}
function routerFor(claimsByUrl) {
  const registry = {
    'conv-stub': () => ({
      id: 'conv-stub', isPaid: false,
      async healthCheck() { return true; },
      async complete({ prompt }) {
        const url = Object.keys(claimsByUrl).find((u) => prompt.includes(marker(u)));
        return { text: JSON.stringify(url ? claimsByUrl[url] : []), model: 'conv-stub', requestId: null, inputTokens: 1, outputTokens: 1, estimatedCost: 0, isPaid: false };
      }
    })
  };
  return new LLMRouter({ priority: ['conv-stub'], allowPaidProviders: false, registry });
}
async function run(claimsByUrl, { bodies = {}, detectContradiction = null } = {}) {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  const result = await runResearchProject({
    storage, opportunityId: seedOpportunity(storage), sourceProvider: new UrlListProvider(Object.keys(claimsByUrl)),
    llmRouter: routerFor(claimsByUrl), policy: researchPolicy, fetchImpl: fakeFetch(bodies), detectContradiction
  });
  return { storage, dbPath, result };
}

const A = 'https://publisher-one.com/story';
const B = 'https://publisher-two.org/story';
const C = 'https://publisher-three.net/story';
const A2 = 'https://publisher-one.com/other-story'; // same registrable domain as A

const ident = (over = {}) => ({
  subject: 'Spain', predicate: 'win', object: 'the final', qualifiers: [], time: '2026', quantity: null, unit: null,
  polarity: 'AFFIRMED', modality: 'OCCURRED', relation: 'DESCRIPTIVE', ...over
});
const fact = (claim, identity, extra = {}) => ({ claim, claim_type: 'FACT', is_load_bearing: true, identity, ...extra });
const sourceIdsOf = (storage, claimId) => [...new Set(storage.all('SELECT source_id FROM claim_sources WHERE claim_id = ?', [claimId]).map((r) => r.source_id))];
const decisions = (storage, name) => storage.all('SELECT * FROM decision_log WHERE decision = ?', [name]);
const snap = (row) => JSON.parse(row.config_snapshot);

// ---------------- Tests 1-4: entity variants stay separate end-to-end ----------------

const VARIANTS = [
  ['Test 1. non-sporting win (WTO dispute)', 'Spain won the WTO trade dispute in 2026.', 'Spain national football team won the WTO trade dispute in 2026.', 'the WTO trade dispute', 'Spain national football team'],
  ['Test 2. youth team', 'Spain youth team won the final in 2026.', 'Spain national football team won the final in 2026.', 'the final', null, 'Spain youth team'],
  ['Test 3. women\'s team', 'Spain women\'s national football team won the final in 2026.', 'Spain national football team won the final in 2026.', 'the final', null, 'Spain women\'s national football team'],
  ['Test 4. U21', 'Spain U21 won the final in 2026.', 'Spain national football team won the final in 2026.', 'the final', null, 'Spain U21']
];
for (const [name, textA, textB, object, subjB, subjA] of VARIANTS) {
  test(`${name}: entity variants never converge and never corroborate each other`, async () => {
    const { storage, dbPath, result } = await run({
      [A]: [fact(textA, ident({ subject: subjA ?? 'Spain', object }))],
      [B]: [fact(textB, ident({ subject: subjB ?? 'Spain national football team', object }))]
    }, { bodies: { [A]: textA, [B]: textB } });
    try {
      assert.equal(result.claims.length, 2);
      assert.equal(result.convergence.promoted, 0);
      assert.equal(decisions(storage, 'MERGED_BY_CONVERGENCE').length, 0);
      assert.equal(decisions(storage, 'MERGED_BY_IDENTITY').length, 0);
      for (const c of result.claims) {
        assert.equal(sourceIdsOf(storage, c.id).length, 1);
        assert.notEqual(c.evidence_status, 'VERIFIED');
      }
    } finally { cleanup(storage, dbPath); }
  });
}

// ---------------- Test 8: rejected normalization identity must not bridge ----------------

test('Test 8. identity derived from a REJECTED rewrite is discarded and cannot corroborate another source', async () => {
  const srcA = 'Spain beat Argentina. They won the final in 2026.';
  const srcB = 'Spain won the final in 2026.';
  const { storage, dbPath, result } = await run({
    [A]: [fact('Spain won the final in 2026.', ident(), { original_claim: 'They won the final in 2026.' })],
    [B]: [fact('Spain won the final in 2026.', ident())]
  }, { bodies: { [A]: srcA, [B]: srcB } });
  try {
    // A's claim keeps the ORIGINAL vague wording; it did not merge with B via the rewrite's identity.
    assert.equal(result.claims.length, 2);
    const texts = result.claims.map((c) => c.claim).sort();
    assert.deepEqual(texts, ['Spain won the final in 2026.', 'They won the final in 2026.']);
    assert.equal(decisions(storage, 'MERGED_BY_IDENTITY').length, 0);
    assert.equal(decisions(storage, 'MERGED_BY_CONVERGENCE').length, 0);
    for (const c of result.claims) assert.equal(sourceIdsOf(storage, c.id).length, 1);
    assert.ok(result.claims.every((c) => c.evidence_status !== 'VERIFIED'));
    const rej = decisions(storage, 'NORMALIZATION_REJECTED');
    assert.equal(rej.length, 1);
    const s = snap(rej[0]);
    assert.equal(s.identityDiscarded, true);
    assert.equal(s.convergenceTrusted, false);
    assert.equal(s.originalClaim, 'They won the final in 2026.');
    assert.equal(s.proposedClaim, 'Spain won the final in 2026.');
    assert.equal(s.finalClaim, 'They won the final in 2026.');
  } finally { cleanup(storage, dbPath); }
});

// ---------------- Test 7: missing original_claim ----------------

test('Test 7. rewritten claim without original_claim persists but is skipped by convergence (and the run does not fail)', async () => {
  const { storage, dbPath, result } = await run({
    // claim is NOT verbatim in the source and has no original_claim
    [A]: [fact('Spain lifted the 2026 trophy.', ident({ predicate: 'lift', object: 'the 2026 trophy' }))],
    [B]: [fact('Spain won the final in 2026.', ident())]
  }, { bodies: { [A]: 'Spain won. They lifted the 2026 trophy.', [B]: 'Spain won the final in 2026.' } });
  try {
    assert.equal(result.claims.length, 2);
    assert.equal(result.convergence.skipped, 1);
    assert.equal(result.convergence.eligible, 1);
    const skipped = decisions(storage, 'CONVERGENCE_SKIPPED');
    assert.equal(skipped.length, 1);
    assert.match(skipped[0].reason, /^normalization_not_trusted:UNVERIFIED_ORIGIN:original_claim_missing_and_claim_not_verbatim/);
    assert.equal(decisions(storage, 'NORMALIZATION_UNVERIFIED').length, 1);
  } finally { cleanup(storage, dbPath); }
});

// ---------------- Test 9: provenance ----------------

test('Test 9. accepted normalization keeps original wording, normalized wording, source and decision', async () => {
  const { storage, dbPath, result } = await run({
    [A]: [fact('Spain lifted the trophy in 2026.', ident({ predicate: 'lift', object: 'the trophy' }), { original_claim: 'They lifted the trophy in 2026.' })]
  }, { bodies: { [A]: 'Spain won. They lifted the trophy in 2026.' } });
  try {
    assert.equal(result.claims.length, 1);
    assert.equal(result.claims[0].claim, 'Spain lifted the trophy in 2026.');
    const acc = decisions(storage, 'NORMALIZATION_ACCEPTED');
    assert.equal(acc.length, 1);
    assert.equal(acc[0].reason, 'mechanical_antecedent_substitution');
    assert.equal(acc[0].subject_id, result.claims[0].id);
    const s = snap(acc[0]);
    assert.equal(s.originalClaim, 'They lifted the trophy in 2026.');
    assert.equal(s.proposedClaim, 'Spain lifted the trophy in 2026.');
    assert.equal(s.finalClaim, 'Spain lifted the trophy in 2026.');
    assert.equal(s.sourceUrl, A);
    assert.equal(s.status, 'NORMALIZED');
    assert.equal(s.convergenceTrusted, true);
    assert.equal(storage.get('SELECT url FROM sources WHERE id = ?', [s.sourceId]).url, A);
  } finally { cleanup(storage, dbPath); }
});

// ---------------- Tests 10-12: existing exact identity + evidence model unchanged ----------------

test('Tests 10/11. exact identity still merges differently-worded claims; two independent domains reach VERIFIED via the existing evidence system', async () => {
  const { storage, dbPath, result } = await run({
    [A]: [fact('Spain won the final in 2026.', ident())],
    [B]: [fact('The final in 2026 was won by Spain.', ident())]
  }, { bodies: { [A]: 'Spain won the final in 2026.', [B]: 'The final in 2026 was won by Spain.' } });
  try {
    assert.equal(result.claims.length, 1);
    assert.equal(decisions(storage, 'MERGED_BY_IDENTITY').length, 1);
    assert.equal(decisions(storage, 'MERGED_BY_CONVERGENCE').length, 0);
    assert.equal(sourceIdsOf(storage, result.claims[0].id).length, 2);
    assert.equal(result.claims[0].evidence_status, 'VERIFIED');
  } finally { cleanup(storage, dbPath); }
});

test('Test 12. two sources on ONE registrable domain share a claim but are NOT independent corroboration', async () => {
  const { storage, dbPath, result } = await run({
    [A]: [fact('Spain won the final in 2026.', ident())],
    [A2]: [fact('The final in 2026 was won by Spain.', ident())]
  }, { bodies: { [A]: 'Spain won the final in 2026.', [A2]: 'The final in 2026 was won by Spain.' } });
  try {
    assert.equal(result.claims.length, 1);
    assert.equal(sourceIdsOf(storage, result.claims[0].id).length, 2);
    assert.equal(result.claims[0].evidence_status, 'PARTIALLY_SUPPORTED');
  } finally { cleanup(storage, dbPath); }
});

// ---------------- retained behaviours ----------------

test('G2. a CANDIDATE_SAME_FACT that is not fully exact stays separate and never reaches VERIFIED', async () => {
  const { storage, dbPath, result } = await run({
    [A]: [fact('Spain won the final in 2026 after extra time.', ident({ qualifiers: ['extra time'] }))],
    [B]: [fact('Spain won the final in 2026 on penalties.', ident({ qualifiers: ['penalties'] }))]
  }, { bodies: { [A]: 'Spain won the final in 2026 after extra time.', [B]: 'Spain won the final in 2026 on penalties.' } });
  try {
    assert.equal(result.claims.length, 2);
    assert.equal(result.convergence.candidates, 1);
    assert.equal(result.convergence.promoted, 0);
    assert.equal(decisions(storage, 'CANDIDATE_SAME_FACT')[0].reason, 'not_promoted_fields_not_deterministic');
    assert.ok(result.claims.every((c) => c.evidence_status === 'PARTIALLY_SUPPORTED'));
  } finally { cleanup(storage, dbPath); }
});

test('B/C/D. predicate, year and quantity differences never converge', async () => {
  const pred = await run({
    [A]: [fact('Spain won the final in 2026.', ident())],
    [B]: [fact('Argentina lost the final in 2026.', ident({ subject: 'Argentina', predicate: 'lose' }))]
  }, { bodies: { [A]: 'Spain won the final in 2026.', [B]: 'Argentina lost the final in 2026.' } });
  try { assert.equal(pred.result.claims.length, 2); assert.equal(pred.result.convergence.candidates, 0); } finally { cleanup(pred.storage, pred.dbPath); }
  const q = (n) => ident({ predicate: 'score', object: null, quantity: n, unit: 'goals' });
  const qty = await run({
    [A]: [fact('Spain scored 2 goals in the final in 2026.', q(2))],
    [B]: [fact('Spain scored 3 goals in the final in 2026.', q(3))]
  }, { bodies: { [A]: 'Spain scored 2 goals in the final in 2026.', [B]: 'Spain scored 3 goals in the final in 2026.' } });
  try { assert.equal(qty.result.claims.length, 2); assert.equal(qty.result.convergence.promoted, 0); } finally { cleanup(qty.storage, qty.dbPath); }
});

test('H. contradiction isolation: the existing detector still contests claims; convergence suppresses nothing', async () => {
  const detectContradiction = async () => 'CONTRADICTS';
  const { storage, dbPath, result } = await run({
    [A]: [fact('Spain won the final in 2026.', ident())],
    [B]: [fact('The final in 2026 was won by Spain.', ident())],
    [C]: [fact('Argentina won the final in 2026.', ident({ subject: 'Argentina' }))]
  }, { detectContradiction, bodies: { [A]: 'Spain won the final in 2026.', [B]: 'The final in 2026 was won by Spain.', [C]: 'Argentina won the final in 2026.' } });
  try {
    assert.equal(result.claims.length, 2);
    assert.equal(storage.all('SELECT * FROM claim_relations').length, 1);
    assert.ok(result.claims.every((c) => c.evidence_status === 'CONTESTED'));
  } finally { cleanup(storage, dbPath); }
});

// ---------------- Identity-index trust gate ----------------
// A claim may query or populate claimIdentityIndex only when its normalization
// exists and is convergenceTrusted (UNCHANGED / NORMALIZED). A claim whose text is
// not in its source body is UNVERIFIED_ORIGIN and must neither join nor seed an
// identity merge, in either arrival order.

const W1 = 'Spain won the final in 2026.';
const W2 = 'The final in 2026 was won by Spain.';
const W3 = 'Spain were the winners of the final in 2026.'; // same ident(), different wording than W1/W2
const unverified = (storage) => decisions(storage, 'NORMALIZATION_UNVERIFIED');
const claimOf = (result, text) => result.claims.find((c) => c.claim === text);

test('Gate 1. trusted verbatim claims with differing wording still merge by identity', async () => {
  const { storage, dbPath, result } = await run({
    [A]: [fact(W1, ident())], [B]: [fact(W2, ident())]
  }, { bodies: { [A]: W1, [B]: W2 } });
  try {
    assert.equal(result.claims.length, 1);
    assert.equal(decisions(storage, 'MERGED_BY_IDENTITY').length, 1);
    assert.equal(unverified(storage).length, 0);
    assert.equal(sourceIdsOf(storage, result.claims[0].id).length, 2);
  } finally { cleanup(storage, dbPath); }
});

test('Gate 2. accepted normalization (NORMALIZED) still merges with a trusted verbatim peer', async () => {
  const { storage, dbPath, result } = await run({
    [A]: [fact(W1, ident(), { original_claim: 'They won the final in 2026.' })],
    [B]: [fact(W2, ident())]
  }, { bodies: { [A]: 'Spain won. They won the final in 2026.', [B]: W2 } });
  try {
    assert.equal(decisions(storage, 'NORMALIZATION_ACCEPTED').length, 1);
    assert.equal(result.claims.length, 1);
    assert.equal(decisions(storage, 'MERGED_BY_IDENTITY').length, 1);
    assert.equal(sourceIdsOf(storage, result.claims[0].id).length, 2);
  } finally { cleanup(storage, dbPath); }
});

test('Gate 3. UNVERIFIED_ORIGIN claims with matching identity and different wording never merge by identity', async () => {
  // Same fixtures as Gate 1 but neither source body contains its claim -> UNVERIFIED_ORIGIN.
  const { storage, dbPath, result } = await run({
    [A]: [fact(W1, ident())], [B]: [fact(W2, ident())]
  });
  try {
    assert.equal(unverified(storage).length, 2);
    assert.equal(result.claims.length, 2);
    assert.equal(decisions(storage, 'MERGED_BY_IDENTITY').length, 0);
    for (const c of result.claims) assert.equal(sourceIdsOf(storage, c.id).length, 1);
  } finally { cleanup(storage, dbPath); }
});

test('Gate 4. untrusted-first: an untrusted claim cannot seed the index; trusted peers still merge with each other', async () => {
  const { storage, dbPath, result } = await run({
    [A]: [fact(W3, ident())],   // UNVERIFIED_ORIGIN (not in its body), arrives first
    [B]: [fact(W1, ident())],   // trusted
    [C]: [fact(W2, ident())]    // trusted
  }, { bodies: { [B]: W1, [C]: W2 } });
  try {
    assert.equal(unverified(storage).length, 1);
    assert.equal(result.claims.length, 2);
    assert.equal(result.claims[0].claim, W3, 'untrusted claim was persisted first');
    const untrusted = claimOf(result, W3);
    const trusted = claimOf(result, W1);
    assert.equal(sourceIdsOf(storage, untrusted.id).length, 1);
    assert.equal(sourceIdsOf(storage, trusted.id).length, 2);
    const merged = decisions(storage, 'MERGED_BY_IDENTITY');
    assert.equal(merged.length, 1);
    assert.equal(merged[0].subject_id, trusted.id);
  } finally { cleanup(storage, dbPath); }
});

test('Gate 5. trusted-first: a trusted claim cannot absorb a later untrusted claim', async () => {
  const { storage, dbPath, result } = await run({
    [A]: [fact(W1, ident())],   // trusted, arrives first
    [B]: [fact(W3, ident())]    // UNVERIFIED_ORIGIN (not in its body)
  }, { bodies: { [A]: W1 } });
  try {
    assert.equal(unverified(storage).length, 1);
    assert.equal(result.claims.length, 2);
    assert.equal(decisions(storage, 'MERGED_BY_IDENTITY').length, 0);
    for (const c of result.claims) assert.equal(sourceIdsOf(storage, c.id).length, 1);
  } finally { cleanup(storage, dbPath); }
});

test('Gate 7. exact-text merging is unchanged: identical text still merges even when UNVERIFIED_ORIGIN', async () => {
  const { storage, dbPath, result } = await run({
    [A]: [fact(W1, ident())], [B]: [fact(W1, ident())]
  });
  try {
    assert.equal(unverified(storage).length, 2);
    assert.equal(result.claims.length, 1);
    assert.equal(decisions(storage, 'MERGED_BY_IDENTITY').length, 0);
    assert.equal(sourceIdsOf(storage, result.claims[0].id).length, 2);
  } finally { cleanup(storage, dbPath); }
});
