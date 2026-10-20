/**
 * Autonomous delivery-format selection: LONG_FORM_ONLY | SHORT_FORM_ONLY | BOTH.
 *
 * Decides, per content_version, which delivery formats are worth publishing,
 * using ONLY signals that already exist in the repository's own tables:
 *
 *   - measured narration duration and the short-form segment that
 *     shortFormSelection.js can actually cut (media_artifacts.render_spec_json)
 *   - evidence depth: VERIFIED claims and distinct sources of the item's
 *     research project (claims / claim_sources)
 *   - the Discovery-time feature estimates on the opportunity (novelty,
 *     story_potential, production_difficulty, ...) -- recorded, NOT gated on:
 *     they are unvalidated model estimates, not measured outcomes
 *   - analytics_snapshots sample counts per format -- recorded only; the
 *     decision does not consume performance data in v1 (see MIN_ANALYTICS_SAMPLES)
 *
 * No LLM, no network, no invented analytics. Missing signals are listed
 * explicitly and, when a DECISIVE signal is missing, the result is
 * FORMAT_UNDECIDED: the item keeps today's (pre-selector) behaviour instead
 * of being steered by a guess.
 *
 * This module never renders, never publishes, never transitions
 * content_versions.state. The decision is persisted as ONE decision_log row
 * (decision = FORMAT_*, config_snapshot = signals + thresholds + rule).
 */
import crypto from 'node:crypto';
import { selectShortFormSegment } from './shortFormSelection.js';
import { MEDIA_STAGE, SHORT_FORM_RENDER_DEFAULTS } from './constants.js';
import { publicationTargetForProvider } from '../publication/constants.js';

export const FORMAT_DECISION = Object.freeze({
  LONG_FORM_ONLY: 'FORMAT_LONG_FORM_ONLY',
  SHORT_FORM_ONLY: 'FORMAT_SHORT_FORM_ONLY',
  BOTH: 'FORMAT_BOTH',
  // A decisive signal is missing: no format steering, legacy behaviour.
  UNDECIDED: 'FORMAT_UNDECIDED'
});

const FORMAT_DECISION_VALUES = Object.freeze(Object.values(FORMAT_DECISION));

/**
 * POLICY DEFAULTS, not calibrated values. No outcome data exists in this
 * repository to calibrate them against; they are recorded verbatim in every
 * decision's config_snapshot so a later calibration can be compared with
 * what was actually applied.
 */
export const FORMAT_SELECTION_THRESHOLDS = Object.freeze({
  // Long-form depth: enough substantiated material for a video longer than
  // the short-form cap to be more than padding.
  LONG_FORM_MIN_VERIFIED_CLAIMS: 5,
  LONG_FORM_MIN_DISTINCT_SOURCES: 3,
  // A segment shorter than this is not a viable standalone short.
  SHORT_FORM_MIN_SECONDS: 15,
  // Below this many SUCCESS snapshots per target, performance data is
  // reported as unavailable (and, in v1, never consumed either way).
  MIN_ANALYTICS_SAMPLES: 10
});

const SOFT_OPPORTUNITY_FIELDS = Object.freeze([
  'novelty', 'competition', 'story_potential', 'evidence_availability', 'production_difficulty', 'overall_score'
]);

function isFiniteNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * Pure, deterministic decision.
 *
 * @param {object} signals
 * @param {number|null} signals.narrationDurationSeconds - measured long-form narration duration
 * @param {{selected:boolean,startSeconds?:number,endSeconds?:number,reason?:string}|null} signals.shortSegment - result of selectShortFormSegment
 * @param {number|null} signals.verifiedClaims
 * @param {number|null} signals.distinctSources
 * @param {object} [thresholds]
 * @returns {{decision:string, rule:string, reasons:string[], missingSignals:string[], viable:{long:boolean|null, short:boolean|null}}}
 */
