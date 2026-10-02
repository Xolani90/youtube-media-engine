import crypto from 'node:crypto';
import { RESEARCH_STAGE, RESEARCH_PROJECT_STATUS, RETRIEVAL_STATUS, EVIDENCE_STATUS, CLAIM_TYPE, CONTRADICTION_RESULT, CONTRADICTION_EXECUTION_STATE } from './constants.js';
import { acquireSources } from './acquisition.js';
import { classifySourceRole, classifySourceQuality } from './sourceClassification.js';
import { extractClaims, validateExtractedClaim, ExtractionFailureError } from './claims.js';
import { deriveClaimIdentity, summarizeIdentityCoverage } from './claimIdentity.js';
import { ConvergenceIndex, evaluateConvergence, isConvergenceEligible } from './claimConvergence.js';
import { computeEvidenceStatus } from './evidenceGrading.js';
import { canonicalizePair, recordContradiction, hasUnresolvedContradiction } from './contradictions.js';
import { evaluateCompleteness } from './completeness.js';
import { traceAsync } from '../diagnostics/trace.js';

/**
 * Records a decision_log entry, same shape/discipline as Discovery's
 * logDecision (v0.6 S16 — stage is a first-class column, never encoded
 * into decision/reason).
 */
function logDecision(storage, { runId = null, stage, subjectType, subjectId, decision, reason, provider = null, confidence = null, resultingState = null, configSnapshot = null }, nowISO = () => new Date().toISOString()) {
  const id = crypto.randomUUID();
  storage.run(
    `INSERT INTO decision_log
      (id, run_id, subject_type, subject_id, decision, reason, provider, config_snapshot, confidence, risk_level, resulting_state, created_at, stage)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
    [id, runId, subjectType, subjectId, decision, reason, provider, configSnapshot ? JSON.stringify(configSnapshot) : null, confidence, resultingState, nowISO(), stage]
  );
  return id;
}

/**
 * Creates a research_projects row for the given opportunity, enforcing
 * idempotency. The database's UNIQUE(opportunity_id) index is the actual
 * guarantee; the app-level check here is a fast-path/clear-error layer
 * (v0.2 S14/S18, v0.4).
 */
function createResearchProject(storage, { opportunityId, runId = null }, nowISO = () => new Date().toISOString()) {
  const existing = storage.get('SELECT * FROM research_projects WHERE opportunity_id = ?', [opportunityId]);
  if (existing) {
    return { project: existing, created: false };
  }
  const id = crypto.randomUUID();
  const createdAt = nowISO();
  try {
    storage.run(
      `INSERT INTO research_projects (id, opportunity_id, run_id, status, created_at)
       VALUES (?, ?, ?, 'RESEARCHING', ?)`,
      [id, opportunityId, runId, createdAt]
    );
  } catch (err) {
    if (/UNIQUE constraint failed/.test(err.message)) {
      // Lost a race / app-level check was stale — the DB constraint is the
      // real guarantee. Re-read and return the existing row.
      const row = storage.get('SELECT * FROM research_projects WHERE opportunity_id = ?', [opportunityId]);
      return { project: row, created: false };
    }
    throw err;
  }
  return { project: storage.get('SELECT * FROM research_projects WHERE id = ?', [id]), created: true };
}

function insertSource(storage, { researchProjectId, url, sourceType = null, role, qualityTier, retrievalStatus, content, notes = null }, nowISO = () => new Date().toISOString()) {
  const id = crypto.randomUUID();
  storage.run(
    `INSERT INTO sources (id, research_project_id, url, source_type, role, quality_tier, retrieval_status, content, retrieved_at, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, researchProjectId, url, sourceType, role, qualityTier, retrievalStatus, content, nowISO(), notes]
  );
  return id;
}

function insertClaim(storage, { researchProjectId, claim, claimType, isLoadBearing }, nowISO = () => new Date().toISOString()) {
  const id = crypto.randomUUID();
  storage.run(
    `INSERT INTO claims (id, research_project_id, claim, claim_type, evidence_status, is_load_bearing, created_at)
     VALUES (?, ?, ?, ?, 'UNSUPPORTED', ?, ?)`,
    [id, researchProjectId, claim, claimType, isLoadBearing ? 1 : 0, nowISO()]
  );
  return id;
}

