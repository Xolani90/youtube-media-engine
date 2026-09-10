export const OUTCOME_BEARING_REVIEW_THRESHOLD = 100;

/**
 * Determines whether the current weight configuration is REVIEW ELIGIBLE.
 * This function NEVER changes the active weight version itself — reaching
 * the threshold only makes a review permissible; it is not a trigger for
 * automatic recalculation (v0.6 §10, frozen governance rule).
 *
 * @param outcomeBearingCount - number of opportunities that have completed
 *   the full path discovery -> scoring -> research -> content -> outcome.
 *   Scored-but-not-researched opportunities do NOT count.
 */
export function isReviewEligible(outcomeBearingCount) {
  return outcomeBearingCount >= OUTCOME_BEARING_REVIEW_THRESHOLD;
}

/**
 * Represents the outcome of a review process. This function performs NO
 * automatic weight change — it exists to make the governance sequence
 * explicit and testable: reaching eligibility does not by itself produce
 * a new active weight version; only explicit adoption does.
 *
 * @param evidenceSufficient - boolean, an explicit human/process judgment
 *   call about whether the 100+ outcomes provide sufficient, comparable
 *   evidence (this is NOT computed automatically by this function — v0.6
 *   requires this to be an explicit, evidenced decision, not an automatic
 *   statistical trigger)
 * @param proposedWeights - the candidate new weight configuration, only
 *   relevant if evidenceSufficient is true
 * @param currentWeightsVersion - the currently active weight version
 */
export function reviewWeightConfiguration({ outcomeBearingCount, evidenceSufficient, proposedWeights = null, currentWeightsVersion }) {
  if (!isReviewEligible(outcomeBearingCount)) {
    return { eligible: false, adopted: false, activeVersion: currentWeightsVersion, note: 'Below 100 outcome-bearing opportunities — not review-eligible.' };
  }
  if (!evidenceSufficient) {
    return { eligible: true, adopted: false, activeVersion: currentWeightsVersion, note: 'Review-eligible, but evidence judged insufficient — existing weight version remains active.' };
  }
  if (!proposedWeights) {
    throw new Error('evidenceSufficient=true requires a proposedWeights configuration to adopt.');
  }
  // Adoption itself is an explicit, separate act — this function returns
  // the *proposal outcome*; actual persistence of a new config version is
  // a caller-side write, never implicit here.
  return { eligible: true, adopted: true, activeVersion: proposedWeights.version, note: 'Evidence sufficient — new weight version proposed for explicit adoption.' };
}