export function decideVideoFormat(signals, thresholds = FORMAT_SELECTION_THRESHOLDS) {
  const missingSignals = [];
  const s = signals && typeof signals === 'object' ? signals : {};

  const duration = isFiniteNumber(s.narrationDurationSeconds) && s.narrationDurationSeconds > 0
    ? s.narrationDurationSeconds : null;
  if (duration === null) missingSignals.push('narration_duration');

  const claims = isFiniteNumber(s.verifiedClaims) && s.verifiedClaims >= 0 ? s.verifiedClaims : null;
  const sources = isFiniteNumber(s.distinctSources) && s.distinctSources >= 0 ? s.distinctSources : null;
  if (claims === null || sources === null) missingSignals.push('evidence_depth');

  const segment = s.shortSegment && typeof s.shortSegment === 'object' && typeof s.shortSegment.selected === 'boolean'
    ? s.shortSegment : null;
  if (segment === null) missingSignals.push('short_segment');

  if (duration === null || claims === null || sources === null || segment === null) {
    return {
      decision: FORMAT_DECISION.UNDECIDED,
      rule: 'DECISIVE_SIGNAL_MISSING',
      reasons: [`decisive signal(s) unavailable: ${missingSignals.join(', ')}; no format steering applied`],
      missingSignals,
      viable: { long: null, short: null }
    };
  }

  const shortCap = SHORT_FORM_RENDER_DEFAULTS.MAX_DURATION_SECONDS;
  const reasons = [];

  const segmentSeconds = segment.selected ? segment.endSeconds - segment.startSeconds : 0;
  const shortViable = segment.selected && segmentSeconds >= thresholds.SHORT_FORM_MIN_SECONDS;
  if (shortViable) {
    reasons.push(`short-form: bounded segment of ${segmentSeconds}s exists at an existing segment boundary`);
  } else if (!segment.selected) {
    reasons.push(`short-form: no valid segment (${segment.reason ?? 'unspecified'})`);
  } else {
    reasons.push(`short-form: segment ${segmentSeconds}s is below the ${thresholds.SHORT_FORM_MIN_SECONDS}s minimum`);
  }

  const longerThanShort = duration > shortCap;
  const deepEnough =
    claims >= thresholds.LONG_FORM_MIN_VERIFIED_CLAIMS && sources >= thresholds.LONG_FORM_MIN_DISTINCT_SOURCES;
  const longViable = longerThanShort && deepEnough;
  if (longViable) {
    reasons.push(
      `long-form: ${duration}s narration exceeds the ${shortCap}s short cap and evidence depth is sufficient ` +
      `(${claims} verified claims, ${sources} distinct sources)`
    );
  } else if (!longerThanShort) {
    reasons.push(`long-form: ${duration}s narration does not exceed the ${shortCap}s short cap, so it adds nothing over the short`);
  } else {
    reasons.push(
      `long-form: evidence depth below policy default (${claims}/${thresholds.LONG_FORM_MIN_VERIFIED_CLAIMS} verified claims, ` +
      `${sources}/${thresholds.LONG_FORM_MIN_DISTINCT_SOURCES} distinct sources)`
    );
  }

  const viable = { long: longViable, short: shortViable };
  let decision;
  let rule;
  if (longViable && shortViable) {
    decision = FORMAT_DECISION.BOTH;
    rule = 'BOTH_VIABLE';
    reasons.push('both formats viable: the short reuses the long-form narration, visuals and timing (one extra render, no new research)');
  } else if (longViable) {
    decision = FORMAT_DECISION.LONG_FORM_ONLY;
    rule = 'LONG_ONLY_NO_VIABLE_SHORT';
  } else if (shortViable) {
    decision = FORMAT_DECISION.SHORT_FORM_ONLY;
    rule = 'SHORT_ONLY_LONG_NOT_VIABLE';
  } else {
    // Neither proven viable: do NOT steer. Recording LONG_FORM_ONLY here would
    // exclude every configured short-form publication provider, which the
    // pre-selector engine did not do. UNDECIDED = legacy behaviour (both
    // formats stay eligible; the short-form stage reports its own outcome).
    decision = FORMAT_DECISION.UNDECIDED;
    rule = 'FALLBACK_NO_FORMAT_PROVEN';
    reasons.push('neither format proven viable; no format steering applied (pre-selector behaviour preserved)');
  }

  return { decision, rule, reasons, missingSignals, viable };
}

