/**
 * Work-selection queries for Autonomous Operation (checkpoint §14, Gap 1
 * in §8). Each function is a single, plain SQL SELECT against an
 * existing state/status column -- no new table, no queue, no new state
 * machine (see checkpoint §15). Every query mirrors the verified
 * state/status -> stage mapping in checkpoint §10, re-derived directly
 * from each stage's own source during this pass (see the Autonomous
 * Operation Checkpoint document for the re-verification notes).
 *
 * Each function returns the exact shape of `item` the matching stage's
 * run*() entry point in src/autonomous/runner.js expects -- never a raw
 * row, so runner.js never needs to know column names itself.
 */

export function selectEligibleResearch(storage) {
  // opportunities.status is set once at Discovery time and never
  // updated afterward (verified: no `UPDATE opportunities` anywhere in
  // src/research/pipeline.js). Dedup is therefore against the existence
  // of a research_projects row at all, matching the same
  // UNIQUE(opportunity_id) guarantee src/research/pipeline.js itself
  // relies on (createResearchProject) -- this is a pure efficiency
  // pre-filter, not a second source of truth.
  return storage
    .all(
      `SELECT id FROM opportunities
       WHERE status = 'HANDED_TO_RESEARCH'
       AND id NOT IN (SELECT opportunity_id FROM research_projects)`
    )
    .map((row) => ({ opportunityId: row.id }));
}

export function selectEligibleBriefs(storage) {
  return storage
    .all(
      `SELECT id FROM research_projects
       WHERE status = 'RESEARCH_COMPLETE'
       AND id NOT IN (
         SELECT research_project_id FROM content_briefs
         WHERE research_project_id IS NOT NULL
       )`
    )
    .map((row) => ({ researchProjectId: row.id }));
}

export function selectEligibleScripts(storage) {
  return storage
    .all(`SELECT content_brief_id FROM content_versions WHERE state = 'BRIEF_CREATED'`)
    .map((row) => ({ contentBriefId: row.content_brief_id }));
}

export function selectEligibleFactChecks(storage) {
  return storage
    .all(`SELECT content_brief_id FROM content_versions WHERE state = 'SCRIPT_DRAFT'`)
    .map((row) => ({ contentBriefId: row.content_brief_id }));
}

export function selectEligibleOriginalityChecks(storage) {
  return storage
    .all(`SELECT content_brief_id FROM content_versions WHERE state = 'FACT_CHECK'`)
    .map((row) => ({ contentBriefId: row.content_brief_id }));
}

export function selectEligibleQualityGates(storage) {
  return storage
    .all(`SELECT content_brief_id FROM content_versions WHERE state = 'ORIGINALITY_CHECK'`)
    .map((row) => ({ contentBriefId: row.content_brief_id }));
}

export function selectEligibleProductions(storage) {
  return storage
    .all(
      `SELECT content_brief_id FROM content_versions
       WHERE state = 'PRODUCTION_READY'
       AND id NOT IN (SELECT content_version_id FROM stage_retry_state WHERE stage = 'PRODUCTION' AND quarantined_at IS NOT NULL)`
    )
    .map((row) => ({ contentBriefId: row.content_brief_id }));
}

export function selectEligibleMediaProductions(storage) {
  return storage
    .all(`SELECT content_brief_id FROM content_versions WHERE state = 'PRODUCED'`)
    .map((row) => ({ contentBriefId: row.content_brief_id }));
}

// Same structural precondition as selectEligibleMediaProductions
// (content_version.state === 'PRODUCED') -- Asset Provisioning's own
// eligibility.js (resolveProducedContentForProvisioning) additionally
// requires a `productions` row, which is a structural guarantee of
// state === 'PRODUCED' itself, so no extra filter is needed here. This
// is a pure efficiency pre-filter, matching the discipline used by every
// other selector in this file; Asset Provisioning's own eligibility
// check (and its own idempotency guard against re-provisioning) remains
// the sole authority and is never bypassed, duplicated, or
// second-guessed here.
export function selectEligibleAssetProvisioning(storage) {
  return storage
    .all(`SELECT content_brief_id FROM content_versions WHERE state = 'PRODUCED'`)
    .map((row) => ({ contentBriefId: row.content_brief_id }));
}

// Same structural precondition as selectEligibleAssetProvisioning /
// selectEligibleMediaProductions (content_version.state === 'PRODUCED')
// -- Rights Verification sits between the two in stage order but does
// not transition content_versions.state, so it shares their same
// selection query rather than a state of its own. Rights Verification's
// own eligibility check (src/rights-verification/eligibility.js,
// resolveProducedContentForRightsVerification + selectEligibleAssets)
// additionally requires a `productions` row and per-asset lazy
// re-verification gating; that remains the sole authority and is never
// bypassed, duplicated, or second-guessed here -- this is a pure
// efficiency pre-filter, matching every other selector in this file.
export function selectEligibleRightsVerification(storage) {
  return storage
    .all(`SELECT content_brief_id FROM content_versions WHERE state = 'PRODUCED'`)
    .map((row) => ({ contentBriefId: row.content_brief_id }));
}

export function selectEligiblePublications(storage) {
  // Publication's own structural eligibility (src/publication/eligibility.js,
  // resolveMediaForPublication) additionally requires an existing
  // media_artifacts row for this content_version -- Media Production
  // must have already rendered and validated a real .mp4. Filtering on
  // that here is a pure efficiency pre-filter (avoid an unnecessary
  // call that would just report NOT_YET_RENDERED); Publication's own
  // eligibility check remains the sole authority and is never
  // bypassed, duplicated, or second-guessed here.
  //
  // Deliberately NOT filtered by publications.status: an item that
  // already has a FAILED publication attempt is intentionally still
  // selected here, because FAILED is documented as retryable and
  // Publication v1's own claim logic (frozen, §3/§4) is what performs
  // the actual, safe reclaim -- this query does not need to know FAILED
  // exists. An AMBIGUOUS attempt is also still selected -- Publication's
  // own guard (never auto-retried, §4) is what makes a redundant call
  // safe: it no-ops rather than mis-selecting.
  return storage
    .all(
      `SELECT content_brief_id FROM content_versions
       WHERE state = 'PRODUCED'
       AND id IN (SELECT content_version_id FROM media_artifacts)
       AND id NOT IN (SELECT content_version_id FROM stage_retry_state WHERE stage = 'PUBLICATION' AND quarantined_at IS NOT NULL)`
    )
    .map((row) => ({ contentBriefId: row.content_brief_id }));
}