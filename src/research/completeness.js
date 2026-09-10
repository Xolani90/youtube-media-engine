import { CLAIM_TYPE, EVIDENCE_STATUS, CORE_QUESTION_TYPE } from './constants.js';

/**
 * A load-bearing claim's evidence status is "permitted" for completeness
 * per research_policy.json's completeness_by_claim_type — config-driven,
 * never hard-coded (v0.4 corrected completeness semantics). OPINION can
 * never satisfy a factual requirement, regardless of evidence_status.
 */
function meetsFactualRequirement(claim, policy) {
  if (claim.claim_type === CLAIM_TYPE.OPINION) return false;
  const rule = policy.evidence.completeness_by_claim_type[claim.claim_type];
  if (!rule) return false;
  if (claim.evidence_status === rule.load_bearing_requires) return true;
  if (rule.policy_may_permit && claim.evidence_status === rule.policy_may_permit) return true;
  return false;
}

/**
 * A VERIFIED opinion may satisfy a sentiment/reaction requirement — and so
 * may a VERIFIED fact/inference (v0.5 allowance: a verified fact can also
 * speak to sentiment). This is deliberately not type-gated the way the
 * factual requirement is.
 */
function meetsSentimentRequirement(claim) {
  return claim.evidence_status === EVIDENCE_STATUS.VERIFIED;
}

/**
 * Completeness / readiness (Research Subsystem Specification v0.4,
 * corrected completeness semantics; question-type semantics per the
 * authorized D-01/D-02 handoff spec).
 *
 * @param {object} params
 * @param {Array<{id, claim_type, evidence_status, is_load_bearing}>} params.claims - ALL claims for the project
 * @param {object} params.policy - research_policy.json
 * @param {'FACTUAL'|'SENTIMENT'|'MIXED'} params.coreQuestionType
 * @param {boolean} params.stoppingConditionMet - project has reached a defined stopping condition
 * @returns {{status: 'RESEARCH_COMPLETE'|'INSUFFICIENT_EVIDENCE'|'FAILED', stopReason: string}}
 */
export function evaluateCompleteness({ claims, policy, coreQuestionType, stoppingConditionMet }) {
  if (!Object.values(CORE_QUESTION_TYPE).includes(coreQuestionType)) {
    return { status: 'FAILED', stopReason: 'UNKNOWN_CORE_QUESTION_TYPE' };
  }

  const loadBearing = claims.filter((c) => c.is_load_bearing);
  if (loadBearing.length === 0) {
    // Zero load-bearing claims identified is itself a stop condition (v0.2
    // S7): a research project cannot honestly answer its own core question
    // on the strength of non-load-bearing claims alone.
    return { status: 'INSUFFICIENT_EVIDENCE', stopReason: 'NO_LOAD_BEARING_CLAIMS' };
  }

  // Every load-bearing claim must be resolved to a policy-permitted
  // evidence status for its type; a claim still UNSUPPORTED (no usable
  // evidence at all) blocks completion outright, independent of whether
  // the question-type requirement below happens to already be satisfied
  // by other load-bearing claims (v0.4 completeness rule #1).
  const unresolved = loadBearing.filter((c) => c.evidence_status === EVIDENCE_STATUS.UNSUPPORTED);
  if (unresolved.length > 0) {
    return { status: 'INSUFFICIENT_EVIDENCE', stopReason: 'UNSUPPORTED_LOAD_BEARING_CLAIM' };
  }

  const factualSatisfying = loadBearing.filter((c) => meetsFactualRequirement(c, policy));
  const sentimentSatisfying = loadBearing.filter((c) => meetsSentimentRequirement(c));

  let questionSatisfied = false;
  let stopReason = null;

  if (coreQuestionType === CORE_QUESTION_TYPE.FACTUAL) {
    questionSatisfied = factualSatisfying.length > 0;
    stopReason = questionSatisfied ? null : 'FACTUAL_REQUIREMENT_UNMET';
  } else if (coreQuestionType === CORE_QUESTION_TYPE.SENTIMENT) {
    questionSatisfied = sentimentSatisfying.length > 0;
    stopReason = questionSatisfied ? null : 'SENTIMENT_REQUIREMENT_UNMET';
  } else {
    // MIXED: a project-level AND, not factual OR sentiment. A single claim
    // satisfying both components at once (e.g. a VERIFIED FACT can satisfy
    // sentiment too) must NOT count as satisfying MIXED alone — the two
    // components must be backed by genuinely distinct claims.
    if (factualSatisfying.length === 0) {
      stopReason = 'MIXED_FACTUAL_COMPONENT_UNMET';
    } else if (sentimentSatisfying.length === 0) {
      stopReason = 'MIXED_SENTIMENT_COMPONENT_UNMET';
    } else {
      const distinctPairExists =
        factualSatisfying.length > 1 ||
        sentimentSatisfying.length > 1 ||
        factualSatisfying[0].id !== sentimentSatisfying[0].id;
      if (!distinctPairExists) {
        stopReason = 'MIXED_REQUIRES_DISTINCT_CLAIMS';
      } else {
        questionSatisfied = true;
      }
    }
  }

  if (!questionSatisfied) {
    return { status: 'INSUFFICIENT_EVIDENCE', stopReason };
  }

  if (!stoppingConditionMet) {
    return { status: 'INSUFFICIENT_EVIDENCE', stopReason: 'STOPPING_CONDITION_NOT_MET' };
  }

  // Supplementary overall-resolution threshold — can never substitute for
  // the load-bearing/question-type requirements above, only add to them.
  const resolvedCount = claims.filter((c) => c.evidence_status !== EVIDENCE_STATUS.UNSUPPORTED).length;
  const overallRatio = claims.length ? resolvedCount / claims.length : 0;
  if (overallRatio < policy.completeness.overall_resolution_threshold) {
    return { status: 'INSUFFICIENT_EVIDENCE', stopReason: 'OVERALL_RESOLUTION_THRESHOLD_NOT_MET' };
  }

  return { status: 'RESEARCH_COMPLETE', stopReason: 'COMPLETENESS_CRITERIA_MET' };
}