import crypto from 'node:crypto';
import {
  ORIGINALITY_STAGE,
  CORPUS_DEFINITION,
  ALGORITHM,
  ALGORITHM_VERSION,
  KNOWN_LIMITATIONS,
  DECISION_LOG_DECISION
} from './constants.js';
import { resolveCurrentScript } from './eligibility.js';
import { tokenize, jaccardSimilarity } from '../discovery/similarity.js';
import { canTransition, transition, InvalidTransitionError } from '../state/ContentStateMachine.js';

/**
 * Records a decision_log entry. Same shape/discipline as Fact-Check's,
 * Script's, and Brief's local logDecision helpers (stage is a first-class
 * column, never encoded into decision/reason) — this is a small,
 * deliberately duplicated helper per the repository's existing
 * per-module convention, not a shared import.
 */
function logDecision(storage, { runId = null, stage, subjectType, subjectId, decision, reason, resultingState = null }, nowISO = () => new Date().toISOString()) {
  const id = crypto.randomUUID();
  storage.run(
    `INSERT INTO decision_log
      (id, run_id, subject_type, subject_id, decision, reason, provider, config_snapshot, confidence, risk_level, resulting_state, created_at, stage)
     VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?, ?)`,
    [id, runId, subjectType, subjectId, decision, reason, resultingState, nowISO(), stage]
  );
  return id;
}

/**
 * Records the required decision_log entry for an Originality structural
 * failure (no current Script resolvable) and returns the structured
 * failure the caller receives. No Originality result row is persisted —
 * there was nothing to evaluate.
 */
function structuralFailure(storage, { runId, subjectType, subjectId, reason }, nowISO) {
  logDecision(storage, {
    runId,
    stage: ORIGINALITY_STAGE,
    subjectType,
    subjectId,
    decision: DECISION_LOG_DECISION.STRUCTURAL_FAILURE,
    reason
  }, nowISO);
  return { outcome: 'STRUCTURAL_FAILURE', reason, originalityCheck: null };
}

/**
 * Runs the D-G1 v1 Originality measurement for the current Script of a
 * content item.
 *
 * This is a standalone, explicitly-invoked stage (mirrors `runFactCheck`'s
 * "manual trigger surface, any driver may invoke it" shape) — the
 * repository currently has no production orchestrator that calls this or
 * `runFactCheck` automatically, and none is created here.
 *
 * Unlike Fact-Check, every explicit invocation creates a NEW append-only
 * result row — there is no non-forced idempotent-return path, because the
 * corpus (`scripts`) is dynamic: the same script_id can legitimately
 * produce different measurements at different times as more scripts are
 * persisted.
 *
 * @param {object} deps
 * @param {import('../storage/StorageDriver.js').StorageDriver} deps.storage
 * @param {string} deps.contentBriefId
 * @param {string} [deps.runId]
 */
