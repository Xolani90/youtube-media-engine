import crypto from 'node:crypto';

/**
 * Read-only analytics recommendation generator.
 *
 * Turns comparable, verified YouTube analytics snapshots into PENDING,
 * human-reviewed findings. It never changes discovery, briefs, scripts,
 * production or publication, never writes to analytics_snapshots or
 * publications, and approval only updates the recommendation row itself.
 *
 * Comparability rules (all enforced, none inferred):
 *  - Fixed windows anchored on the UTC date D0 of the publication's persisted
 *    PUBLISHED decision: '24H' = the first full UTC day (D0+1 .. D0+1) and
 *    '7D' = the first seven full UTC days (D0+1 .. D0+7). Only a snapshot with
 *    EXACTLY that period_start/period_end is used; other periods are ignored,
 *    never aggregated or stretched.
 *  - A window is only usable once DATA_LATENCY_DAYS have passed after its end
 *    (conservative assumption, not verified against YouTube's own latency).
 *  - Publication must be PUBLISHED with a provider id, confirmed public by the
 *    provider, not scheduled, and linked to a LIVE system run. The snapshot table
 *    has no real/simulated flag, so these structural checks are the only
 *    provenance available; they cannot prove a snapshot came from the live API.
 *  - Snapshot must be status SUCCESS, same provider and video id as the
 *    publication, with the metric reported (NULL is missing, never zero).
 *  - A finding needs at least MIN_BASELINE other comparable videos in the same
 *    window (so at least 3 valid measurements). Otherwise: INSUFFICIENT_DATA.
 * Findings are descriptive (relative to the channel's own median), not
 * statistical tests and not causal claims.
 *
 * Audience metrics (retention curve points, traffic-source shares) follow the
 * SAME rules, read from analytics_audience_snapshots: exact fixed window, same
 * publication gate, SUCCESS only, collected after the data settled. Anything
 * else is an explicit exclusion whose reason names the snapshot status
 * (e.g. audience_retention_unavailable): UNAVAILABLE is never turned into a
 * zero, and a traffic source that the report did not list is never assumed to
 * be 0%.
 */

export const WINDOWS = Object.freeze({
  '24H': { startOffsetDays: 1, endOffsetDays: 1 },
  '7D': { startOffsetDays: 1, endOffsetDays: 7 }
});
export const DATA_LATENCY_DAYS = 2;
export const MIN_BASELINE = 2;
export const MIN_IMPRESSIONS_FOR_CTR = 1000;
export const RELATIVE_THRESHOLD = 0.25;
export const METRICS = Object.freeze({
  impressions_ctr: { needsImpressions: true },
  average_view_percentage: { needsImpressions: false, max: 100 }
});
// Audience metrics. `read` pulls one number from the stored summary_json;
// undefined/null => not reported => excluded, never zero.
export const MIN_TRAFFIC_VIEWS_FOR_SHARE = 100;
export const AUDIENCE_METRICS = Object.freeze({
  retention_at_25: { kind: 'RETENTION', read: (s) => s.at25 },
  retention_at_50: { kind: 'RETENTION', read: (s) => s.at50 },
  traffic_share_yt_search: { kind: 'TRAFFIC_SOURCES', needsViews: true, max: 1, read: (s) => s.shares?.YT_SEARCH },
  traffic_share_related_video: { kind: 'TRAFFIC_SOURCES', needsViews: true, max: 1, read: (s) => s.shares?.RELATED_VIDEO },
  traffic_share_shorts: { kind: 'TRAFFIC_SOURCES', needsViews: true, max: 1, read: (s) => s.shares?.SHORTS }
});
export const AUDIENCE_KIND_LIST = Object.freeze([...new Set(Object.values(AUDIENCE_METRICS).map((m) => m.kind))]);
export const RECOMMENDATION_STATUS = Object.freeze({ PENDING: 'PENDING', APPROVED: 'APPROVED', REJECTED: 'REJECTED' });
export const RESULT_STATUS = Object.freeze({ OK: 'OK', INSUFFICIENT_DATA: 'INSUFFICIENT_DATA' });

