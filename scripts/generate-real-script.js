// Manual, opt-in, one-shot script. NOT part of `npm test`, NOT run at
// application startup, NOT part of the autonomous runner.
//
// Purpose: prove that a real 'groq-free' completion (via the existing
// GroqProvider / LLMRouter / candidates.js registry) can be consumed by
// the existing, unmodified createScript() pipeline end to end -- real
// generation, real structural + claim-reference validation, real bounded
// retry, real persistence, real lifecycle transition, real decision_log
// entries.
//
// Fixture strategy (mirrors tests/integration/script-pipeline-e2e.test.js's
// seedEligibleBrief() exactly): Script requires an already-persisted,
// structurally complete Brief. That Brief is produced via the real,
// unmodified createBrief() pipeline, but driven by a cheap deterministic
// stub router -- exactly as the existing e2e test does -- since proving
// real-Groq-through-the-pipeline is this milestone's job for the SCRIPT
// stage specifically, not the Brief stage (already proven separately by
// scripts/generate-real-brief.js). Only the Script-stage router is real
// Groq. This keeps the harness to one real API call and does not
// reproduce or bypass any Brief/Script validation.
//
// Nothing about Discovery, workSelection, publication, the scheduler, or
// the autonomous runner is touched or exercised here.
//
// Usage:
//   GROQ_FREE_API_KEY=... node scripts/generate-real-script.js
//
// Exit code is 0 only on a genuinely created (or regenerated) Script.
// Any failure -- missing key, rejected generation, thrown error -- exits
// non-zero with the real error/reason printed. No fallback to any other
// provider is attempted for the Script stage; that router is constructed
// with priority strictly limited to ['groq-free'].

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { SqliteStorageDriver } from '../src/storage/SqliteStorageDriver.js';
import { LLMRouter } from '../src/providers/llm/router.js';
import { createBrief } from '../src/brief/pipeline.js';
import { createScript } from '../src/script/pipeline.js';
import briefPolicy from '../config/brief_policy.json' with { type: 'json' };
import scriptPolicy from '../config/script_policy.json' with { type: 'json' };

function freshStorage() {
  const dbPath = path.join(os.tmpdir(), `script-real-groq-${Date.now()}-${Math.random()}.db`);
  return { storage: new SqliteStorageDriver({ dbPath }), dbPath };
}

function cleanup(storage, dbPath) {
  storage.close();
  fs.rmSync(dbPath, { force: true });
  fs.rmSync(`${dbPath}-wal`, { force: true });
  fs.rmSync(`${dbPath}-shm`, { force: true });
}

// Identical shape to seedResearchProject()/insertClaim() in
// tests/integration/script-pipeline-e2e.test.js.
function seedResearchProject(storage, { coreQuestion = 'Did the launch cause a measurable increase?' } = {}) {
  const opportunityId = crypto.randomUUID();
  storage.run(
    `INSERT INTO opportunities (id, title, description, source, discovered_at, status, opportunity_proposition)
     VALUES (?, 'Real Groq script generation smoke opportunity', 'A description', 'rss', ?, 'HANDED_TO_RESEARCH', ?)`,
    [opportunityId, new Date().toISOString(), JSON.stringify({ core_question: coreQuestion })]
  );
  const researchProjectId = crypto.randomUUID();
  storage.run(
    `INSERT INTO research_projects (id, opportunity_id, status, created_at) VALUES (?, ?, 'RESEARCH_COMPLETE', ?)`,
    [researchProjectId, opportunityId, new Date().toISOString()]
  );
  return { opportunityId, researchProjectId };
}

function insertClaim(storage, researchProjectId, claim) {
  const id = crypto.randomUUID();
  storage.run(
    `INSERT INTO claims (id, research_project_id, claim, claim_type, evidence_status, is_load_bearing, created_at)
     VALUES (?, ?, ?, 'FACT', 'VERIFIED', 1, ?)`,
    [id, researchProjectId, claim, new Date().toISOString()]
  );
  return id;
}

// Identical shape to wellFormedBriefFields() in the existing Script e2e
// test -- a structurally complete Brief content object for the stub
// router to return. This is fixture input to the (real, unmodified)
// Brief pipeline, not a hand-built Brief row.
function wellFormedBriefFields(keyClaims) {
  return {
    working_title: 'Real Groq Script Harness Brief', target_audience: 'Audience', viewer_promise: 'Promise',
    hook: 'Hook', angle: 'Angle', narrative_structure: 'Structure', counterpoints: 'Counterpoints',
    original_insights: 'Insights', visual_ideas: 'Visuals', monetization_opportunities: 'Monetization',
    risk_assessment: 'Risk', key_claims: keyClaims
  };
}

