import fs from 'node:fs';
import { RULE, RESULT } from './constants.js';
import { sha256File } from '../media/artifactStore.js';
import { SCRIPT_STAGE } from '../script/constants.js';
import { BRIEF_STAGE } from '../brief/constants.js';
import { RESEARCH_STAGE } from '../research/constants.js';

/**
 * Gate 2 / FINAL_COMPLIANCE v1 deterministic evaluator (ADR-0032 sections
 * 3-9): exactly GC-001 .. GC-005, reading only existing repository evidence.
 * No LLM, no provider call, no new provenance identifier or hash framework,
 * no write of any kind (persistence is the caller's job).
 *
 * Result vocabulary per rule and overall: PASS | REVIEW | BLOCK.
 * Missing required evidence is REVIEW unless a rule defines a concrete BLOCK.
 */

const nonEmptyString = (v) => typeof v === 'string' && v.length > 0;
const result = (rule_id, res, reason) => ({ rule_id, result: res, reason });

// ------------------------------------------------------------ context

/**
 * Resolves the current relationships Gate 2 reasons about, exactly as
 * Publication resolves them (content_versions.script_id is the sole
 * authoritative script pointer; the brief is that script's content_brief_id).
 * Any part that does not resolve is null -- rules decide what that means.
 */
export function resolveGate2Context(storage, contentVersionId) {
  const contentVersion = storage.get('SELECT * FROM content_versions WHERE id = ?', [contentVersionId]) ?? null;
  const script = contentVersion?.script_id
    ? storage.get('SELECT * FROM scripts WHERE id = ?', [contentVersion.script_id]) ?? null
    : null;
  const brief = script
    ? storage.get('SELECT * FROM content_briefs WHERE id = ?', [script.content_brief_id]) ?? null
    : null;
  const production = contentVersion
    ? storage.get('SELECT * FROM productions WHERE content_version_id = ?', [contentVersion.id]) ?? null
    : null;
  const media = contentVersion
    ? storage.get('SELECT * FROM media_artifacts WHERE content_version_id = ?', [contentVersion.id]) ?? null
    : null;
  return { contentVersion, script, brief, production, media };
}

/**
 * Hashes the actual media file. Shared by the evaluator (GC-001) and the
 * publication-boundary verification so both use one definition of "actual
 * file checksum": SHA-256 over the file's bytes.
 * @returns {{status: 'OK', checksum: string} | {status: 'MISSING'} | {status: 'UNREADABLE'}}
 */
export function hashMediaFile(artifactPath) {
  if (!nonEmptyString(artifactPath) || !fs.existsSync(artifactPath)) return { status: 'MISSING' };
  try {
    return { status: 'OK', checksum: sha256File(artifactPath) };
  } catch {
    return { status: 'UNREADABLE' };
  }
}

// ------------------------------------------------------------ GC-001

export function evaluateFinalMediaIntegrity(media) {
  const id = RULE.FINAL_MEDIA_INTEGRITY;
  if (!media) return result(id, RESULT.REVIEW, 'MEDIA_ARTIFACT_ROW_MISSING');
  if (!nonEmptyString(media.artifact_path)) return result(id, RESULT.REVIEW, 'ARTIFACT_PATH_MISSING');
  if (!nonEmptyString(media.artifact_checksum)) return result(id, RESULT.REVIEW, 'ARTIFACT_CHECKSUM_NOT_PERSISTED');
  const file = hashMediaFile(media.artifact_path);
  if (file.status === 'MISSING') return result(id, RESULT.REVIEW, 'ARTIFACT_FILE_MISSING');
  if (file.status === 'UNREADABLE') return result(id, RESULT.REVIEW, 'ARTIFACT_FILE_UNREADABLE');
  if (file.checksum !== media.artifact_checksum) return result(id, RESULT.BLOCK, 'ARTIFACT_CHECKSUM_MISMATCH');
  return result(id, RESULT.PASS, 'CHECKSUM_MATCH');
}

// ------------------------------------------------------------ GC-002

/**
 * The append-only asset_verifications history is authoritative; the mutable
 * assets.verification_status cache is never read here.
 *
 * Applicable assets = the assets attached to this content_version through
 * asset_usages (the same relationship Production / Media Production /
 * Publication already use). For each, the applicable authoritative record is
 * the NEWEST asset_verifications row by SQLite insertion order (rowid) --
 * not created_at, which can collide and which the id (a random UUID) cannot
 * order. Returns references only.
 *
 * @returns {Array<{asset_id: string, asset_verification_id: string|null, decision: string|null}>} sorted by asset_id
 */
