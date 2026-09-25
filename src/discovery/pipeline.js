import crypto from 'node:crypto';
import { checkDuplicate, DEDUP_RESULT, generateUnderlyingEventId, createDedupWorkloadBudget } from './dedup.js';
import { checkHardEligibility } from './eligibility.js';
import { generateProposition, validateProposition } from './proposition.js';
import { computeValueScore } from './scoring.js';
import { evaluateOpportunityRisk } from './riskGate.js';
import { selectDiversePortfolio } from './diversity.js';
import { STAGE, REJECTION_REASON, DEDUP_WORKLOAD, CEILING_REASON, LLM_PROVIDER_UNAVAILABLE } from './constants.js';
import { RISK_LEVELS } from '../state/RiskPolicy.js';
import { traceAsync } from '../diagnostics/trace.js';

/**
 * Records a decision_log entry with `stage` as a first-class field
 * (v0.6 §16 — never encoded into decision/reason).
 */
function logDecision(storage, { runId, stage, subjectId, decision, reason, provider = null, confidence = null, riskLevel = null, resultingState = null, configSnapshot = null }) {
  const id = crypto.randomUUID();
  storage.run(
    `INSERT INTO decision_log
      (id, run_id, subject_type, subject_id, decision, reason, provider, config_snapshot, confidence, risk_level, resulting_state, created_at, stage)
     VALUES (?, ?, 'opportunity', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, runId, subjectId, decision, reason, provider, configSnapshot ? JSON.stringify(configSnapshot) : null, confidence, riskLevel, resultingState, new Date().toISOString(), stage]
  );
  return id;
}

/**
 * Shared helper for the one SKIPPED/LLM_PROVIDER_UNAVAILABLE decision shape
 * used at both the PROPOSITION_GENERATION and FEATURE_COMPUTATION pipeline
 * boundaries when the underlying failure is LLMRouter reporting that every
 * eligible provider failed transiently (`err.llmProviderUnavailable ===
 * true` -- see LLMRouter#complete and classifyProviderFailure). Kept to a
 * single decision-log call so the two boundaries can't drift in shape.
 */
function logProviderUnavailableSkip(storage, { runId, stage, subjectId, errorMessage }) {
  logDecision(storage, {
    runId, stage, subjectId,
    decision: 'SKIPPED', reason: LLM_PROVIDER_UNAVAILABLE,
    resultingState: 'SKIPPED', configSnapshot: { errorMessage }
  });
}

function insertOpportunity(storage, opp) {
  storage.run(
    `INSERT INTO opportunities
      (id, run_id, title, description, source, source_url, discovered_at, category, keywords, audience,
       commercial_intent, novelty, competition, story_potential, evidence_availability, production_difficulty,
       monetization_potential, policy_risk, copyright_risk, repetition_risk, overall_score, score_breakdown,
       status, opportunity_proposition, underlying_event_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      opp.id, opp.runId, opp.title, opp.description, opp.source, opp.sourceUrl, opp.discoveredAt,
      opp.category ?? null, opp.keywords ? JSON.stringify(opp.keywords) : null, opp.audience ?? null,
      opp.commercialIntent ?? null, opp.novelty ?? null, opp.competition ?? null, opp.storyPotential ?? null,
      opp.evidenceAvailability ?? null, opp.productionDifficulty ?? null, opp.monetizationPotential ?? null,
      opp.policyRisk ?? null, opp.copyrightRisk ?? null, opp.repetitionRisk ?? null, opp.overallScore ?? null,
      opp.scoreBreakdown ? JSON.stringify(opp.scoreBreakdown) : null, opp.status,
      opp.opportunityProposition ? JSON.stringify(opp.opportunityProposition) : null, opp.underlyingEventId ?? null
    ]
  );
}

