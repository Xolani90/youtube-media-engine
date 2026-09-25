import crypto from 'node:crypto';
import { ANALYTICS_STAGE, ANALYTICS_RESULT_STATUS, ANALYTICS_SNAPSHOT_STATUS, DECISION_LOG_DECISION } from './constants.js';

/** Same shape/discipline as every other stage's local logDecision helper (see ../publication/pipeline.js). */
function logDecision(storage, { runId = null, subjectType, subjectId, decision, reason }, nowISO = () => new Date().toISOString()) {
  const id = crypto.randomUUID();
  storage.run(
    `INSERT INTO decision_log
      (id, run_id, subject_type, subject_id, decision, reason, provider, config_snapshot, confidence, risk_level, resulting_state, created_at, stage)
     VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, ?, ?)`,
    [id, runId, subjectType, subjectId, decision, reason, nowISO(), ANALYTICS_STAGE]
  );
  return id;
}

const RESULT_TO_DECISION = Object.freeze({
  [ANALYTICS_RESULT_STATUS.SUCCESS]: DECISION_LOG_DECISION.ANALYTICS_SUCCESS,
  [ANALYTICS_RESULT_STATUS.UNAVAILABLE]: DECISION_LOG_DECISION.ANALYTICS_UNAVAILABLE,
  [ANALYTICS_RESULT_STATUS.AUTH_FAILURE]: DECISION_LOG_DECISION.ANALYTICS_AUTH_FAILURE,
  [ANALYTICS_RESULT_STATUS.RATE_LIMITED]: DECISION_LOG_DECISION.ANALYTICS_RATE_LIMITED,
  [ANALYTICS_RESULT_STATUS.TRANSIENT_FAILURE]: DECISION_LOG_DECISION.ANALYTICS_TRANSIENT_FAILURE,
  [ANALYTICS_RESULT_STATUS.PERMANENT_FAILURE]: DECISION_LOG_DECISION.ANALYTICS_PERMANENT_FAILURE
});

// A global/account-level condition: retrying per-video within this run
// cannot help, so the whole collection run stops rather than repeating
// the same doomed call once per remaining video (Phase 3 spec §10: "do
// not allow one unavailable video to abort the entire run UNLESS the
// error represents a global/authentication/API condition where
// continuing would be pointless"). UNAVAILABLE/PERMANENT_FAILURE are
// deliberately NOT in this set -- those can be genuinely per-video
// (e.g. a malformed filter for one id) and are handled per video below
// since this adapter batches all videos into ONE request, a
// video-specific UNAVAILABLE surfaces as a per-video `null` inside a
// SUCCESS response (see YouTubeAnalyticsAdapter#_interpretReport), not
// as a top-level status -- so this set only ever needs to cover the
// top-level, whole-request outcomes that mean "this account/token
// cannot get analytics right now, at all".
const RUN_ABORTING_STATUSES = new Set([ANALYTICS_RESULT_STATUS.AUTH_FAILURE]);

// Bounded: the number of videos placed into a single batched
// youtubeAnalytics.reports.query call (Phase 3 spec §11: prefer
// batching, but never build an unbounded request). YouTube's own
// filters-parameter length limit is generous but finite; 50 keeps a
// single request comfortably within it while still batching far more
// than one-request-per-video.
export const MAX_VIDEOS_PER_BATCH = 50;

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/**
 * Finds publications eligible for analytics collection: confirmed
 * PUBLISHED rows for the given provider with a confirmed
 * provider_item_id. Deliberately re-implemented here rather than
 * imported from ../publication/eligibility.js or
 * ../autonomous/workSelection.js, per this repository's existing
 * per-stage decoupling convention -- and deliberately NOT registered
 * in workSelection.js/runner.js's ContentStateMachine-driven sweep
 * (Phase 3 spec §15/§25 step 6): analytics does not transition any
 * content_version state and can be legitimately re-collected for the
 * same publication indefinitely (a new period every time), so it does
 * not fit that sweep's "eligible once, becomes ineligible" model.
 *
 * @param {import('../storage/StorageDriver.js').StorageDriver} storage
 * @param {string} provider
 * @returns {object[]} publications rows
 */
export function selectEligiblePublicationsForAnalytics(storage, provider) {
  return storage.all(
    `SELECT * FROM publications WHERE provider = ? AND status = 'PUBLISHED' AND provider_item_id IS NOT NULL`,
    [provider]
  );
}

