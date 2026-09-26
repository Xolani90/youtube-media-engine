import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { MEDIA_STAGE, OUTCOME, DECISION_LOG_DECISION, RENDER_DEFAULTS, CAPTION_DEFAULTS, SHORT_FORM_RENDER_DEFAULTS } from './constants.js';
import { resolveProductionForMedia } from './eligibility.js';
import { selectVisualAssets } from './visualTiming.js';
import { computeVisualSequencing } from './visualSequencing.js';
import { segmentCaptions, computeCaptionTiming } from './captionTiming.js';
import { buildRenderSpec, renderSpecChecksum } from './renderSpec.js';
import { synthesizeNarration, probeDurationSeconds } from './narration.js';
import { scriptBodyToNarrationText, ScriptBodyContractError } from './scriptText.js';
import { renderSilentVideo, muxNarration, writeSrtFile } from './render.js';
import { validateMediaArtifact } from './validate.js';
import { mediaDir, finalizeArtifact, sha256File } from './artifactStore.js';
import { selectShortFormSegment, trimVisualTiming, trimCaptionTiming } from './shortFormSelection.js';
import { AssetProvenanceRepository } from '../state/AssetProvenance.js';
import { config } from '../config/index.js';
import { traceSync } from '../diagnostics/trace.js';
import { isQuarantined, recordFailedAttemptIfRetryable, retryFields, FAILURE_NATURE, RETRY_STAGE } from '../state/StageRetryPolicy.js';

/** Same shape/discipline as every other stage's local logDecision helper. Media Production never transitions content_versions.state, so resultingState is always null here. */
function logDecision(storage, { runId = null, subjectType, subjectId, decision, reason }, nowISO = () => new Date().toISOString()) {
  const id = crypto.randomUUID();
  storage.run(
    `INSERT INTO decision_log
      (id, run_id, subject_type, subject_id, decision, reason, provider, config_snapshot, confidence, risk_level, resulting_state, created_at, stage)
     VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, ?, ?)`,
    [id, runId, subjectType, subjectId, decision, reason, nowISO(), MEDIA_STAGE]
  );
  return id;
}

/** D-G2 assets currently attached to this content_version, with usage_context merged in. Read-only. Identical helper to src/production/pipeline.js's own (deliberately re-implemented, per the existing per-stage decoupling convention). */
function fetchAssetsWithUsageContext(storage, contentVersionId) {
  const repo = new AssetProvenanceRepository(storage);
  const assets = repo.getAssetsForContent(contentVersionId);
  const usageRows = storage.all(
    'SELECT asset_id, usage_context FROM asset_usages WHERE content_version_id = ?',
    [contentVersionId]
  );
  const usageByAssetId = new Map(usageRows.map((u) => [u.asset_id, u.usage_context]));
  return assets.map((a) => ({ ...a, usage_context: usageByAssetId.get(a.id) ?? null }));
}

/**
 * Runs Real Media Production v1 for the current Script of a content
 * item that Production MVP has already produced (Owner brief). Standalone,
 * explicitly-invoked stage — no orchestrator calls this automatically,
 * mirroring every prior stage's manual-trigger-surface convention.
 *
 * Entry precondition: content_version.state === 'PRODUCED' and a
 * `productions` row exists for it (Production MVP already ran). This
 * stage never transitions content_versions.state itself — see
 * constants.js's module docstring for why.
 *
 * @param {object} deps
 * @param {import('../storage/StorageDriver.js').StorageDriver} deps.storage
 * @param {string} deps.contentBriefId
 * @param {string} [deps.artifactsDir] - defaults to config.mediaArtifactsDir
 * @param {string} [deps.runId]
 */