/** Which formats a recorded decision authorises for publication. UNDECIDED / no decision = legacy: both. */
export function formatsForDecision(decision) {
  switch (decision) {
    case FORMAT_DECISION.LONG_FORM_ONLY: return { longForm: true, shortForm: false };
    case FORMAT_DECISION.SHORT_FORM_ONLY: return { longForm: false, shortForm: true };
    default: return { longForm: true, shortForm: true };
  }
}

/** The FORMAT_* decision that EXCLUDES the given publication provider's target (or null if none does). */
export function excludingDecisionForProvider(provider) {
  return publicationTargetForProvider(provider) === 'SHORT_FORM'
    ? FORMAT_DECISION.LONG_FORM_ONLY
    : FORMAT_DECISION.SHORT_FORM_ONLY;
}

/** Latest persisted FORMAT_* decision row for a content_version, or null. */
export function getFormatDecision(storage, contentVersionId) {
  const placeholders = FORMAT_DECISION_VALUES.map(() => '?').join(',');
  return storage.get(
    `SELECT * FROM decision_log
     WHERE subject_type = 'content_version' AND subject_id = ? AND decision IN (${placeholders})
     ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    [contentVersionId, ...FORMAT_DECISION_VALUES]
  ) ?? null;
}

function parseJson(text) {
  try { return JSON.parse(text); } catch { return null; }
}

/**
 * Reads every available signal for one content_version. Never throws on
 * missing data: an unavailable signal is null and named in `missing`.
 */
export function collectFormatSignals(storage, { contentVersion, longFormArtifact }) {
  const missing = [];

  // --- Measured media signals (long-form render_spec, already computed) ---
  const spec = longFormArtifact ? parseJson(longFormArtifact.render_spec_json) : null;
  const narrationDurationSeconds = isFiniteNumber(spec?.narration?.duration_seconds) ? spec.narration.duration_seconds : null;
  const shortSegment = spec && narrationDurationSeconds !== null
    ? selectShortFormSegment({
        visualTiming: spec.visual_timing,
        captionTiming: spec.captions,
        narrationDurationSeconds,
        maxDurationSeconds: SHORT_FORM_RENDER_DEFAULTS.MAX_DURATION_SECONDS
      })
    : null;

  // --- Evidence depth (research project of the same opportunity) ---
  const brief = storage.get('SELECT * FROM content_briefs WHERE id = ?', [contentVersion.content_brief_id]);
  const opportunityId = brief?.opportunity_id ?? null;
  let verifiedClaims = null;
  let distinctSources = null;
  // The brief's own research_project_id is the precise link; fall back to the
  // opportunity's project (UNIQUE per opportunity) only when it is unset.
  const project = brief?.research_project_id
    ? { id: brief.research_project_id }
    : (opportunityId
        ? storage.get('SELECT id FROM research_projects WHERE opportunity_id = ?', [opportunityId])
        : null);
  if (project) {
    verifiedClaims = storage.get(
      `SELECT COUNT(*) AS n FROM claims WHERE research_project_id = ? AND evidence_status = 'VERIFIED'`,
      [project.id]
    ).n;
    distinctSources = storage.get(
      `SELECT COUNT(DISTINCT cs.source_id) AS n
       FROM claim_sources cs JOIN claims c ON c.id = cs.claim_id
       WHERE c.research_project_id = ? AND c.evidence_status = 'VERIFIED'`,
      [project.id]
    ).n;
  }

  // --- Discovery-time estimates (recorded, not gated) ---
  const opportunity = opportunityId ? storage.get('SELECT * FROM opportunities WHERE id = ?', [opportunityId]) : null;
  const opportunityEstimates = {};
  for (const f of SOFT_OPPORTUNITY_FIELDS) {
    opportunityEstimates[f] = isFiniteNumber(opportunity?.[f]) ? opportunity[f] : null;
  }
  if (Object.values(opportunityEstimates).every((v) => v === null)) missing.push('opportunity_estimates');

  // --- Historical performance: availability only, never consumed in v1 ---
  const analytics = { longForm: 0, shortForm: 0 };
  const rows = storage.all(
    `SELECT provider, COUNT(*) AS n FROM analytics_snapshots WHERE status = 'SUCCESS' GROUP BY provider`
  );
  for (const r of rows) {
    if (publicationTargetForProvider(r.provider) === 'SHORT_FORM') analytics.shortForm += r.n;
    else analytics.longForm += r.n;
  }
  const enough = FORMAT_SELECTION_THRESHOLDS.MIN_ANALYTICS_SAMPLES;
  if (analytics.longForm < enough || analytics.shortForm < enough) missing.push('historical_performance');

  return {
    signals: { narrationDurationSeconds, shortSegment, verifiedClaims, distinctSources },
    context: {
      opportunityEstimates,
      analyticsSuccessSnapshots: analytics,
      historicalPerformance: analytics.longForm >= enough && analytics.shortForm >= enough
        ? 'AVAILABLE_NOT_CONSUMED_V1'
        : 'UNAVAILABLE'
    },
    missingContext: missing
  };
}

function insertFormatDecision(storage, { runId, contentVersionId, decision, reason, snapshot }, nowISO) {
  const id = crypto.randomUUID();
  storage.run(
    `INSERT INTO decision_log
      (id, run_id, subject_type, subject_id, decision, reason, provider, config_snapshot, confidence, risk_level, resulting_state, created_at, stage)
     VALUES (?, ?, 'content_version', ?, ?, ?, NULL, ?, NULL, NULL, NULL, ?, ?)`,
    [id, runId, contentVersionId, decision, reason, JSON.stringify(snapshot), nowISO(), MEDIA_STAGE]
  );
  return id;
}

/**
 * Idempotent: returns the existing decision if one was already recorded.
 * Requires the long-form media_artifacts row (its measured render_spec is the
 * decisive input); without it returns { outcome: 'NOT_YET_PRODUCED' } and
 * records nothing.
 */
export function runFormatSelection({ storage, contentBriefId, runId = null }) {
  const nowISO = () => new Date().toISOString();
  const contentVersion = storage.get('SELECT * FROM content_versions WHERE content_brief_id = ?', [contentBriefId]);
  if (!contentVersion) return { outcome: 'STRUCTURAL_FAILURE', reason: 'CONTENT_VERSION_NOT_FOUND', decision: null };

  const existing = getFormatDecision(storage, contentVersion.id);
  if (existing) return { outcome: 'ALREADY_DECIDED', decision: existing.decision, row: existing };

  const longFormArtifact = storage.get('SELECT * FROM media_artifacts WHERE content_version_id = ?', [contentVersion.id]);
  if (!longFormArtifact) return { outcome: 'NOT_YET_PRODUCED', reason: 'LONG_FORM_NOT_YET_RENDERED', decision: null };

  const { signals, context, missingContext } = collectFormatSignals(storage, { contentVersion, longFormArtifact });
  const result = decideVideoFormat(signals);
  const snapshot = {
    rule: result.rule,
    reasons: result.reasons,
    viable: result.viable,
    signals,
    context,
    missing_signals: [...result.missingSignals, ...missingContext],
    thresholds: FORMAT_SELECTION_THRESHOLDS,
    segment_basis: 'PREFIX_V1'
  };
  insertFormatDecision(storage, {
    runId,
    contentVersionId: contentVersion.id,
    decision: result.decision,
    reason: result.reasons.join(' | '),
    snapshot
  }, nowISO);
  return { outcome: 'DECIDED', decision: result.decision, rule: result.rule, reasons: result.reasons, missingSignals: snapshot.missing_signals };
}

/**
 * The autonomous short-form stage body: decide the format first (idempotent),
 * then derive the short only when the decision includes it. `produceShortForm`
 * is runShortFormProduction, injected to keep this module free of the
 * render pipeline.
 */
export function runFormatAwareShortForm({ storage, contentBriefId, artifactsDir, runId = null, produceShortForm }) {
  const selection = runFormatSelection({ storage, contentBriefId, runId });
  if (selection.outcome === 'DECIDED' || selection.outcome === 'ALREADY_DECIDED') {
    if (!formatsForDecision(selection.decision).shortForm) {
      return { outcome: 'SHORT_FORM_NOT_SELECTED', formatDecision: selection.decision, mediaArtifact: null };
    }
  }
  // NOT_YET_PRODUCED / STRUCTURAL_FAILURE fall through: the production
  // function reports them with its own, unchanged outcomes.
  return produceShortForm({ storage, contentBriefId, artifactsDir, runId });
}