/**
 * Runs the full Opportunity Discovery pipeline (v0.6 §3) over a batch of
 * normalized observations. Persists accepted/rejected opportunities and
 * every decision to the provided storage.
 *
 * @param observations - array of normalized observations (see RssSource.normalize)
 * @param rawFeatures - fn(observation) => { novelty, competition, story_potential,
 *   evidence_availability, production_difficulty, audience_potential,
 *   commercial_intent, affiliate_potential, lead_generation_potential,
 *   product_adjacency, sponsorship_potential, policyRisk, copyrightRisk,
 *   repetitionRisk } — raw (0-100 for value dims, 0-1 for risk dims) feature
 *   computation. This is deliberately injectable so tests can supply
 *   synthetic feature values without needing real evidence-gathering logic
 *   (which belongs to the separately-scoped Research subsystem).
 */
export async function runDiscoveryPipeline({
  storage, runId, observations, llmRouter, discoveryPolicy, scoringWeights,
  alreadyProducedCorpus = [], topK, rawFeatures, evaluationStore = null,
  evaluationSchedule = null, freshEvaluationBudget = Infinity,
  // ADR-0038: run-scoped, independent L2/L3 dedup workload budget. A caller
  // override (tests/controlled callers) still wins; the production default
  // is the frozen 4,950/4,950 ceilings tied to the RSS global admission cap.
  dedupWorkloadBudget = createDedupWorkloadBudget({
    l2Cap: DEDUP_WORKLOAD.L2_COMPARISON_CAP,
    l3Cap: DEDUP_WORKLOAD.L3_SEMANTIC_CALL_CAP
  })
}) {
  const stats = {
    discovered: observations.length, dedupRejected: 0, eligibilityRejected: 0, propositionRejected: 0,
    featureRejected: 0, scored: 0, riskVetoed: 0, selected: 0, diversityExcluded: 0,
    // ADR-0034: reused = took the ADR-0033 reuse path; freshEvaluated = a
    // fresh evaluation was durably committed (regardless of later risk-veto
    // or diversity exclusion); budgetSkipped = required a fresh evaluation
    // but the run's freshEvaluationBudget was exhausted first.
    reused: 0, freshEvaluated: 0, budgetSkipped: 0,
    // Feature computation (rawFeatures) failed solely because every
    // eligible LLM provider was transiently unavailable (LLMRouter's
    // `llmProviderUnavailable` flag) -- distinct from featureRejected,
    // which remains a durable, non-transient rejection. Not counted
    // toward freshEvaluated (no durable evaluation was committed) or
    // budgetSkipped (this candidate was not schedule-skipped).
    providerUnavailable: 0,
    // ADR-0038: a candidate whose dedup comparison set was only partially
    // evaluated because an L2/L3 workload ceiling was reached. Never pushed
    // into `accepted`, so it is absent from scoredCandidates/selected and
    // automatically becomes NOT_SCORED_UNRESOLVED via the existing
    // ADR-0033/0034 ledger classification -- no ledger changes needed.
    dedupUnresolved: 0
  };
  // ADR-0038: occurrence-level ceiling booleans for this run's dedup workload.
  const ceilings = { l2ComparisonCapReached: false, l3SemanticCallCapReached: false };
  const accepted = []; // observations that survived dedup + eligibility, carrying underlyingEventId

  for (const observation of observations) {
    let dedupResolvedDuplicate = false;
    let dedupUnresolved = false;
    let underlyingEventId = null;
    let distinctAngle = null;

    for (const existing of accepted) {
      const dedupResult = await checkDuplicate(observation, existing.observation, {
        thresholds: discoveryPolicy.thresholds.dedup.similarity,
        llmRouter,
        budget: dedupWorkloadBudget
      });

      if (dedupResult.eventMatch === DEDUP_RESULT.UNRESOLVED) {
        // ADR-0038: an L2/L3 workload ceiling was reached before this pair
        // could be resolved. Never fabricated as DUPLICATE or DISTINCT --
        // the candidate is left out of `accepted` entirely so it lands on
        // NOT_SCORED_UNRESOLVED via the existing ledger classification.
        dedupUnresolved = true;
        const ceilingReasonCode = dedupResult.ceilingReason === 'L3'
          ? CEILING_REASON.DISCOVERY_L3_SEMANTIC_CALL_CAP_REACHED
          : CEILING_REASON.DISCOVERY_L2_COMPARISON_CAP_REACHED;
        if (dedupResult.ceilingReason === 'L3') {
          ceilings.l3SemanticCallCapReached = true;
        } else {
          ceilings.l2ComparisonCapReached = true;
        }
        logDecision(storage, {
          runId, stage: STAGE.EVENT_DEDUP, subjectId: observation.sourceId || observation.sourceUrl || 'unknown',
          decision: 'UNRESOLVED', reason: ceilingReasonCode,
          resultingState: 'NOT_SCORED_UNRESOLVED', configSnapshot: { layersUsed: dedupResult.layersUsed }
        });
        break;
      }

      if (dedupResult.eventMatch === DEDUP_RESULT.DUPLICATE) {
        if (dedupResult.distinctAngle) {
          underlyingEventId = existing.underlyingEventId;
          distinctAngle = true;
        } else {
          dedupResolvedDuplicate = true;
          logDecision(storage, {
            runId, stage: STAGE.EVENT_DEDUP, subjectId: observation.sourceId || observation.sourceUrl || 'unknown',
            decision: 'REJECTED', reason: REJECTION_REASON.DUPLICATE,
            resultingState: 'REJECTED', configSnapshot: { layersUsed: dedupResult.layersUsed, llmCallMade: dedupResult.llmCallMade }
          });
          break;
        }
      }
    }

    if (dedupUnresolved) {
      stats.dedupUnresolved++;
      continue;
    }

    if (dedupResolvedDuplicate) {
      stats.dedupRejected++;
      continue;
    }

    const eligibility = checkHardEligibility(observation, {
      alreadyProducedCorpus,
      dedupResolvedDuplicate: false, // already filtered above
      thresholds: discoveryPolicy.thresholds
    });

    const candidateId = crypto.randomUUID();

    if (!eligibility.eligible) {
      stats.eligibilityRejected++;
      logDecision(storage, {
        runId, stage: STAGE.HARD_ELIGIBILITY, subjectId: candidateId,
        decision: 'REJECTED', reason: eligibility.reason, resultingState: 'REJECTED'
      });
      continue;
    }

    accepted.push({
      id: candidateId,
      observation,
      underlyingEventId: underlyingEventId || generateUnderlyingEventId(),
      distinctAngle
    });
  }

  // Proposition generation + validation, scoring, for every eligible candidate.
  // ADR-0033: when an evaluationStore is supplied and holds a valid durable
  // record for this observation, reuse it instead of calling the proposition
  // and feature LLMs again. A missing/invalid record falls through to the
  // unmodified fresh-evaluation path. Absence of a store is byte-for-byte
  // the baseline behavior.
  // ADR-0034: reuse-first, then a per-run budget on fresh evaluations.
  // Reuse is decided exactly as ADR-0033 always has (evaluationStore.lookup,
  // unaffected by scheduling). Only candidates that are NOT reusable enter
  // scheduling: ordered oldest-last-fresh-evaluation-first (never-evaluated
  // first), the first `freshEvaluationBudget` of them proceed; the rest are
  // skipped for this run entirely (no LLM calls, no opportunity persisted,
  // schedule state untouched) and remain eligible in future runs.
  const reuseByCandidateId = new Map();
  const needsFresh = [];
  for (const candidate of accepted) {
    const reused = evaluationStore ? evaluationStore.lookup(candidate.observation) : null;
    if (reused) {
      reuseByCandidateId.set(candidate.id, reused);
    } else {
      needsFresh.push(candidate);
    }
  }

  const budgetSkippedIds = new Set();
  if (evaluationSchedule && Number.isFinite(freshEvaluationBudget) && needsFresh.length > freshEvaluationBudget) {
    const ordered = needsFresh
      .map((candidate) => ({
        candidate,
        lastFreshEvaluatedAt: evaluationSchedule.lastFreshEvaluatedAt(candidate.observation),
        identityKey: evaluationSchedule.identityKey(candidate.observation)
      }))
      .sort((a, b) => {
        // last_fresh_evaluation_at ASC NULLS FIRST, identity_key ASC
        if (a.lastFreshEvaluatedAt === null && b.lastFreshEvaluatedAt !== null) return -1;
        if (a.lastFreshEvaluatedAt !== null && b.lastFreshEvaluatedAt === null) return 1;
        if (a.lastFreshEvaluatedAt !== b.lastFreshEvaluatedAt) {
          return a.lastFreshEvaluatedAt < b.lastFreshEvaluatedAt ? -1 : 1;
        }
        return (a.identityKey ?? '').localeCompare(b.identityKey ?? '');
      });
    for (const entry of ordered.slice(freshEvaluationBudget)) {
      budgetSkippedIds.add(entry.candidate.id);
    }
  }

  const scoredCandidates = [];
  for (const candidate of accepted) {
    if (budgetSkippedIds.has(candidate.id)) {
      stats.budgetSkipped++;
      logDecision(storage, {
        runId, stage: STAGE.PROPOSITION_GENERATION, subjectId: candidate.id,
        decision: 'SKIPPED', reason: 'fresh_evaluation_budget_exhausted', resultingState: 'SKIPPED'
      });
      continue;
    }

    const reused = reuseByCandidateId.get(candidate.id) ?? null;
    let proposition;
    let raw;

    if (reused) {
      stats.reused++;
      proposition = reused.proposition;
      raw = reused.raw;
      logDecision(storage, {
        runId, stage: STAGE.PROPOSITION_GENERATION, subjectId: candidate.id,
        decision: 'REUSED', reason: 'durable_evaluation_reused',
        configSnapshot: { completedAt: reused.completedAt, contractVersion: reused.contractVersion, auditMetadata: reused.auditMetadata }
      });
      logDecision(storage, {
        runId, stage: STAGE.PROPOSITION_VALIDATION, subjectId: candidate.id,
        decision: 'ACCEPTED', reason: 'proposition_valid', resultingState: 'PROPOSITION_VALID'
      });
    } else {
      let genResult;
      // generateProposition() calls LLMRouter#complete() -- if every
      // eligible provider failed transiently (timeout / exhausted 429;
      // see classifyProviderFailure), that surfaces here as an aggregate
      // error with `llmProviderUnavailable === true`. That specific,
      // narrowly-classified condition is handled as a per-candidate skip
      // (the same SKIPPED/LLM_PROVIDER_UNAVAILABLE shape used below for
      // feature computation) so a transient provider outage does not
      // abort the entire Discovery run. Any other error (validation bugs,
      // non-transient HTTP statuses, unexpected exceptions) is NOT this
      // condition and must still propagate/fail the run normally.
      try {
        genResult = await traceAsync('discovery.proposition', { candidate: candidate.id }, () => generateProposition(candidate.observation, llmRouter));
      } catch (err) {
        if (err && err.llmProviderUnavailable === true) {
          stats.providerUnavailable++;
          logProviderUnavailableSkip(storage, {
            runId, stage: STAGE.PROPOSITION_GENERATION, subjectId: candidate.id, errorMessage: err.message
          });
          continue;
        }
        throw err;
      }
      logDecision(storage, {
        runId, stage: STAGE.PROPOSITION_GENERATION, subjectId: candidate.id,
        decision: 'GENERATED', reason: 'proposition_generation_completed', provider: genResult.providerUsed,
        configSnapshot: { model: genResult.model, rawOutput: genResult.rawOutput, estimatedCost: genResult.estimatedCost, isPaid: genResult.isPaid }
      });

      const validation = validateProposition(genResult.proposition);
      if (!validation.valid) {
        stats.propositionRejected++;
        logDecision(storage, {
          runId, stage: STAGE.PROPOSITION_VALIDATION, subjectId: candidate.id,
          decision: 'REJECTED', reason: REJECTION_REASON.INELIGIBLE_NO_VIABLE_PROPOSITION,
          resultingState: 'REJECTED', configSnapshot: { validationDetail: validation.reason }
        });
        continue;
      }
      logDecision(storage, {
        runId, stage: STAGE.PROPOSITION_VALIDATION, subjectId: candidate.id,
        decision: 'ACCEPTED', reason: 'proposition_valid', resultingState: 'PROPOSITION_VALID'
      });

      proposition = genResult.proposition;
      // Feature computation (e.g. computeRawFeatures) intentionally throws
      // on malformed/truncated LLM output rather than fabricating a score
      // -- see src/discovery/featureComputation.js's own contract. That
      // throw must not be allowed to propagate out of the pipeline (which
      // would abort the entire Discovery run over a single candidate); it
      // is handled here, at the pipeline boundary, as a per-candidate
      // rejection -- the same shape as the PROPOSITION_VALIDATION rejection
      // above -- so the failing candidate is skipped and the loop proceeds
      // to the next one.
      try {
        raw = await traceAsync('discovery.features', { candidate: candidate.id }, () => rawFeatures(candidate.observation));
      } catch (err) {
        // A rawFeatures() throw whose root cause is LLMRouter reporting
        // that every eligible provider failed transiently (timeout /
        // exhausted 429 -- never an explicit 4xx, a config error, or an
        // arbitrary unexpected exception; see LLMRouter#complete and
        // classifyProviderFailure) is a temporary provider-unavailable
        // condition, not a genuine feature-computation rejection: it is
        // logged as SKIPPED and does not consume this candidate's
        // eligibility permanently the way featureRejected does.
        if (err && err.llmProviderUnavailable === true) {
          stats.providerUnavailable++;
          logProviderUnavailableSkip(storage, {
            runId, stage: STAGE.FEATURE_COMPUTATION, subjectId: candidate.id, errorMessage: err.message
          });
          continue;
        }
        stats.featureRejected++;
        logDecision(storage, {
          runId, stage: STAGE.FEATURE_COMPUTATION, subjectId: candidate.id,
          decision: 'REJECTED', reason: REJECTION_REASON.INELIGIBLE_FEATURE_COMPUTATION_FAILED,
          resultingState: 'REJECTED', configSnapshot: { errorMessage: err.message }
        });
        continue;
      }

      if (evaluationStore) {
        const commitEvaluation = () => {
          evaluationStore.commit(candidate.observation, {
            proposition,
            raw,
            audit: { proposition: { provider: genResult.providerUsed, model: genResult.model } }
          });
          // ADR-0034: the schedule timestamp is written in the SAME
          // transaction as the discovery_evaluations commit above, and only
          // once that commit is part of a transaction that will actually
          // succeed -- never on a partial/failed commit.
          if (evaluationSchedule) evaluationSchedule.recordFreshEvaluation(candidate.observation);
        };
        if (evaluationSchedule) {
          storage.transaction(commitEvaluation);
        } else {
          commitEvaluation();
        }
      }
      // A successful fresh evaluation is one whose durable evaluation (and,
      // when scheduling is active, schedule timestamp) has been persisted --
      // independent of downstream scoring/risk/diversity outcomes.
      stats.freshEvaluated++;
    }
    const { overallScore, breakdown } = computeValueScore(
      {
        novelty: raw.novelty, competition: raw.competition, story_potential: raw.story_potential,
        evidence_availability: raw.evidence_availability, production_difficulty: raw.production_difficulty,
        audience_potential: raw.audience_potential, commercial_intent: raw.commercial_intent,
        affiliate_potential: raw.affiliate_potential, lead_generation_potential: raw.lead_generation_potential,
        product_adjacency: raw.product_adjacency, sponsorship_potential: raw.sponsorship_potential
      },
      { weightsConfig: scoringWeights, normalizationConfig: discoveryPolicy.normalization, discoveryPolicyVersion: discoveryPolicy.version }
    );
    stats.scored++;
    logDecision(storage, {
      runId, stage: STAGE.VALUE_SCORE, subjectId: candidate.id,
      decision: 'SCORED', reason: 'value_score_computed', resultingState: 'SCORED',
      configSnapshot: { overallScore, weightsVersion: scoringWeights.version, normalizationVersion: discoveryPolicy.version }
    });

    const risk = evaluateOpportunityRisk(
      { policyRisk: raw.policyRisk, copyrightRisk: raw.copyrightRisk, repetitionRisk: raw.repetitionRisk },
      discoveryPolicy.thresholds.risk
    );

    const vetoed = risk.action === 'STOP_AND_ESCALATE';
    logDecision(storage, {
      runId, stage: STAGE.RISK_GATE, subjectId: candidate.id,
      decision: vetoed ? 'REJECTED' : 'PASS', reason: vetoed ? risk.flagsRaised[0] : 'risk_acceptable',
      riskLevel: risk.level, resultingState: vetoed ? 'REJECTED' : 'RISK_CLEARED'
    });

    scoredCandidates.push({
      id: candidate.id,
      observation: candidate.observation,
      underlyingEventId: candidate.underlyingEventId,
      overallScore,
      breakdown,
      raw,
      riskLevel: risk.level,
      vetoed,
      proposition
    });

    if (vetoed) stats.riskVetoed++;
  }

  const riskCleared = scoredCandidates.filter((c) => !c.vetoed);
  riskCleared.sort((a, b) => b.overallScore - a.overallScore);

  const { selected, excluded } = selectDiversePortfolio(riskCleared, topK);
  stats.selected = selected.length;
  stats.diversityExcluded = excluded.filter((e) => e.reason !== 'TOP_K_REACHED').length;

  for (const c of excluded) {
    if (c.reason === 'TOP_K_REACHED') continue; // not a diversity exclusion, just insufficient slots
    logDecision(storage, {
      runId, stage: STAGE.DIVERSITY_SELECTION, subjectId: c.candidate.id,
      decision: 'NOT_SELECTED', reason: c.reason, resultingState: 'NOT_SELECTED'
    });
  }

  // Persist every scored candidate (selected or not) — v0.6: unresearched-
  // but-scored opportunities persist rather than being discarded.
  for (const c of scoredCandidates) {
    const isSelected = selected.some((s) => s.id === c.id);
    insertOpportunity(storage, {
      id: c.id, runId, title: c.observation.title, description: c.observation.description,
      source: c.observation.sourceType || 'rss', sourceUrl: c.observation.sourceUrl,
      discoveredAt: c.observation.discoveredAt, novelty: c.raw.novelty, competition: c.raw.competition,
      storyPotential: c.raw.story_potential, evidenceAvailability: c.raw.evidence_availability,
      productionDifficulty: c.raw.production_difficulty, monetizationPotential:
        (c.raw.audience_potential + c.raw.commercial_intent + c.raw.affiliate_potential + c.raw.lead_generation_potential + c.raw.product_adjacency + c.raw.sponsorship_potential) / 6,
      policyRisk: c.raw.policyRisk, copyrightRisk: c.raw.copyrightRisk, repetitionRisk: c.raw.repetitionRisk,
      overallScore: c.overallScore, scoreBreakdown: c.breakdown,
      status: c.vetoed ? 'REJECTED' : (isSelected ? 'HANDED_TO_RESEARCH' : 'SCORED'),
      underlyingEventId: c.underlyingEventId, opportunityProposition: c.proposition
    });
    if (isSelected) {
      logDecision(storage, {
        runId, stage: STAGE.DIVERSITY_SELECTION, subjectId: c.id,
        decision: 'SELECTED', reason: 'top_k_selected', resultingState: 'HANDED_TO_RESEARCH'
      });
    }
  }

  return { stats, selected, scoredCandidates, ceilings };
}