function upsertSnapshot(storage, { publication, periodStart, periodEnd, nowISO, status, metrics, failureReason, resultJson }) {
  const id = crypto.randomUUID();
  const now = nowISO();
  storage.run(
    `INSERT INTO analytics_snapshots
      (id, publication_id, provider, provider_item_id, period_start, period_end, collected_at,
       views, likes, comments, shares, estimated_watch_time_minutes, average_view_duration_seconds,
       average_view_percentage, impressions, impressions_ctr, status, failure_reason, result_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(publication_id, period_start, period_end) DO UPDATE SET
       collected_at = excluded.collected_at,
       views = excluded.views, likes = excluded.likes, comments = excluded.comments, shares = excluded.shares,
       estimated_watch_time_minutes = excluded.estimated_watch_time_minutes,
       average_view_duration_seconds = excluded.average_view_duration_seconds,
       average_view_percentage = excluded.average_view_percentage,
       impressions = excluded.impressions, impressions_ctr = excluded.impressions_ctr,
       status = excluded.status, failure_reason = excluded.failure_reason, result_json = excluded.result_json`,
    [
      id, publication.id, publication.provider, publication.provider_item_id, periodStart, periodEnd, now,
      metrics?.views ?? null, metrics?.likes ?? null, metrics?.comments ?? null, metrics?.shares ?? null,
      metrics?.estimatedWatchTimeMinutes ?? null, metrics?.averageViewDurationSeconds ?? null,
      metrics?.averageViewPercentage ?? null, metrics?.impressions ?? null, metrics?.impressionsCtr ?? null,
      status, failureReason ?? null, resultJson, now
    ]
  );
  return storage.get(
    `SELECT * FROM analytics_snapshots WHERE publication_id = ? AND period_start = ? AND period_end = ?`,
    [publication.id, periodStart, periodEnd]
  );
}

/**
 * Runs Phase 3 analytics collection for every eligible PUBLISHED
 * publication of `provider`, for the explicit UTC date range
 * [periodStart, periodEnd]. Purely observational: never calls
 * ../publication/pipeline.js, the publication provider adapter, D-C2
 * (../state/SideEffectAuthorization.js), or the content state machine
 * -- see the "Publication isolation" proof in the Phase 3 report. May
 * be invoked directly (mirrors every stage's manual-trigger-surface
 * convention) or from scripts/collect-youtube-analytics.js; it is
 * deliberately NOT wired into src/autonomous/runner.js (Phase 3 spec
 * §15 -- no appropriate existing sweep point; see
 * selectEligiblePublicationsForAnalytics's docstring for why).
 *
 * One video failing (or being UNAVAILABLE) never aborts collection of
 * the other eligible videos, UNLESS the adapter reports a top-level,
 * whole-request outcome in RUN_ABORTING_STATUSES (currently:
 * AUTH_FAILURE) -- Phase 3 spec §10.
 *
 * @param {object} deps
 * @param {import('../storage/StorageDriver.js').StorageDriver} deps.storage
 * @param {string} deps.periodStart - UTC date, YYYY-MM-DD (inclusive)
 * @param {string} deps.periodEnd - UTC date, YYYY-MM-DD (inclusive)
 * @param {string} [deps.provider] - provider id, defaults to 'youtube'
 * @param {{collect: (args: {videoIds: string[], periodStart: string, periodEnd: string}) => Promise<object>}} deps.adapter - injectable for tests; production callers pass a YouTubeAnalyticsAdapter instance
 * @param {string} [deps.runId]
 * @param {() => string} [deps.nowISO]
 * @returns {Promise<{ runId: string|null, provider: string, periodStart: string, periodEnd: string, eligible: number, batches: number, collected: number, unavailable: number, failed: number, aborted: boolean, results: Array<{publicationId: string, providerItemId: string, status: string}> }>}
 */