export function collectAssetVerifications(storage, contentVersionId) {
  const assetRows = storage.all(
    `SELECT DISTINCT assets.id AS asset_id
       FROM assets
       JOIN asset_usages ON asset_usages.asset_id = assets.id
      WHERE asset_usages.content_version_id = ?
      ORDER BY assets.id ASC`,
    [contentVersionId]
  );
  return assetRows.map(({ asset_id }) => {
    const latest = storage.get(
      'SELECT id, decision FROM asset_verifications WHERE asset_id = ? ORDER BY rowid DESC LIMIT 1',
      [asset_id]
    );
    return { asset_id, asset_verification_id: latest?.id ?? null, decision: latest?.decision ?? null };
  });
}

export function evaluateAssetRights(assets) {
  const id = RULE.ASSET_RIGHTS;
  if (assets.length === 0) return result(id, RESULT.PASS, 'NO_APPLICABLE_ASSETS');
  const blocked = assets.filter((a) => a.decision === 'DISPUTED');
  if (blocked.length > 0) return result(id, RESULT.BLOCK, `ASSET_DISPUTED_${blocked.map((a) => a.asset_id).join(',')}`);
  const notVerified = assets.filter((a) => a.decision !== 'VERIFIED');
  if (notVerified.length > 0) {
    // NOT_VERIFIED, no record at all, or an unrecognized decision value: never
    // an inferred pass.
    return result(id, RESULT.REVIEW, `ASSET_NOT_VERIFIED_${notVerified.map((a) => a.asset_id).join(',')}`);
  }
  return result(id, RESULT.PASS, 'ALL_ASSETS_VERIFIED');
}

// ------------------------------------------------------------ GC-003

/**
 * Both fields must be strings with non-whitespace content after trimming.
 * No BLOCK condition. The publication fallback title "Untitled (<id>)" never
 * satisfies this rule: it is only generated when working_title is null (which
 * is REVIEW here), and a stored value identical to that exact fallback string
 * is treated as the fallback, not as real metadata.
 */
export function evaluateFinalMetadataPresence({ workingTitle, viewerPromise, contentVersionId }) {
  const id = RULE.FINAL_METADATA_PRESENCE;
  const usable = (v) => typeof v === 'string' && v.trim().length > 0;
  const bad = [];
  if (!usable(workingTitle) || workingTitle.trim() === `Untitled (${contentVersionId})`) bad.push('WORKING_TITLE');
  if (!usable(viewerPromise)) bad.push('VIEWER_PROMISE');
  if (bad.length > 0) return result(id, RESULT.REVIEW, `METADATA_MISSING_OR_BLANK_${bad.join('_AND_')}`);
  return result(id, RESULT.PASS, 'METADATA_PRESENT');
}

// ------------------------------------------------------------ GC-004

/**
 * Consistency among content_versions.script_id, productions.script_id,
 * scripts.id / scripts.version and media_artifacts.id (via its production
 * identity). Values that are present but disagree -> BLOCK. Evidence that is
 * simply absent -> REVIEW (missing evidence, no rule-specific BLOCK for it).
 * A present mismatch outranks an absence.
 */
export function evaluateScriptMediaConsistency({ contentVersion, script, production, media }) {
  const id = RULE.SCRIPT_MEDIA_CONSISTENCY;
  const mismatches = [];
  const missing = [];

  if (!contentVersion?.script_id) missing.push('CONTENT_VERSION_SCRIPT_ID');
  if (!script) missing.push('SCRIPT_ROW');
  else if (!Number.isInteger(script.version)) missing.push('SCRIPT_VERSION');
  if (!production) missing.push('PRODUCTION_ROW');
  if (!media) missing.push('MEDIA_ARTIFACT_ROW');

  if (contentVersion?.script_id && script && script.id !== contentVersion.script_id) mismatches.push('SCRIPT_ID_VS_CONTENT_VERSION');
  if (contentVersion?.script_id && production && production.script_id !== contentVersion.script_id) mismatches.push('PRODUCTION_SCRIPT_ID_VS_CONTENT_VERSION');
  if (contentVersion && production && production.content_version_id !== contentVersion.id) mismatches.push('PRODUCTION_CONTENT_VERSION');
  if (production && media && media.production_id !== production.id) mismatches.push('MEDIA_PRODUCTION_ID_VS_PRODUCTION');
  if (contentVersion && media && media.content_version_id !== contentVersion.id) mismatches.push('MEDIA_CONTENT_VERSION');

  if (mismatches.length > 0) return result(id, RESULT.BLOCK, `INCONSISTENT_${mismatches.join('_')}`);
  if (missing.length > 0) return result(id, RESULT.REVIEW, `MISSING_${missing.join('_')}`);
  return result(id, RESULT.PASS, 'CONSISTENT');
}

// ------------------------------------------------------------ GC-005

