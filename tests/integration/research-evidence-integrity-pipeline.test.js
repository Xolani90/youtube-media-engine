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

// Real-path regression tests for the evidence-integrity fixes. Everything
// here is local and deterministic: a temp SQLite DB, a stub source
// provider, a stub LLM router and an injected fetch. No network, no
// contradiction detector (so no claim can be CONTESTED here).

function freshStorage() {
  const dbPath = path.join(os.tmpdir(), `research-integrity-${Date.now()}-${Math.random()}.db`);
  return { storage: new SqliteStorageDriver({ dbPath }), dbPath };
}

function cleanup(storage, dbPath) {
  storage.close();
  fs.rmSync(dbPath, { force: true });
  fs.rmSync(`${dbPath}-wal`, { force: true });
  fs.rmSync(`${dbPath}-shm`, { force: true });
}

function seedHandedOffOpportunity(storage) {
  const id = crypto.randomUUID();
  const proposition = {
    subject: 'Test subject', target_audience: 'Test audience', audience_problem: 'Test problem',
    core_question: 'Did the product launch cause a measurable sales increase?',
    gap: 'g', angle: 'a', differentiation: 'd', commercial_relevance: 'c',
    core_question_type: 'FACTUAL'
  };
  storage.run(
    `INSERT INTO opportunities (id, title, source, discovered_at, status, opportunity_proposition)
     VALUES (?, 'Test opportunity', 'rss', ?, 'HANDED_TO_RESEARCH', ?)`,
    [id, new Date().toISOString(), JSON.stringify(proposition)]
  );
  return id;
}

class UrlListProvider extends ResearchSourceProvider {
  constructor(urls) {
    super();
    this.urls = urls;
  }
  get id() { return 'url-list-stub'; }
  async healthCheck() { return true; }
  async discoverCandidates() {
    return { candidates: this.urls.map((url, i) => ({ url, title: `t${i}`, snippet: 's' })) };
  }
}

function fakeFetch() {
  return async () => ({
    ok: true, status: 200,
    headers: { get: () => 'text/html' },
    text: async () => '<html><body>Acme reported $1B in Q3 revenue.</body></html>'
  });
}

function claimRouter(claimsToReturn) {
  const registry = {
    'integrity-stub': () => ({
      id: 'integrity-stub', isPaid: false,
      async healthCheck() { return true; },
      async complete() {
        return { text: JSON.stringify(claimsToReturn), model: 'integrity-stub', requestId: null, inputTokens: 1, outputTokens: 1, estimatedCost: 0, isPaid: false };
      }
    })
  };
  return new LLMRouter({ priority: ['integrity-stub'], allowPaidProviders: false, registry });
}

const FACT = { claim: 'Acme reported $1B in Q3 revenue.', claim_type: 'FACT', is_load_bearing: true };
// Same claim with a structured identity fully grounded in its own wording.
const FACT_ID = {
  ...FACT,
  identity: {
    subject: 'Acme', predicate: 'report', object: 'revenue', qualifiers: ['Q3'], time: null, quantity: 1e9, unit: 'USD',
    polarity: 'AFFIRMED', modality: 'OCCURRED', relation: 'DESCRIPTIVE'
  }
};

async function runWith(urls, claims) {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  const opportunityId = seedHandedOffOpportunity(storage);
  const result = await runResearchProject({
    storage, opportunityId, sourceProvider: new UrlListProvider(urls), llmRouter: claimRouter(claims),
    policy: researchPolicy, classification: {}, fetchImpl: fakeFetch()
  });
  return { storage, dbPath, result };
}

test('REAL PATH A: one source that yields the same claim twice is deduplicated to a single primary link, and is NOT VERIFIED', async () => {
  const { storage, dbPath, result } = await runWith(['https://publisher-one.com/story'], [FACT, FACT]);
  try {
    assert.equal(result.claims.length, 1);
    const claimId = result.claims[0].id;
    const links = storage.all('SELECT source_id, role FROM claim_sources WHERE claim_id = ?', [claimId]);

    // Same source, same wording: deduplicated -- no redundant corroborating row.
    assert.equal(links.length, 1);
    assert.deepEqual(links.map((l) => l.role), ['primary']);

    assert.equal(result.claims[0].evidence_status, 'PARTIALLY_SUPPORTED');
    const persisted = storage.get('SELECT evidence_status FROM claims WHERE id = ?', [claimId]);
    assert.equal(persisted.evidence_status, 'PARTIALLY_SUPPORTED');
  } finally {
    cleanup(storage, dbPath);
  }
});

test('REAL PATH B: two URLs from the same registrable domain corroborating one claim are NOT VERIFIED', async () => {
  const { storage, dbPath, result } = await runWith(
    ['https://news.example.com/article-a', 'https://www.example.com/article-b'], [FACT_ID]
  );
  try {
    assert.equal(result.claims.length, 1);
    const claimId = result.claims[0].id;
    const links = storage.all('SELECT source_id, role FROM claim_sources WHERE claim_id = ?', [claimId]);

    // Precondition: two DISTINCT source rows are linked (so defect A dedupe alone cannot explain the result).
    assert.equal(new Set(links.map((l) => l.source_id)).size, 2);

    assert.equal(result.claims[0].evidence_status, 'PARTIALLY_SUPPORTED');
  } finally {
    cleanup(storage, dbPath);
  }
});

test('REAL PATH C: two URLs from different registrable domains corroborating one claim CAN be VERIFIED', async () => {
  const { storage, dbPath, result } = await runWith(
    ['https://publisher-one.com/story', 'https://publisher-two.org/story'], [FACT_ID]
  );
  try {
    assert.equal(result.claims.length, 1);
    const claimId = result.claims[0].id;
    const links = storage.all('SELECT source_id, role FROM claim_sources WHERE claim_id = ?', [claimId]);
    assert.equal(new Set(links.map((l) => l.source_id)).size, 2);
    assert.deepEqual(links.map((l) => l.role).sort(), ['corroborating', 'primary']);

    assert.equal(result.claims[0].evidence_status, 'VERIFIED');
  } finally {
    cleanup(storage, dbPath);
  }
});

test('REAL PATH D: primary_authoritative behavior through the real pipeline is unchanged (sufficient alone)', async () => {
  const { storage, dbPath } = freshStorage();
  await storage.migrate();
  try {
    const opportunityId = seedHandedOffOpportunity(storage);
    const result = await runResearchProject({
      storage, opportunityId, sourceProvider: new UrlListProvider(['https://acme.com/press-release']),
      llmRouter: claimRouter([FACT]), policy: researchPolicy,
      classification: { authoritativeDomains: ['acme.com'] }, fetchImpl: fakeFetch()
    });
    assert.equal(result.claims[0].evidence_status, 'VERIFIED');
  } finally {
    cleanup(storage, dbPath);
  }
});