function linkClaimSource(storage, { claimId, sourceId, role }, nowISO = () => new Date().toISOString()) {
  const id = crypto.randomUUID();
  try {
    storage.run(
      `INSERT INTO claim_sources (id, claim_id, source_id, role, created_at) VALUES (?, ?, ?, ?, ?)`,
      [id, claimId, sourceId, role, nowISO()]
    );
    return { inserted: true, id };
  } catch (err) {
    if (/UNIQUE constraint failed/.test(err.message)) {
      return { inserted: false, reason: 'ALREADY_LINKED' };
    }
    throw err;
  }
}

function setEvidenceStatus(storage, claimId, evidenceStatus) {
  storage.run('UPDATE claims SET evidence_status = ? WHERE id = ?', [evidenceStatus, claimId]);
}

/**
 * Discovery query = the proposition's `subject` (the disambiguating entity,
 * e.g. "OpenAI's Dots proactive assistant") plus the core question. The core
 * question alone may omit the entity that makes the topic unambiguous (live
 * run 36628871372: "How does Dots help users..." retrieved a mobile game, an
 * iPhone accessibility guide and an unrelated receivership notice). The
 * subject is prepended only when the core question does not already contain it.
 */
export function buildResearchQuery(subject, coreQuestion) {
  const question = typeof coreQuestion === 'string' ? coreQuestion.trim() : '';
  const anchor = typeof subject === 'string' ? subject.trim() : '';
  if (!anchor) return coreQuestion;
  if (!question) return anchor;
  if (question.toLowerCase().includes(anchor.toLowerCase())) return question;
  return `${anchor} ${question}`;
}

/**
 * Runs one opportunity's Research project end to end.
 *
 * Consumes the REAL Discovery -> Research handoff: the opportunity must
 * already be persisted with status='HANDED_TO_RESEARCH' (D-01), and
 * `core_question_type` must already be present in its
 * opportunity_proposition JSON (D-02). Research does NOT regenerate or
 * reinterpret either value.
 *
 * @param {object} deps
 * @param {import('../storage/StorageDriver.js').StorageDriver} deps.storage
 * @param {string} deps.opportunityId
 * @param {import('./ResearchSourceProvider.js').ResearchSourceProvider} deps.sourceProvider
 * @param {object} deps.llmRouter
 * @param {object} deps.policy - research_policy.json
 * @param {object} [deps.classification] - { authoritativeDomains, syndicatedDomains } for sourceClassification
 * @param {function} [deps.retrieveImpl] - injectable retrieval fn for testing
 * @param {function} [deps.fetchImpl] - forwarded to retrieveImpl
 * @param {function} [deps.detectContradiction] - async (claimA, claimB, llmRouter) => one of CONTRADICTION_RESULT ('CONTRADICTS'|'NO_CONTRADICTION'|'UNCERTAIN'); a thrown/rejected call is treated as ERROR by the caller. LLM-assisted semantic judgment, RG-02 contract (see ./contradictionDetector.js for the production implementation). Optional: no contradiction detection performed if omitted (logged as NOT_CHECKED).
 * @param {string} [deps.runId]
 */