export async function collectAnalytics({ storage, periodStart, periodEnd, provider = 'youtube', adapter, runId = null, nowISO = () => new Date().toISOString() }) {
  if (!storage) throw new Error('collectAnalytics requires deps.storage');
  if (!periodStart || !periodEnd) throw new Error('collectAnalytics requires an explicit periodStart and periodEnd');
  if (!adapter || typeof adapter.collect !== 'function') throw new Error('collectAnalytics requires deps.adapter implementing collect()');

  const eligible = selectEligiblePublicationsForAnalytics(storage, provider);
  const byVideoId = new Map(eligible.map((p) => [p.provider_item_id, p]));
  const batches = chunk(eligible, MAX_VIDEOS_PER_BATCH);

  const results = [];
  let collected = 0;
  let unavailable = 0;
  let failed = 0;
  let aborted = false;

  for (const batch of batches) {
    if (aborted) break;
    const videoIds = batch.map((p) => p.provider_item_id);

    let report;
    try {
      report = await adapter.collect({ videoIds, periodStart, periodEnd });
    } catch (err) {
      // An adapter throwing is a programmer/contract error (mirrors
      // PublicationProvider's own contract), not a normal outcome --
      // classify it as a permanent failure for every video in this
      // batch rather than letting it crash the whole collection run.
      report = { status: ANALYTICS_RESULT_STATUS.PERMANENT_FAILURE, provider, errorClass: `adapter_threw_${err.message}` };
    }

    if (report.status !== ANALYTICS_RESULT_STATUS.SUCCESS) {
      // A whole-batch, non-SUCCESS outcome: every video in this batch
      // gets the same status/reason (there is no per-video breakdown
      // to fall back on -- the request itself failed as a whole).
      const decision = RESULT_TO_DECISION[report.status] ?? DECISION_LOG_DECISION.ANALYTICS_PERMANENT_FAILURE;
      for (const publication of batch) {
        upsertSnapshot(storage, {
          publication, periodStart, periodEnd, nowISO,
          status: report.status, metrics: null, failureReason: report.errorClass ?? report.status,
          resultJson: JSON.stringify(report)
        });
        logDecision(storage, {
          runId, subjectType: 'publication', subjectId: publication.id,
          decision, reason: `analytics_${publication.id}_${report.status.toLowerCase()}_${report.errorClass ?? ''}`
        }, nowISO);
        results.push({ publicationId: publication.id, providerItemId: publication.provider_item_id, status: report.status });
        if (report.status === ANALYTICS_RESULT_STATUS.UNAVAILABLE) unavailable += 1; else failed += 1;
      }
      if (RUN_ABORTING_STATUSES.has(report.status)) {
        aborted = true;
        logDecision(storage, {
          runId, subjectType: 'analytics_run', subjectId: provider,
          decision: DECISION_LOG_DECISION.ANALYTICS_RUN_ABORTED, reason: `analytics_run_aborted_${report.status}_${report.errorClass ?? ''}`
        }, nowISO);
      }
      continue;
    }

    // SUCCESS at the batch level: interpret each video independently.
    // A video with `null` in byVideoId (no row in the response) is
    // UNAVAILABLE for THIS video only -- never zeros, and never
    // treated as a reason to fail the rest of the batch.
    for (const publication of batch) {
      const videoMetrics = report.byVideoId?.[publication.provider_item_id];
      if (videoMetrics === null || videoMetrics === undefined) {
        upsertSnapshot(storage, {
          publication, periodStart, periodEnd, nowISO,
          status: ANALYTICS_SNAPSHOT_STATUS.UNAVAILABLE, metrics: null, failureReason: 'no_row_for_video_in_period',
          resultJson: JSON.stringify({ note: 'no_row_for_video_in_period' })
        });
        logDecision(storage, {
          runId, subjectType: 'publication', subjectId: publication.id,
          decision: DECISION_LOG_DECISION.ANALYTICS_UNAVAILABLE, reason: `analytics_${publication.id}_no_row_for_period`
        }, nowISO);
        results.push({ publicationId: publication.id, providerItemId: publication.provider_item_id, status: ANALYTICS_SNAPSHOT_STATUS.UNAVAILABLE });
        unavailable += 1;
        continue;
      }
      upsertSnapshot(storage, {
        publication, periodStart, periodEnd, nowISO,
        status: ANALYTICS_SNAPSHOT_STATUS.SUCCESS, metrics: videoMetrics, failureReason: null,
        resultJson: JSON.stringify(videoMetrics)
      });
      logDecision(storage, {
        runId, subjectType: 'publication', subjectId: publication.id,
        decision: DECISION_LOG_DECISION.ANALYTICS_SUCCESS, reason: `analytics_${publication.id}_collected`
      }, nowISO);
      results.push({ publicationId: publication.id, providerItemId: publication.provider_item_id, status: ANALYTICS_SNAPSHOT_STATUS.SUCCESS });
      collected += 1;
    }
  }

  return {
    runId, provider, periodStart, periodEnd,
    eligible: eligible.length, batches: batches.length,
    collected, unavailable, failed, aborted,
    results
  };
}

export default collectAnalytics;