const DAY_MS = 24 * 60 * 60 * 1000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function utcDate(ms) { return new Date(ms).toISOString().slice(0, 10); }
function addDays(dateStr, n) { return utcDate(Date.parse(`${dateStr}T00:00:00Z`) + n * DAY_MS); }
function safeJson(s) { try { return JSON.parse(s); } catch { return null; } }
function median(xs) {
  const a = [...xs].sort((x, y) => x - y);
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

/** Exact fixed periods for a publication anchored at anchorISO. */
export function windowPeriods(anchorISO) {
  const ms = Date.parse(anchorISO);
  if (!Number.isFinite(ms)) return null;
  const d0 = utcDate(ms);
  return Object.fromEntries(Object.entries(WINDOWS).map(([k, w]) => [k, { start: addDays(d0, w.startOffsetDays), end: addDays(d0, w.endOffsetDays) }]));
}

/** Reads publications, publish anchors, run modes and snapshots. Read-only. */
export function loadEvidence(storage, { provider = 'youtube' } = {}) {
  const publications = storage.all(
    `SELECT p.id, p.provider, p.provider_item_id, p.status, p.content_version_id, p.request_json, p.result_json,
            (SELECT d.created_at FROM decision_log d WHERE d.decision = 'PUBLISHED' AND d.subject_type = 'content_version'
               AND d.subject_id = p.content_version_id AND d.reason = 'publication_' || p.id || '_persisted' ORDER BY d.created_at ASC LIMIT 1) AS published_at,
            (SELECT r.mode FROM decision_log d JOIN system_runs r ON r.id = d.run_id WHERE d.decision = 'PUBLISHED' AND d.subject_type = 'content_version'
               AND d.subject_id = p.content_version_id AND d.reason = 'publication_' || p.id || '_persisted' ORDER BY d.created_at ASC LIMIT 1) AS run_mode
       FROM publications p WHERE p.provider = ? AND p.status = 'PUBLISHED' AND p.provider_item_id IS NOT NULL`,
    [provider]
  );
  const snapshots = storage.all(
    `SELECT s.* FROM analytics_snapshots s JOIN publications p ON p.id = s.publication_id WHERE p.provider = ? AND s.provider = ?`,
    [provider, provider]
  );
  const audienceSnapshots = storage.all(
    `SELECT s.* FROM analytics_audience_snapshots s JOIN publications p ON p.id = s.publication_id WHERE p.provider = ? AND s.provider = ?`,
    [provider, provider]
  );
  return { provider, publications, snapshots, audienceSnapshots };
}

/**
 * The publication-level gate shared by recommendation generation and by every
 * collection planner (so what is collected is exactly what can be used).
 * Returns the exclusion reason, or null when the publication is eligible.
 * Check order is part of the contract (first failing reason wins).
 */
export function publicationExclusionReason(p, provider) {
  if (p.status !== 'PUBLISHED' || !p.provider_item_id || p.provider !== provider) return 'publication_not_confirmed_published';
  const result = safeJson(p.result_json);
  const request = safeJson(p.request_json);
  if (result?.confirmedVisibility !== 'public') return 'visibility_not_confirmed_public';
  if (request?.requestedPublishAt) return 'scheduled_publication';
  if (!p.published_at) return 'no_persisted_published_decision';
  if (p.run_mode !== 'LIVE') return p.run_mode ? 'run_mode_not_live' : 'publication_not_linked_to_a_run';
  if (!windowPeriods(p.published_at)) return 'unparseable_published_at';
  return null;
}

/** ms timestamp from which a window's data may be used (end + 1 day + latency). */
export function windowUsableAtMs(period) {
  return Date.parse(`${addDays(period.end, 1)}T00:00:00Z`) + DATA_LATENCY_DAYS * DAY_MS;
}

/** Pure: decides which publications/windows yield valid measurements. */
export function collectMeasurements({ provider, publications, snapshots, audienceSnapshots }, { now = new Date().toISOString() } = {}) {
  const nowMs = Date.parse(now);
  const exclusions = [];
  const collectionNeeded = [];
  const audienceCollectionNeeded = [];
  const measurements = []; // { publication, window, metric, value, snapshot, context? }
  const byPub = new Map();
  for (const s of snapshots) { if (!byPub.has(s.publication_id)) byPub.set(s.publication_id, []); byPub.get(s.publication_id).push(s); }
  // Audience evidence is only evaluated when the caller supplies it (loadEvidence always does).
  const audienceEnabled = Array.isArray(audienceSnapshots);
  const audByPub = new Map();
  for (const s of audienceSnapshots ?? []) { if (!audByPub.has(s.publication_id)) audByPub.set(s.publication_id, []); audByPub.get(s.publication_id).push(s); }

  for (const p of publications) {
    const exclude = (reason, window = null) => exclusions.push({ publicationId: p.id, window, reason });
    const gate = publicationExclusionReason(p, provider);
    if (gate) { exclude(gate); continue; }
    const periods = windowPeriods(p.published_at);

    for (const [window, period] of Object.entries(periods)) {
      const usableAtMs = windowUsableAtMs(period);
      if (!(nowMs >= usableAtMs)) { exclude('window_not_yet_usable', window); continue; }

      base: {
        const snap = (byPub.get(p.id) ?? []).find((s) => s.period_start === period.start && s.period_end === period.end);
        if (!snap) { exclude('no_snapshot_for_exact_window', window); collectionNeeded.push({ publicationId: p.id, providerItemId: p.provider_item_id, window, periodStart: period.start, periodEnd: period.end }); break base; }
        if (snap.status !== 'SUCCESS') { exclude('snapshot_not_success', window); break base; }
        if (snap.provider !== p.provider || snap.provider_item_id !== p.provider_item_id) { exclude('snapshot_identity_mismatch', window); break base; }
        if (!DATE_RE.test(snap.period_start) || !DATE_RE.test(snap.period_end)) { exclude('snapshot_period_malformed', window); break base; }
        if (!(Date.parse(snap.collected_at) >= usableAtMs)) { exclude('snapshot_collected_before_data_settled', window); break base; }
        for (const [metric, rule] of Object.entries(METRICS)) {
          const value = snap[metric];
          if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || (rule.max !== undefined && value > rule.max)) { exclude(`${metric}_missing_or_invalid`, window); continue; }
          if (rule.needsImpressions && !(typeof snap.impressions === 'number' && snap.impressions >= MIN_IMPRESSIONS_FOR_CTR)) { exclude(`${metric}_impressions_below_minimum`, window); continue; }
          measurements.push({ publication: p, window, metric, value, snapshot: snap });
        }
      }

      if (!audienceEnabled) continue;
      for (const kind of AUDIENCE_KIND_LIST) {
        const tag = `audience_${kind === 'RETENTION' ? 'retention' : 'traffic'}`;
        const snap = (audByPub.get(p.id) ?? []).find((s) => s.kind === kind && s.period_start === period.start && s.period_end === period.end);
        if (!snap) { exclude(`${tag}_no_snapshot_for_exact_window`, window); audienceCollectionNeeded.push({ publicationId: p.id, providerItemId: p.provider_item_id, window, kind, periodStart: period.start, periodEnd: period.end }); continue; }
        // The reason carries the status, so UNAVAILABLE (no data) is visibly not "zero performance".
        if (snap.status !== 'SUCCESS') { exclude(`${tag}_${String(snap.status).toLowerCase()}`, window); continue; }
        if (snap.provider !== p.provider || snap.provider_item_id !== p.provider_item_id) { exclude(`${tag}_snapshot_identity_mismatch`, window); continue; }
        if (!DATE_RE.test(snap.period_start) || !DATE_RE.test(snap.period_end)) { exclude(`${tag}_snapshot_period_malformed`, window); continue; }
        if (!(Date.parse(snap.collected_at) >= usableAtMs)) { exclude(`${tag}_snapshot_collected_before_data_settled`, window); continue; }
        const summary = safeJson(snap.summary_json);
        if (!summary || typeof summary !== 'object') { exclude(`${tag}_summary_missing`, window); continue; }
        for (const [metric, rule] of Object.entries(AUDIENCE_METRICS)) {
          if (rule.kind !== kind) continue;
          const value = rule.read(summary);
          if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || (rule.max !== undefined && value > rule.max)) { exclude(`${metric}_missing_or_invalid`, window); continue; }
          if (rule.needsViews && !(summary.totalViewsComplete === true && typeof summary.totalViews === 'number' && summary.totalViews >= MIN_TRAFFIC_VIEWS_FOR_SHARE)) { exclude(`${metric}_views_below_minimum`, window); continue; }
          measurements.push({ publication: p, window, metric, value, snapshot: snap, context: kind === 'RETENTION' ? { steepestDrop: summary.steepestDrop ?? null } : { totalViews: summary.totalViews } });
        }
      }
    }
  }
  return { measurements, exclusions, collectionNeeded, audienceCollectionNeeded };
}

