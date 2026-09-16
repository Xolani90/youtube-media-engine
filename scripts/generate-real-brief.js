// Manual, opt-in, one-shot script. NOT part of `npm test`, NOT run at
// application startup, NOT part of the autonomous runner.
//
// Purpose: prove that a real 'groq-free' completion (via the existing
// GroqProvider / LLMRouter / candidates.js registry) can be consumed by
// the existing, unmodified createBrief() pipeline end to end -- real
// generation, real structural + claim-id validation, real bounded retry,
// real persistence, real lifecycle transition, real decision_log entries.
//
// This script deliberately reuses the exact fixture-construction shape
// from tests/integration/brief-pipeline-e2e.test.js (fresh temp SQLite
// file, migrate, seed one RESEARCH_COMPLETE opportunity/research_project
// with one eligible VERIFIED FACT claim) rather than inventing a parallel
// data model. Nothing about Discovery, workSelection, publication, the
// scheduler, or the autonomous runner is touched or exercised here.
//
// Usage:
//   GROQ_FREE_API_KEY=... node scripts/generate-real-brief.js
//
// Exit code is 0 only on a genuinely created (or regenerated) Brief.
// Any failure -- missing key, rejected generation, thrown error -- exits
// non-zero with the real error/reason printed. No fallback to any other
// provider is attempted; the router is constructed with priority strictly
// limited to ['groq-free'].

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { SqliteStorageDriver } from '../src/storage/SqliteStorageDriver.js';
import { LLMRouter } from '../src/providers/llm/router.js';
import { createBrief } from '../src/brief/pipeline.js';
import briefPolicy from '../config/brief_policy.json' with { type: 'json' };

function freshStorage() {
  const dbPath = path.join(os.tmpdir(), `brief-real-groq-${Date.now()}-${Math.random()}.db`);
  return { storage: new SqliteStorageDriver({ dbPath }), dbPath };
}

function cleanup(storage, dbPath) {
  storage.close();
  fs.rmSync(dbPath, { force: true });
  fs.rmSync(`${dbPath}-wal`, { force: true });
  fs.rmSync(`${dbPath}-shm`, { force: true });
}

// Identical shape to seedResearchProject() in
// tests/integration/brief-pipeline-e2e.test.js -- the minimum Research
// output createBrief() requires: a RESEARCH_COMPLETE research_project
// linked to an opportunity, plus one eligible (FACT, VERIFIED) claim.
function seedResearchProject(storage, { coreQuestion = 'Did the launch cause a measurable increase?' } = {}) {
  const opportunityId = crypto.randomUUID();
  storage.run(
    `INSERT INTO opportunities (id, title, description, source, discovered_at, status, opportunity_proposition)
     VALUES (?, 'Real Groq generation smoke opportunity', 'A description', 'rss', ?, 'HANDED_TO_RESEARCH', ?)`,
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

    const { researchProjectId } = seedResearchProject(storage);
    const claimId = insertClaim(storage, researchProjectId, 'Acme reported $1B revenue.');

    // Explicitly limited to groq-free only -- no reliance on the
    // unrelated default provider ordering in config.llmProviderPriority,
    // and no silent fallback to any other provider id.
    const llmRouter = new LLMRouter({ priority: ['groq-free'] });

    console.log('Requesting a real Brief generation via provider: groq-free ...');
    const result = await createBrief({ storage, researchProjectId, llmRouter, policy: briefPolicy });

    if (result.rejected) {
      console.error('FAILED: createBrief() rejected the generation.');
      console.error(`  reason: ${result.reason}`);
      if (result.attemptsUsed) console.error(`  attemptsUsed: ${result.attemptsUsed}`);
      cleanup(storage, dbPath);
      cleanedUp = true;
      process.exitCode = 1;
      return;
    }

    // The model Groq actually returned is not part of createBrief()'s
    // return shape -- the pipeline logs it into decision_log's
    // config_snapshot (see BRIEF_GENERATION/ACCEPTED, src/brief/pipeline.js),
    // the same place it already logs it for every other provider. Read it
    // back here, before closing storage, purely for this script's own
    // evidence output -- this is a read of existing data, not a pipeline
    // change.
    const acceptedGenerationLog = storage.get(
      `SELECT config_snapshot FROM decision_log
       WHERE stage = 'BRIEF_GENERATION' AND decision = 'ACCEPTED' AND subject_id = ?
       ORDER BY created_at DESC LIMIT 1`,
      [researchProjectId]
    );
    const groqModel = acceptedGenerationLog
      ? JSON.parse(acceptedGenerationLog.config_snapshot).model
      : null;

    const { brief } = result;
    cleanup(storage, dbPath);
    cleanedUp = true;
    console.log('SUCCESS: real Groq-generated Brief accepted and persisted.');
    console.log(JSON.stringify({
      provider: 'groq-free',
      model: groqModel,
      created: result.created,
      regenerated: result.regenerated,
      rejected: result.rejected,
      briefId: brief.id,
      researchProjectId: brief.research_project_id,
      opportunityId: brief.opportunity_id,
      coreQuestion: brief.core_question,
      keyClaims: JSON.parse(brief.key_claims),
      briefFields: {
        working_title: brief.working_title,
        target_audience: brief.target_audience,
        viewer_promise: brief.viewer_promise,
        hook: brief.hook,
        angle: brief.angle,
        narrative_structure: brief.narrative_structure,
        counterpoints: brief.counterpoints,
        original_insights: brief.original_insights,
        visual_ideas: brief.visual_ideas,
        monetization_opportunities: brief.monetization_opportunities,
        risk_assessment: brief.risk_assessment
      }
    }, null, 2));

    // content_versions lifecycle transition (BRIEF_CREATED) and the
    // BRIEF_ELIGIBILITY_CHECK / BRIEF_KEY_CLAIM_ELIGIBILITY / BRIEF_GENERATION
    // / BRIEF_PERSISTED decision_log stages are recorded synchronously
    // inside createBrief() before it returns -- the e2e test already
    // proves that behavior unconditionally. This script's job is only to
    // prove a real groq-free response drove this same, unmodified path,
    // which the 'created'/'brief' evidence above already establishes.
    // (Note: the model name/requestId/token usage Groq actually returned
    // are not part of createBrief()'s return shape -- they are logged to
    // decision_log's config_snapshot by the pipeline itself, consistent
    // with how it already treats every other provider.)
  } catch (err) {
    if (!cleanedUp) {
      try { cleanup(storage, dbPath); } catch { /* best-effort cleanup */ }
    }
    console.error('FAILED: unexpected error while running the real Groq generation.');
    console.error(err.stack || err.message || err);
    process.exitCode = 1;
  }
}

main();
