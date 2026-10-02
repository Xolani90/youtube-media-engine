import crypto from 'node:crypto';
import { RESEARCH_STAGE, RESEARCH_PROJECT_STATUS, RETRIEVAL_STATUS, EVIDENCE_STATUS, CLAIM_TYPE, CONTRADICTION_RESULT, CONTRADICTION_EXECUTION_STATE } from './constants.js';
import { acquireSources } from './acquisition.js';
import { classifySourceRole, assessEvidenceAdmissibility } from './sourceClassification.js';
import { buildSourceProvenance } from './sourceProvenance.js';
import { buildEvidenceQueries, discoverWithCascade, newEvidenceSearchDiag } from './evidenceSearch.js';
import { extractClaims, validateExtractedClaim, ExtractionFailureError } from './claims.js';
import { deriveClaimIdentity, summarizeIdentityCoverage } from './claimIdentity.js';
import { ConvergenceIndex, evaluateConvergence, explainConvergence, isConvergenceEligible } from './claimConvergence.js';
import { computeEvidenceStatus, explainEvidenceSources, independenceKey } from './evidenceGrading.js';
import {
  verifyClaimAgainstSources, selectCandidateSources, claimPriorityScore,
  VERIFICATION_RESULT, REJECTION_REASON, DEFAULT_VERIFICATION_LIMITS
} from './evidenceVerification.js';
import { canonicalizePair, recordContradiction, hasUnresolvedContradiction } from './contradictions.js';
import { evaluateCompleteness } from './completeness.js';
import { traceAsync } from '../diagnostics/trace.js';

// Research diagnostics (CLAIM_TRACE / EVIDENCE_TRACE / RESEARCH_TRACE_SUMMARY and the
// convergence explanation) are inert unless explicitly enabled, matching diagnostics/trace.js.
const diagnosticsEnabled = () => process.env.DIAGNOSTIC_TRACE === 'true';

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

const QUOTE_REJECTIONS = new Set([REJECTION_REASON.QUOTE_MISSING, REJECTION_REASON.QUOTE_TOO_SHORT, REJECTION_REASON.QUOTE_NOT_IN_SOURCE]);

function newResearchDiag() {
  return {
    retrieval: { plainAttempts: 0, plainSuccesses: 0, fallbackAttempts: 0, fallbackSuccesses: 0, weakSourcesRejected: 0, unusableSources: 0 },
    sourceQuality: { primaryAuthoritative: 0, independentReporting: 0, syndicated: 0, socialMedia: 0, weakOrRejected: 0 },
    relevance: { candidatesScored: 0, candidatesRejectedAsIrrelevant: 0, entries: [] },
    evidenceSearch: newEvidenceSearchDiag()
  };
}

function noteAcquiredDiag(diag, acquired, roleResult, admissibility) {
  const r = diag.retrieval;
  r.plainAttempts += 1;
  if (acquired.fallback?.attempted) {
    r.fallbackAttempts += 1;
    if (acquired.fallback.success) r.fallbackSuccesses += 1;
  }
  const viaFallback = acquired.retrievalMethod === 'reader_fallback';
  if (acquired.status === RETRIEVAL_STATUS.SUCCESS && !viaFallback) r.plainSuccesses += 1;
  if (!admissibility.admissible) {
    r.unusableSources += 1;
    if (/^content_/.test(admissibility.reason) || acquired.contentAssessment) r.weakSourcesRejected += 1;
    diag.sourceQuality.weakOrRejected += 1;
    return;
  }
  const q = diag.sourceQuality;
  if (roleResult.role === 'primary_authoritative') q.primaryAuthoritative += 1;
  else if (roleResult.role === 'syndicated') q.syndicated += 1;
  else if (roleResult.role === 'social_media') q.socialMedia += 1;
  else q.independentReporting += 1;
}

function newEvidenceVerificationTrace() {
  return {
    claimsConsidered: 0, candidateSources: 0, verifierCalls: 0, supports: 0, contradicts: 0, uncertain: 0,
    quotesAccepted: 0, quotesRejected: 0, corroboratingLinksAdded: 0, contradictingLinksAdded: 0,
    providerFailures: 0, expansionSourcesAcquired: 0, stopReason: null, verifiedLoadBearingFact: 0
  };
}

