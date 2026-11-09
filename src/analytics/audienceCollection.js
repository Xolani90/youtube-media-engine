import crypto from 'node:crypto';
import { ANALYTICS_STAGE, ANALYTICS_RESULT_STATUS, DECISION_LOG_DECISION } from './constants.js';
import { selectEligiblePublicationsForAnalytics } from './collector.js';
import { windowPeriods, windowUsableAtMs, publicationExclusionReason, AUDIENCE_KIND_LIST } from './recommendations.js';

/**
 * Audience analytics collection: retention curve + traffic sources, per
 * publication and EXACT window period, persisted to analytics_audience_snapshots
 * (migration 0033) and read by recommendations.js.
 *
 * Through the existing machinery only: eligibility is the collector's
 * (selectEligiblePublicationsForAnalytics) plus the recommendation generator's
 * own publication gate; window periods/latency are recommendations.js's; the
 * adapter owns auth, bounded retry and status classification. Observational
 * only: never touches publications, content state, publication authorization,
 * discovery, generation or publishing.
 *
 * Request economy (these are one-request-per-video reports):
 *  - SUCCESS is never re-requested; UNAVAILABLE collected AFTER the window's data
 *    settled is final (YouTube withholds retention for low-volume videos --
 *    asking every run would just repeat the same empty answer); a rejected
 *    request (PERMANENT_FAILURE) is final until an operator clears the row.
 *  - AUTH_FAILURE / RATE_LIMITED / TRANSIENT_FAILURE are retried only after a
 *    cool-down, and AUTH_FAILURE or RATE_LIMITED stops the whole run (nothing
 *    after them in this run could succeed or would be polite).
 *
 * UNAVAILABLE is stored as UNAVAILABLE with summary_json NULL -- never as zero.
 */

export const AUDIENCE_KINDS = Object.freeze({ RETENTION: 'RETENTION', TRAFFIC_SOURCES: 'TRAFFIC_SOURCES' });
const KIND_METHOD = Object.freeze({ RETENTION: 'collectRetentionCurve', TRAFFIC_SOURCES: 'collectTrafficSources' });
const KIND_TAG = Object.freeze({ RETENTION: 'retention', TRAFFIC_SOURCES: 'traffic' });
const S = ANALYTICS_RESULT_STATUS;
const RUN_ABORTING = new Set([S.AUTH_FAILURE, S.RATE_LIMITED]);
const RETRYABLE = new Set([S.AUTH_FAILURE, S.RATE_LIMITED, S.TRANSIENT_FAILURE]);
const HOUR_MS = 60 * 60 * 1000;
const DEFAULT_RETRY_AFTER_HOURS = 6;

const RESULT_TO_DECISION = Object.freeze({
  [S.SUCCESS]: DECISION_LOG_DECISION.ANALYTICS_SUCCESS,
  [S.UNAVAILABLE]: DECISION_LOG_DECISION.ANALYTICS_UNAVAILABLE,
  [S.AUTH_FAILURE]: DECISION_LOG_DECISION.ANALYTICS_AUTH_FAILURE,
  [S.RATE_LIMITED]: DECISION_LOG_DECISION.ANALYTICS_RATE_LIMITED,
  [S.TRANSIENT_FAILURE]: DECISION_LOG_DECISION.ANALYTICS_TRANSIENT_FAILURE,
  [S.PERMANENT_FAILURE]: DECISION_LOG_DECISION.ANALYTICS_PERMANENT_FAILURE
});

function logDecision(storage, { runId = null, subjectType, subjectId, decision, reason }, nowISO) {
  storage.run(
    `INSERT INTO decision_log
      (id, run_id, subject_type, subject_id, decision, reason, provider, config_snapshot, confidence, risk_level, resulting_state, created_at, stage)
     VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, ?, ?)`,
    [crypto.randomUUID(), runId, subjectType, subjectId, decision, reason, nowISO(), ANALYTICS_STAGE]
  );
}

/** Pure. Comparable summary of a SUCCESS retention result (what recommendations read). */
export function summarizeRetention(result) {
  const s = result.summary;
  return { at10: s.at10 ?? null, at25: s.at25 ?? null, at50: s.at50 ?? null, at75: s.at75 ?? null, steepestDrop: s.steepestDrop ?? null, pointCount: s.pointCount };
}

/** Pure. Comparable summary of a SUCCESS traffic result. `shares` holds only sources the report listed. */
export function summarizeTraffic(result) {
  const shares = {};
  for (const src of result.sources) shares[src.source] = src.viewsShare;
  return { totalViews: result.totalViews, totalViewsComplete: result.totalViewsComplete, zeroViews: result.zeroViews, shares };
}

/**
 * Pure. Which (publication, window, kind) audience reports are due now.
 * Uses the recommendation generator's own gate and window arithmetic, so only
 * publications/windows the generator could actually use are ever requested.
 *
 * @returns {{ targets: Array<{publicationId, periodStart, periodEnd, kinds: string[], windows: string[]}>, deferred: object[], final: object[], notDue: object[], skipped: object[], holdReason: string|null }}
 */