// Counts existing decision_log rows for a keyed subject. Exactly one row is
// the only unambiguous case; the id is returned only then.
function uniqueDecisionLogRow(storage, { subjectType, subjectId, stage, decision }) {
  const rows = storage.all(
    `SELECT id FROM decision_log
      WHERE subject_type = ? AND subject_id = ? AND stage = ? AND decision = ?
      ORDER BY rowid ASC`,
    [subjectType, subjectId, stage, decision]
  );
  return { count: rows.length, id: rows.length === 1 ? rows[0].id : null };
}

function parseKeyClaims(raw) {
  if (raw === null || raw === undefined || (typeof raw === 'string' && raw.trim() === '')) return { chain: false, ids: [] };
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { error: 'KEY_CLAIMS_UNPARSEABLE' };
  }
  if (!Array.isArray(parsed)) return { error: 'KEY_CLAIMS_NOT_AN_ARRAY' };
  if (parsed.length === 0) return { chain: false, ids: [] };
  if (!parsed.every((c) => typeof c === 'string' && c.length > 0)) return { error: 'KEY_CLAIMS_INVALID_ENTRY' };
  return { chain: true, ids: [...new Set(parsed)].sort() };
}

/**
 * Existing-provenance lookup using ONLY existing decision_log rows and
 * existing repository relationships (ADR-0032 section 8):
 *   script lineage: scripts.content_brief_id -> the script-generation ACCEPTED row keyed by that brief
 *   brief lineage:  content_briefs.research_project_id -> the brief-generation ACCEPTED row keyed by that research project
 *   source chain (only where key_claims lists claims): key_claims -> claim_sources -> sources -> the
 *     claim-extraction row keyed by each linked source id
 * Conservative: every required link must resolve deterministically to exactly
 * one row; absent or ambiguous lineage is incomplete (REVIEW). Nothing is invented.
 *
 * @returns {{complete: boolean, reasons: string[], refs: {script_generation_id: string|null, brief_generation_id: string|null, claim_extractions: Array<{source_id: string, decision_log_id: string|null}>}}}
 */
export function collectProvenance(storage, { script, brief }) {
  const reasons = [];
  const refs = { script_generation_id: null, brief_generation_id: null, claim_extractions: [] };

  if (!script) {
    reasons.push('SCRIPT_UNRESOLVED');
    return { complete: false, reasons, refs };
  }
  if (!brief) {
    reasons.push('BRIEF_UNRESOLVED');
    return { complete: false, reasons, refs };
  }

  // Script provenance.
  const scriptGen = uniqueDecisionLogRow(storage, {
    subjectType: 'content_brief', subjectId: script.content_brief_id,
    stage: SCRIPT_STAGE.GENERATION, decision: 'ACCEPTED'
  });
  if (scriptGen.count === 0) reasons.push('SCRIPT_GENERATION_ACCEPTED_ROW_ABSENT');
  else if (scriptGen.count > 1) reasons.push('SCRIPT_GENERATION_ACCEPTED_ROW_AMBIGUOUS');
  refs.script_generation_id = scriptGen.id;

  // Brief provenance.
  if (!brief.research_project_id) {
    reasons.push('BRIEF_RESEARCH_PROJECT_ABSENT');
  } else {
    const briefGen = uniqueDecisionLogRow(storage, {
      subjectType: 'research_project', subjectId: brief.research_project_id,
      stage: BRIEF_STAGE.GENERATION, decision: 'ACCEPTED'
    });
    if (briefGen.count === 0) reasons.push('BRIEF_GENERATION_ACCEPTED_ROW_ABSENT');
    else if (briefGen.count > 1) reasons.push('BRIEF_GENERATION_ACCEPTED_ROW_AMBIGUOUS');
    refs.brief_generation_id = briefGen.id;
  }

  // Research/source provenance, only where the chain exists.
  const keyClaims = parseKeyClaims(brief.key_claims);
  if (keyClaims.error) {
    reasons.push(keyClaims.error);
  } else if (keyClaims.chain) {
    const sourceIds = new Set();
    for (const claimId of keyClaims.ids) {
      const claim = storage.get('SELECT id, research_project_id FROM claims WHERE id = ?', [claimId]);
      if (!claim) { reasons.push(`KEY_CLAIM_UNKNOWN_${claimId}`); continue; }
      if (brief.research_project_id && claim.research_project_id !== brief.research_project_id) {
        reasons.push(`KEY_CLAIM_OUTSIDE_RESEARCH_PROJECT_${claimId}`);
        continue;
      }
      const links = storage.all('SELECT DISTINCT source_id FROM claim_sources WHERE claim_id = ? ORDER BY source_id ASC', [claimId]);
      if (links.length === 0) { reasons.push(`KEY_CLAIM_HAS_NO_SOURCE_${claimId}`); continue; }
      for (const l of links) sourceIds.add(l.source_id);
    }
    for (const sourceId of [...sourceIds].sort()) {
      const source = storage.get('SELECT id, research_project_id FROM sources WHERE id = ?', [sourceId]);
      if (!source) { reasons.push(`SOURCE_UNKNOWN_${sourceId}`); refs.claim_extractions.push({ source_id: sourceId, decision_log_id: null }); continue; }
      if (brief.research_project_id && source.research_project_id !== brief.research_project_id) {
        reasons.push(`SOURCE_OUTSIDE_RESEARCH_PROJECT_${sourceId}`);
      }
      const extraction = uniqueDecisionLogRow(storage, {
        subjectType: 'source', subjectId: sourceId,
        stage: RESEARCH_STAGE.CLAIM_EXTRACTION, decision: 'EXTRACTED'
      });
      if (extraction.count === 0) reasons.push(`CLAIM_EXTRACTION_ROW_ABSENT_${sourceId}`);
      else if (extraction.count > 1) reasons.push(`CLAIM_EXTRACTION_ROW_AMBIGUOUS_${sourceId}`);
      refs.claim_extractions.push({ source_id: sourceId, decision_log_id: extraction.id });
    }
  }

  return { complete: reasons.length === 0, reasons, refs };
}

