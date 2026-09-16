// Manual, opt-in, one-shot script. NOT part of `npm test`, NOT run at
// application startup, NOT part of the autonomous runner.
//
// Purpose: prove that a real 'groq-free' completion (via the existing
// GroqProvider / LLMRouter / candidates.js registry) can be consumed by
// the existing, unmodified runResearchProject() pipeline end to end --
// real claim extraction, real deterministic source classification, real
// deterministic evidence grading, real completeness evaluation, real
// persistence, real decision_log entries.
//
// Fixture strategy (mirrors the 'FACTUAL: a single primary_authoritative-
// sourced, load-bearing FACT claim reaches RESEARCH_COMPLETE' case in
// tests/integration/research-pipeline-e2e.test.js exactly): a single
// HANDED_TO_RESEARCH opportunity with core_question_type='FACTUAL', a
// single source classified primary_authoritative via the same
// classification={authoritativeDomains:[...]} mechanism the test uses,
// and a stubbed ResearchSourceProvider + fetchImpl -- source DISCOVERY
// and RETRIEVAL are deterministic-by-design in this codebase (see
// src/research/ResearchSourceProvider.js, retrieval.js) and are not the
// LLM boundary under test here; only the Research-stage claim-extraction
// LLMRouter is real Groq. This keeps the harness to real API call(s)
// against the actual extractClaims() -> llmRouter.complete() boundary in
// src/research/claims.js, without faking or bypassing that boundary and
// without reproducing or duplicating Research's own validation logic.
//
// Nothing about Discovery, Brief, Script, Fact-Check, Originality, Quality
// Gate, Production, Media Production, publication, the scheduler, or the
// autonomous runner is touched or exercised here.
//
// Usage:
//   GROQ_FREE_API_KEY=... node scripts/generate-real-research.js
//
// Exit code is 0 only if the Research project genuinely reaches
// RESEARCH_COMPLETE via the real, unmodified pipeline with the LLM call
// answered by groq-free. Any failure -- missing key, no usable claims,
// thrown error -- exits non-zero with the real error/reason printed. No
// fallback to any other provider is attempted; the router is constructed
// with priority strictly limited to ['groq-free'].

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { SqliteStorageDriver } from '../src/storage/SqliteStorageDriver.js';
import { LLMRouter } from '../src/providers/llm/router.js';
import { ResearchSourceProvider } from '../src/research/ResearchSourceProvider.js';
import { runResearchProject } from '../src/research/pipeline.js';
import researchPolicy from '../config/research_policy.json' with { type: 'json' };

function freshStorage() {
  const dbPath = path.join(os.tmpdir(), `research-real-groq-${Date.now()}-${Math.random()}.db`);
  return { storage: new SqliteStorageDriver({ dbPath }), dbPath };
}

function cleanup(storage, dbPath) {
  storage.close();
  fs.rmSync(dbPath, { force: true });
  fs.rmSync(`${dbPath}-wal`, { force: true });
  fs.rmSync(`${dbPath}-shm`, { force: true });
}

// Identical shape to seedHandedOffOpportunity() in
// tests/integration/research-pipeline-e2e.test.js -- simulates exactly
// what Discovery's real pipeline persists (D-01/D-02), which Research
// consumes as-is.
function seedHandedOffOpportunity(storage, { coreQuestionType = 'FACTUAL' } = {}) {
  const id = crypto.randomUUID();
  const proposition = {
    subject: 'Real Groq research harness subject', target_audience: 'Test audience',
    audience_problem: 'Test problem',
    core_question: 'Did the product launch cause a measurable sales increase?',
    gap: 'g', angle: 'a', differentiation: 'd', commercial_relevance: 'c',
    core_question_type: coreQuestionType
  };
  storage.run(
    `INSERT INTO opportunities (id, title, source, discovered_at, status, opportunity_proposition)
     VALUES (?, 'Real Groq research generation smoke opportunity', 'rss', ?, 'HANDED_TO_RESEARCH', ?)`,
    [id, new Date().toISOString(), JSON.stringify(proposition)]
  );
  return id;
}

// Identical shape to SingleSourceProvider in the existing Research e2e
// test -- deterministic source DISCOVERY stub (not the LLM boundary under
// test).
class SingleSourceProvider extends ResearchSourceProvider {
  constructor(urls) {
    super();
    this.urls = urls;
  }
  get id() { return 'single-source-real-groq-harness'; }
  async healthCheck() { return true; }
  async discoverCandidates() {
    return { candidates: this.urls.map((url, i) => ({ url, title: `t${i}`, snippet: 's' })) };
  }
}