export function planAudienceCollection(evidence, { now = new Date().toISOString(), retryAfterHours = DEFAULT_RETRY_AFTER_HOURS } = {}) {
  const nowMs = Date.parse(now);
  if (!Number.isFinite(nowMs)) throw new Error('planAudienceCollection requires a valid now');
  const audience = evidence.audienceSnapshots ?? [];
  const items = [];
  const deferred = [];
  const final = [];
  const notDue = [];
  const skipped = [];

  for (const p of evidence.publications) {
    const gate = publicationExclusionReason(p, evidence.provider);
    if (gate) { skipped.push({ publicationId: p.id, reason: gate }); continue; }
    for (const [window, period] of Object.entries(windowPeriods(p.published_at))) {
      const usableAtMs = windowUsableAtMs(period);
      if (!(nowMs >= usableAtMs)) { notDue.push({ publicationId: p.id, window }); continue; }
      for (const kind of AUDIENCE_KIND_LIST) {
        const snap = audience.find((s) => s.publication_id === p.id && s.kind === kind && s.period_start === period.start && s.period_end === period.end);
        const item = { publicationId: p.id, window, kind, periodStart: period.start, periodEnd: period.end };
        if (!snap) { items.push({ ...item, reason: 'no_snapshot' }); continue; }
        if (snap.status === S.SUCCESS) continue;
        const settled = Date.parse(snap.collected_at) >= usableAtMs;
        if (snap.status === S.PERMANENT_FAILURE || (snap.status === S.UNAVAILABLE && settled)) { final.push({ ...item, status: snap.status }); continue; }
        // UNAVAILABLE collected before the data settled, or a retryable failure: cool-down then retry.
        if (snap.status !== S.UNAVAILABLE && !RETRYABLE.has(snap.status)) { final.push({ ...item, status: snap.status }); continue; }
        const retryAtMs = Date.parse(snap.collected_at) + retryAfterHours * HOUR_MS;
        if (Number.isFinite(retryAtMs) && nowMs < retryAtMs) { deferred.push({ ...item, status: snap.status, retryAt: new Date(retryAtMs).toISOString() }); continue; }
        items.push({ ...item, reason: 'retry_non_success' });
      }
    }
  }

  const groups = new Map();
  for (const it of items) {
    const key = `${it.publicationId}|${it.periodStart}|${it.periodEnd}`;
    if (!groups.has(key)) groups.set(key, { publicationId: it.publicationId, periodStart: it.periodStart, periodEnd: it.periodEnd, kinds: [], windows: [] });
    const g = groups.get(key);
    if (!g.kinds.includes(it.kind)) g.kinds.push(it.kind);
    if (!g.windows.includes(it.window)) g.windows.push(it.window);
  }
  let targets = [...groups.values()].sort((a, b) => (a.periodStart + a.periodEnd + a.publicationId).localeCompare(b.periodStart + b.periodEnd + b.publicationId));
  // AUTH_FAILURE / RATE_LIMITED are account-level: while one is cooling down, probing other
  // publications or reports would only repeat the same failure, so the whole run is held.
  let holdReason = null;
  if (deferred.some((d) => RUN_ABORTING.has(d.status))) { holdReason = 'account_level_failure_cooling_down'; targets = []; }
  return { now, targets, deferred, final, notDue, skipped, holdReason };
}

// Returns true when a row was inserted or updated. A SUCCESS row is immutable: the conditional
// DO UPDATE ... WHERE makes a later attempt (failed, unavailable, or a duplicate SUCCESS from a
// concurrent job that passed the pre-request check) a no-op, so it returns false.
function upsertAudienceSnapshot(storage, { publication, kind, periodStart, periodEnd, nowISO, status, failureReason, summary, result }) {
  const now = nowISO();
  const info = storage.run(
    `INSERT INTO analytics_audience_snapshots
      (id, publication_id, provider, provider_item_id, kind, period_start, period_end, collected_at, status, failure_reason, summary_json, result_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(publication_id, kind, period_start, period_end) DO UPDATE SET
       collected_at = excluded.collected_at, status = excluded.status, failure_reason = excluded.failure_reason,
       summary_json = excluded.summary_json, result_json = excluded.result_json
     WHERE analytics_audience_snapshots.status <> 'SUCCESS'`,
    [crypto.randomUUID(), publication.id, publication.provider, publication.provider_item_id, kind, periodStart, periodEnd, now, status,
      failureReason ?? null, summary ? JSON.stringify(summary) : null, JSON.stringify(result ?? {}), now]
  );
  return info.changes > 0;
}

/**
 * Collects the requested audience reports for explicit targets. Never throws
 * for a provider outcome. Targets whose publication is not currently eligible
 * (not PUBLISHED / no provider id) are ignored, never invented.
 *
 * @param {object} deps
 * @param {object} deps.storage
 * @param {object} deps.adapter - must implement collectRetentionCurve() and collectTrafficSources()
 * @param {Array<{publicationId: string, periodStart: string, periodEnd: string, kinds?: string[]}>} deps.targets
 */