export async function runResearchProject({
  storage, opportunityId, sourceProvider, llmRouter, policy, classification = {},
  retrieveImpl, fetchImpl, detectContradiction = null, runId = null
}) {
  const opportunity = storage.get('SELECT * FROM opportunities WHERE id = ?', [opportunityId]);
  if (!opportunity) {
    throw new Error(`opportunity ${opportunityId} not found`);
  }
  if (opportunity.status !== 'HANDED_TO_RESEARCH') {
    throw new Error(`opportunity ${opportunityId} is not HANDED_TO_RESEARCH (actual status: ${opportunity.status})`);
  }

  let proposition;
  try {
    proposition = JSON.parse(opportunity.opportunity_proposition);
  } catch {
    throw new Error(`opportunity ${opportunityId} has an unparseable opportunity_proposition`);
  }
  const coreQuestionType = proposition.core_question_type;
  const coreQuestion = proposition.core_question;

  const { project, created } = createResearchProject(storage, { opportunityId, runId });
  if (created) {
    logDecision(storage, {
      runId, stage: RESEARCH_STAGE.RESEARCH_PROJECT_CREATED, subjectType: 'research_project', subjectId: project.id,
      decision: 'CREATED', reason: 'opportunity_handed_to_research', resultingState: RESEARCH_PROJECT_STATUS.RESEARCHING
    });
  }
  // Idempotency: if this project already reached a terminal state, do not
  // re-run — return the existing outcome rather than silently redoing work.
  if (project.status !== RESEARCH_PROJECT_STATUS.RESEARCHING) {
    return { project, alreadyTerminal: true };
  }

  // --- Source discovery + bounded acquisition ---
  const acquisitionResult = await acquireSources({
    provider: sourceProvider, query: buildResearchQuery(proposition.subject, coreQuestion), policy, retrieveImpl, fetchImpl
  });

  if (acquisitionResult.discoveryFailed) {
    logDecision(storage, {
      runId, stage: RESEARCH_STAGE.SOURCE_DISCOVERY, subjectType: 'research_project', subjectId: project.id,
      decision: 'FAILED', reason: acquisitionResult.discoveryError, resultingState: RESEARCH_PROJECT_STATUS.FAILED
    });
    storage.run('UPDATE research_projects SET status = ?, stop_reason = ?, completed_at = ? WHERE id = ?',
      [RESEARCH_PROJECT_STATUS.FAILED, 'SOURCE_DISCOVERY_FAILED', new Date().toISOString(), project.id]);
    return { project: storage.get('SELECT * FROM research_projects WHERE id = ?', [project.id]), stopReason: 'SOURCE_DISCOVERY_FAILED' };
  }

  const persistedSources = [];
  // source id -> the acquisition candidate's publishedAt (provider metadata,
  // possibly null). Kept beside persistedSources so the returned source shape
  // is unchanged. Only claim-identity year grounding reads it.
  const publishedAtBySourceId = new Map();
  for (const acquired of acquisitionResult.acquired) {
    const roleResult = classifySourceRole(acquired.url, classification);
    const qualityTier = classifySourceQuality(acquired.status, roleResult.role);
    const sourceId = insertSource(storage, {
      researchProjectId: project.id, url: acquired.url, sourceType: null,
      role: roleResult.role, qualityTier, retrievalStatus: acquired.status,
      content: acquired.content, notes: acquired.error
    });
    logDecision(storage, {
      runId, stage: RESEARCH_STAGE.SOURCE_ACQUISITION, subjectType: 'source', subjectId: sourceId,
      decision: acquired.status, reason: acquired.error || 'retrieved', resultingState: acquired.status
    });
    logDecision(storage, {
      runId, stage: RESEARCH_STAGE.SOURCE_CLASSIFICATION, subjectType: 'source', subjectId: sourceId,
      decision: roleResult.role, reason: roleResult.ambiguous ? 'ambiguous_deterministic_classification' : 'deterministic_domain_match',
      resultingState: qualityTier
    });
    publishedAtBySourceId.set(sourceId, acquired.publishedAt ?? null);
    persistedSources.push({ id: sourceId, url: acquired.url, retrieval_status: acquired.status, role: roleResult.role, quality_tier: qualityTier, retrieved_at: new Date().toISOString() });
  }

  // Failure isolation (v0.4 S12): failed/unparseable sources don't abort
  // the project — extraction simply proceeds over whatever succeeded.
  const successfulSources = persistedSources.filter((s) => s.retrieval_status === RETRIEVAL_STATUS.SUCCESS);

  // --- Claim extraction + load-bearing classification (LLM-assisted, deterministically validated) ---
  const persistedClaims = [];
  // key: normalized claim text -> claim ids carrying that exact wording.
  // Exact wording is used ONLY to deduplicate a claim re-extracted from the
  // SAME source. Identical wording from a different source never creates a
  // corroborating link by itself: identical text does not prove the same
  // referent or the same fact, so it must go through the grounded-identity
  // path (fingerprint) like any other candidate.
  const claimTextIndex = new Map();
  // claim id -> Set of source ids already linked in this run.
  const claimSourceIds = new Map();
  // key: deterministic claim-identity fingerprint (see claimIdentity.js) ->
  // { id, claimType, isLoadBearing }. Populated only for FACT claims whose
  // LLM-proposed structured identity passed validation AND agrees with the
  // claim's own text. Exact fingerprint equality is the only way two
  // differently-worded claims can share a claim row; no similarity scoring.
  const claimIdentityIndex = new Map();
  // Candidate-convergence layer (see claimConvergence.js). Runs ONLY after the
  // exact text / exact fingerprint paths found nothing. A promotion merely lets
  // two representations share one claim row; evidence is still earned through
  // computeEvidenceStatus below, and contradictions are still detected by the
  // existing detector. Candidate similarity != same fact != VERIFIED.
  const convergenceIndex = new ConvergenceIndex();
  const convergence = { eligible: 0, skipped: 0, candidates: 0, promoted: 0, ambiguous: 0 };

  for (const source of successfulSources) {
    const full = persistedSources.find((s) => s.id === source.id);
    const sourceRow = storage.get('SELECT * FROM sources WHERE id = ?', [source.id]);
    let extraction;
    try {
      extraction = await traceAsync(
        'research.claimExtraction', { source: source.id },
        () => extractClaims({ sourceText: sourceRow.content, coreQuestion, sourceRole: sourceRow.role, sourceUrl: sourceRow.url }, llmRouter),
        (e) => ({ claims: e?.claims?.length })
      );
    } catch (err) {
      // Fail-closed: an extraction that could not establish a valid result
      // (empty / malformed / truncated / provider failure, after one bounded
      // retry) is recorded as a FAILURE -- never as a zero-claim EXTRACTED
      // row -- and the error propagates through the pipeline's existing
      // failure semantics, exactly as any other provider error does.
      if (err instanceof ExtractionFailureError) {
        logDecision(storage, {
          runId, stage: RESEARCH_STAGE.CLAIM_EXTRACTION, subjectType: 'source', subjectId: source.id,
          decision: 'EXTRACTION_FAILED', reason: err.parseOutcome, provider: err.providerUsed,
          configSnapshot: {
            model: err.model, parseOutcome: err.parseOutcome, finishReason: err.finishReason,
            attempts: err.attempts, outputTokens: err.outputTokens, contentLength: err.contentLength
          }
        });
      }
      throw err;
    }
    // Provider id + the candidate's own publication date. claimIdentity.js
    // trusts it only for specific providers and only to ground a month-only year.
    const publicationContext = { providerId: sourceProvider?.id, publishedAt: publishedAtBySourceId.get(source.id) ?? null };
    logDecision(storage, {
      runId, stage: RESEARCH_STAGE.CLAIM_EXTRACTION, subjectType: 'source', subjectId: source.id,
      decision: 'EXTRACTED', reason: `${extraction.claims.length}_claims_proposed`, provider: extraction.providerUsed,
      configSnapshot: {
        model: extraction.model, estimatedCost: extraction.estimatedCost, isPaid: extraction.isPaid,
        identity: summarizeIdentityCoverage(extraction.claims, publicationContext),
        parseOutcome: extraction.diagnostics.parseOutcome, finishReason: extraction.diagnostics.finishReason, attempts: extraction.diagnostics.attempts
      }
    });

    for (const proposed of extraction.claims) {
      const validation = validateExtractedClaim(proposed);
      if (!validation.valid) {
        logDecision(storage, {
          runId, stage: RESEARCH_STAGE.CLAIM_EXTRACTION, subjectType: 'source', subjectId: source.id,
          decision: 'REJECTED', reason: validation.reason
        });
        continue;
      }

      const normalized = proposed.claim.trim().toLowerCase();
      const { fingerprint, identity: derivedIdentity } = deriveClaimIdentity(proposed, publicationContext);
      // The identity is only trusted (usable for convergence) when a fingerprint exists.
      const trustedIdentity = fingerprint ? derivedIdentity : null;
      // Identity-index trust boundary: a claim may query or populate
      // claimIdentityIndex only when its normalization exists and is
      // convergence-trusted (UNCHANGED / NORMALIZED). RETAINED_ORIGINAL,
      // UNVERIFIED_ORIGIN and missing normalization fail closed, in both
      // arrival orders.
      const identityIndexEligible = proposed.normalization?.convergenceTrusted === true;
      let claimId = null;
      let isNewClaim = false;
      let mergedByIdentity = false;
      const sameTextIds = claimTextIndex.get(normalized) ?? [];
      // Same exact wording, same source: pure deduplication (no new link,
      // no corroboration -- the source is already linked to that row).
      const dedupId = sameTextIds.find((id) => claimSourceIds.get(id)?.has(source.id));
      if (dedupId) {
        claimId = dedupId;
        logDecision(storage, {
          runId, stage: RESEARCH_STAGE.CLAIM_EXTRACTION, subjectType: 'claim', subjectId: claimId,
          decision: 'EXACT_TEXT_DEDUPLICATED', reason: 'same_source_same_text',
          configSnapshot: { sourceId: source.id }
        });
      }
      if (!claimId && fingerprint && identityIndexEligible) {
        // Conservative: same fingerprint AND same claim_type AND same
        // is_load_bearing, otherwise the claims stay separate.
        const existing = claimIdentityIndex.get(fingerprint);
        if (existing && existing.claimType === proposed.claim_type && existing.isLoadBearing === proposed.is_load_bearing) {
          claimId = existing.id;
          mergedByIdentity = true;
        }
      }
      if (mergedByIdentity) {
        logDecision(storage, {
          runId, stage: RESEARCH_STAGE.CLAIM_EXTRACTION, subjectType: 'claim', subjectId: claimId,
          decision: 'MERGED_BY_IDENTITY', reason: 'identity_fingerprint_match',
          configSnapshot: { fingerprint, sourceId: source.id, exactTextMatch: sameTextIds.includes(claimId) }
        });
      }
      let convergenceEligibility = null;
      if (!claimId && trustedIdentity) {
        convergenceEligibility = isConvergenceEligible(proposed, coreQuestion);
        if (!convergenceEligibility.eligible) {
          convergence.skipped += 1;
        } else {
          convergence.eligible += 1;
          const evaluation = evaluateConvergence(convergenceIndex, {
            identity: trustedIdentity, claimType: proposed.claim_type,
            isLoadBearing: proposed.is_load_bearing, sourceId: source.id
          });
          convergence.candidates += evaluation.candidates.length;
          if (evaluation.ambiguous) convergence.ambiguous += 1;
          for (const cand of evaluation.candidates) {
            const promotedHere = evaluation.promoted?.entry.claimId === cand.entry.claimId;
            logDecision(storage, {
              runId, stage: RESEARCH_STAGE.CLAIM_EXTRACTION, subjectType: 'claim', subjectId: cand.entry.claimId,
              decision: 'CANDIDATE_SAME_FACT',
              reason: promotedHere ? 'promoted_deterministic_rule'
                : (cand.comparison.promotion.eligible ? 'not_promoted_ambiguous_targets' : 'not_promoted_fields_not_deterministic'),
              configSnapshot: {
                incomingSourceId: source.id, incomingClaimText: proposed.claim,
                fields: cand.comparison.fields, promotionEligible: cand.comparison.promotion.eligible,
                rule: cand.comparison.promotion.rule
              }
            });
          }
          if (evaluation.promoted) {
            claimId = evaluation.promoted.entry.claimId;
            convergence.promoted += 1;
            logDecision(storage, {
              runId, stage: RESEARCH_STAGE.CLAIM_EXTRACTION, subjectType: 'claim', subjectId: claimId,
              decision: 'MERGED_BY_CONVERGENCE', reason: evaluation.promoted.comparison.promotion.rule,
              configSnapshot: {
                sourceId: source.id, incomingClaimText: proposed.claim,
                fields: evaluation.promoted.comparison.fields
              }
            });
          }
        }
      }
      if (!claimId) {
        claimId = insertClaim(storage, {
          researchProjectId: project.id, claim: proposed.claim,
          claimType: proposed.claim_type, isLoadBearing: proposed.is_load_bearing
        });
        if (sameTextIds.length > 0) {
          // Identical wording exists on a row from another source but no
          // grounded fact-identity path proved it is the same fact: keep a
          // separate row so it stays visible to contradiction analysis.
          logDecision(storage, {
            runId, stage: RESEARCH_STAGE.CLAIM_EXTRACTION, subjectType: 'claim', subjectId: claimId,
            decision: 'EXACT_TEXT_REJECTED', reason: fingerprint && identityIndexEligible ? 'identity_not_matching' : 'no_grounded_identity',
            configSnapshot: { sourceId: source.id, matchingClaimIds: sameTextIds }
          });
        }
        claimTextIndex.set(normalized, [...sameTextIds, claimId]);
        if (fingerprint && identityIndexEligible) {
          claimIdentityIndex.set(fingerprint, { id: claimId, claimType: proposed.claim_type, isLoadBearing: proposed.is_load_bearing });
        }
        persistedClaims.push({ id: claimId, claim: proposed.claim, claim_type: proposed.claim_type, is_load_bearing: proposed.is_load_bearing });
        isNewClaim = true;
        if (trustedIdentity && convergenceEligibility?.eligible) {
          convergenceIndex.add({
            claimId, identity: trustedIdentity, claimType: proposed.claim_type,
            isLoadBearing: proposed.is_load_bearing, sourceIds: [source.id]
          });
        }

        logDecision(storage, {
          runId, stage: RESEARCH_STAGE.LOAD_BEARING_CLASSIFICATION, subjectType: 'claim', subjectId: claimId,
          decision: proposed.is_load_bearing ? 'LOAD_BEARING' : 'NOT_LOAD_BEARING', reason: 'llm_proposed_deterministically_validated'
        });
      }

      if (!claimSourceIds.get(claimId)?.has(source.id)) {
        linkClaimSource(storage, { claimId, sourceId: source.id, role: isNewClaim ? 'primary' : 'corroborating' });
        if (!claimSourceIds.has(claimId)) claimSourceIds.set(claimId, new Set());
        claimSourceIds.get(claimId).add(source.id);
      }
      convergenceIndex.noteSource(claimId, source.id);

      // Provenance: a reviewer must be able to recover what the source said,
      // what the model proposed, and what normalization decided. The persisted
      // claim row holds the final wording; the original and proposed wordings
      // live here (one row per source representation, even when merged).
      const norm = proposed.normalization;
      if (norm && (proposed.original_claim || norm.status === 'RETAINED_ORIGINAL' || norm.status === 'NORMALIZED' || norm.status === 'UNVERIFIED_ORIGIN')) {
        logDecision(storage, {
          runId, stage: RESEARCH_STAGE.CLAIM_EXTRACTION, subjectType: 'claim', subjectId: claimId,
          decision: norm.status === 'NORMALIZED' ? 'NORMALIZATION_ACCEPTED'
            : (norm.status === 'RETAINED_ORIGINAL' ? 'NORMALIZATION_REJECTED' : (norm.status === 'UNVERIFIED_ORIGIN' ? 'NORMALIZATION_UNVERIFIED' : 'NORMALIZATION_UNCHANGED')),
          reason: norm.reason,
          configSnapshot: {
            sourceId: source.id, sourceUrl: sourceRow.url, status: norm.status,
            originalClaim: proposed.original_claim ?? null, proposedClaim: norm.proposedClaim ?? null,
            finalClaim: proposed.claim, convergenceTrusted: norm.convergenceTrusted === true,
            identityDiscarded: norm.identityDiscarded === true
          }
        });
      }
      if (convergenceEligibility && !convergenceEligibility.eligible) {
        logDecision(storage, {
          runId, stage: RESEARCH_STAGE.CLAIM_EXTRACTION, subjectType: 'claim', subjectId: claimId,
          decision: 'CONVERGENCE_SKIPPED', reason: convergenceEligibility.reason,
          configSnapshot: { sourceId: source.id, claimText: proposed.claim }
        });
      }
    }
  }

  // --- Contradiction detection (LLM-assisted semantic judgment) ---
  // RG-02 owner-authorized contract: claim-to-claim only (§3.1), scoped to
  // FACT claims that are is_load_bearing = true (§3.2/§3.3) — both the
  // semantic scope of this baseline AND the cost-control boundary for
  // pairwise detector calls. detectContradiction resolves to exactly one
  // of CONTRADICTION_RESULT's four states; a thrown/rejected call is
  // treated the same as an explicit ERROR result (§5) — neither is ever
  // silently downgraded to NO_CONTRADICTION.
  let contradictionCheckFailed = false;
  let contradictionCheckFailureReason = null;
  if (!detectContradiction) {
    logDecision(storage, {
      runId, stage: RESEARCH_STAGE.CONTRADICTION_CHECK, subjectType: 'research_project', subjectId: project.id,
      decision: CONTRADICTION_EXECUTION_STATE.NOT_CHECKED, reason: 'detector_not_configured'
    });
  } else {
    const allEligibleClaims = persistedClaims.filter((c) => c.claim_type === CLAIM_TYPE.FACT && c.is_load_bearing);
    // Workload ceiling (post-eligibility): bounds the exhaustive pairwise
    // loop below to at most C(maxEligibleClaims, 2) detector calls per
    // project, preventing the combinatorial blowup seen with large
    // eligible sets (e.g. 18 claims -> 153 calls) from exhausting both
    // free LLM providers' quotas in one project. Uses the existing
    // deterministic extraction order (no new ranking/scoring logic).
    const maxEligibleClaims = policy?.contradiction?.max_eligible_claims ?? 8;
    const eligibleClaims = allEligibleClaims.slice(0, maxEligibleClaims);
    if (eligibleClaims.length < 2) {
      logDecision(storage, {
        runId, stage: RESEARCH_STAGE.CONTRADICTION_CHECK, subjectType: 'research_project', subjectId: project.id,
        decision: CONTRADICTION_EXECUTION_STATE.NOT_CHECKED, reason: 'insufficient_eligible_claim_pairs'
      });
    } else {
      let anyContradiction = false;
      let anyUncertain = false;
      outer: for (let i = 0; i < eligibleClaims.length; i++) {
        for (let j = i + 1; j < eligibleClaims.length; j++) {
          const a = eligibleClaims[i];
          const b = eligibleClaims[j];
          const [canonA, canonB] = canonicalizePair(a.id, b.id);

          let outcome;
          let errorReason = null;
          try {
            outcome = await traceAsync(
              'research.contradiction', { pair: `${i}-${j}`, of: eligibleClaims.length },
              () => detectContradiction(a, b, llmRouter),
              (o) => ({ outcome: typeof o === 'string' ? o : undefined })
            );
          } catch (err) {
            outcome = CONTRADICTION_RESULT.ERROR;
            errorReason = err?.message || 'detector threw';
          }

          if (outcome === CONTRADICTION_RESULT.CONTRADICTS) {
            recordContradiction(storage, { claimId: canonA, relatedClaimId: canonB });
            anyContradiction = true;
            logDecision(storage, {
              runId, stage: RESEARCH_STAGE.CONTRADICTION_CHECK, subjectType: 'claim', subjectId: canonA,
              decision: CONTRADICTION_RESULT.CONTRADICTS, reason: `contradicts_${canonB}`,
              resultingState: CONTRADICTION_EXECUTION_STATE.CONTRADICTION_FOUND
            });
          } else if (outcome === CONTRADICTION_RESULT.UNCERTAIN) {
            anyUncertain = true;
            logDecision(storage, {
              runId, stage: RESEARCH_STAGE.CONTRADICTION_CHECK, subjectType: 'claim', subjectId: canonA,
              decision: CONTRADICTION_RESULT.UNCERTAIN, reason: `uncertain_${canonB}`,
              resultingState: CONTRADICTION_EXECUTION_STATE.UNCERTAIN
            });
          } else if (outcome === CONTRADICTION_RESULT.ERROR) {
            contradictionCheckFailed = true;
            contradictionCheckFailureReason = errorReason || 'detector_error';
            logDecision(storage, {
              runId, stage: RESEARCH_STAGE.CONTRADICTION_CHECK, subjectType: 'claim', subjectId: canonA,
              decision: CONTRADICTION_RESULT.ERROR, reason: contradictionCheckFailureReason,
              resultingState: CONTRADICTION_EXECUTION_STATE.ERROR
            });
            break outer;
          } else {
            // NO_CONTRADICTION: do not persist a relation.
            logDecision(storage, {
              runId, stage: RESEARCH_STAGE.CONTRADICTION_CHECK, subjectType: 'claim', subjectId: canonA,
              decision: CONTRADICTION_RESULT.NO_CONTRADICTION, reason: `no_contradiction_${canonB}`,
              resultingState: CONTRADICTION_EXECUTION_STATE.NO_CONTRADICTION
            });
          }
        }
      }

      if (!contradictionCheckFailed && !anyContradiction && !anyUncertain) {
        logDecision(storage, {
          runId, stage: RESEARCH_STAGE.CONTRADICTION_CHECK, subjectType: 'research_project', subjectId: project.id,
          decision: CONTRADICTION_EXECUTION_STATE.NO_CONTRADICTION, reason: 'all_eligible_pairs_checked_no_contradiction'
        });
      }
    }
  }

  // Fail-closed (§5): a detector ERROR must not let Research proceed as
  // though contradiction checking succeeded. Evidence grading and
  // completeness are never evaluated on a project whose contradiction
  // check did not complete — mirrors the existing SOURCE_DISCOVERY_FAILED
  // early-return pattern above.
  if (contradictionCheckFailed) {
    logDecision(storage, {
      runId, stage: RESEARCH_STAGE.CONTRADICTION_CHECK, subjectType: 'research_project', subjectId: project.id,
      decision: 'FAILED', reason: contradictionCheckFailureReason, resultingState: RESEARCH_PROJECT_STATUS.FAILED
    });
    storage.run('UPDATE research_projects SET status = ?, stop_reason = ?, completed_at = ? WHERE id = ?',
      [RESEARCH_PROJECT_STATUS.FAILED, 'CONTRADICTION_CHECK_FAILED', new Date().toISOString(), project.id]);
    return {
      project: storage.get('SELECT * FROM research_projects WHERE id = ?', [project.id]),
      stopReason: 'CONTRADICTION_CHECK_FAILED',
      claims: persistedClaims,
      sources: persistedSources
    };
  }

  // --- Deterministic evidence grading (never LLM self-certified) ---
  const sourcesById = new Map(persistedSources.map((s) => [s.id, s]));
  for (const claimRow of persistedClaims) {
    const links = storage.all('SELECT * FROM claim_sources WHERE claim_id = ?', [claimRow.id]);
    const contested = hasUnresolvedContradiction(storage, claimRow.id);
    const evidenceStatus = computeEvidenceStatus({
      claimSourceLinks: links, sourcesById, policy, hasUnresolvedContradiction: contested
    });
    setEvidenceStatus(storage, claimRow.id, evidenceStatus);
    claimRow.evidence_status = evidenceStatus;
    logDecision(storage, {
      runId, stage: RESEARCH_STAGE.EVIDENCE_GRADING, subjectType: 'claim', subjectId: claimRow.id,
      decision: evidenceStatus, reason: contested ? 'unresolved_contradiction' : 'deterministic_corroboration_check'
    });
  }

  // --- Completeness evaluation ---
  // Stopping condition (Owner decision — see
  // docs/DECISIONS/RESEARCH-GOVERNANCE-BASELINE.md §10, §15): true only
  // when acquisition reached a legitimate research boundary — every
  // discovered candidate was visited (candidatesExhausted) or the
  // configured source cap was reached. Hitting max_acquisition_attempts
  // while candidates still remained and the source cap was not reached is
  // NOT a legitimate stop: max_acquisition_attempts is a safety/resource
  // ceiling on retrieval calls, not evidence that the bounded acquisition
  // pass was completed. Every acquired source has already been processed
  // for claim extraction by this point (the loop above always runs to
  // completion before this line), so that half of the condition needs no
  // separate check.
  const stoppingConditionMet =
    acquisitionResult.candidatesExhausted ||
    acquisitionResult.acquired.length >= policy.acquisition.max_sources_per_research_project;
  const completenessResult = evaluateCompleteness({
    claims: persistedClaims, policy, coreQuestionType, stoppingConditionMet
  });

  logDecision(storage, {
    runId, stage: RESEARCH_STAGE.COMPLETENESS_CHECK, subjectType: 'research_project', subjectId: project.id,
    decision: completenessResult.status, reason: completenessResult.stopReason, resultingState: completenessResult.status
  });

  const completedAt = new Date().toISOString();
  storage.run('UPDATE research_projects SET status = ?, stop_reason = ?, completed_at = ? WHERE id = ?',
    [completenessResult.status, completenessResult.stopReason, completedAt, project.id]);

  return {
    project: storage.get('SELECT * FROM research_projects WHERE id = ?', [project.id]),
    stopReason: completenessResult.stopReason,
    claims: persistedClaims,
    sources: persistedSources,
    acquisitionResult,
    convergence
  };
}