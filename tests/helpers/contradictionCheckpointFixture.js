import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { SqliteStorageDriver } from '../../src/storage/SqliteStorageDriver.js';
import { LLMRouter } from '../../src/providers/llm/router.js';
import { ResearchSourceProvider } from '../../src/research/ResearchSourceProvider.js';
import { runResearchProject } from '../../src/research/pipeline.js';
import researchPolicy from '../../config/research_policy.json' with { type: 'json' };

// Shared fixture for the CONTRADICTION_PERSISTED checkpoint tests (Pass 40).
// Three authoritative sources -> three distinct load-bearing FACT claims ->
// three contradiction pairs (C0~C1, C0~C2, C1~C2 in canonical id order).

export const URLS = ['https://acme.com/a', 'https://acme.com/b', 'https://acme.com/c'];
export const CLAIM_TEXTS = ['Policy X took effect in 2024.', 'Policy X was repealed in 2024.', 'Policy X applies to all regions.'];

export function tmpDbPath() {
  return path.join(os.tmpdir(), `contradiction-checkpoint-${process.pid}-${Date.now()}-${Math.random()}.db`);
}
export function removeDb(dbPath) {
  for (const s of ['', '-wal', '-shm', '.killed']) fs.rmSync(`${dbPath}${s}`, { force: true });
}

export function seedOpportunity(storage) {
  const id = crypto.randomUUID();
  storage.run(
    `INSERT INTO opportunities (id, title, source, discovered_at, status, opportunity_proposition)
     VALUES (?, 'T', 'rss', ?, 'HANDED_TO_RESEARCH', ?)`,
    [id, new Date().toISOString(), JSON.stringify({
      subject: 'Test subject', target_audience: 'a', audience_problem: 'p',
      core_question: 'Did policy X take effect, and what were its effects?',
      gap: 'g', angle: 'a', differentiation: 'd', commercial_relevance: 'c', core_question_type: 'FACTUAL'
    })]
  );
  return id;
}

class Sources extends ResearchSourceProvider {
  get id() { return 'ccp-stub'; }
  async healthCheck() { return true; }
  async discoverCandidates() { return { candidates: URLS.map((url, i) => ({ url, title: `t${i}`, snippet: 's' })) }; }
}
const BODIES = {
  [URLS[0]]: '<html><body>The first outlet reported the quarterly results today.</body></html>',
  [URLS[1]]: '<html><body>The second outlet confirmed the quarterly results today.</body></html>',
  [URLS[2]]: '<html><body>The third outlet summarised the quarterly results today.</body></html>'
};
const fetchImpl = async (url) => ({ ok: true, status: 200, headers: { get: () => 'text/html' }, text: async () => BODIES[url] });

/** Extraction call n returns claim n (then repeats the last one for any later LLM call). */
export function claimRouter() {
  let call = 0;
  const registry = {
    seq: () => ({
      id: 'seq', isPaid: false,
      async healthCheck() { return true; },
      async complete() {
        const text = CLAIM_TEXTS[Math.min(call, CLAIM_TEXTS.length - 1)];
        call += 1;
        return { text: JSON.stringify([{ claim: text, claim_type: 'FACT', is_load_bearing: true }]), model: 'seq', requestId: null, inputTokens: 1, outputTokens: 1, estimatedCost: 0, isPaid: false };
      }
    })
  };
  return new LLMRouter({ priority: ['seq'], allowPaidProviders: false, registry });
}

/** Scripted detector: each entry is a verdict string or an Error to throw. Counts its calls. */
export function scriptedDetector(script) {
  const fn = async () => {
    const step = script[Math.min(fn.calls, script.length - 1)];
    fn.calls += 1;
    if (step instanceof Error) throw step;
    return step;
  };
  fn.calls = 0;
  return fn;
}

export const httpError = (status) => Object.assign(new Error(`HTTP ${status}`), { status });

export function runPipeline(storage, opportunityId, detectContradiction) {
  return runResearchProject({
    storage, opportunityId, sourceProvider: new Sources(), llmRouter: claimRouter(), policy: researchPolicy,
    classification: { authoritativeDomains: ['acme.com'] }, fetchImpl, detectContradiction
  });
}

export function openDb(dbPath) { return new SqliteStorageDriver({ dbPath }); }

/** Id-free snapshot of everything contradiction-related plus the terminal outcome. */
export function snapshot(storage) {
  const text = new Map(storage.all('SELECT id, claim FROM claims').map((r) => [r.id, r.claim]));
  const norm = (s) => String(s ?? '').replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, (id) => `<${text.get(id) ?? id}>`);
  const project = storage.get('SELECT status, stop_reason FROM research_projects');
  return {
    project: { status: project.status, stopReason: project.stop_reason },
    relations: storage.all('SELECT claim_id, related_claim_id FROM claim_relations')
      .map((r) => [text.get(r.claim_id), text.get(r.related_claim_id)].sort().join(' ~ ')).sort(),
    statuses: storage.all('SELECT claim, evidence_status FROM claims ORDER BY claim').map((r) => `${r.claim} => ${r.evidence_status}`),
    // Claim ids are random, so which claim of a pair is the canonical "subject"
    // varies between runs: pairs are compared as unordered claim-text pairs.
    contradictionDecisions: storage.all("SELECT subject_type, subject_id, decision, reason FROM decision_log WHERE stage = 'CONTRADICTION_CHECK'")
      .map((r) => {
        const other = String(r.reason ?? '').match(/[0-9a-f]{8}-[0-9a-f-]{27}$/)?.[0];
        if (r.subject_type === 'claim' && other) {
          return `${[text.get(r.subject_id), text.get(other)].sort().join(' ~ ')} | ${r.decision}`;
        }
        return `${r.subject_type} | ${r.decision} | ${norm(r.reason)}`;
      }).sort(),
    grading: storage.all("SELECT subject_id, decision, reason FROM decision_log WHERE stage = 'EVIDENCE_GRADING'")
      .map((r) => `${norm(r.subject_id)} | ${r.decision} | ${r.reason}`).sort()
  };
}
