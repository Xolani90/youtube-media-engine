import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { SqliteStorageDriver } from '../../src/storage/SqliteStorageDriver.js';
import { ResearchSourceProvider } from '../../src/research/ResearchSourceProvider.js';
import { runResearchProject } from '../../src/research/pipeline.js';
import { verifyClaimAgainstSources } from '../../src/research/evidenceVerification.js';
import researchPolicy from '../../config/research_policy.json' with { type: 'json' };

// Pass 44 regression: corroboration is earned from claim TEXT vs source TEXT.
// Identity / fingerprint / convergence is NOT a prerequisite. Everything is
// local and deterministic: temp SQLite DB, stub provider, stub router, fake fetch.

const URL_A = 'https://publisher-one.com/story';
const URL_B = 'https://publisher-two.org/pricing';
const TEXT_A = 'Google introduced the model with $2 per million input tokens.';
const TEXT_B = 'API pricing begins at two dollars for every million input tokens.';
const CLAIM_A = 'Google introduced pricing of $2 per million input tokens.';
const CLAIM_B = 'API pricing begins at two dollars for every million input tokens.';

function freshStorage() {
  const dbPath = path.join(os.tmpdir(), `research-evver-${Date.now()}-${Math.random()}.db`);
  return { storage: new SqliteStorageDriver({ dbPath }), dbPath };
}
function cleanup(storage, dbPath) {
  storage.close();
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(`${dbPath}${suffix}`, { force: true });
}
function seedOpportunity(storage) {
  const id = crypto.randomUUID();
  const proposition = {
    subject: 'Gemini pricing', target_audience: 'devs', audience_problem: 'cost', core_question: 'What does the model cost?',
    gap: 'g', angle: 'a', differentiation: 'd', commercial_relevance: 'c', core_question_type: 'FACTUAL'
  };
  storage.run(
    `INSERT INTO opportunities (id, title, source, discovered_at, status, opportunity_proposition) VALUES (?, 'T', 'rss', ?, 'HANDED_TO_RESEARCH', ?)`,
    [id, new Date().toISOString(), JSON.stringify(proposition)]
  );
  return id;
}

class ScriptedProvider extends ResearchSourceProvider {
  constructor(byCall) { super(); this.byCall = byCall; this.calls = []; }
  get id() { return 'scripted-stub'; }
  async healthCheck() { return true; }
  async discoverCandidates({ query }) {
    this.calls.push(query);
    const urls = this.byCall[Math.min(this.calls.length - 1, this.byCall.length - 1)];
    return { candidates: urls.map((url, i) => ({ url, title: `t${i}`, snippet: 's' })), failures: [] };
  }
}

function pagesFetch(pages) {
  return async (url) => {
    const text = pages[url];
    if (text === undefined) return { ok: false, status: 404, headers: { get: () => 'text/html' }, text: async () => '' };
    return { ok: true, status: 200, headers: { get: () => 'text/html' }, text: async () => `<html><body>${text}</body></html>` };
  };
}

/**
 * Router that answers BOTH prompt kinds from the real pipeline prompts:
 *  - extraction prompt -> claims keyed by which source text it contains;
 *  - verification prompt -> `verify(sourceKey)` decides the model's answer.
 */
function scriptedRouter({ extract, verify }) {
  const state = { extractionCalls: 0, verificationCalls: 0 };
  return {
    state,
    async complete({ prompt }) {
      let payload;
      if (prompt.includes('verifying ONE claim')) {
        state.verificationCalls += 1;
        const key = prompt.includes(TEXT_B) ? 'B' : (prompt.includes(TEXT_A) ? 'A' : '?');
        payload = verify(key, prompt);
      } else {
        state.extractionCalls += 1;
        const key = prompt.includes(TEXT_B) ? 'B' : 'A';
        payload = extract[key] ?? [];
      }
      return { result: { text: JSON.stringify(payload), model: 'scripted', inputTokens: 1, outputTokens: 1, estimatedCost: 0, isPaid: false }, providerUsed: 'scripted' };
    }
  };
}

