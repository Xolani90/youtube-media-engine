import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { SqliteStorageDriver } from '../../src/storage/SqliteStorageDriver.js';
import { LLMRouter } from '../../src/providers/llm/router.js';
import { GeminiProvider } from '../../src/providers/llm/GeminiProvider.js';
import { ResearchSourceProvider } from '../../src/research/ResearchSourceProvider.js';
import { runResearchProject } from '../../src/research/pipeline.js';
import { independenceKey } from '../../src/research/evidenceGrading.js';
import researchPolicy from '../../config/research_policy.json' with { type: 'json' };

// Real-path regression tests for structured claim-identity corroboration.
// Local + deterministic: temp SQLite DB, stub source provider, stub LLM
// router that answers per source (chosen by a host marker in the prompt),
// injected fetch. No network.

function freshStorage() {
  const dbPath = path.join(os.tmpdir(), `claim-identity-${Date.now()}-${Math.random()}.db`);
  return { storage: new SqliteStorageDriver({ dbPath }), dbPath };
}
function cleanup(storage, dbPath) {
  storage.close();
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(`${dbPath}${suffix}`, { force: true });
}
function seedOpportunity(storage) {
  const id = crypto.randomUUID();
  const proposition = {
    subject: 's', target_audience: 'a', audience_problem: 'p', core_question: 'Did Acme launch Widget in March 2026?',
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
const marker = (url) => `MARK_${new URL(url).hostname.replace(/\W/g, '_')}`;
// claimsByUrl (optional): embed that URL's claim texts in the fetched page so each claim is
// verbatim in its source and therefore normalization-trusted (UNCHANGED). Without it the page
// never contains the claim, so the claim is UNVERIFIED_ORIGIN and cannot use the identity index.
function fakeFetch(claimsByUrl = null) {
  return async (url) => ({
    ok: true, status: 200, headers: { get: () => 'text/html' },
    text: async () => `<html><body>${marker(url)} independent report covering the product topic in some detail. ${(claimsByUrl?.[url] ?? []).map((c) => c.claim).join(' ')}</body></html>`
  });
}
// claimsByUrl: { [url]: claims[] } — the stub answers according to the source in the prompt.
function routerFor(claimsByUrl) {
  const registry = {
    'identity-stub': () => ({
      id: 'identity-stub', isPaid: false,
      async healthCheck() { return true; },
      async complete({ prompt }) {
        const url = Object.keys(claimsByUrl).find((u) => prompt.includes(marker(u)));
        const claims = url ? claimsByUrl[url] : [];
        return { text: JSON.stringify(claims), model: 'identity-stub', requestId: null, inputTokens: 1, outputTokens: 1, estimatedCost: 0, isPaid: false };
      }
    })
  };
  return new LLMRouter({ priority: ['identity-stub'], allowPaidProviders: false, registry });
}

async function run(claimsByUrl, { classification = {}, detectContradiction = null, sourceContainsClaims = false } = {}) {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  const opportunityId = seedOpportunity(storage);
  const result = await runResearchProject({
    storage, opportunityId, sourceProvider: new UrlListProvider(Object.keys(claimsByUrl)),
    llmRouter: routerFor(claimsByUrl), policy: researchPolicy, classification,
    fetchImpl: fakeFetch(sourceContainsClaims ? claimsByUrl : null), detectContradiction
  });
  return { storage, dbPath, result };
}

const A = 'https://publisher-one.com/story';
const B = 'https://publisher-two.org/story';

const launch = (over = {}) => ({
  subject: 'Acme', predicate: 'launch', object: 'Widget', qualifiers: [], time: '2026-03',
  quantity: null, unit: null, polarity: 'AFFIRMED', modality: 'OCCURRED', relation: 'DESCRIPTIVE', ...over
});
const fact = (claim, identity, extra = {}) => ({ claim, claim_type: 'FACT', is_load_bearing: true, identity, ...extra });
const sourceIdsOf = (storage, claimId) => [...new Set(storage.all('SELECT source_id FROM claim_sources WHERE claim_id = ?', [claimId]).map((r) => r.source_id))];

test('1. paraphrase across two registrable domains: ONE claim, two source ids, two domains, VERIFIED', async () => {
  const { storage, dbPath, result } = await run({
    [A]: [fact('Acme released Widget in March 2026.', launch({ predicate: 'release' }))],
    [B]: [fact('Widget was launched by Acme during March 2026.', launch({ predicate: 'launch' }))]
  }, { sourceContainsClaims: true });
  try {
    assert.equal(result.claims.length, 1);
    // Original human-readable text is preserved verbatim (first-seen wording).
    assert.equal(result.claims[0].claim, 'Acme released Widget in March 2026.');
    const ids = sourceIdsOf(storage, result.claims[0].id);
    assert.equal(ids.length, 2);
    const urls = ids.map((id) => storage.get('SELECT url FROM sources WHERE id = ?', [id]).url);
    assert.equal(new Set(urls.map(independenceKey)).size, 2);
    assert.equal(result.claims[0].evidence_status, 'VERIFIED');
    const merged = storage.all("SELECT reason FROM decision_log WHERE decision = 'MERGED_BY_IDENTITY'");
    assert.equal(merged.length, 1);
  } finally { cleanup(storage, dbPath); }
});

test('1b. paraphrases WITHOUT identity keep the old exact-text behavior (separate claims, PARTIALLY_SUPPORTED)', async () => {
  const { storage, dbPath, result } = await run({
    [A]: [fact('Acme released Widget in March 2026.', null)],
    [B]: [fact('Widget was launched by Acme during March 2026.', null)]
  });
  try {
    assert.equal(result.claims.length, 2);
    assert.ok(result.claims.every((c) => c.evidence_status === 'PARTIALLY_SUPPORTED'));
  } finally { cleanup(storage, dbPath); }
});

test('2. different number does NOT merge ($1B vs $2B revenue)', async () => {
  const rev = (q) => ({ subject: 'Acme', predicate: 'report', object: 'revenue', qualifiers: [], time: '2025', quantity: q, unit: 'USD', polarity: 'AFFIRMED', modality: 'OCCURRED', relation: 'DESCRIPTIVE' });
  const { storage, dbPath, result } = await run({
    [A]: [fact('Acme reported $1 billion revenue in 2025.', rev(1e9))],
    [B]: [fact('Acme reported $2 billion revenue in 2025.', rev(2e9))]
  });
  try {
    assert.equal(result.claims.length, 2);
    for (const c of result.claims) {
      assert.equal(sourceIdsOf(storage, c.id).length, 1);
      assert.equal(c.evidence_status, 'PARTIALLY_SUPPORTED');
    }
  } finally { cleanup(storage, dbPath); }
});

test('2b. an identity that misstates the number in its own claim text is untrusted and cannot merge', async () => {
  const rev = { subject: 'Acme', predicate: 'report', object: 'revenue', qualifiers: [], time: '2025', quantity: 1e9, unit: 'USD', polarity: 'AFFIRMED', modality: 'OCCURRED', relation: 'DESCRIPTIVE' };
  const { storage, dbPath, result } = await run({
    [A]: [fact('Acme reported $1 billion revenue in 2025.', rev)],
    [B]: [fact('Acme reported $2 billion revenue in 2025.', rev)] // LLM copied the wrong structure
  });
  try {
    assert.equal(result.claims.length, 2);
  } finally { cleanup(storage, dbPath); }
});

test('3. different date does NOT merge (March vs April)', async () => {
  const { storage, dbPath, result } = await run({
    [A]: [fact('Acme launched Widget in March 2026.', launch({ time: '2026-03' }))],
    [B]: [fact('Acme launched Widget in April 2026.', launch({ time: '2026-04' }))]
  });
  try {
    assert.equal(result.claims.length, 2);
    assert.ok(result.claims.every((c) => c.evidence_status === 'PARTIALLY_SUPPORTED'));
  } finally { cleanup(storage, dbPath); }
});

test('3b. identity whose month contradicts its own text cannot merge', async () => {
  const { storage, dbPath, result } = await run({
    [A]: [fact('Acme launched Widget in March 2026.', launch({ time: '2026-03' }))],
    [B]: [fact('Acme launched Widget in April 2026.', launch({ time: '2026-03' }))]
  });
  try {
    assert.equal(result.claims.length, 2);
  } finally { cleanup(storage, dbPath); }
});

test('4. negation does NOT merge with affirmation (also when the LLM mislabels polarity)', async () => {
  for (const negatedIdentity of [launch({ polarity: 'NEGATED' }), launch({ polarity: 'AFFIRMED' })]) {
    const { storage, dbPath, result } = await run({
      [A]: [fact('Acme launched Widget in March 2026.', launch())],
      [B]: [fact('Acme did not launch Widget in March 2026.', negatedIdentity)]
    });
    try {
      assert.equal(result.claims.length, 2);
      assert.ok(result.claims.every((c) => c.evidence_status === 'PARTIALLY_SUPPORTED'));
    } finally { cleanup(storage, dbPath); }
  }
});

test('5. different entities do NOT merge', async () => {
  const { storage, dbPath, result } = await run({
    [A]: [fact('Acme launched Widget in March 2026.', launch())],
    [B]: [fact('Globex launched Widget in March 2026.', launch({ subject: 'Globex' }))]
  });
  try {
    assert.equal(result.claims.length, 2);
  } finally { cleanup(storage, dbPath); }
});

test('6. correlation vs causation do NOT merge (also when the LLM mislabels the causal one)', async () => {
  const sales = (relation) => ({ subject: 'widget launch', predicate: 'affect', object: 'sales', qualifiers: [], time: null, quantity: null, unit: null, polarity: 'AFFIRMED', modality: 'OCCURRED', relation });
  for (const causalRelation of ['CAUSAL', 'ASSOCIATIVE', 'DESCRIPTIVE']) {
    const { storage, dbPath, result } = await run({
      [A]: [fact('The widget launch was associated with higher sales.', sales('ASSOCIATIVE'))],
      [B]: [fact('The widget launch caused higher sales.', sales(causalRelation))]
    });
    try {
      assert.equal(result.claims.length, 2, `causal label ${causalRelation}`);
    } finally { cleanup(storage, dbPath); }
  }
});

test('6b. announced/planned/estimated is not merged with occurred', async () => {
  const { storage, dbPath, result } = await run({
    [A]: [fact('Acme launched Widget in March 2026.', launch())],
    [B]: [fact('Acme plans to launch Widget in March 2026.', launch({ modality: 'PLANNED' }))]
  });
  try {
    assert.equal(result.claims.length, 2);
  } finally { cleanup(storage, dbPath); }
});

test('7. one source cannot self-corroborate, even via paraphrase', async () => {
  const { storage, dbPath, result } = await run({
    [A]: [
      fact('Acme released Widget in March 2026.', launch({ predicate: 'release' })),
      fact('Widget was launched by Acme during March 2026.', launch({ predicate: 'launch' }))
    ]
  }, { sourceContainsClaims: true });
  try {
    assert.equal(result.claims.length, 1);
    assert.equal(sourceIdsOf(storage, result.claims[0].id).length, 1);
    assert.equal(result.claims[0].evidence_status, 'PARTIALLY_SUPPORTED');
  } finally { cleanup(storage, dbPath); }
});

test('8. one registrable domain cannot corroborate itself via paraphrase', async () => {
  const { storage, dbPath, result } = await run({
    'https://news.example.com/a': [fact('Acme released Widget in March 2026.', launch({ predicate: 'release' }))],
    'https://www.example.com/b': [fact('Widget was launched by Acme during March 2026.', launch({ predicate: 'launch' }))]
  }, { sourceContainsClaims: true });
  try {
    assert.equal(result.claims.length, 1);
    assert.equal(sourceIdsOf(storage, result.claims[0].id).length, 2);
    assert.equal(result.claims[0].evidence_status, 'PARTIALLY_SUPPORTED');
  } finally { cleanup(storage, dbPath); }
});

test('9. identical wording with no grounded identity does not corroborate across domains (exact text alone is not evidence)', async () => {
  const text = 'Acme launched Widget in March 2026.';
  const { storage, dbPath, result } = await run({ [A]: [fact(text, null)], [B]: [fact(text, null)] });
  try {
    assert.equal(result.claims.length, 2);
    assert.ok(result.claims.every((c) => c.evidence_status === 'PARTIALLY_SUPPORTED'));
  } finally { cleanup(storage, dbPath); }
});

test('10. primary authoritative source is still sufficient alone; identity changes nothing about that', async () => {
  const P = 'https://acme.com/press-release';
  const { storage, dbPath, result } = await run(
    { [P]: [fact('Acme released Widget in March 2026.', launch({ predicate: 'release' }))] },
    { classification: { authoritativeDomains: ['acme.com'] } }
  );
  try {
    assert.equal(result.claims.length, 1);
    assert.equal(result.claims[0].evidence_status, 'VERIFIED');
  } finally { cleanup(storage, dbPath); }
});

test('11. opposing propositions stay separate and reach the contradiction machinery (both CONTESTED)', async () => {
  const seen = [];
  const detectContradiction = async (a, b) => { seen.push([a.claim, b.claim].sort()); return 'CONTRADICTS'; };
  const { storage, dbPath, result } = await run({
    [A]: [fact('Acme launched Widget in March 2026.', launch())],
    [B]: [fact('Acme did not launch Widget in March 2026.', launch({ polarity: 'NEGATED' }))]
  }, { detectContradiction });
  try {
    assert.equal(result.claims.length, 2);
    assert.equal(seen.length, 1);
    assert.deepEqual(seen[0], ['Acme did not launch Widget in March 2026.', 'Acme launched Widget in March 2026.']);
    assert.ok(result.claims.every((c) => c.evidence_status === 'CONTESTED'));
    assert.equal(storage.all("SELECT 1 FROM claim_relations WHERE relation_type = 'CONTRADICTS'").length, 1);
  } finally { cleanup(storage, dbPath); }
});

test('is_load_bearing mismatch between paraphrases keeps them separate (conservative)', async () => {
  const { storage, dbPath, result } = await run({
    [A]: [fact('Acme released Widget in March 2026.', launch({ predicate: 'release' }), { is_load_bearing: true })],
    [B]: [fact('Widget was launched by Acme during March 2026.', launch(), { is_load_bearing: false })]
  });
  try {
    assert.equal(result.claims.length, 2);
  } finally { cleanup(storage, dbPath); }
});

// ---- Canonicalization (v2) through the real pipeline ----
const revId = (over = {}) => ({ subject: 'Acme', predicate: 'report', object: 'revenue', qualifiers: [], time: '2025', quantity: 1e9, unit: 'USD', polarity: 'AFFIRMED', modality: 'OCCURRED', relation: 'DESCRIPTIVE', ...over });

test('C-int-1. lexically different but equivalent identities (inflection, article, date form, unit form) merge and VERIFY across two domains', async () => {
  const { storage, dbPath, result } = await run({
    [A]: [fact('Acme reported $1 billion revenue in 2025.', revId())],
    [B]: [fact("Acme's revenue for 2025 was reported as 1,000 million US dollars.", revId({ predicate: 'Reported', object: 'the Revenue', quantity: 1000, unit: 'million US dollars', time: '2025' }))]
  }, { sourceContainsClaims: true });
  try {
    assert.equal(result.claims.length, 1);
    assert.equal(sourceIdsOf(storage, result.claims[0].id).length, 2);
    assert.equal(result.claims[0].evidence_status, 'VERIFIED');
    assert.equal(storage.all("SELECT 1 FROM decision_log WHERE decision = 'MERGED_BY_IDENTITY'").length, 1);
  } finally { cleanup(storage, dbPath); }
});

test('C-int-2. equivalent date forms merge through the pipeline; a different date does not', async () => {
  const { storage, dbPath, result } = await run({
    [A]: [fact('Acme released Widget in March 2026.', launch({ predicate: 'release', time: '2026-03' }))],
    [B]: [fact('Widget was launched by Acme in March 2026.', launch({ time: 'March 2026' }))],
    'https://publisher-three.net/story': [fact('Acme released Widget in April 2026.', launch({ predicate: 'release', time: 'April 2026' }))]
  }, { sourceContainsClaims: true });
  try {
    assert.equal(result.claims.length, 2);
    const march = result.claims.find((c) => c.claim.includes('March'));
    const april = result.claims.find((c) => c.claim.includes('April'));
    assert.equal(sourceIdsOf(storage, march.id).length, 2);
    assert.equal(march.evidence_status, 'VERIFIED');
    assert.equal(sourceIdsOf(storage, april.id).length, 1);
    assert.equal(april.evidence_status, 'PARTIALLY_SUPPORTED');
  } finally { cleanup(storage, dbPath); }
});

test('C-int-3. same-domain and same-source lexical variants merge but never count as independent corroboration', async () => {
  const sameDomain = await run({
    'https://news.example.com/a': [fact('Acme reported $1 billion revenue in 2025.', revId())],
    'https://www.example.com/b': [fact('Acme reported one billion dollars.', revId({ predicate: 'reports', unit: '$' }))]
  }, { sourceContainsClaims: true });
  try {
    // Second wording has a spelled number the structure cannot verify -> untrusted, stays separate.
    assert.equal(sameDomain.result.claims.length, 2);
    assert.ok(sameDomain.result.claims.every((c) => c.evidence_status === 'PARTIALLY_SUPPORTED'));
  } finally { cleanup(sameDomain.storage, sameDomain.dbPath); }

  const sameDomain2 = await run({
    'https://news.example.com/a': [fact('Acme reported $1 billion revenue in 2025.', revId())],
    'https://www.example.com/b': [fact('Acme reported revenue of $1 billion for 2025.', revId({ predicate: 'reports', unit: '$' }))]
  }, { sourceContainsClaims: true });
  try {
    assert.equal(sameDomain2.result.claims.length, 1);
    assert.equal(sourceIdsOf(sameDomain2.storage, sameDomain2.result.claims[0].id).length, 2);
    assert.equal(sameDomain2.result.claims[0].evidence_status, 'PARTIALLY_SUPPORTED');
  } finally { cleanup(sameDomain2.storage, sameDomain2.dbPath); }

  const sameSource = await run({
    [A]: [
      fact('Acme reported $1 billion revenue in 2025.', revId()),
      fact('Revenue of $1 billion was reported by Acme for 2025.', revId({ predicate: 'reported', unit: 'US dollars' }))
    ]
  }, { sourceContainsClaims: true });
  try {
    assert.equal(sameSource.result.claims.length, 1);
    assert.equal(sourceIdsOf(sameSource.storage, sameSource.result.claims[0].id).length, 1);
    assert.equal(sameSource.result.claims[0].evidence_status, 'PARTIALLY_SUPPORTED');
  } finally { cleanup(sameSource.storage, sameSource.dbPath); }
});

test('C-int-4. contradictory propositions with lexical variance stay separate and reach contradiction handling', async () => {
  const seen = [];
  const detectContradiction = async (a, b) => { seen.push(1); return 'CONTRADICTS'; };
  const { storage, dbPath, result } = await run({
    [A]: [fact('Acme released Widget in March 2026.', launch({ predicate: 'released', time: 'March 2026' }))],
    [B]: [fact('Acme did not launch Widget in March 2026.', launch({ predicate: 'launched', polarity: 'NEGATED', time: '2026/03' }))]
  }, { detectContradiction });
  try {
    assert.equal(result.claims.length, 2);
    assert.equal(seen.length, 1);
    assert.ok(result.claims.every((c) => c.evidence_status === 'CONTESTED'));
    assert.equal(storage.all("SELECT 1 FROM decision_log WHERE decision = 'MERGED_BY_IDENTITY'").length, 0);
  } finally { cleanup(storage, dbPath); }
});

// ---- Real extraction path: GeminiProvider response parsing -> extractClaims -> pipeline ----
// Real GeminiProvider + real LLMRouter with only the HTTP fetch injected: the
// response is Gemini-shaped (candidates/parts, text split over several parts,
// one answer wrapped in a JSON code fence).
function geminiRouterFor(textByUrl) {
  const fetchImpl = async (_url, opts) => {
    const prompt = JSON.parse(opts.body).contents[0].parts[0].text;
    const url = Object.keys(textByUrl).find((u) => prompt.includes(marker(u)));
    const text = url ? textByUrl[url] : '[]';
    const half = Math.floor(text.length / 2);
    return {
      ok: true, status: 200, headers: { get: () => null },
      json: async () => ({
        candidates: [{ content: { parts: [{ text: text.slice(0, half) }, { text: text.slice(half) }] }, finishReason: 'STOP' }],
        modelVersion: 'gemini-test', usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 }
      })
    };
  };
  const registry = { 'gemini-free': () => new GeminiProvider({ fetchImpl, apiKeyProvider: () => 'k', sleepImpl: async () => {}, nowImpl: () => 0 }) };
  return new LLMRouter({ priority: ['gemini-free'], allowPaidProviders: false, registry });
}

test('E1. real Gemini response path preserves structured identity, merges cross-source paraphrases, and reports identity coverage', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  try {
    const opportunityId = seedOpportunity(storage);
    const claimsByUrl = {
      [A]: [
        fact('Acme reported $1 billion revenue in 2025.', revId()),
        fact('Acme released Gadget in March 2026.', null),                                        // missing
        fact('Acme released Widget in 2026.', { ...launch({ time: '2026' }), polarity: 'MAYBE' }), // malformed
        fact('Acme did not release Widget in 2027.', launch({ time: '2027' })),                   // inconsistent (negation, AFFIRMED)
        { claim: 'Analysts liked it.', claim_type: 'OPINION', is_load_bearing: false, identity: revId() } // non-FACT: ignored
      ],
      [B]: [fact('Revenue of $1 billion for 2025 was reported by Acme.', revId({ predicate: 'reported', unit: 'US dollars' }))]
    };
    const textByUrl = {
      [A]: '```json\n' + JSON.stringify(claimsByUrl[A], null, 2) + '\n```',
      [B]: JSON.stringify(claimsByUrl[B])
    };
    const result = await runResearchProject({
      storage, opportunityId, sourceProvider: new UrlListProvider([A, B]),
      llmRouter: geminiRouterFor(textByUrl), policy: researchPolicy, classification: {},
      fetchImpl: fakeFetch(claimsByUrl), detectContradiction: null
    });

    // Identity survived Gemini parsing + extraction: paraphrase merged, two domains, VERIFIED.
    const revenue = result.claims.find((c) => c.claim === 'Acme reported $1 billion revenue in 2025.');
    assert.equal(sourceIdsOf(storage, revenue.id).length, 2);
    assert.equal(revenue.evidence_status, 'VERIFIED');
    assert.equal(storage.all("SELECT 1 FROM decision_log WHERE decision = 'MERGED_BY_IDENTITY'").length, 1);
    // Fail-closed cases stayed separate single-source claims; non-FACT identity is inert.
    for (const text of ['Acme released Gadget in March 2026.', 'Acme released Widget in 2026.', 'Acme did not release Widget in 2027.', 'Analysts liked it.']) {
      const c = result.claims.find((x) => x.claim === text);
      assert.equal(sourceIdsOf(storage, c.id).length, 1, text);
    }

    // Coverage is diagnosable from the existing EXTRACTED decision rows.
    const snaps = storage.all("SELECT config_snapshot FROM decision_log WHERE decision = 'EXTRACTED'").map((r) => JSON.parse(r.config_snapshot).identity);
    const withMissing = snaps.find((s) => s.factClaims === 4);
    assert.deepEqual(withMissing, {
      factClaims: 4, fingerprinted: 1, missing: 1, malformed: 1, inconsistent: 1,
      reasons: { identity_missing: 1, identity_polarity_invalid: 1, polarity_text_mismatch: 1 }
    });
    assert.deepEqual(snaps.find((s) => s.factClaims === 1), { factClaims: 1, fingerprinted: 1, missing: 0, malformed: 0, inconsistent: 0, reasons: {} });
  } finally { cleanup(storage, dbPath); }
});
