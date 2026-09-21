import crypto from 'node:crypto';
import { checkDuplicate, DEDUP_RESULT, generateUnderlyingEventId } from './dedup.js';
import { checkHardEligibility } from './eligibility.js';
import { generateProposition, validateProposition } from './proposition.js';
import { computeValueScore } from './scoring.js';
import { evaluateOpportunityRisk } from './riskGate.js';
import { selectDiversePortfolio } from './diversity.js';
import { STAGE, REJECTION_REASON } from './constants.js';
import { RISK_LEVELS } from '../state/RiskPolicy.js';

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
  alreadyProducedCorpus = [], topK, rawFeatures, evaluationStore = null
}) {
  const stats = { discovered: observations.length, dedupRejected: 0, eligibilityRejected: 0, propositionRejected: 0, scored: 0, riskVetoed: 0, selected: 0, diversityExcluded: 0 };
  const accepted = []; // observations that survived dedup + eligibility, carrying underlyingEventId

  for (const observation of observations) {
    let dedupResolvedDuplicate = false;
    let underlyingEventId = null;
    let distinctAngle = null;

    for (const existing of accepted) {
      const dedupResult = await checkDuplicate(observation, existing.observation, {
        thresholds: discoveryPolicy.thresholds.dedup.similarity,
        llmRouter
      });

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
  const scoredCandidates = [];
  for (const candidate of accepted) {
    const reused = evaluationStore ? evaluationStore.lookup(candidate.observation) : null;
    let proposition;
    let raw;

    if (reused) {
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
      const genResult = await generateProposition(candidate.observation, llmRouter);
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
      raw = await rawFeatures(candidate.observation);

      if (evaluationStore) {
        evaluationStore.commit(candidate.observation, {
          proposition,
          raw,
          audit: { proposition: { provider: genResult.providerUsed, model: genResult.model } }
        });
      }
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

  return { stats, selected, scoredCandidates };
}