// Identical shape to fakeFetch() in the existing Research e2e test --
// deterministic RETRIEVAL stub (not the LLM boundary under test).
function fakeFetch(bodyByUrl) {
  return async (url) => ({
    ok: true, status: 200,
    headers: { get: () => 'text/html' },
    text: async () => bodyByUrl[url] || '<html><body>No content</body></html>'
  });
}

async function main() {
  const apiKey = process.env.GROQ_FREE_API_KEY;
  if (!apiKey) {
    console.error(
      'FAILED: GROQ_FREE_API_KEY is not set in the process environment.\n' +
      'This script requires a real key and will not fall back to any other provider.'
    );
    process.exitCode = 1;
    return;
  }

  const { storage, dbPath } = freshStorage();
  let cleanedUp = false;
  try {
    await storage.migrate();

    const opportunityId = seedHandedOffOpportunity(storage, { coreQuestionType: 'FACTUAL' });

    const url = 'https://acme.com/press-release';
    const provider = new SingleSourceProvider([url]);
    const fetchImpl = fakeFetch({
      [url]: '<html><body>Acme reported one billion dollars in Q3 revenue following the product launch.</body></html>'
    });

    // Explicitly limited to groq-free only for the Research claim-
    // extraction call -- no reliance on the unrelated default provider
    // ordering in config.llmProviderPriority, and no silent fallback to
    // any other provider id (Gemini, OpenRouter, local-stub, etc.).
    const llmRouter = new LLMRouter({ priority: ['groq-free'] });

    console.log('Requesting real Research claim extraction via provider: groq-free ...');
    const result = await runResearchProject({
      storage, opportunityId, sourceProvider: provider, llmRouter, policy: researchPolicy,
      classification: { authoritativeDomains: ['acme.com'] },
      fetchImpl
    });

    if (result.project.status !== 'RESEARCH_COMPLETE') {
      console.error('FAILED: Research project did not reach RESEARCH_COMPLETE.');
      console.error(`  status: ${result.project.status}`);
      console.error(`  stopReason: ${result.stopReason || result.project.stop_reason}`);
      cleanup(storage, dbPath);
      cleanedUp = true;
      process.exitCode = 1;
      return;
    }

    // The model Groq actually returned is not part of runResearchProject()'s
    // return shape -- the pipeline logs it into decision_log's
    // config_snapshot (CLAIM_EXTRACTION/EXTRACTED, src/research/pipeline.js),
    // the same place it already logs it for every other provider. Read it
    // back here, before closing storage, purely for this script's own
    // evidence output -- this is a read of existing data, not a pipeline
    // change or a parallel provenance mechanism.
    // decision_log has no research_project_id column -- subject_id points
    // at the source row for CLAIM_EXTRACTION entries instead (see
    // src/research/pipeline.js). This harness runs exactly one source
    // through exactly one Research project, so the most recent
    // CLAIM_EXTRACTION/EXTRACTED row is unambiguous.
    const extractionLog = storage.get(
      `SELECT provider, config_snapshot FROM decision_log
       WHERE stage = 'CLAIM_EXTRACTION' AND decision = 'EXTRACTED'
       ORDER BY created_at DESC LIMIT 1`
    );
    const groqProvider = extractionLog ? extractionLog.provider : null;
    const groqModel = extractionLog && extractionLog.config_snapshot
      ? JSON.parse(extractionLog.config_snapshot).model
      : null;

    const { project, claims, sources } = result;
    cleanup(storage, dbPath);
    cleanedUp = true;

    console.log('SUCCESS: real Groq-driven Research project reached RESEARCH_COMPLETE.');
    console.log(JSON.stringify({
      provider: groqProvider,
      model: groqModel,
      created: true,
      researchProjectId: project.id,
      opportunityId,
      status: project.status,
      stopReason: project.stop_reason,
      sourceCount: sources.length,
      claimCount: claims.length,
      claims: claims.map((c) => ({
        claim: c.claim, claim_type: c.claim_type, is_load_bearing: c.is_load_bearing, evidence_status: c.evidence_status
      }))
    }, null, 2));
  } catch (err) {
    if (!cleanedUp) {
      try { cleanup(storage, dbPath); } catch { /* best-effort cleanup */ }
    }
    console.error('FAILED: unexpected error while running the real Groq Research generation.');
    console.error(err.stack || err.message || err);
    process.exitCode = 1;
  }
}

main();
