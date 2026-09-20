import crypto from 'node:crypto';
import { BRIEF_STAGE } from './constants.js';
import { checkResearchEligibility } from './eligibility.js';
import { resolveAuthoritativeCoreQuestion } from './coreQuestion.js';
import { selectEligibleKeyClaims, validateKeyClaimIds } from './claims.js';
import { generateBriefFields, validateGeneratedBrief } from './generate.js';
import { canTransition, transition, InvalidTransitionError } from '../state/ContentStateMachine.js';
import { isQuarantined, recordFailedAttemptIfRetryable, retryFields, FAILURE_NATURE, RETRY_STAGE } from '../state/StageRetryPolicy.js';

/**
 * Records a decision_log entry, same shape/discipline as Research's and
 * Discovery's local logDecision helpers (stage is a first-class column,
 * never encoded into decision/reason).
 */
function logDecision(storage, { runId = null, stage, subjectType, subjectId, decision, reason, provider = null, resultingState = null, configSnapshot = null }, nowISO = () => new Date().toISOString()) {
  const id = crypto.randomUUID();
  storage.run(
    `INSERT INTO decision_log
      (id, run_id, subject_type, subject_id, decision, reason, provider, config_snapshot, confidence, risk_level, resulting_state, created_at, stage)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?)`,
    [id, runId, subjectType, subjectId, decision, reason, provider, configSnapshot ? JSON.stringify(configSnapshot) : null, resultingState, nowISO(), stage]
  );
  return id;
}

function fieldsToRow(parsed) {
  return {
    working_title: parsed.working_title,
    target_audience: parsed.target_audience,
    viewer_promise: parsed.viewer_promise,
    hook: parsed.hook,
    angle: parsed.angle,
    narrative_structure: parsed.narrative_structure,
    counterpoints: parsed.counterpoints,
    original_insights: parsed.original_insights,
    visual_ideas: parsed.visual_ideas,
    monetization_opportunities: parsed.monetization_opportunities,
    risk_assessment: parsed.risk_assessment
  };
}

/**
 * Creates (or, with `regenerate: true`, replaces) the canonical Brief for
 * a Research project (Brief Specification, D1-D16).
 *
 * This is the manual trigger surface for v1 (D7): a plain callable entry
 * point, in the same "run once, any driver may invoke it" style as
 * `runResearchProject` — no CLI/scheduler wrapper is introduced here,
 * matching the fact that Research itself has none yet either.
 *
 * @param {object} deps
 * @param {import('../storage/StorageDriver.js').StorageDriver} deps.storage
 * @param {string} deps.researchProjectId
 * @param {object} deps.llmRouter
 * @param {object} deps.policy - brief_policy.json
 * @param {boolean} [deps.regenerate] - explicit regeneration flag (D6). Without it, a duplicate request returns the existing canonical Brief unchanged.
 * @param {string} [deps.runId]
 */