/** Pure: builds candidate findings or an explicit INSUFFICIENT_DATA result. */
export function buildRecommendations(evidence, { now = new Date().toISOString() } = {}) {
  const { measurements, exclusions, collectionNeeded, audienceCollectionNeeded } = collectMeasurements(evidence, { now });
  const candidates = [];
  const reasons = [];
  const groups = new Map();
  for (const m of measurements) {
    const key = `${m.window}|${m.metric}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(m);
  }
  if (evidence.publications.length === 0) reasons.push('no_published_publications');
  for (const [key, group] of groups) {
    if (group.length < MIN_BASELINE + 1) { reasons.push(`fewer_than_${MIN_BASELINE + 1}_comparable_measurements_for_${key.replace('|', '_')}`); continue; }
    for (const subject of group) {
      const baseline = group.filter((m) => m !== subject);
      const med = median(baseline.map((m) => m.value));
      if (!(med > 0)) { reasons.push(`baseline_median_not_positive_for_${key.replace('|', '_')}`); continue; }
      const rel = (subject.value - med) / med;
      if (Math.abs(rel) < RELATIVE_THRESHOLD) continue;
      const direction = rel > 0 ? 'ABOVE_BASELINE' : 'BELOW_BASELINE';
      const pct = Math.round(Math.abs(rel) * 100);
      candidates.push({
        publicationId: subject.publication.id,
        provider: subject.publication.provider,
        providerItemId: subject.publication.provider_item_id,
        window: subject.window,
        metric: subject.metric,
        direction,
        subjectValue: subject.value,
        baselineMedian: med,
        baselineCount: baseline.length,
        relativeDifference: rel,
        summary: `${subject.metric} in the ${subject.window} window was ${pct}% ${direction === 'ABOVE_BASELINE' ? 'above' : 'below'} the median of ${baseline.length} other comparable videos (${subject.value} vs ${med}). Descriptive only; not a statistical test or a causal claim.`,
        evidence: { snapshotId: subject.snapshot.id, periodStart: subject.snapshot.period_start, periodEnd: subject.snapshot.period_end, baselineSnapshotIds: baseline.map((m) => m.snapshot.id), ...(AUDIENCE_METRICS[subject.metric] ? { snapshotTable: 'analytics_audience_snapshots', snapshotKind: AUDIENCE_METRICS[subject.metric].kind } : {}), ...(subject.context ? { context: subject.context } : {}) }
      });
    }
  }
  if (measurements.length === 0 && evidence.publications.length > 0) reasons.push('no_valid_measurements');
  const status = groups.size > 0 && [...groups.values()].some((g) => g.length >= MIN_BASELINE + 1) ? RESULT_STATUS.OK : RESULT_STATUS.INSUFFICIENT_DATA;
  return { status, reasons: [...new Set(reasons)], candidates, exclusions, collectionNeeded, audienceCollectionNeeded };
}

function fingerprint(c) {
  return crypto.createHash('sha256').update([c.provider, c.providerItemId, c.window, c.metric, c.direction].join('|')).digest('hex');
}

/**
 * Persists new PENDING recommendations (idempotent per fingerprint; existing
 * rows, including decided ones, are never modified). Reads snapshots only.
 */
export function generateRecommendations({ storage, provider = 'youtube', now = () => new Date().toISOString() } = {}) {
  if (!storage) throw new Error('generateRecommendations requires storage');
  const built = buildRecommendations(loadEvidence(storage, { provider }), { now: now() });
  let created = 0;
  let existing = 0;
  for (const c of built.candidates) {
    const fp = fingerprint(c);
    const res = storage.run(
      `INSERT OR IGNORE INTO analytics_recommendations
        (id, fingerprint, publication_id, provider, provider_item_id, window_kind, metric, direction, subject_value, baseline_median,
         baseline_count, relative_difference, summary, evidence_json, status, decided_at, decision_note, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', NULL, NULL, ?)`,
      [crypto.randomUUID(), fp, c.publicationId, c.provider, c.providerItemId, c.window, c.metric, c.direction, c.subjectValue,
        c.baselineMedian, c.baselineCount, c.relativeDifference, c.summary, JSON.stringify(c.evidence), now()]
    );
    if (res?.changes > 0) created += 1; else existing += 1;
  }
  return { status: built.status, reasons: built.reasons, created, existing, exclusions: built.exclusions, collectionNeeded: built.collectionNeeded, audienceCollectionNeeded: built.audienceCollectionNeeded };
}

export function listRecommendations(storage, { status = null } = {}) {
  return status
    ? storage.all('SELECT * FROM analytics_recommendations WHERE status = ? ORDER BY created_at, id', [status])
    : storage.all('SELECT * FROM analytics_recommendations ORDER BY created_at, id');
}

/**
 * Operator decision. Only a PENDING row can be decided, and the only effect is
 * on that row: approval triggers no discovery, generation or publication.
 */
export function decideRecommendation({ storage, id, decision, note = null, now = () => new Date().toISOString() }) {
  if (decision !== RECOMMENDATION_STATUS.APPROVED && decision !== RECOMMENDATION_STATUS.REJECTED) throw new Error('decision must be APPROVED or REJECTED');
  const res = storage.run(
    `UPDATE analytics_recommendations SET status = ?, decided_at = ?, decision_note = ? WHERE id = ? AND status = 'PENDING'`,
    [decision, now(), note, id]
  );
  if (!(res?.changes > 0)) throw new Error(`recommendation ${id} not found or not PENDING`);
  return storage.get('SELECT * FROM analytics_recommendations WHERE id = ?', [id]);
}