export function runMediaProduction({ storage, contentBriefId, artifactsDir = config.mediaArtifactsDir, runId = null }) {
  const nowISO = () => new Date().toISOString();

  const eligibility = resolveProductionForMedia(storage, contentBriefId);
  if (!eligibility.eligible) {
    const decision = eligibility.reason === 'NO_PRODUCTION_RECORD'
      ? DECISION_LOG_DECISION.NOT_YET_PRODUCED
      : DECISION_LOG_DECISION.STRUCTURAL_FAILURE;
    logDecision(storage, {
      runId, subjectType: 'content_brief', subjectId: contentBriefId,
      decision, reason: eligibility.reason
    }, nowISO);
    const outcome = eligibility.reason === 'NO_PRODUCTION_RECORD' ? OUTCOME.NOT_YET_PRODUCED : OUTCOME.STRUCTURAL_FAILURE;
    return { outcome, reason: eligibility.reason, mediaArtifact: null };
  }
  const { contentVersion, script, production } = eligibility;

  if (contentVersion.state !== 'PRODUCED') {
    logDecision(storage, {
      runId, subjectType: 'content_version', subjectId: contentVersion.id,
      decision: DECISION_LOG_DECISION.NOT_YET_PRODUCED, reason: `content_version_state_${contentVersion.state}`
    }, nowISO);
    return { outcome: OUTCOME.NOT_YET_PRODUCED, reason: contentVersion.state, mediaArtifact: null };
  }

  // A4 bounded-retry governance: a quarantined content version is refused on
  // direct invocation too (no narration/render work is started). Owner-only
  // reactivation is the sole way out.
  if (isQuarantined(storage, contentVersion.id, RETRY_STAGE.MEDIA_PRODUCTION)) {
    logDecision(storage, {
      runId, subjectType: 'content_version', subjectId: contentVersion.id,
      decision: 'QUARANTINE_REFUSED', reason: 'media_production_quarantined_owner_reactivation_required'
    }, nowISO);
    return { outcome: OUTCOME.QUARANTINED, reason: 'MEDIA_PRODUCTION_QUARANTINED', mediaArtifact: null };
  }

  // A4: NARRATION_FAILED, RENDER_FAILED, VALIDATION_FAILED and
  // ASSET_CHECKSUM_MISMATCH are the four authorized named outcome CLASSES; they
  // share ONE budget under (MEDIA_PRODUCTION, content_version_id), but a
  // failure consumes it only if its evidence establishes a transient,
  // item-specific cause (see StageRetryPolicy assessRetryEligibility).
  // ASSET_CHECKSUM_MISMATCH is deterministic by default (stored bytes differ
  // from the declared checksum: re-checking cannot change that). No site below
  // currently establishes a transient cause, so every failure is logged and
  // returned exactly as before, records no attempt, and never quarantines;
  // formal classification is Slice 3. One invocation ends in at most one
  // failure and there is no in-invocation retry of any of them. The
  // decision_log entry and the (eligible-only) counter/quarantine commit in
  // ONE transaction; a persistence error propagates.
  const failWith = (outcome, decision, logReason, resultReason, evidence) => {
    const retry = storage.transaction(() => {
      logDecision(storage, {
        runId, subjectType: 'content_version', subjectId: contentVersion.id, decision, reason: logReason
      }, nowISO);
      return recordFailedAttemptIfRetryable(storage, {
        outcome, evidence,
        subjectId: contentVersion.id, stage: RETRY_STAGE.MEDIA_PRODUCTION, reason: `${outcome}_${logReason}`, runId, nowISO
      });
    });
    return { outcome, reason: resultReason, mediaArtifact: null, ...retryFields(retry) };
  };

  // Idempotency: one media_artifacts row per content_version (UNIQUE
  // index, mirrors productions' own precedent). Already-rendered ->
  // return the existing record unchanged, never re-render.
  const existingArtifact = storage.get('SELECT * FROM media_artifacts WHERE content_version_id = ?', [contentVersion.id]);
  if (existingArtifact) {
    return { outcome: OUTCOME.ALREADY_RENDERED, mediaArtifact: existingArtifact };
  }

  // Re-check D-G2 asset rights at render time (assets may have changed
  // since Production MVP ran) — identical discipline to Production MVP's
  // own re-check. usage_restrictions free text is never parsed.
  const assets = fetchAssetsWithUsageContext(storage, contentVersion.id);
  const unsafeAsset = assets.find((a) => a.verification_status === 'DISPUTED' || a.verification_status === 'UNVERIFIED');
  if (unsafeAsset) {
    logDecision(storage, {
      runId, subjectType: 'content_version', subjectId: contentVersion.id,
      decision: DECISION_LOG_DECISION.ASSET_RIGHTS_BLOCKED,
      reason: `asset_${unsafeAsset.id}_verification_status_${unsafeAsset.verification_status}`
    }, nowISO);
    return { outcome: OUTCOME.ASSET_RIGHTS_BLOCKED, reason: unsafeAsset.verification_status, mediaArtifact: null };
  }

  // Checksum verification where applicable (Owner brief §15): only for
  // assets that both declare a checksum AND whose file is present on
  // disk right now — a missing file is handled explicitly below, as a
  // render precondition, not silently treated as a rights problem.
  for (const asset of assets) {
    if (asset.checksum && fs.existsSync(asset.location)) {
      const actual = sha256File(asset.location);
      if (actual !== asset.checksum) {
        return failWith(
          OUTCOME.ASSET_CHECKSUM_MISMATCH, DECISION_LOG_DECISION.ASSET_CHECKSUM_MISMATCH,
          `asset_${asset.id}_checksum_mismatch`, `asset_${asset.id}`
        );
      }
    }
  }

  const visualAssets = selectVisualAssets(assets);
  if (visualAssets.length === 0) {
    logDecision(storage, {
      runId, subjectType: 'content_version', subjectId: contentVersion.id,
      decision: DECISION_LOG_DECISION.NO_VISUAL_ASSETS, reason: 'no_usable_visual_assets_attached'
    }, nowISO);
    return { outcome: OUTCOME.NO_VISUAL_ASSETS, mediaArtifact: null };
  }
  const missingAsset = visualAssets.find((a) => !fs.existsSync(a.location));
  if (missingAsset) {
    return failWith(
      OUTCOME.RENDER_FAILED, DECISION_LOG_DECISION.RENDER_FAILED,
      `missing_asset_file_${missingAsset.id}`, `missing_asset_file_${missingAsset.id}`
    );
  }

  // --- Script -> Media contract (B-01 / F-4) ---
  // scripts.body is the persisted structured (JSON) script. Convert it
  // ONCE, deterministically, into the human-readable prose that both
  // narration and caption segmentation consume (src/media/scriptText.js).
  // A body that cannot be interpreted per the Script contract fails
  // explicitly here -- before any narration or render work -- rather than
  // being spoken or captioned as raw JSON. No new outcome or state is
  // introduced: this is a narration-input failure.
  let narrationText;
  try {
    narrationText = scriptBodyToNarrationText(script.body);
  } catch (err) {
    if (!(err instanceof ScriptBodyContractError)) throw err;
    return failWith(
      OUTCOME.NARRATION_FAILED, DECISION_LOG_DECISION.NARRATION_FAILED,
      `script_body_contract_violation_${err.reason}`, err.reason,
      // The stored script body is the same on every run: deterministic.
      { nature: FAILURE_NATURE.DETERMINISTIC, basis: `script_body_contract_violation_${err.reason}` }
    );
  }

  const dir = mediaDir(artifactsDir, contentVersion.id);

  // --- Narration ---
  const narrationPath = path.join(dir, 'narration.wav');
  const narrationTmpPath = path.join(dir, `.narration.wav.tmp-${process.pid}-${Date.now()}`);
  let narrationDurationSeconds;
  try {
    traceSync('child.espeak-ng', { textChars: narrationText?.length }, () => synthesizeNarration(narrationText, narrationTmpPath));
    fs.renameSync(narrationTmpPath, narrationPath);
    narrationDurationSeconds = traceSync('child.ffprobe.narration', {}, () => probeDurationSeconds(narrationPath));
  } catch (err) {
    fs.rmSync(narrationTmpPath, { force: true });
    return failWith(
      OUTCOME.NARRATION_FAILED, DECISION_LOG_DECISION.NARRATION_FAILED,
      `narration_failed_${err.message}`, err.message
    );
  }

  // --- Captions (Media Production v1.1) ---
  // Caption text is the SAME narrationText the narrator speaks (the
  // canonical Script -> Media conversion above), deterministically
  // segmented — never an LLM, never a rewrite. No caption-worthy text
  // simply renders with no subtitles, exactly as v1 did. Computed before
  // visual sequencing (below) because v1.2's sequencing uses caption
  // segment boundaries as its script-structure signal.
  const captionSegments = segmentCaptions(narrationText, CAPTION_DEFAULTS.MAX_CAPTION_LENGTH);
  let captionTiming = [];
  if (captionSegments.length > 0) {
    try {
      captionTiming = computeCaptionTiming(captionSegments, narrationDurationSeconds);
    } catch (err) {
      return failWith(
        OUTCOME.RENDER_FAILED, DECISION_LOG_DECISION.RENDER_FAILED,
        `caption_timing_failed_${err.message}`, err.message
      );
    }
  }

  // --- Visual sequencing (Media Production v1.2) ---
  // Deterministic, script-aware timing: uses caption segment boundaries
  // (computed just above) as scene-cut candidates instead of a flat
  // equal-share division. Falls back to the plain equal-division
  // timeline unchanged when there's no caption structure to key off of.
  const visualTiming = computeVisualSequencing(visualAssets, captionTiming, narrationDurationSeconds);

  // --- Render spec ---
  const renderSpec = buildRenderSpec({ contentVersion, narrationPath, narrationDurationSeconds, visualTiming, captions: captionTiming });
  const { json: renderSpecJson, checksum: renderSpecChecksumValue } = renderSpecChecksum(renderSpec);

  // --- Render (temporary paths; only promoted to final paths after validation) ---
  const silentVideoTmpPath = path.join(dir, `.silent.tmp-${process.pid}-${Date.now()}.mp4`);
  const concatListTmpPath = path.join(dir, `.concat.tmp-${process.pid}-${Date.now()}.txt`);
  const finalVideoTmpPath = path.join(dir, `.video.tmp-${process.pid}-${Date.now()}.mp4`);
  const finalVideoPath = path.join(dir, 'video.mp4');
  // Only written when there are captions to burn in.
  const captionsSrtTmpPath = captionTiming.length > 0
    ? path.join(dir, `.captions.tmp-${process.pid}-${Date.now()}.srt`)
    : null;

  try {
    if (captionsSrtTmpPath) {
      writeSrtFile(captionTiming, captionsSrtTmpPath);
    }
    traceSync('child.ffmpeg.render', { segments: visualTiming?.length }, () => renderSilentVideo({
      visualTiming,
      width: RENDER_DEFAULTS.WIDTH,
      height: RENDER_DEFAULTS.HEIGHT,
      fps: RENDER_DEFAULTS.FPS,
      videoEncoder: RENDER_DEFAULTS.VIDEO_ENCODER,
      listPath: concatListTmpPath,
      outputPath: silentVideoTmpPath,
      subtitlesPath: captionsSrtTmpPath
    }));
    traceSync('child.ffmpeg.mux', {}, () => muxNarration({
      silentVideoPath: silentVideoTmpPath,
      narrationPath,
      audioEncoder: RENDER_DEFAULTS.AUDIO_ENCODER,
      outputPath: finalVideoTmpPath
    }));
  } catch (err) {
    fs.rmSync(silentVideoTmpPath, { force: true });
    fs.rmSync(finalVideoTmpPath, { force: true });
    return failWith(
      OUTCOME.RENDER_FAILED, DECISION_LOG_DECISION.RENDER_FAILED,
      `render_failed_${err.message}`, err.message
    );
  } finally {
    fs.rmSync(silentVideoTmpPath, { force: true });
    if (captionsSrtTmpPath) fs.rmSync(captionsSrtTmpPath, { force: true });
  }

  // --- Validate BEFORE persisting anything or promoting the tmp path ---
  const validation = traceSync('child.ffprobe.validate', {}, () => validateMediaArtifact(finalVideoTmpPath, {
    width: RENDER_DEFAULTS.WIDTH,
    height: RENDER_DEFAULTS.HEIGHT,
    videoCodecName: RENDER_DEFAULTS.VIDEO_CODEC_NAME,
    audioCodecName: RENDER_DEFAULTS.AUDIO_CODEC_NAME
  }));
  if (!validation.valid) {
    fs.rmSync(finalVideoTmpPath, { force: true });
    return failWith(
      OUTCOME.VALIDATION_FAILED, DECISION_LOG_DECISION.VALIDATION_FAILED,
      `validation_failed_${validation.reason}`, validation.reason
    );
  }

  // Validated -> promote to the final deterministic path (atomic rename).
  finalizeArtifact(finalVideoTmpPath, finalVideoPath);
  const artifactChecksum = sha256File(finalVideoPath);

  const outcome = storage.transaction(() => {
    // Re-check for a race: a concurrent run may have already inserted a
    // media_artifacts row for this content_version while this run was
    // rendering. If so, this run's file is an inconsequential duplicate
    // of what a concurrent successful run would also have produced
    // (same deterministic render spec/visual timing; narration audio
    // bytes are genuinely deterministic too, per constants.js's
    // documented espeak-ng finding) — no second DB row is inserted.
    const raceExisting = storage.get('SELECT * FROM media_artifacts WHERE content_version_id = ?', [contentVersion.id]);
    if (raceExisting) {
      return { raced: true };
    }
    const stillProduction = storage.get('SELECT * FROM productions WHERE id = ?', [production.id]);
    if (!stillProduction) {
      throw new Error(`productions row ${production.id} no longer exists; refusing to persist Media Production result.`);
    }

    const mediaArtifactId = crypto.randomUUID();
    storage.run(
      `INSERT INTO media_artifacts
        (id, production_id, content_version_id, render_spec_json, render_spec_checksum,
         narration_path, narration_duration_seconds, artifact_path, artifact_checksum,
         duration_seconds, width, height, video_codec, audio_codec, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        mediaArtifactId, production.id, contentVersion.id, renderSpecJson, renderSpecChecksumValue,
        narrationPath, narrationDurationSeconds, finalVideoPath, artifactChecksum,
        validation.duration, validation.width, validation.height, validation.videoCodec, validation.audioCodec,
        nowISO()
      ]
    );
    logDecision(storage, {
      runId, subjectType: 'content_version', subjectId: contentVersion.id,
      decision: DECISION_LOG_DECISION.RENDERED, reason: `media_artifact_persisted_${mediaArtifactId}`
    }, nowISO);

    return { mediaArtifactId };
  });

  if (outcome.raced) {
    const existing = storage.get('SELECT * FROM media_artifacts WHERE content_version_id = ?', [contentVersion.id]);
    return { outcome: OUTCOME.ALREADY_RENDERED, mediaArtifact: existing ?? null };
  }

  const mediaArtifact = storage.get('SELECT * FROM media_artifacts WHERE id = ?', [outcome.mediaArtifactId]);
  return { outcome: OUTCOME.RENDERED, mediaArtifact };
}

/**
 * Short-form derivative production (v1): renders a bounded-duration,
 * vertical (1080x1920) derivative of an ALREADY-RENDERED long-form
 * media_artifacts row. Deliberately thin -- it re-reads the source's
 * own already-computed render_spec_json (visual_timing/captions/
 * narration duration) rather than recomputing anything from scratch,
 * selects a deterministic bounded segment (shortFormSelection.js), and
 * reuses the same render/mux/validate/artifact functions long-form uses
 * unmodified, just with different width/height/output-path/duration.
 *
 * No LLM, no Whisper, no "viral clip" heuristic -- this is
 * infrastructure, not content intelligence (see shortFormSelection.js).
 *
 * Entry precondition: an existing `media_artifacts` row for the
 * content_version (long-form must already be rendered). This stage
 * never transitions content_versions.state, exactly like
 * runMediaProduction above.
 *
 * @param {object} deps
 * @param {import('../storage/StorageDriver.js').StorageDriver} deps.storage
 * @param {string} deps.contentBriefId
 * @param {string} [deps.artifactsDir] - defaults to config.mediaArtifactsDir
 * @param {string} [deps.runId]
 */
export function runShortFormProduction({ storage, contentBriefId, artifactsDir = config.mediaArtifactsDir, runId = null }) {
  const nowISO = () => new Date().toISOString();

  // Same content_version resolution rule every stage uses independently
  // (content_briefs -> content_versions is a direct FK; no script/brief
  // lookup is needed here since this stage reads ONLY the long-form
  // media_artifacts row, never the script/brief themselves).
  const contentVersion = storage.get(
    'SELECT * FROM content_versions WHERE content_brief_id = ?',
    [contentBriefId]
  );
  if (!contentVersion) {
    logDecision(storage, {
      runId, subjectType: 'content_brief', subjectId: contentBriefId,
      decision: DECISION_LOG_DECISION.STRUCTURAL_FAILURE, reason: 'CONTENT_VERSION_NOT_FOUND'
    }, nowISO);
    return { outcome: OUTCOME.STRUCTURAL_FAILURE, reason: 'CONTENT_VERSION_NOT_FOUND', mediaArtifact: null };
  }

  const longFormArtifact = storage.get(
    'SELECT * FROM media_artifacts WHERE content_version_id = ?',
    [contentVersion.id]
  );
  if (!longFormArtifact) {
    logDecision(storage, {
      runId, subjectType: 'content_version', subjectId: contentVersion.id,
      decision: DECISION_LOG_DECISION.NOT_YET_PRODUCED, reason: 'LONG_FORM_NOT_YET_RENDERED'
    }, nowISO);
    return { outcome: OUTCOME.NOT_YET_PRODUCED, reason: 'LONG_FORM_NOT_YET_RENDERED', mediaArtifact: null };
  }

  // Idempotency: one short_form_media_artifacts row per content_version
  // (UNIQUE index, same one-row-per-subject precedent as media_artifacts
  // itself). Already-rendered -> return the existing record unchanged.
  const existingShortForm = storage.get(
    'SELECT * FROM short_form_media_artifacts WHERE content_version_id = ?',
    [contentVersion.id]
  );
  if (existingShortForm) {
    return { outcome: OUTCOME.ALREADY_RENDERED, mediaArtifact: existingShortForm };
  }

  // --- Read the source's own already-computed timing; never recompute. ---
  let sourceRenderSpec;
  try {
    sourceRenderSpec = JSON.parse(longFormArtifact.render_spec_json);
  } catch (err) {
    logDecision(storage, {
      runId, subjectType: 'content_version', subjectId: contentVersion.id,
      decision: DECISION_LOG_DECISION.STRUCTURAL_FAILURE, reason: `source_render_spec_unparseable_${err.message}`
    }, nowISO);
    return { outcome: OUTCOME.STRUCTURAL_FAILURE, reason: 'SOURCE_RENDER_SPEC_UNPARSEABLE', mediaArtifact: null };
  }

  const selection = selectShortFormSegment({
    visualTiming: sourceRenderSpec.visual_timing,
    captionTiming: sourceRenderSpec.captions,
    narrationDurationSeconds: sourceRenderSpec.narration?.duration_seconds,
    maxDurationSeconds: SHORT_FORM_RENDER_DEFAULTS.MAX_DURATION_SECONDS
  });
  if (!selection.selected) {
    logDecision(storage, {
      runId, subjectType: 'content_version', subjectId: contentVersion.id,
      decision: DECISION_LOG_DECISION.NO_VALID_SEGMENT, reason: selection.reason
    }, nowISO);
    return { outcome: OUTCOME.NO_VALID_SEGMENT, reason: selection.reason, mediaArtifact: null };
  }
  const { endSeconds } = selection;

  const shortVisualTiming = trimVisualTiming(sourceRenderSpec.visual_timing, endSeconds);
  const shortCaptionTiming = trimCaptionTiming(sourceRenderSpec.captions, endSeconds);

  // v1 always trims from 0 -- see shortFormSelection.js's module docstring
  // for why an arbitrary start offset is out of scope. The FULL narration
  // audio file is reused unchanged (never re-synthesized, never re-cut):
  // muxNarration's existing `-shortest` behavior bounds the muxed output
  // to the (shorter) trimmed visual track for us, exactly as it already
  // does for long-form.
  const renderSpec = buildRenderSpec({
    contentVersion,
    narrationPath: longFormArtifact.narration_path,
    narrationDurationSeconds: endSeconds,
    visualTiming: shortVisualTiming,
    captions: shortCaptionTiming,
    width: SHORT_FORM_RENDER_DEFAULTS.WIDTH,
    height: SHORT_FORM_RENDER_DEFAULTS.HEIGHT,
    fps: RENDER_DEFAULTS.FPS,
    outputFormat: RENDER_DEFAULTS.OUTPUT_FORMAT,
    videoEncoder: RENDER_DEFAULTS.VIDEO_ENCODER,
    audioEncoder: RENDER_DEFAULTS.AUDIO_ENCODER
  });
  const { json: renderSpecJson, checksum: renderSpecChecksumValue } = renderSpecChecksum(renderSpec);

  // Same content_version directory long-form already uses (artifactStore.js
  // conventions), but a distinct deterministic filename so the two
  // artifacts never collide.
  const dir = mediaDir(artifactsDir, contentVersion.id);
  const silentVideoTmpPath = path.join(dir, `.silent-short.tmp-${process.pid}-${Date.now()}.mp4`);
  const concatListTmpPath = path.join(dir, `.concat-short.tmp-${process.pid}-${Date.now()}.txt`);
  const finalVideoTmpPath = path.join(dir, `.video-short.tmp-${process.pid}-${Date.now()}.mp4`);
  const finalVideoPath = path.join(dir, 'video-short.mp4');
  const captionsSrtTmpPath = shortCaptionTiming.length > 0
    ? path.join(dir, `.captions-short.tmp-${process.pid}-${Date.now()}.srt`)
    : null;

  try {
    if (captionsSrtTmpPath) {
      writeSrtFile(shortCaptionTiming, captionsSrtTmpPath);
    }
    traceSync('child.ffmpeg.render.short', { segments: shortVisualTiming?.length }, () => renderSilentVideo({
      visualTiming: shortVisualTiming,
      width: SHORT_FORM_RENDER_DEFAULTS.WIDTH,
      height: SHORT_FORM_RENDER_DEFAULTS.HEIGHT,
      fps: RENDER_DEFAULTS.FPS,
      videoEncoder: RENDER_DEFAULTS.VIDEO_ENCODER,
      listPath: concatListTmpPath,
      outputPath: silentVideoTmpPath,
      subtitlesPath: captionsSrtTmpPath
    }));
    traceSync('child.ffmpeg.mux.short', {}, () => muxNarration({
      silentVideoPath: silentVideoTmpPath,
      narrationPath: longFormArtifact.narration_path,
      audioEncoder: RENDER_DEFAULTS.AUDIO_ENCODER,
      outputPath: finalVideoTmpPath
    }));
  } catch (err) {
    fs.rmSync(silentVideoTmpPath, { force: true });
    fs.rmSync(finalVideoTmpPath, { force: true });
    logDecision(storage, {
      runId, subjectType: 'content_version', subjectId: contentVersion.id,
      decision: DECISION_LOG_DECISION.RENDER_FAILED, reason: `short_form_render_failed_${err.message}`
    }, nowISO);
    return { outcome: OUTCOME.RENDER_FAILED, reason: err.message, mediaArtifact: null };
  } finally {
    fs.rmSync(silentVideoTmpPath, { force: true });
    if (captionsSrtTmpPath) fs.rmSync(captionsSrtTmpPath, { force: true });
  }

  const validation = traceSync('child.ffprobe.validate.short', {}, () => validateMediaArtifact(finalVideoTmpPath, {
    width: SHORT_FORM_RENDER_DEFAULTS.WIDTH,
    height: SHORT_FORM_RENDER_DEFAULTS.HEIGHT,
    videoCodecName: RENDER_DEFAULTS.VIDEO_CODEC_NAME,
    audioCodecName: RENDER_DEFAULTS.AUDIO_CODEC_NAME
  }));
  if (!validation.valid) {
    fs.rmSync(finalVideoTmpPath, { force: true });
    logDecision(storage, {
      runId, subjectType: 'content_version', subjectId: contentVersion.id,
      decision: DECISION_LOG_DECISION.VALIDATION_FAILED, reason: `short_form_validation_failed_${validation.reason}`
    }, nowISO);
    return { outcome: OUTCOME.VALIDATION_FAILED, reason: validation.reason, mediaArtifact: null };
  }

  finalizeArtifact(finalVideoTmpPath, finalVideoPath);
  const artifactChecksum = sha256File(finalVideoPath);

  const outcome = storage.transaction(() => {
    // Same race-safety discipline as runMediaProduction above.
    const raceExisting = storage.get('SELECT * FROM short_form_media_artifacts WHERE content_version_id = ?', [contentVersion.id]);
    if (raceExisting) {
      return { raced: true };
    }
    const stillLongForm = storage.get('SELECT * FROM media_artifacts WHERE id = ?', [longFormArtifact.id]);
    if (!stillLongForm) {
      throw new Error(`media_artifacts row ${longFormArtifact.id} no longer exists; refusing to persist short-form result.`);
    }

    const shortFormId = crypto.randomUUID();
    storage.run(
      `INSERT INTO short_form_media_artifacts
        (id, media_artifact_id, content_version_id, segment_start_seconds, segment_end_seconds,
         render_spec_json, render_spec_checksum, artifact_path, artifact_checksum,
         duration_seconds, width, height, video_codec, audio_codec, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        shortFormId, longFormArtifact.id, contentVersion.id, 0, endSeconds,
        renderSpecJson, renderSpecChecksumValue, finalVideoPath, artifactChecksum,
        validation.duration, validation.width, validation.height, validation.videoCodec, validation.audioCodec,
        nowISO()
      ]
    );
    logDecision(storage, {
      runId, subjectType: 'content_version', subjectId: contentVersion.id,
      decision: DECISION_LOG_DECISION.RENDERED, reason: `short_form_media_artifact_persisted_${shortFormId}`
    }, nowISO);

    return { shortFormId };
  });

  if (outcome.raced) {
    const existing = storage.get('SELECT * FROM short_form_media_artifacts WHERE content_version_id = ?', [contentVersion.id]);
    return { outcome: OUTCOME.ALREADY_RENDERED, mediaArtifact: existing ?? null };
  }

  const shortFormArtifact = storage.get('SELECT * FROM short_form_media_artifacts WHERE id = ?', [outcome.shortFormId]);
  return { outcome: OUTCOME.RENDERED, mediaArtifact: shortFormArtifact };
}