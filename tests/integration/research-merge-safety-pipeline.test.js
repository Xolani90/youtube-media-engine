// Merge-safety regression tests: unsupported structured identity must not seed/absorb a fingerprint
// merge, and identical wording alone must never create corroborating evidence across sources.
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
import { deriveClaimIdentity } from '../../src/research/claimIdentity.js';
import researchPolicy from '../../config/research_policy.json' with { type: 'json' };


function freshStorage() {
  const dbPath = path.join(os.tmpdir(), `merge-safety-${Date.now()}-${Math.random()}.db`);
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
const SA = 'https://news.example.com/story-a'; // same registrable domain as SB
const SB = 'https://sport.example.com/story-b';

const ident = (over = {}) => ({
  subject: 'Argentina', predicate: 'win', object: 'the tournament', qualifiers: [], time: null, quantity: null, unit: null,
  polarity: 'AFFIRMED', modality: 'OCCURRED', relation: 'DESCRIPTIVE', ...over
});
const fact = (claim, identity, extra = {}) => ({ claim, claim_type: 'FACT', is_load_bearing: true, identity, ...extra });
const linksOf = (storage, claimId) => storage.all('SELECT source_id, role FROM claim_sources WHERE claim_id = ?', [claimId]);
const decisions = (storage, name) => storage.all('SELECT * FROM decision_log WHERE decision = ?', [name]);
const verified = (result) => result.claims.filter((c) => c.evidence_status === 'VERIFIED');
const onlyOwnSource = (storage, result) => { for (const c of result.claims) assert.equal(linksOf(storage, c.id).length, 1); };
const bothBodies = (a, b, textA, textB = textA) => ({ bodies: { [a]: textA, [b]: textB } });

// ---------- Part 1: identity grounding (unit level, real deriveClaimIdentity) ----------
const derive = (claim, identity) => deriveClaimIdentity({ claim, claim_type: 'FACT', is_load_bearing: true, identity });

test('Test 1 (unit). unsupported subject: no fingerprint', () => {
  const r = derive('Antoine Griezmann scored twice.', ident({ subject: 'Kylian Mbappé', predicate: 'score', object: null }));
  assert.equal(r.fingerprint, null);
  assert.equal(r.reason, 'subject_not_grounded');
});
test('Test 2 (unit). unsupported object/time: fingerprint rejected', () => {
  const r = derive('Argentina are the world champions.', ident({ object: 'FIFA World Cup', time: '2022' }));
  assert.equal(r.fingerprint, null);
  assert.equal(r.reason, 'object_not_grounded');
});
test('Test 3 (unit). structured year absent from the text: fingerprint rejected', () => {
  const r = derive('Argentina won the tournament.', ident({ time: '2022' }));
  assert.equal(r.fingerprint, null);
  assert.equal(r.reason, 'time_year_not_grounded');
});
test('Test 3b (unit). qualifier absent from the text: fingerprint rejected', () => {
  const r = derive('Argentina won the tournament.', ident({ qualifiers: ['on penalties'] }));
  assert.equal(r.reason, 'qualifier_not_grounded');
});
test('Test 4 (unit). safe explicit claim gets a fingerprint; predicate rewording stays free', () => {
  const full = ident({ object: 'FIFA World Cup', time: '2022' });
  const r = derive('Argentina won the 2022 FIFA World Cup.', full);
  assert.match(r.fingerprint, /^[0-9a-f]{64}$/);
  // the predicate is deliberately not token-grounded: a reworded verb keeps the same fingerprint
  assert.equal(derive('Argentina captured the 2022 FIFA World Cup title.', full).fingerprint, r.fingerprint);
});

// ---------- Part 1 end-to-end ----------
test('Test 1. unsupported subject cannot be absorbed by an explicit claim: separate rows, nothing VERIFIED', async () => {
  const mb = ident({ subject: 'Kylian Mbappé', predicate: 'score', object: null });
  const { storage, dbPath, result } = await run({
    [A]: [fact('Antoine Griezmann scored twice.', mb)],
    [B]: [fact('Kylian Mbappé scored twice.', mb)]
  }, { bodies: { [A]: 'Antoine Griezmann scored twice.', [B]: 'Kylian Mbappé scored twice.' } });
  try {
    assert.equal(result.claims.length, 2);
    assert.equal(decisions(storage, 'MERGED_BY_IDENTITY').length, 0);
    assert.equal(decisions(storage, 'MERGED_BY_CONVERGENCE').length, 0);
    onlyOwnSource(storage, result);
    assert.equal(verified(result).length, 0);
  } finally { cleanup(storage, dbPath); }
});

test('Test 2. unsupported object/time cannot merge with a grounded explicit claim', async () => {
  const wc = ident({ object: 'FIFA World Cup', time: '2022' });
  const { storage, dbPath, result } = await run({
    [A]: [fact('Argentina are the world champions.', wc)],
    [B]: [fact('Argentina won the 2022 FIFA World Cup.', wc)]
  }, { bodies: { [A]: 'Argentina are the world champions.', [B]: 'Argentina won the 2022 FIFA World Cup.' } });
  try {
    assert.equal(result.claims.length, 2);
    assert.equal(decisions(storage, 'MERGED_BY_IDENTITY').length, 0);
    onlyOwnSource(storage, result);
    assert.equal(verified(result).length, 0);
  } finally { cleanup(storage, dbPath); }
});

test('Test 5. safe deterministic "They" normalization is still accepted and its grounded identity merges', async () => {
  const { storage, dbPath, result } = await run({
    [A]: [fact('Spain won the final in 2026.', ident({ subject: 'Spain', object: 'the final', time: '2026' }), { original_claim: 'They won the final in 2026.' })],
    [B]: [fact('The final in 2026 was won by Spain.', ident({ subject: 'Spain', object: 'the final', time: '2026' }))]
  }, { bodies: { [A]: 'Spain won. They won the final in 2026.', [B]: 'The final in 2026 was won by Spain.' } });
  try {
    assert.equal(decisions(storage, 'NORMALIZATION_ACCEPTED').length, 1);
    assert.equal(result.claims.length, 1);
    assert.equal(decisions(storage, 'MERGED_BY_IDENTITY').length, 1);
    assert.equal(linksOf(storage, result.claims[0].id).length, 2);
    assert.equal(result.claims[0].evidence_status, 'VERIFIED');
  } finally { cleanup(storage, dbPath); }
});

test('Test 6. reworded grounded facts still converge and can be VERIFIED by two independent domains', async () => {
  const { storage, dbPath, result } = await run({
    [A]: [fact('Argentina won the tournament.', ident())],
    [B]: [fact('Argentina captured the tournament title.', ident())]
  }, { bodies: { [A]: 'Argentina won the tournament.', [B]: 'Argentina captured the tournament title.' } });
  try {
    assert.equal(result.claims.length, 1);
    assert.equal(decisions(storage, 'MERGED_BY_IDENTITY').length, 1);
    assert.deepEqual(linksOf(storage, result.claims[0].id).map((l) => l.role).sort(), ['corroborating', 'primary']);
    assert.equal(result.claims[0].evidence_status, 'VERIFIED');
  } finally { cleanup(storage, dbPath); }
});

// ---------- Part 2: exact text is not evidence ----------
test('Test 7. same wording, different referents: no corroboration from wording alone', async () => {
  const { storage, dbPath, result } = await run({
    [A]: [fact('They won the tournament.', ident({ subject: 'Argentina' }))],
    [B]: [fact('They won the tournament.', ident({ subject: 'France' }))]
  }, bothBodies(A, B, 'They won the tournament.'));
  try {
    assert.equal(result.claims.length, 2);
    onlyOwnSource(storage, result);
    assert.equal(verified(result).length, 0);
    assert.equal(decisions(storage, 'EXACT_TEXT_REJECTED').length, 1);
    assert.equal(decisions(storage, 'MERGED_BY_IDENTITY').length, 0);
  } finally { cleanup(storage, dbPath); }
});

test('Test 8. same wording, disagreeing grounded identities: exact text does not override; both rows reach contradiction analysis', async () => {
  const seen = [];
  const detectContradiction = async (a, b) => { seen.push([a.id, b.id].sort()); return 'CONTRADICTS'; };
  const { storage, dbPath, result } = await run({
    [A]: [fact('Argentina won the final.', ident({ object: 'the final', predicate: 'win' }))],
    [B]: [fact('Argentina won the final.', ident({ object: 'the final', predicate: 'reach' }))]
  }, { ...bothBodies(A, B, 'Argentina won the final.'), detectContradiction });
  try {
    assert.equal(result.claims.length, 2);
    onlyOwnSource(storage, result);
    assert.equal(decisions(storage, 'EXACT_TEXT_REJECTED').length, 1);
    assert.equal(seen.length, 1);
    assert.deepEqual(seen[0], result.claims.map((c) => c.id).sort());
    assert.equal(verified(result).length, 0);
  } finally { cleanup(storage, dbPath); }
});

test('Test 9. same wording, FACT vs OPINION: the opinion never corroborates the fact row', async () => {
  const { storage, dbPath, result } = await run({
    [A]: [fact('Argentina won the final.', ident({ object: 'the final' }))],
    [B]: [{ claim: 'Argentina won the final.', claim_type: 'OPINION', is_load_bearing: false, identity: null }]
  }, bothBodies(A, B, 'Argentina won the final.'));
  try {
    assert.equal(result.claims.length, 2);
    onlyOwnSource(storage, result);
    assert.equal(verified(result).length, 0);
  } finally { cleanup(storage, dbPath); }
});

test('Test 10. same registrable domain: duplicate wording cannot make independent VERIFIED evidence', async () => {
  const withId = await run({
    [SA]: [fact('Argentina won the tournament.', ident())],
    [SB]: [fact('Argentina captured the tournament title.', ident())]
  }, { bodies: { [SA]: 'Argentina won the tournament.', [SB]: 'Argentina captured the tournament title.' } });
  try {
    assert.equal(verified(withId.result).length, 0);
  } finally { cleanup(withId.storage, withId.dbPath); }
  const textOnly = await run({
    [SA]: [fact('Argentina won the tournament.', null)], [SB]: [fact('Argentina won the tournament.', null)]
  }, bothBodies(SA, SB, 'Argentina won the tournament.'));
  try {
    assert.equal(textOnly.result.claims.length, 2);
    assert.equal(verified(textOnly.result).length, 0);
  } finally { cleanup(textOnly.storage, textOnly.dbPath); }
});

test('Test 11. UNVERIFIED_ORIGIN identity cannot seed or absorb an identity merge', async () => {
  const { storage, dbPath, result } = await run({
    [A]: [fact('Argentina won the tournament.', ident())],
    [B]: [fact('Argentina captured the tournament title.', ident())]
  });
  try {
    assert.equal(result.claims.length, 2);
    assert.equal(decisions(storage, 'MERGED_BY_IDENTITY').length, 0);
    assert.equal(decisions(storage, 'NORMALIZATION_UNVERIFIED').length, 2);
    assert.equal(verified(result).length, 0);
  } finally { cleanup(storage, dbPath); }
});

test('Test 12. same source repeating a claim is deduplicated, not counted as corroboration', async () => {
  const { storage, dbPath, result } = await run({
    [A]: [fact('Argentina won the tournament.', ident()), fact('Argentina won the tournament.', ident())]
  }, { bodies: { [A]: 'Argentina won the tournament.' } });
  try {
    assert.equal(result.claims.length, 1);
    assert.equal(decisions(storage, 'EXACT_TEXT_DEDUPLICATED').length, 1);
    assert.deepEqual(linksOf(storage, result.claims[0].id).map((l) => l.role), ['primary']);
    assert.equal(result.claims[0].evidence_status, 'PARTIALLY_SUPPORTED');
  } finally { cleanup(storage, dbPath); }
});