function stubRouterReturning(text) {
  const registry = {
    'brief-seed-stub': () => ({
      id: 'brief-seed-stub', isPaid: false,
      async healthCheck() { return true; },
      async complete() {
        return { text, model: 'brief-seed-stub', requestId: null, inputTokens: 1, outputTokens: 1, estimatedCost: 0, isPaid: false };
      }
    })
  };
  return new LLMRouter({ priority: ['brief-seed-stub'], allowPaidProviders: false, registry });
}

// Produces a real, persisted, eligible Brief via the actual createBrief()
// pipeline (deterministic stub-driven), exactly mirroring
// seedEligibleBrief() in tests/integration/script-pipeline-e2e.test.js.
async function seedEligibleBrief(storage) {
  const { researchProjectId } = seedResearchProject(storage);
  const claimId = insertClaim(storage, researchProjectId, 'Acme reported $1B revenue.');
  const briefRouter = stubRouterReturning(JSON.stringify(wellFormedBriefFields([claimId])));
  const briefResult = await createBrief({ storage, researchProjectId, llmRouter: briefRouter, policy: briefPolicy });
  if (briefResult.rejected) {
    throw new Error(`Fixture setup failed: createBrief() rejected the seed Brief (${briefResult.reason}). This is a fixture problem, not a Script-stage result.`);
  }
  return { researchProjectId, claimId, contentBriefId: briefResult.brief.id };
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

    const { contentBriefId } = await seedEligibleBrief(storage);

    // Explicitly limited to groq-free only for the Script-generation call
    // -- no reliance on the unrelated default provider ordering in
    // config.llmProviderPriority, and no silent fallback to any other
    // provider id (Gemini, OpenRouter, local-stub, etc.).
    const llmRouter = new LLMRouter({ priority: ['groq-free'] });

    console.log('Requesting a real Script generation via provider: groq-free ...');
    const result = await createScript({ storage, contentBriefId, llmRouter, policy: scriptPolicy });

    if (result.rejected) {
      console.error('FAILED: createScript() rejected the generation.');
      console.error(`  reason: ${result.reason}`);
      if (result.attemptsUsed) console.error(`  attemptsUsed: ${result.attemptsUsed}`);
      cleanup(storage, dbPath);
      cleanedUp = true;
      process.exitCode = 1;
      return;
    }

    // The model Groq actually returned is not part of createScript()'s
    // return shape -- the pipeline logs it into decision_log's
    // config_snapshot (SCRIPT_GENERATION/ACCEPTED, src/script/pipeline.js),
    // the same place it already logs it for every other provider. Read it
    // back here, before closing storage, purely for this script's own
    // evidence output -- this is a read of existing data, not a pipeline
    // change or a parallel provenance mechanism.
    const acceptedGenerationLog = storage.get(
      `SELECT config_snapshot FROM decision_log
       WHERE stage = 'SCRIPT_GENERATION' AND decision = 'ACCEPTED' AND subject_id = ?
       ORDER BY created_at DESC LIMIT 1`,
      [contentBriefId]
    );
    const groqModel = acceptedGenerationLog
      ? JSON.parse(acceptedGenerationLog.config_snapshot).model
      : null;

    const { script } = result;
    const body = JSON.parse(script.body);
    cleanup(storage, dbPath);
    cleanedUp = true;

    console.log('SUCCESS: real Groq-generated Script accepted and persisted.');
    console.log(JSON.stringify({
      provider: 'groq-free',
      model: groqModel,
      created: result.created,
      regenerated: result.regenerated,
      rejected: result.rejected,
      scriptId: script.id,
      contentBriefId: script.content_brief_id,
      version: script.version,
      sections: Array.isArray(body.sections) ? body.sections.length : 0,
      wordCount: [body.hook, body.narrative, body.counterpoints, body.conclusion,
        ...(Array.isArray(body.sections) ? body.sections.map((s) => `${s.heading} ${s.content}`) : [])]
        .join(' ').trim().split(/\s+/).filter(Boolean).length,
      hook: body.hook,
      excerpt: (body.narrative || '').slice(0, 240)
    }, null, 2));
  } catch (err) {
    if (!cleanedUp) {
      try { cleanup(storage, dbPath); } catch { /* best-effort cleanup */ }
    }
    console.error('FAILED: unexpected error while running the real Groq Script generation.');
    console.error(err.stack || err.message || err);
    process.exitCode = 1;
  }
}

main();