export async function createBrief({ storage, researchProjectId, llmRouter, policy, regenerate = false, runId = null }) {
  const researchProject = storage.get('SELECT * FROM research_projects WHERE id = ?', [researchProjectId]);

  // --- D5/D6 idempotency fast path: an existing canonical Brief without an
  // explicit regeneration request is returned as-is, with no LLM call and
  // no re-validation — "does not generate another Brief unnecessarily".
  const existing = storage.get('SELECT * FROM content_briefs WHERE research_project_id = ?', [researchProjectId]);
  if (existing && !regenerate) {
    return { brief: existing, created: false, regenerated: false, rejected: false };
  }

  // --- A4 bounded-retry governance: a quarantined research project is refused
  // on direct invocation too (selection filtering is not the only guard).
  // Identity is (BRIEF, research_project_id): no content_version exists yet
  // and none is ever fabricated. Owner-only reactivation is the sole way out.
  if (isQuarantined(storage, researchProjectId, RETRY_STAGE.BRIEF)) {
    logDecision(storage, {
      runId, stage: BRIEF_STAGE.ELIGIBILITY_CHECK, subjectType: 'research_project',
      subjectId: researchProjectId, decision: 'QUARANTINE_REFUSED', reason: 'brief_quarantined_owner_reactivation_required'
    });
    return { outcome: 'QUARANTINED', rejected: true, reason: 'BRIEF_QUARANTINED', created: false, regenerated: false };
  }

  // --- D1: eligibility gate ---
  const eligibility = checkResearchEligibility(researchProject);
  if (!eligibility.eligible) {
    logDecision(storage, {
      runId, stage: BRIEF_STAGE.ELIGIBILITY_CHECK, subjectType: 'research_project',
      subjectId: researchProjectId, decision: 'REJECTED', reason: eligibility.reason
    });
    return { rejected: true, reason: eligibility.reason, created: false, regenerated: false };
  }
  logDecision(storage, {
    runId, stage: BRIEF_STAGE.ELIGIBILITY_CHECK, subjectType: 'research_project',
    subjectId: researchProjectId, decision: 'ELIGIBLE', reason: 'RESEARCH_COMPLETE'
  });

  // --- D14: deterministic core_question resolution ---
  const coreQuestionResult = resolveAuthoritativeCoreQuestion(storage, researchProjectId);
  if (!coreQuestionResult.ok) {
    logDecision(storage, {
      runId, stage: BRIEF_STAGE.CORE_QUESTION_RESOLUTION, subjectType: 'research_project',
      subjectId: researchProjectId, decision: 'REJECTED', reason: coreQuestionResult.reason
    });
    return { rejected: true, reason: coreQuestionResult.reason, created: false, regenerated: false };
  }
  const { coreQuestion, opportunity } = coreQuestionResult;

  // --- D2/D3/D10/D12: eligible key-claim pool; zero eligible -> no Brief ---
  const eligibleClaims = selectEligibleKeyClaims(storage, researchProjectId);
  logDecision(storage, {
    runId, stage: BRIEF_STAGE.KEY_CLAIM_ELIGIBILITY, subjectType: 'research_project',
    subjectId: researchProjectId, decision: 'COMPUTED', reason: `${eligibleClaims.length}_eligible_claims`
  });
  if (eligibleClaims.length === 0) {
    logDecision(storage, {
      runId, stage: BRIEF_STAGE.KEY_CLAIM_ELIGIBILITY, subjectType: 'research_project',
      subjectId: researchProjectId, decision: 'REJECTED', reason: 'NO_ELIGIBLE_KEY_CLAIMS'
    });
    return { rejected: true, reason: 'NO_ELIGIBLE_KEY_CLAIMS', created: false, regenerated: false };
  }

  // --- Generation + deterministic Validation, bounded retry (D11, §13) ---
  const maxAttempts = policy?.generation?.max_attempts ?? 3;
  let accepted = null;
  let attemptsUsed = 0;
  let lastFailureReason = null;

  while (attemptsUsed < maxAttempts && !accepted) {
    attemptsUsed++;
    const generation = await generateBriefFields({ coreQuestion, opportunity, eligibleClaims }, llmRouter);

    const structural = validateGeneratedBrief(generation.parsed);
    if (!structural.valid) {
      lastFailureReason = structural.reason;
      logDecision(storage, {
        runId, stage: BRIEF_STAGE.VALIDATION, subjectType: 'research_project', subjectId: researchProjectId,
        decision: 'REJECTED', reason: structural.reason, provider: generation.providerUsed,
        configSnapshot: { model: generation.model, estimatedCost: generation.estimatedCost, isPaid: generation.isPaid, attempt: attemptsUsed }
      });
      continue;
    }

    const claimIdCheck = validateKeyClaimIds(storage, researchProjectId, generation.parsed.key_claims);
    if (!claimIdCheck.valid) {
      lastFailureReason = claimIdCheck.reason;
      logDecision(storage, {
        runId, stage: BRIEF_STAGE.VALIDATION, subjectType: 'research_project', subjectId: researchProjectId,
        decision: 'REJECTED', reason: claimIdCheck.reason, provider: generation.providerUsed,
        configSnapshot: { model: generation.model, estimatedCost: generation.estimatedCost, isPaid: generation.isPaid, attempt: attemptsUsed }
      });
      continue;
    }

    accepted = generation;
  }

  if (!accepted) {
    // A4: this whole createBrief() call ending in GENERATION_RETRY_EXHAUSTED is
    // ONE A4 attempt under (BRIEF, research_project_id). A4 is a SEPARATE, autonomous-
    // invocation-level mechanism: the in-call generation loop above (its own
    // cap, policy.generation.max_attempts) is UNCHANGED and is neither counted
    // toward nor reset by A4. Worst case = 3 A4 attempts x the internal cap
    // (9 provider generations at the default cap of 3): Owner-accepted policy.
    // Evidence: every internal generation produced output that failed
    // validation; a later invocation draws fresh generations for this same
    // item, so the failure is item-specific and recoverable, not deterministic.
    // Log entry + counter + quarantine commit in ONE transaction.
    const retry = storage.transaction(() => {
      logDecision(storage, {
        runId, stage: BRIEF_STAGE.GENERATION, subjectType: 'research_project', subjectId: researchProjectId,
        decision: 'FAILED', reason: `RETRY_EXHAUSTED_${lastFailureReason}`
      });
      return recordFailedAttemptIfRetryable(storage, {
        outcome: 'GENERATION_RETRY_EXHAUSTED',
        evidence: { nature: FAILURE_NATURE.TRANSIENT, basis: 'generation_exhausted_output_failed_validation' },
        subjectId: researchProjectId, stage: RETRY_STAGE.BRIEF,
        reason: `GENERATION_RETRY_EXHAUSTED_${lastFailureReason}`, runId
      });
    });
    // No partial Brief, no lifecycle transition, Research state unchanged (D8, D16 failure behavior).
    return {
      rejected: true, reason: `GENERATION_RETRY_EXHAUSTED_${lastFailureReason}`, created: false, regenerated: false,
      attemptsUsed, ...retryFields(retry)
    };
  }

  logDecision(storage, {
    runId, stage: BRIEF_STAGE.GENERATION, subjectType: 'research_project', subjectId: researchProjectId,
    decision: 'ACCEPTED', reason: `accepted_on_attempt_${attemptsUsed}`, provider: accepted.providerUsed,
    configSnapshot: { model: accepted.model, estimatedCost: accepted.estimatedCost, isPaid: accepted.isPaid }
  });

  const row = fieldsToRow(accepted.parsed);
  const keyClaimsJson = JSON.stringify(accepted.parsed.key_claims);
  const nowISO = new Date().toISOString();

  // --- Atomic persist (+ lifecycle transition on first creation) ---
  // better-sqlite3 transactions are synchronous; all generation/LLM work is
  // already complete above, so everything inside this closure is a plain
  // synchronous DB write and can be wrapped safely (§14/§16: no partial
  // Brief, no incorrect BRIEF_CREATED transition on any failure here).
  const outcome = storage.transaction(() => {
    if (existing) {
      // D6: explicit regeneration replaces the canonical Brief in place —
      // same id, same created_at, content replaced. Brief id is stable, so
      // downstream FK references (Script, content_versions) remain valid;
      // no new content_versions row or lifecycle transition is needed,
      // since the pipeline was already at BRIEF_CREATED for this Research
      // project.
      storage.run(
        `UPDATE content_briefs SET
           working_title = ?, core_question = ?, target_audience = ?, viewer_promise = ?, hook = ?,
           angle = ?, narrative_structure = ?, key_claims = ?, counterpoints = ?, original_insights = ?,
           visual_ideas = ?, monetization_opportunities = ?, risk_assessment = ?
         WHERE id = ?`,
        [
          row.working_title, coreQuestion, row.target_audience, row.viewer_promise, row.hook,
          row.angle, row.narrative_structure, keyClaimsJson, row.counterpoints, row.original_insights,
          row.visual_ideas, row.monetization_opportunities, row.risk_assessment, existing.id
        ]
      );
      logDecision(storage, {
        runId, stage: BRIEF_STAGE.PERSISTED, subjectType: 'content_brief', subjectId: existing.id,
        decision: 'REPLACED', reason: 'explicit_regeneration'
      }, () => nowISO);
      return { briefId: existing.id, created: false, regenerated: true, contentVersionId: null };
    }

    const briefId = crypto.randomUUID();
    storage.run(
      `INSERT INTO content_briefs
        (id, opportunity_id, research_project_id, working_title, core_question, target_audience, viewer_promise,
         hook, angle, narrative_structure, key_claims, counterpoints, original_insights, visual_ideas,
         monetization_opportunities, risk_assessment, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        briefId, opportunity.id, researchProjectId, row.working_title, coreQuestion, row.target_audience,
        row.viewer_promise, row.hook, row.angle, row.narrative_structure, keyClaimsJson,
        row.counterpoints, row.original_insights, row.visual_ideas, row.monetization_opportunities,
        row.risk_assessment, nowISO
      ]
    );
    logDecision(storage, {
      runId, stage: BRIEF_STAGE.PERSISTED, subjectType: 'content_brief', subjectId: briefId,
      decision: 'CREATED', reason: 'brief_generation_accepted'
    }, () => nowISO);

    // D7/D15: RESEARCH_COMPLETE -> BRIEF_CREATED, only after successful
    // persistence, and only on first creation (regeneration does not move
    // the lifecycle state — it is already at BRIEF_CREATED). No content
    // version row exists yet for this piece of content (content_versions
    // requires a non-null content_brief_id, so this is necessarily its
    // first row) — that row is where the lifecycle state actually lives.
    if (!canTransition('RESEARCH_COMPLETE', 'BRIEF_CREATED')) {
      // Defensive: the state machine itself already guarantees this, but
      // Brief must not silently persist a Brief the lifecycle model would
      // reject.
      throw new InvalidTransitionError('RESEARCH_COMPLETE -> BRIEF_CREATED is not a valid transition');
    }
    const newState = transition('RESEARCH_COMPLETE', 'BRIEF_CREATED');

    const contentVersionId = crypto.randomUUID();
    storage.run(
      `INSERT INTO content_versions (id, content_brief_id, script_id, state, created_at)
       VALUES (?, ?, NULL, ?, ?)`,
      [contentVersionId, briefId, newState, nowISO]
    );
    logDecision(storage, {
      runId, stage: BRIEF_STAGE.LIFECYCLE_TRANSITION, subjectType: 'content_version', subjectId: contentVersionId,
      decision: 'BRIEF_CREATED', reason: 'brief_persisted', resultingState: newState
    }, () => nowISO);

    return { briefId, created: true, regenerated: false, contentVersionId };
  });

  const brief = storage.get('SELECT * FROM content_briefs WHERE id = ?', [outcome.briefId]);
  return {
    brief,
    created: outcome.created,
    regenerated: outcome.regenerated,
    rejected: false,
    contentVersionId: outcome.contentVersionId,
    attemptsUsed
  };
}