import { CLAIM_SEVERITY, EVIDENCE_SEVERITY_MAP, SEVERITY_RANK, FACT_CHECK_STATUS } from './constants.js';

/**
 * Per-claim severity mapping (spec §8). Exhaustive, deterministic. An
 * applicable CONTRADICTS relation always forces REJECT, regardless of the
 * claim's own evidence_status.
 *
 * @param {object} claim - a `claims` row (must have `evidence_status`)
 * @param {boolean} hasApplicableContradiction
 * @returns {string} one of CLAIM_SEVERITY
 */
export function severityForClaim(claim, hasApplicableContradiction) {
  if (hasApplicableContradiction) {
    return CLAIM_SEVERITY.REJECT;
  }
  return EVIDENCE_SEVERITY_MAP[claim.evidence_status] ?? CLAIM_SEVERITY.REJECT;
}

function severityToOverallStatus(severity) {
  if (severity === CLAIM_SEVERITY.REJECT) return FACT_CHECK_STATUS.REJECT;
  if (severity === CLAIM_SEVERITY.REVIEW) return FACT_CHECK_STATUS.REVIEW;
  return FACT_CHECK_STATUS.PASS;
}

/**
 * Deterministic worst-case-wins decision (spec §8). No dependency on
 * RiskPolicy; this is Fact-Check's own decision function over Fact-Check's
 * own finding vocabulary.
 *
 * @param {Array<{heading: string, claim: object, hasApplicableContradiction: boolean}>} items
 * @returns {{status: string, findings: Array<{claim_id: string, section_heading: string, finding: string}>}}
 */
export function evaluateDecision(items) {
  let worstRank = SEVERITY_RANK[CLAIM_SEVERITY.PASS_COMPATIBLE];
  const findings = items.map(({ heading, claim, hasApplicableContradiction }) => {
    const severity = severityForClaim(claim, hasApplicableContradiction);
    const rank = SEVERITY_RANK[severity];
    if (rank > worstRank) worstRank = rank;
    const finding = { claim_id: claim.id, finding: severity };
    if (heading) {
      finding.section_heading = heading;
    }
    return finding;
  });

  const overallSeverity = Object.keys(SEVERITY_RANK).find((sev) => SEVERITY_RANK[sev] === worstRank);
  return { status: severityToOverallStatus(overallSeverity), findings };
}