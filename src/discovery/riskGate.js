import { evaluateFlags } from '../state/RiskPolicy.js';

export const HIGH_POLICY_RISK = 'HIGH_POLICY_RISK';
export const HIGH_COPYRIGHT_RISK = 'HIGH_COPYRIGHT_RISK';
export const HIGH_REPETITION_RISK = 'HIGH_REPETITION_RISK';

/**
 * Maps an opportunity's three risk dimensions (0-1 scale) against the
 * configured thresholds into RiskPolicy flags, then evaluates via the
 * EXISTING evaluateFlags() — this is a specific application of the
 * already-implemented Phase 1 RiskPolicy mechanism, not a parallel one
 * (v0.6 §11: "reuses the existing Phase 1 RiskPolicy mechanism; no
 * parallel risk framework is introduced").
 *
 * HIGH_POLICY_RISK / HIGH_COPYRIGHT_RISK / HIGH_REPETITION_RISK are new
 * flag names, not new severity machinery — they plug into the SAME
 * FLAG_SEVERITY map and the SAME evaluateFlags() function already built
 * in Phase 1. RiskPolicy.js's own comment states this map is intended to
 * be extended ("The Owner can revise this mapping"), so this is additive
 * configuration of the existing mechanism, not a second risk framework.
 */
export function evaluateOpportunityRisk({ policyRisk, copyrightRisk, repetitionRisk }, riskThresholds) {
  const flags = [];

  if (policyRisk >= riskThresholds.policy.critical_threshold) flags.push(HIGH_POLICY_RISK);
  else if (policyRisk >= riskThresholds.policy.warning_threshold) flags.push('FACTUAL_UNCERTAINTY');

  if (copyrightRisk >= riskThresholds.copyright.critical_threshold) flags.push(HIGH_COPYRIGHT_RISK);

  if (repetitionRisk >= riskThresholds.repetition.critical_threshold) flags.push(HIGH_REPETITION_RISK);
  else if (repetitionRisk >= riskThresholds.repetition.warning_threshold) flags.push('DUPLICATIVE_CONTENT');

  const { level, action } = evaluateFlags(flags);
  return { level, action, flagsRaised: flags };
}