const fact = (claim, identity = null) => ({ claim, claim_type: 'FACT', is_load_bearing: true, ...(identity ? { identity } : {}) });
const supportsFrom = (key) => ({ result: 'SUPPORTS', quote: key === 'B' ? TEXT_B : TEXT_A });

async function run({ urls, router, policy = researchPolicy, provider, classification = {}, evidenceVerifier, pages = null }) {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  const opportunityId = seedOpportunity(storage);
  const sourceProvider = provider ?? new ScriptedProvider([urls]);
  const result = await runResearchProject({
    storage, opportunityId, sourceProvider, llmRouter: router, policy, classification,
    fetchImpl: pagesFetch(pages ?? { [URL_A]: TEXT_A, [URL_B]: TEXT_B, 'https://news.publisher-one.com/other': TEXT_B }),
    ...(evidenceVerifier ? { evidenceVerifier } : {})
  });
  return { storage, dbPath, result, sourceProvider };
}
const linksOf = (storage, claimId) => storage.all('SELECT cs.role, s.url FROM claim_sources cs JOIN sources s ON s.id = cs.source_id WHERE cs.claim_id = ?', [claimId]);

test('Test 10: NO FINGERPRINT REQUIRED - differently worded claims with no identity reach VERIFIED via source-text verification', async () => {
  const prev = process.env.DIAGNOSTIC_TRACE;
  process.env.DIAGNOSTIC_TRACE = 'true';
  const router = scriptedRouter({
    extract: { A: [fact(CLAIM_A)], B: [fact(CLAIM_B)] },
    verify: (key) => supportsFrom(key)
  });
  const { storage, dbPath, result } = await run({ urls: [URL_A, URL_B], router });
  try {
    assert.equal(result.claims.length, 2, 'different wording and no identity: two claim rows, never merged');
    const verified = result.claims.filter((c) => c.evidence_status === 'VERIFIED');
    assert.equal(verified.length, 1, 'exactly one claim reached VERIFIED (enrichment stops at the first VERIFIED load-bearing FACT)');
    const links = linksOf(storage, verified[0].id);
    assert.deepEqual(links.map((l) => l.role).sort(), ['corroborating', 'primary']);
    assert.equal(new Set(links.map((l) => l.url)).size, 2);
    assert.equal(router.state.verificationCalls, 1, 'one high-value call, not claim x source');

    // Audit trail: validated quote + source recorded in decision_log
    const rows = storage.all(`SELECT decision, reason, config_snapshot FROM decision_log WHERE stage = 'EVIDENCE_VERIFICATION'`);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].decision, 'SUPPORTS');
    assert.equal(rows[0].reason, 'quote_validated');
    const snap = JSON.parse(rows[0].config_snapshot);
    assert.equal(snap.quoteAccepted, true);
    assert.ok(snap.quote.length > 10);

    assert.equal(result.stopReason, 'COMPLETENESS_CRITERIA_MET');

    const summary = storage.get(`SELECT config_snapshot FROM decision_log WHERE decision = 'RESEARCH_TRACE_SUMMARY'`);
    const ev = JSON.parse(summary.config_snapshot).evidenceVerification;
    assert.equal(ev.verifierCalls, 1);
    assert.equal(ev.supports, 1);
    assert.equal(ev.quotesAccepted, 1);
    assert.equal(ev.corroboratingLinksAdded, 1);
    assert.equal(ev.verifiedLoadBearingFact, 1);
    assert.equal(ev.stopReason, 'verified_load_bearing_fact');
  } finally {
    if (prev === undefined) delete process.env.DIAGNOSTIC_TRACE; else process.env.DIAGNOSTIC_TRACE = prev;
    cleanup(storage, dbPath);
  }
});