export function runOriginalityCheck({ storage, contentBriefId, runId = null }) {
  const nowISO = () => new Date().toISOString();

  // Resolve the current Script via content_versions.script_id only — no
  // independent "ORDER BY version DESC" definition of current.
  const eligibility = resolveCurrentScript(storage, contentBriefId);
  if (!eligibility.eligible) {
    return structuralFailure(storage, {
      runId, subjectType: 'content_brief', subjectId: contentBriefId, reason: eligibility.reason
    }, nowISO);
  }
  const { script } = eligibility;

  // Corpus: every persisted scripts row except the exact current
  // script_id. Earlier drafts of the same content_brief_id are NOT
  // excluded (Owner Decision). Ordered by id for deterministic tie-break
  // on the maximum (first row encountered at a given similarity wins).
  const corpusRows = storage.all('SELECT id, body FROM scripts WHERE id != ? ORDER BY id ASC', [script.id]);
  const corpusSize = corpusRows.length;

  // tokenize()/jaccardSimilarity() are total, pure functions over text —
  // this computation cannot throw for a persisted `body TEXT NOT NULL`
  // row. It is deliberately performed outside the transaction (mirrors
  // Fact-Check's evaluateDecision(), computed before its transaction),
  // since it does not itself perform any write.
  const candidateTokens = tokenize(script.body);
  let maxSimilarity = null;
  let mostSimilarScriptId = null;
  for (const row of corpusRows) {
    const sim = jaccardSimilarity(candidateTokens, tokenize(row.body));
    if (maxSimilarity === null || sim > maxSimilarity) {
      maxSimilarity = sim;
      mostSimilarScriptId = row.id;
    }
  }
  // corpus_size = 0 is a genuine, distinct outcome, not "0 similarity" —
  // jaccardSimilarity() itself returns 0 for empty/empty input, so this
  // stage (not the reused similarity function) explicitly owns the
  // empty-corpus branch: null, not 0, and no most-similar script.
  if (corpusSize === 0) {
    maxSimilarity = null;
    mostSimilarScriptId = null;
  }

  // Atomic persist (+ lifecycle transition only from FACT_CHECK).
  const outcome = storage.transaction(() => {
    // Re-read content_versions inside the transaction: it must still be
    // pointed at this exact script (mirrors Fact-Check's staleness guard).
    const contentVersion = storage.get(
      'SELECT * FROM content_versions WHERE content_brief_id = ?',
      [contentBriefId]
    );
    if (!contentVersion || contentVersion.script_id !== script.id) {
      throw new Error(`content_versions no longer points at script ${script.id} for content_brief ${contentBriefId}; refusing to persist Originality result.`);
    }

    const originalityCheckId = crypto.randomUUID();
    storage.run(
      `INSERT INTO originality_checks
        (id, content_version_id, script_id, corpus_definition, corpus_size, algorithm, algorithm_version, max_similarity, most_similar_script_id, known_limitations, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [originalityCheckId, contentVersion.id, script.id, CORPUS_DEFINITION, corpusSize, ALGORITHM, ALGORITHM_VERSION, maxSimilarity, mostSimilarScriptId, KNOWN_LIMITATIONS, nowISO()]
    );

    const evaluatedDecision = corpusSize === 0
      ? DECISION_LOG_DECISION.ORIGINALITY_EVALUATED_EMPTY_CORPUS
      : DECISION_LOG_DECISION.ORIGINALITY_EVALUATED;
    logDecision(storage, {
      runId, stage: ORIGINALITY_STAGE, subjectType: 'script', subjectId: script.id,
      decision: evaluatedDecision, reason: `originality_evaluated_${originalityCheckId}`
    }, nowISO);

    // Only transition from the exact state D-G1 is defined for
    // (FACT_CHECK -> ORIGINALITY_CHECK). A content version already past
    // FACT_CHECK (e.g. re-evaluated later) still gets a new persisted
    // measurement, but no lifecycle side effect — there is no
    // ORIGINALITY_CHECK -> ORIGINALITY_CHECK self-transition and forcing
    // one is not part of this stage's scope.
    let transitioned = false;
    if (contentVersion.state === 'FACT_CHECK') {
      if (!canTransition(contentVersion.state, 'ORIGINALITY_CHECK')) {
        throw new InvalidTransitionError(`${contentVersion.state} -> ORIGINALITY_CHECK is not a valid transition`);
      }
      const newState = transition(contentVersion.state, 'ORIGINALITY_CHECK');
      storage.run(
        'UPDATE content_versions SET state = ? WHERE id = ?',
        [newState, contentVersion.id]
      );
      logDecision(storage, {
        runId, stage: ORIGINALITY_STAGE, subjectType: 'content_version', subjectId: contentVersion.id,
        decision: 'ORIGINALITY_CHECK', reason: 'originality_check_persisted', resultingState: newState
      }, nowISO);
      transitioned = true;
    }

    return { originalityCheckId, transitioned };
  });

  const originalityCheck = storage.get('SELECT * FROM originality_checks WHERE id = ?', [outcome.originalityCheckId]);
  return {
    outcome: corpusSize === 0 ? 'EMPTY_CORPUS' : 'EVALUATED',
    transitioned: outcome.transitioned,
    originalityCheck
  };
}