export function evaluateExistingProvenance(provenance) {
  const id = RULE.EXISTING_PROVENANCE;
  if (provenance.complete) return result(id, RESULT.PASS, 'PROVENANCE_RESOLVED');
  return result(id, RESULT.REVIEW, provenance.reasons.join(';'));
}

// ------------------------------------------------------------ aggregation

/** ANY BLOCK -> BLOCK; otherwise any REVIEW -> REVIEW; otherwise PASS. */
export function aggregateGate2Results(ruleResults) {
  if (ruleResults.some((r) => r.result === RESULT.BLOCK)) return RESULT.BLOCK;
  if (ruleResults.some((r) => r.result !== RESULT.PASS)) return RESULT.REVIEW; // REVIEW (or, defensively, anything unrecognized)
  return RESULT.PASS;
}

// ------------------------------------------------------------ binding / evidence

/** Deterministic representation of the bound final metadata (fixed key order). */
export function metadataRepresentation(workingTitle, viewerPromise) {
  return JSON.stringify({ working_title: workingTitle, viewer_promise: viewerPromise });
}

export function buildBinding({ contentVersion, script, production, media, brief }) {
  const str = (v) => (typeof v === 'string' ? v : null);
  const workingTitle = str(brief?.working_title);
  const viewerPromise = str(brief?.viewer_promise);
  return {
    contentScriptId: contentVersion?.script_id ?? null,
    scriptId: script?.id ?? null,
    scriptVersion: Number.isInteger(script?.version) ? script.version : null,
    productionScriptId: production?.script_id ?? null,
    mediaArtifactId: media?.id ?? null,
    artifactChecksum: nonEmptyString(media?.artifact_checksum) ? media.artifact_checksum : null,
    workingTitle,
    viewerPromise,
    metadataJson: workingTitle !== null && viewerPromise !== null ? metadataRepresentation(workingTitle, viewerPromise) : null
  };
}

/** References only -- never copies of the referenced rows. */
export function buildEvidence({ assets, provenance, media }) {
  return {
    asset_verifications: assets.map((a) => ({ asset_id: a.asset_id, asset_verification_id: a.asset_verification_id })),
    decision_log: provenance.refs,
    media: {
      media_artifact_id: media?.id ?? null,
      artifact_checksum: nonEmptyString(media?.artifact_checksum) ? media.artifact_checksum : null
    }
  };
}

// ------------------------------------------------------------ entry point

/**
 * Evaluates Gate 2 for one content_version against current repository state.
 * Read-only. Returns per-rule results (sorted by rule id), the overall result,
 * the PASS binding values and the evidence references.
 */
export function evaluateGate2(storage, contentVersionId) {
  const ctx = resolveGate2Context(storage, contentVersionId);
  const assets = collectAssetVerifications(storage, contentVersionId);
  const provenance = collectProvenance(storage, { script: ctx.script, brief: ctx.brief });

  const ruleResults = [
    evaluateFinalMediaIntegrity(ctx.media),
    evaluateAssetRights(assets),
    evaluateFinalMetadataPresence({ workingTitle: ctx.brief?.working_title, viewerPromise: ctx.brief?.viewer_promise, contentVersionId }),
    evaluateScriptMediaConsistency(ctx),
    evaluateExistingProvenance(provenance)
  ].sort((a, b) => (a.rule_id < b.rule_id ? -1 : a.rule_id > b.rule_id ? 1 : 0));

  return {
    overall: aggregateGate2Results(ruleResults),
    ruleResults,
    binding: buildBinding(ctx),
    evidence: buildEvidence({ assets, provenance, media: ctx.media })
  };
}