test('Test 6 (pipeline): a fabricated quote creates no corroborating link and leaves the claim PARTIALLY_SUPPORTED', async () => {
  const router = scriptedRouter({
    extract: { A: [fact(CLAIM_A)], B: [] },
    verify: () => ({ result: 'SUPPORTS', quote: 'Pricing starts at exactly $2 for each million input tokens processed.' })
  });
  const { storage, dbPath, result } = await run({ urls: [URL_A, URL_B], router });
  try {
    assert.equal(result.claims.length, 1);
    assert.equal(result.claims[0].evidence_status, 'PARTIALLY_SUPPORTED');
    assert.deepEqual(linksOf(storage, result.claims[0].id).map((l) => l.role), ['primary']);
    const row = storage.get(`SELECT decision, reason FROM decision_log WHERE stage = 'EVIDENCE_VERIFICATION'`);
    assert.equal(row.decision, 'UNCERTAIN');
    assert.equal(row.reason, 'quote_not_in_source');
  } finally { cleanup(storage, dbPath); }
});

test('Test 5 (pipeline): a validated direct contradiction is recorded as role=contradicting and the claim is CONTESTED', async () => {
  const router = scriptedRouter({
    extract: { A: [fact(CLAIM_A)], B: [] },
    verify: (key) => ({ result: 'CONTRADICTS', quote: key === 'B' ? TEXT_B : TEXT_A })
  });
  const { storage, dbPath, result } = await run({ urls: [URL_A, URL_B], router });
  try {
    const claim = result.claims[0];
    assert.equal(claim.evidence_status, 'CONTESTED');
    assert.deepEqual(linksOf(storage, claim.id).map((l) => l.role).sort(), ['contradicting', 'primary']);
    // claim-to-claim relation table is NOT used for source-level disagreement
    assert.equal(storage.get('SELECT COUNT(*) AS n FROM claim_relations').n, 0);
  } finally { cleanup(storage, dbPath); }
});

test('Test 8 (pipeline): a second URL on the same registrable domain is never even a candidate and cannot corroborate', async () => {
  const router = scriptedRouter({ extract: { A: [fact(CLAIM_A)], B: [] }, verify: (key) => supportsFrom(key) });
  const { storage, dbPath, result } = await run({ urls: [URL_A, 'https://news.publisher-one.com/other'], router });
  try {
    assert.equal(router.state.verificationCalls, 0);
    assert.equal(result.claims[0].evidence_status, 'PARTIALLY_SUPPORTED');
  } finally { cleanup(storage, dbPath); }
});

test('Test 3 (pipeline): exact identity merge is unchanged - already VERIFIED, so the verifier is never called', async () => {
  // Same grounded-identity fixture the existing evidence-integrity pipeline tests use.
  const ACME = 'Acme reported $1B in Q3 revenue.';
  const identity = { subject: 'Acme', predicate: 'report', object: 'revenue', qualifiers: ['Q3'], time: null, quantity: 1e9, unit: 'USD', polarity: 'AFFIRMED', modality: 'OCCURRED', relation: 'DESCRIPTIVE' };
  const router = scriptedRouter({ extract: { A: [fact(ACME, identity)], B: [fact(ACME, identity)] }, verify: () => { throw new Error('verifier must not run'); } });
  let verifierCalls = 0;
  const spy = async (args) => { verifierCalls += 1; return verifyClaimAgainstSources(args); };
  // Identity grounding is checked against the source text, so each page must actually contain the claim.
  const pages = { [URL_A]: `${ACME} ${TEXT_A}`, [URL_B]: `${ACME} ${TEXT_B}` };
  const { storage, dbPath, result } = await run({ urls: [URL_A, URL_B], router, evidenceVerifier: spy, pages });
  try {
    assert.equal(result.claims.length, 1, 'merged by exact identity');
    assert.equal(result.claims[0].evidence_status, 'VERIFIED');
    assert.equal(verifierCalls, 0);
    assert.equal(router.state.verificationCalls, 0);
  } finally { cleanup(storage, dbPath); }
});

