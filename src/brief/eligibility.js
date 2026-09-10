import { RESEARCH_PROJECT_STATUS } from '../research/constants.js';

/**
 * Deterministic eligibility gate for Brief creation (Brief Specification
 * §6, per D1). Only a Research project that reached RESEARCH_COMPLETE is
 * eligible — INSUFFICIENT_EVIDENCE, FAILED, and RESEARCHING are all
 * ineligible for v1; there is no restricted/partial path (D1 removed the
 * previously-considered INSUFFICIENT_EVIDENCE exception).
 */
export function checkResearchEligibility(researchProject) {
  if (!researchProject) {
    return { eligible: false, reason: 'RESEARCH_PROJECT_NOT_FOUND' };
  }
  if (researchProject.status !== RESEARCH_PROJECT_STATUS.RESEARCH_COMPLETE) {
    return { eligible: false, reason: `INELIGIBLE_RESEARCH_STATUS_${researchProject.status}` };
  }
  return { eligible: true, reason: null };
}