export async function collectAudienceAnalytics({ storage, adapter, targets, provider = 'youtube', runId = null, nowISO = () => new Date().toISOString() }) {
  if (!storage) throw new Error('collectAudienceAnalytics requires deps.storage');
  if (!adapter || typeof adapter.collectRetentionCurve !== 'function' || typeof adapter.collectTrafficSources !== 'function') {
    throw new Error('collectAudienceAnalytics requires an adapter implementing collectRetentionCurve() and collectTrafficSources()');
  }
  if (!Array.isArray(targets)) throw new Error('collectAudienceAnalytics requires deps.targets');

  const eligible = new Map(selectEligiblePublicationsForAnalytics(storage, provider).map((p) => [p.id, p]));
  const out = { runId, provider, requested: 0, alreadyCollected: 0, collected: 0, unavailable: 0, failed: 0, aborted: false, results: [] };

  outer:
  for (const t of targets) {
    const publication = eligible.get(t.publicationId);
    if (!publication) continue;
    for (const kind of t.kinds ?? AUDIENCE_KIND_LIST) {
      if (!KIND_METHOD[kind]) throw new Error(`unknown audience kind ${kind}`);
      const existing = storage.get(
        `SELECT status FROM analytics_audience_snapshots WHERE publication_id = ? AND kind = ? AND period_start = ? AND period_end = ?`,
        [publication.id, kind, t.periodStart, t.periodEnd]
      );
      if (existing?.status === S.SUCCESS) { out.alreadyCollected += 1; continue; } // never re-request, never overwrite SUCCESS

      out.requested += 1;
      let result;
      try {
        result = await adapter[KIND_METHOD[kind]]({ videoId: publication.provider_item_id, periodStart: t.periodStart, periodEnd: t.periodEnd });
      } catch (err) {
        result = { status: S.PERMANENT_FAILURE, provider, errorClass: `adapter_threw_${err.message}` };
      }
      const status = Object.values(S).includes(result?.status) ? result.status : S.PERMANENT_FAILURE;
      const ok = status === S.SUCCESS;
      let summary = null;
      let failureReason = ok ? null : (result?.errorClass ?? status);
      let stored = result;
      if (ok) {
        try { summary = kind === 'RETENTION' ? summarizeRetention(result) : summarizeTraffic(result); } catch (err) {
          // A SUCCESS whose shape we cannot summarize is not usable data: say so, do not guess.
          stored = { status: S.PERMANENT_FAILURE, provider, errorClass: `unsummarizable_result_${err.message}`, result };
          failureReason = stored.errorClass;
        }
      }
      const finalStatus = ok && summary ? S.SUCCESS : ok ? S.PERMANENT_FAILURE : status;
      const written = upsertAudienceSnapshot(storage, { publication, kind, periodStart: t.periodStart, periodEnd: t.periodEnd, nowISO, status: finalStatus, failureReason, summary: finalStatus === S.SUCCESS ? summary : null, result: stored });
      if (!written) { // a SUCCESS row appeared while the request was in flight; keep it, record nothing
        out.requested -= 1; out.alreadyCollected += 1;
        // The write was blocked, but the provider's account-level signal is still real: stop probing.
        if (RUN_ABORTING.has(finalStatus)) {
          out.aborted = true;
          logDecision(storage, {
            runId, subjectType: 'analytics_run', subjectId: provider,
            decision: DECISION_LOG_DECISION.ANALYTICS_RUN_ABORTED, reason: `analytics_audience_run_aborted_${finalStatus}_${failureReason ?? ''}`
          }, nowISO);
          break outer;
        }
        continue;
      }
      logDecision(storage, {
        runId, subjectType: 'publication', subjectId: publication.id,
        decision: RESULT_TO_DECISION[finalStatus],
        reason: `analytics_audience_${KIND_TAG[kind]}_${publication.id}_${finalStatus.toLowerCase()}_${failureReason ?? 'collected'}`
      }, nowISO);
      out.results.push({ publicationId: publication.id, kind, periodStart: t.periodStart, periodEnd: t.periodEnd, status: finalStatus });
      if (finalStatus === S.SUCCESS) out.collected += 1;
      else if (finalStatus === S.UNAVAILABLE) out.unavailable += 1;
      else out.failed += 1;

      if (RUN_ABORTING.has(finalStatus)) {
        out.aborted = true;
        logDecision(storage, {
          runId, subjectType: 'analytics_run', subjectId: provider,
          decision: DECISION_LOG_DECISION.ANALYTICS_RUN_ABORTED, reason: `analytics_audience_run_aborted_${finalStatus}_${failureReason ?? ''}`
        }, nowISO);
        break outer;
      }
    }
  }
  return out;
}

export default collectAudienceAnalytics;