test('Test 9 (pipeline): primary_authoritative alone is VERIFIED and costs zero verifier calls', async () => {
  const router = scriptedRouter({ extract: { A: [fact(CLAIM_A)], B: [] }, verify: () => { throw new Error('verifier must not run'); } });
  const { storage, dbPath, result } = await run({ urls: [URL_A], router, classification: { authoritativeDomains: ['publisher-one.com'] } });
  try {
    assert.equal(result.claims[0].evidence_status, 'VERIFIED');
    assert.equal(router.state.verificationCalls, 0);
  } finally { cleanup(storage, dbPath); }
});

test('verifier-call budget is respected', async () => {
  const router = scriptedRouter({ extract: { A: [fact(CLAIM_A)], B: [] }, verify: () => ({ result: 'UNCERTAIN', quote: '' }) });
  const policy = { ...researchPolicy, evidence_verification: { max_verifier_calls_per_project: 1, max_candidates_per_claim: 3 } };
  const { storage, dbPath } = await run({ urls: [URL_A, URL_B], router, policy });
  try {
    assert.equal(router.state.verificationCalls, 1);
  } finally { cleanup(storage, dbPath); }
});

test('evidence expansion: acquires an extra tracked source via the existing provider and verifies it', async () => {
  const router = scriptedRouter({ extract: { A: [fact(CLAIM_A)], B: [] }, verify: (key) => supportsFrom(key) });
  const provider = new ScriptedProvider([[URL_A], [URL_A, URL_B]]);
  const { storage, dbPath, result } = await run({ urls: [], router, provider });
  try {
    assert.ok(provider.calls.length >= 2 && provider.calls.length <= 1 + 6, 'initial discovery + bounded evidence-search cascade');
    assert.equal(provider.calls[1], CLAIM_A, 'first cascade query is the literal claim text');
    assert.equal(storage.get('SELECT COUNT(*) AS n FROM sources').n, 2, 'new source is a tracked row in the project');
    assert.equal(result.claims[0].evidence_status, 'VERIFIED');
    assert.deepEqual(linksOf(storage, result.claims[0].id).map((l) => l.role).sort(), ['corroborating', 'primary']);
  } finally { cleanup(storage, dbPath); }
});

test('evidence expansion never bypasses max_sources_per_research_project', async () => {
  const router = scriptedRouter({ extract: { A: [fact(CLAIM_A)], B: [] }, verify: (key) => supportsFrom(key) });
  const provider = new ScriptedProvider([[URL_A], [URL_A, URL_B]]);
  const policy = { ...researchPolicy, acquisition: { max_sources_per_research_project: 1, max_acquisition_attempts: 12 } };
  const { storage, dbPath, result } = await run({ urls: [], router, provider, policy });
  try {
    assert.equal(provider.calls.length, 1, 'source cap already reached: no expansion discovery');
    assert.equal(storage.get('SELECT COUNT(*) AS n FROM sources').n, 1);
    assert.equal(result.claims[0].evidence_status, 'PARTIALLY_SUPPORTED');
  } finally { cleanup(storage, dbPath); }
});

test('a throwing verifier cannot abort the project or add evidence', async () => {
  const router = scriptedRouter({ extract: { A: [fact(CLAIM_A)], B: [] }, verify: () => ({ result: 'UNCERTAIN', quote: '' }) });
  const { storage, dbPath, result } = await run({ urls: [URL_A, URL_B], router, evidenceVerifier: async () => { throw new Error('boom'); } });
  try {
    assert.equal(result.claims[0].evidence_status, 'PARTIALLY_SUPPORTED');
    assert.equal(storage.get(`SELECT COUNT(*) AS n FROM decision_log WHERE decision = 'ENRICHMENT_ERROR'`).n, 1);
  } finally { cleanup(storage, dbPath); }
});