/**
 * Evidence Verification / Enrichment stage (Pass 44).
 *
 * Verifies load-bearing FACT/INFERENCE claims directly against retrieved source
 * TEXT. It never reads or requires claim identity / fingerprint / convergence.
 * The LLM only classifies claim<->source relationship (SUPPORTS / CONTRADICTS /
 * UNCERTAIN) and every accepted decision carries a quote that was proven to be a
 * literal substring of the application-supplied source text. Accepted decisions
 * become claim_sources rows (`corroborating` / `contradicting`); the existing
 * deterministic computeEvidenceStatus remains the only authority on VERIFIED.
 *
 * Bounded: a project-wide verifier-call budget, a per-claim candidate cap, at
 * most one candidate per registrable domain, and an early stop as soon as one
 * load-bearing FACT reaches VERIFIED. Mutates persistedSources only when the
 * optional evidence expansion acquires additional (tracked) sources.
 */
async function enrichEvidence({
  storage, runId, project, persistedClaims, persistedSources, contentBySourceId, policy, llmRouter,
  evidenceVerifier, sourceProvider, acquisitionResult, retrieveImpl, fetchImpl, classification, trace, diag
}) {
  if (!llmRouter || typeof llmRouter.complete !== 'function' || typeof evidenceVerifier !== 'function') {
    trace.stopReason = 'verifier_not_configured';
    return;
  }
  const cfg = policy?.evidence_verification ?? {};
  const limits = {
    ...DEFAULT_VERIFICATION_LIMITS,
    ...(Number.isInteger(cfg.max_verifier_calls_per_project) ? { maxVerifierCallsPerProject: cfg.max_verifier_calls_per_project } : {}),
    ...(Number.isInteger(cfg.max_candidates_per_claim) ? { maxCandidatesPerClaim: cfg.max_candidates_per_claim } : {})
  };
  let callsRemaining = limits.maxVerifierCallsPerProject;
  const tokenCache = new Map();
  const withContent = (s) => ({ ...s, content: contentBySourceId.get(s.id) ?? '' });
  const sourcesNow = () => persistedSources.map(withContent);
  const sourcesByIdNow = () => new Map(persistedSources.map((s) => [s.id, s]));

  const linksOf = (claimId) => storage.all('SELECT * FROM claim_sources WHERE claim_id = ?', [claimId]);
  const statusOf = (claim) => computeEvidenceStatus({
    claimSourceLinks: linksOf(claim.id), sourcesById: sourcesByIdNow(), policy,
    hasUnresolvedContradiction: hasUnresolvedContradiction(storage, claim.id)
  });
  const isLoadBearingFact = (c) => c.claim_type === CLAIM_TYPE.FACT && c.is_load_bearing === true;

  if (persistedClaims.some((c) => isLoadBearingFact(c) && statusOf(c) === EVIDENCE_STATUS.VERIFIED)) {
    trace.stopReason = 'already_verified';
    return;
  }

  const eligible = persistedClaims.filter((c) =>
    c.is_load_bearing === true && (c.claim_type === CLAIM_TYPE.FACT || c.claim_type === CLAIM_TYPE.INFERENCE) &&
    [EVIDENCE_STATUS.PARTIALLY_SUPPORTED, EVIDENCE_STATUS.UNSUPPORTED].includes(statusOf(c))
  );

  const plan = (claims) => claims.map((claim) => {
    const linkedSourceIds = linksOf(claim.id).filter((l) => l.role !== 'contradicting').map((l) => l.source_id);
    const candidates = selectCandidateSources({
      claim, sources: sourcesNow(), linkedSourceIds, policy, maxCandidates: limits.maxCandidatesPerClaim, tokenCache, diagnostics: diag.relevance
    });
    const best = candidates.length ? candidates[0].score : 0;
    return { claim, candidates, priority: claimPriorityScore(claim, best) };
  }).sort((a, b) => {
    const fa = a.claim.claim_type === CLAIM_TYPE.FACT ? 1 : 0;
    const fb = b.claim.claim_type === CLAIM_TYPE.FACT ? 1 : 0;
    if (fb !== fa) return fb - fa;
    if (b.priority !== a.priority) return b.priority - a.priority;
    return String(a.claim.id) < String(b.claim.id) ? -1 : 1;
  });

  const noteDecision = (claim, decision) => {
    const source = persistedSources.find((s) => s.id === decision.sourceId);
    const accepted = decision.quoteAccepted === true;
    if (decision.rejectionReason === REJECTION_REASON.PROVIDER_ERROR) trace.providerFailures += 1;
    if (QUOTE_REJECTIONS.has(decision.rejectionReason)) trace.quotesRejected += 1;
    if (accepted) trace.quotesAccepted += 1;
    if (accepted && decision.result === VERIFICATION_RESULT.SUPPORTS) trace.supports += 1;
    else if (accepted && decision.result === VERIFICATION_RESULT.CONTRADICTS) trace.contradicts += 1;
    else trace.uncertain += 1;
    logDecision(storage, {
      runId, stage: RESEARCH_STAGE.EVIDENCE_VERIFICATION, subjectType: 'claim', subjectId: claim.id,
      decision: decision.result, reason: accepted ? 'quote_validated' : (decision.rejectionReason ?? 'no_direct_support'),
      provider: decision.provider ?? null,
      configSnapshot: {
        sourceId: decision.sourceId, sourceUrl: source?.url ?? decision.url, sourceDomain: independenceKey(source?.url ?? decision.url),
        sourceRole: source?.role ?? null, quote: decision.quote || null, quoteAccepted: accepted,
        rejectionReason: decision.rejectionReason ?? null, model: decision.model ?? null
      }
    });
    if (!accepted) return;
    const role = decision.result === VERIFICATION_RESULT.SUPPORTS ? 'corroborating' : 'contradicting';
    const link = linkClaimSource(storage, { claimId: claim.id, sourceId: decision.sourceId, role });
    if (link.inserted) {
      if (role === 'corroborating') trace.corroboratingLinksAdded += 1; else trace.contradictingLinksAdded += 1;
    }
  };

  const verifyOne = async (entry) => {
    const { claim, candidates } = entry;
    if (candidates.length === 0 || callsRemaining <= 0) return { verified: false, ran: false };
    trace.candidateSources += candidates.length;
    const out = await evidenceVerifier({
      claim, candidateSources: candidates.map((c) => withContent(c.source)), llmRouter, limits, callBudget: callsRemaining,
      onDecision: (decision) => {
        noteDecision(claim, decision);
        const status = statusOf(claim);
        return status === EVIDENCE_STATUS.VERIFIED || status === EVIDENCE_STATUS.CONTESTED;
      }
    });
    callsRemaining -= out.callsUsed;
    trace.verifierCalls += out.callsUsed;
    return { verified: statusOf(claim) === EVIDENCE_STATUS.VERIFIED, ran: true };
  };

  let ordered = plan(eligible);
  trace.claimsConsidered = ordered.length;
  const run = async (entries) => {
    for (const entry of entries) {
      if (callsRemaining <= 0) { trace.stopReason = 'call_budget_exhausted'; return false; }
      const r = await verifyOne(entry);
      if (r.verified && isLoadBearingFact(entry.claim)) { trace.stopReason = 'verified_load_bearing_fact'; return true; }
    }
    return false;
  };
  if (await run(ordered)) return;
  if (trace.stopReason === 'call_budget_exhausted') return;

  // --- Optional evidence expansion (bounded; reuses ResearchSourceProvider + acquisition limits) ---
  const topFact = ordered.find((e) => e.claim.claim_type === CLAIM_TYPE.FACT);
  const remainingSources = policy.acquisition.max_sources_per_research_project - acquisitionResult.acquired.length;
  const remainingAttempts = policy.acquisition.max_acquisition_attempts - acquisitionResult.attemptsUsed;
  if (!topFact || !sourceProvider || remainingSources <= 0 || remainingAttempts <= 0 || callsRemaining <= 0) {
    trace.stopReason = trace.stopReason ?? (callsRemaining <= 0 ? 'call_budget_exhausted' : ordered.some((e) => e.candidates.length > 0) ? 'candidates_exhausted' : 'no_candidate_sources');
    return;
  }
  const known = new Set(persistedSources.map((s) => s.url));
  // Pass 47: one deterministic query cascade for the top FACT claim instead of
  // a single query. It runs through the SAME provider and the SAME
  // acquireSources() below; the number of discovery calls is bounded by the
  // remaining acquisition attempts, and merged candidates by the remaining
  // attempts too, so the existing acquisition policy stays authoritative.
  const topLinked = linksOf(topFact.claim.id).map((l) => persistedSources.find((s) => s.id === l.source_id)).filter(Boolean);
  // Pass 48: pages on a domain that already supports this claim cannot corroborate it.
  const linkedDomains = [...new Set(topLinked.map((s) => independenceKey(s.url)).filter(Boolean))];
  const evidenceQueries = buildEvidenceQueries({
    claim: topFact.claim,
    linkedSources: topLinked, classification: classification ?? {}
  });
  const expansionProvider = {
    id: sourceProvider.id,
    discoverCandidates: async ({ maxResults }) => {
      const cascade = await discoverWithCascade({
        provider: sourceProvider, queries: evidenceQueries, maxQueries: remainingAttempts, maxResults,
        knownUrls: [...known], maxCandidates: remainingAttempts, excludeDomains: linkedDomains, socialDomains: classification?.socialDomains ?? [], diagnostics: diag?.evidenceSearch ?? null
      });
      return { candidates: cascade.candidates, failures: cascade.failures };
    }
  };
  const expansionPolicy = {
    acquisition: { max_sources_per_research_project: remainingSources, max_acquisition_attempts: remainingAttempts },
    retry: policy.retry
  };
  const expanded = await acquireSources({
    provider: expansionProvider, query: topFact.claim.claim, policy: expansionPolicy, retrieveImpl, fetchImpl
  });
  // Budget bookkeeping: expansion consumes the same project-level acquisition ceilings.
  acquisitionResult.attemptsUsed += expanded.attemptsUsed;
  for (const acquired of expanded.acquired) {
    const roleResult = classifySourceRole(acquired.url, classification);
    const admissibility = assessEvidenceAdmissibility(acquired.status, roleResult.role, acquired.content);
    const qualityTier = admissibility.quality;
    noteAcquiredDiag(diag, acquired, roleResult, admissibility);
    const sourceId = insertSource(storage, {
      researchProjectId: project.id, url: acquired.url, sourceType: null, role: roleResult.role, qualityTier,
      retrievalStatus: acquired.status, content: acquired.content, notes: buildSourceProvenance(acquired)
    });
    logDecision(storage, {
      runId, stage: RESEARCH_STAGE.SOURCE_ACQUISITION, subjectType: 'source', subjectId: sourceId,
      decision: acquired.status, reason: acquired.error || 'retrieved_for_evidence_expansion', resultingState: acquired.status
    });
    logDecision(storage, {
      runId, stage: RESEARCH_STAGE.SOURCE_CLASSIFICATION, subjectType: 'source', subjectId: sourceId,
      decision: roleResult.role, reason: roleResult.ambiguous ? 'ambiguous_deterministic_classification' : 'deterministic_domain_match',
      resultingState: qualityTier
    });
    contentBySourceId.set(sourceId, acquired.content);
    persistedSources.push({ id: sourceId, url: acquired.url, retrieval_status: acquired.status, role: roleResult.role, quality_tier: qualityTier, retrieved_at: new Date().toISOString(), notes: buildSourceProvenance(acquired) });
    known.add(acquired.url);
    if (acquired.status === RETRIEVAL_STATUS.SUCCESS) trace.expansionSourcesAcquired += 1;
  }
  const replanned = plan([topFact.claim]);
  trace.claimsConsidered = Math.max(trace.claimsConsidered, ordered.length);
  if (await run(replanned)) return;
  trace.stopReason = trace.stopReason ?? 'candidates_exhausted';
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
 * @param {object} [deps.classification] - { authoritativeDomains, syndicatedDomains, socialDomains } for sourceClassification
 * @param {function} [deps.retrieveImpl] - injectable retrieval fn for testing
 * @param {function} [deps.fetchImpl] - forwarded to retrieveImpl
 * @param {function} [deps.detectContradiction] - async (claimA, claimB, llmRouter) => one of CONTRADICTION_RESULT ('CONTRADICTS'|'NO_CONTRADICTION'|'UNCERTAIN'); a thrown/rejected call is treated as ERROR by the caller. LLM-assisted semantic judgment, RG-02 contract (see ./contradictionDetector.js for the production implementation). Optional: no contradiction detection performed if omitted (logged as NOT_CHECKED).
 * @param {function} [deps.evidenceVerifier] - claim-vs-source-text verifier (see ./evidenceVerification.js verifyClaimAgainstSources); injectable for testing.
 * @param {string} [deps.runId]
 */
export async function runResearchProject({
  storage, opportunityId, sourceProvider, llmRouter, policy, classification = {},
  retrieveImpl, fetchImpl, detectContradiction = null, runId = null, evidenceVerifier = verifyClaimAgainstSources
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

  const researchDiag = newResearchDiag();
  const persistedSources = [];
  // source id -> the acquisition candidate's publishedAt (provider metadata,
  // possibly null). Kept beside persistedSources so the returned source shape
  // is unchanged. Only claim-identity year grounding reads it.
  const publishedAtBySourceId = new Map();
  // source id -> retrieved text, kept beside persistedSources (whose returned
  // shape is unchanged) for the evidence verification stage.
  const contentBySourceId = new Map();
  for (const acquired of acquisitionResult.acquired) {
    const roleResult = classifySourceRole(acquired.url, classification);
    const admissibility = assessEvidenceAdmissibility(acquired.status, roleResult.role, acquired.content);
    const qualityTier = admissibility.quality;
    noteAcquiredDiag(researchDiag, acquired, roleResult, admissibility);
    const sourceId = insertSource(storage, {
      researchProjectId: project.id, url: acquired.url, sourceType: null,
      role: roleResult.role, qualityTier, retrievalStatus: acquired.status,
      content: acquired.content, notes: buildSourceProvenance(acquired)
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
    contentBySourceId.set(sourceId, acquired.content);
    persistedSources.push({ id: sourceId, url: acquired.url, retrieval_status: acquired.status, role: roleResult.role, quality_tier: qualityTier, retrieved_at: new Date().toISOString(), notes: buildSourceProvenance(acquired) });
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
  const identityTrace = { factClaims: 0, loadBearingFactFingerprinted: 0, reasons: {} };

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
      const { fingerprint, reason: identityReason, identity: derivedIdentity } = deriveClaimIdentity(proposed, publicationContext);
      if (proposed.claim_type === CLAIM_TYPE.FACT) {
        identityTrace.factClaims += 1;
        if (proposed.is_load_bearing && fingerprint) identityTrace.loadBearingFactFingerprinted += 1;
        const key = identityReason === null ? 'null' : String(identityReason);
        identityTrace.reasons[key] = (identityTrace.reasons[key] ?? 0) + 1;
      }
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
      let convergenceDiagnostic = null;
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
          // Must precede evaluation and must remain side-effect free.
          if (diagnosticsEnabled()) try {
            convergenceDiagnostic = explainConvergence(convergenceIndex, {
              identity: trustedIdentity, claimType: proposed.claim_type,
              isLoadBearing: proposed.is_load_bearing, sourceId: source.id
            });
            if (!convergenceDiagnostic.error) {
              convergenceDiagnostic.pairs = convergenceDiagnostic.pairs.map((pair) => ({
                ...pair,
                sourceDomains: pair.sourceIds.map((id) => independenceKey(storage.get('SELECT url FROM sources WHERE id = ?', [id])?.url))
              }));
            }
          } catch { convergenceDiagnostic = { error: true }; }
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

      // Diagnostics are strictly best-effort and occur only after the final
      // claim/source relationship is established.
      if (diagnosticsEnabled() && proposed.claim_type === CLAIM_TYPE.FACT) {
        try {
          const normForTrace = proposed.normalization || {};
          logDecision(storage, {
            runId, stage: RESEARCH_STAGE.CLAIM_EXTRACTION, subjectType: 'claim', subjectId: claimId,
            decision: 'CLAIM_TRACE', reason: dedupId ? 'DEDUP_SAME_SOURCE' : (mergedByIdentity ? 'MERGED_BY_IDENTITY' : (convergenceDiagnostic?.pairs?.some((p) => p.promotionEligible) && !isNewClaim ? 'MERGED_BY_CONVERGENCE' : 'NEW_CLAIM')),
            configSnapshot: {
              sourceId: source.id, sourceDomain: independenceKey(sourceRow.url), sourceRole: sourceRow.role,
              claimText: proposed.claim, claimType: proposed.claim_type, isLoadBearing: proposed.is_load_bearing,
              normalizationStatus: normForTrace.status ?? null, convergenceTrusted: normForTrace.convergenceTrusted === true,
              identityDiscarded: normForTrace.identityDiscarded === true, identityPresent: !!proposed.identity,
              identityReason, fingerprintPresent: !!fingerprint, fingerprintPrefix: fingerprint ? fingerprint.slice(0, 12) : null,
              identityIndexEligible, identity: derivedIdentity ?? null, path: dedupId ? 'DEDUP_SAME_SOURCE' : (mergedByIdentity ? 'MERGED_BY_IDENTITY' : (isNewClaim ? 'NEW_CLAIM' : 'MERGED_BY_CONVERGENCE')),
              convergenceEligible: convergenceEligibility?.eligible ?? false, convergenceSkipReason: convergenceEligibility?.reason ?? null,
              relevance: convergenceEligibility?.relevance ?? null, convergence: convergenceDiagnostic
            }
          });
        } catch { /* diagnostics must never affect research */ }
      }

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

  // --- Evidence verification / enrichment (Pass 44) ---
  // Corroboration is earned from claim TEXT vs source TEXT, never from identity
  // or fingerprint equality. Fail-isolated: any failure here can only leave a
  // claim with less evidence, never more, so it never aborts the project.
  const evidenceVerificationTrace = newEvidenceVerificationTrace();
  try {
    await enrichEvidence({
      storage, runId, project, persistedClaims, persistedSources, contentBySourceId, policy, llmRouter,
      evidenceVerifier, sourceProvider, acquisitionResult, retrieveImpl, fetchImpl, classification, trace: evidenceVerificationTrace, diag: researchDiag
    });
  } catch (err) {
    evidenceVerificationTrace.stopReason = 'enrichment_error';
    logDecision(storage, {
      runId, stage: RESEARCH_STAGE.EVIDENCE_VERIFICATION, subjectType: 'research_project', subjectId: project.id,
      decision: 'ENRICHMENT_ERROR', reason: err?.message || 'evidence enrichment failed'
    });
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
    if (diagnosticsEnabled() && claimRow.claim_type === CLAIM_TYPE.FACT && claimRow.is_load_bearing === true) {
      try {
        logDecision(storage, {
          runId, stage: RESEARCH_STAGE.EVIDENCE_GRADING, subjectType: 'claim', subjectId: claimRow.id,
          decision: 'EVIDENCE_TRACE', reason: evidenceStatus,
          configSnapshot: { ...explainEvidenceSources({ claimSourceLinks: links, sourcesById, policy }), contested }
        });
      } catch { /* diagnostics must never affect research */ }
    }
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

  if (diagnosticsEnabled()) try {
    const factClaims = persistedClaims.filter((c) => c.claim_type === CLAIM_TYPE.FACT);
    const loadBearingFact = factClaims.filter((c) => c.is_load_bearing);
    const verifiedLoadBearingFact = loadBearingFact.filter((c) => c.evidence_status === EVIDENCE_STATUS.VERIFIED).length;
    const successfulPersistedSources = persistedSources.filter((s) => s.retrieval_status === RETRIEVAL_STATUS.SUCCESS);
    const sourceDomains = new Set(successfulPersistedSources.map((s) => independenceKey(s.url)).filter(Boolean));
    const independentReportingDomains = new Set(successfulPersistedSources.filter((s) => s.role === 'independent_reporting').map((s) => independenceKey(s.url)).filter(Boolean));
    logDecision(storage, { runId, stage: RESEARCH_STAGE.COMPLETENESS_CHECK, subjectType: 'research_project', subjectId: project.id,
      decision: 'RESEARCH_TRACE_SUMMARY', reason: completenessResult.status,
      configSnapshot: { factClaims: factClaims.length, loadBearingFact: loadBearingFact.length,
        loadBearingFactFingerprinted: identityTrace.loadBearingFactFingerprinted, identityReasonHistogram: identityTrace.reasons, convergence,
        distinctSuccessfulDomains: sourceDomains.size, independentReportingDomains: independentReportingDomains.size,
        verifiedLoadBearingFact, stoppingConditionMet,
        evidenceVerification: { ...evidenceVerificationTrace, verifiedLoadBearingFact },
        retrieval: researchDiag.retrieval, sourceQuality: researchDiag.sourceQuality,
        evidenceSearch: researchDiag.evidenceSearch,
        relevance: { candidatesScored: researchDiag.relevance.candidatesScored, candidatesRejectedAsIrrelevant: researchDiag.relevance.candidatesRejectedAsIrrelevant, entries: researchDiag.relevance.entries.slice(0, 50) } } });
  } catch { /* diagnostics must never affect research */ }

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
