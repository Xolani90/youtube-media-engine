import crypto from 'node:crypto';
import fs from 'node:fs';
import { PUBLICATION_STAGE, PUBLICATION_STATUS, PUBLICATION_RESULT_STATUS, OUTCOME, DECISION_LOG_DECISION, publicationActionId } from './constants.js';
import { resolveMediaForPublication } from './eligibility.js';
import { buildPublicationRequest } from './PublicationRequest.js';
import { resolveProvider } from './providerRegistry.js';
import { assertExternalActionAllowed, SideEffectDeniedError } from '../state/SideEffectAuthorization.js';
import { canTransition, transition, InvalidTransitionError } from '../state/ContentStateMachine.js';

/** Same shape/discipline as every other stage's local logDecision helper. */
function logDecision(storage, { runId = null, subjectType, subjectId, decision, reason, resultingState = null }, nowISO = () => new Date().toISOString()) {
  const id = crypto.randomUUID();
  storage.run(
    `INSERT INTO decision_log
      (id, run_id, subject_type, subject_id, decision, reason, provider, config_snapshot, confidence, risk_level, resulting_state, created_at, stage)
     VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?, ?)`,
    [id, runId, subjectType, subjectId, decision, reason, resultingState, nowISO(), PUBLICATION_STAGE]
  );
  return id;
}

/**
 * Runs Publication v1 for the current Script/content_version of a
 * content item that Media Production has already rendered (a
 * `media_artifacts` row exists). Standalone, explicitly-invoked stage —
 * no orchestrator calls this automatically, mirroring every prior
 * stage's manual-trigger-surface convention.
 *
 * This is the ONLY place PRODUCED -> PUBLISHED is transitioned, and only
 * after a confirmed provider SUCCESS result (see step 7 below).
 *
 * Provider-neutral core: this function knows nothing about YouTube. It
 * resolves a PublicationProvider via ../publication/providerRegistry.js
 * and interacts with it only through the normalized
 * publish()/PUBLICATION_RESULT_STATUS contract in ./PublicationProvider.js.
 *
 * @param {object} deps
 * @param {import('../storage/StorageDriver.js').StorageDriver} deps.storage
 * @param {string} deps.contentBriefId
 * @param {string} [deps.provider] - provider id, defaults to 'youtube'
 * @param {import('./PublicationProvider.js').PublicationProvider} [deps.adapter] - injectable for tests; defaults to providerRegistry's resolution of `provider`
 * @param {string|null} [deps.requestedPublishAt]
 * @param {string} [deps.runId]
 * @param {string} [deps.mode] - 'SIMULATION' | 'LIVE', the authoritative
 *   mode of the enclosing run (e.g. the value returned by
 *   SystemRunRecorder.start()). Forwarded verbatim to
 *   assertExternalActionAllowed() below (D-C2 §3.1.1/§3.3) so
 *   authorization is checked against the actual run's mode rather than
 *   process-global config. Left undefined by existing direct callers,
 *   in which case assertExternalActionAllowed() keeps its own existing
 *   fallback to config.runMode -- unchanged behavior for every caller
 *   that does not pass this.
 */
export async function runPublication({
  storage,
  contentBriefId,
  provider = 'youtube',
  adapter = resolveProvider(provider),
  requestedPublishAt = null,
  runId = null,
  mode
}) {
  const nowISO = () => new Date().toISOString();

  // --- 1. Eligibility: resolve Script/content_brief + the Media
  // Production artifact. ---
  const eligibility = resolveMediaForPublication(storage, contentBriefId);
  if (!eligibility.eligible) {
    const decision = eligibility.reason === 'NOT_YET_RENDERED'
      ? DECISION_LOG_DECISION.NOT_YET_RENDERED
      : DECISION_LOG_DECISION.STRUCTURAL_FAILURE;
    logDecision(storage, {
      runId, subjectType: 'content_brief', subjectId: contentBriefId,
      decision, reason: eligibility.reason
    }, nowISO);
    const outcome = eligibility.reason === 'NOT_YET_RENDERED' ? OUTCOME.NOT_YET_RENDERED : OUTCOME.STRUCTURAL_FAILURE;
    return { outcome, reason: eligibility.reason, publication: null };
  }
  const { contentVersion, script, contentBrief, mediaArtifact } = eligibility;

  // --- 2. Lifecycle precondition: the only legal entry state is
  // PRODUCED (mirrors Production MVP's own "only legal entry point"
  // check). content_version.state === 'PUBLISHED' already is reported
  // via the existing-publication check below instead, since a
  // media_artifacts row + PUBLISHED state is the normal steady state
  // after a successful prior run, not a structural problem. ---
  if (contentVersion.state !== 'PRODUCED' && contentVersion.state !== 'PUBLISHED') {
    logDecision(storage, {
      runId, subjectType: 'content_version', subjectId: contentVersion.id,
      decision: DECISION_LOG_DECISION.INELIGIBLE_STATE, reason: `not_eligible_from_state_${contentVersion.state}`
    }, nowISO);
    return { outcome: OUTCOME.INELIGIBLE_STATE, reason: contentVersion.state, publication: null };
  }

  // --- 3. Idempotency / restart-safety: consult the durable
  // publication record for this (content_version, provider) BEFORE
  // doing anything else. A confirmed PUBLISHED row is returned
  // unchanged, never re-uploaded (Publication v1 spec §10). An
  // AMBIGUOUS row is also never retried automatically (§11/§12) -- it
  // requires explicit reconciliation outside this pipeline. A PENDING
  // row found here means a prior run was interrupted after claiming the
  // attempt but before a provider result was confirmed one way or the
  // other; since we cannot safely tell "never sent" from "sent but the
  // process died before the response," it is treated the same as an
  // ambiguous result rather than blindly retried (§18: a crash must not
  // cause the engine to unknowingly create duplicate publications). ---
  const existing = storage.get(
    'SELECT * FROM publications WHERE content_version_id = ? AND provider = ?',
    [contentVersion.id, provider]
  );
  if (existing?.status === PUBLICATION_STATUS.PUBLISHED) {
    return { outcome: OUTCOME.ALREADY_PUBLISHED, publication: existing };
  }
  if (existing?.status === PUBLICATION_STATUS.AMBIGUOUS) {
    return { outcome: OUTCOME.AMBIGUOUS, reason: 'previously_ambiguous_not_auto_retried', publication: existing };
  }
  if (existing?.status === PUBLICATION_STATUS.PENDING) {
    const interrupted = storage.transaction(() => {
      storage.run(
        `UPDATE publications SET status = ?, result_json = ?, updated_at = ? WHERE id = ? AND status = 'PENDING'`,
        [PUBLICATION_STATUS.AMBIGUOUS, JSON.stringify({ note: 'interrupted_prior_attempt' }), nowISO(), existing.id]
      );
      return storage.get('SELECT * FROM publications WHERE id = ?', [existing.id]);
    });
    logDecision(storage, {
      runId, subjectType: 'content_version', subjectId: contentVersion.id,
      decision: DECISION_LOG_DECISION.INTERRUPTED_ATTEMPT, reason: `publication_${existing.id}_interrupted`
    }, nowISO);
    return { outcome: OUTCOME.AMBIGUOUS, reason: 'interrupted_prior_attempt', publication: interrupted };
  }

  // --- 4. Media artifact must still exist on disk. ---
  if (!fs.existsSync(mediaArtifact.artifact_path)) {
    logDecision(storage, {
      runId, subjectType: 'content_version', subjectId: contentVersion.id,
      decision: DECISION_LOG_DECISION.ARTIFACT_MISSING, reason: `media_artifact_file_missing_${mediaArtifact.artifact_path}`
    }, nowISO);
    return { outcome: OUTCOME.ARTIFACT_MISSING, publication: null };
  }

  // --- 5. D-C2 external side-effect authorization. Checked immediately
  // before the external action, never cached, and identifies exactly
  // this content_version's publish action (see
  // constants.js#publicationActionId) -- never a blanket
  // "publish:<provider>" that would authorize every future video at
  // once (ADR-0008 §3.1). The provider adapter is never invoked before
  // this passes, so a caller cannot bypass D-C2 by reaching the adapter
  // directly through this pipeline. ---
  const action = publicationActionId(provider, contentVersion.id);
  try {
    assertExternalActionAllowed({ action, mode });
  } catch (err) {
    if (!(err instanceof SideEffectDeniedError)) throw err;
    logDecision(storage, {
      runId, subjectType: 'content_version', subjectId: contentVersion.id,
      decision: DECISION_LOG_DECISION.AUTHORIZATION_DENIED, reason: err.message
    }, nowISO);
    return { outcome: OUTCOME.AUTHORIZATION_DENIED, reason: err.message, publication: null };
  }

  // --- 6. Build the provider-neutral request and durably claim this
  // attempt (PENDING row) BEFORE calling the provider, so a crash
  // between here and the provider result is itself detectable as an
  // interrupted attempt on the next run (step 3 above), rather than
  // leaving no trace at all that an external call may have been made. ---
  const request = buildPublicationRequest({ contentVersion, script, contentBrief, mediaArtifact, requestedPublishAt });
  const requestJson = JSON.stringify(request);

  // Performs the claim attempt (race re-check + INSERT) inside a single
  // transaction, obtaining a fresh SQLite snapshot each time it is
  // invoked. Factored out only so the SQLITE_BUSY_SNAPSHOT recovery
  // path below can perform its one bounded retry as a brand-new
  // transaction without duplicating this body.
  const attemptClaim = () => storage.transaction(() => {
    // Re-check for a race: a concurrent run may have already claimed or
    // completed this (content_version, provider) while this run was
    // getting here.
    const raceExisting = storage.get(
      'SELECT * FROM publications WHERE content_version_id = ? AND provider = ?',
      [contentVersion.id, provider]
    );
    if (raceExisting) {
      if (raceExisting.status === PUBLICATION_STATUS.FAILED) {
        // FAILED is documented (0010_publication.sql, PublicationProvider.js)
        // as safe to retry -- no external side effect occurred. Reuse
        // this exact row (the UNIQUE(content_version_id, provider)
        // index forbids a second one anyway) and atomically transition
        // it back to PENDING, but ONLY if it is still FAILED at the
        // moment of this UPDATE, in this same transaction/snapshot as
        // the read above. A second, concurrent reclaim attempt loses
        // this race the identical way any other claim race already
        // does: its stale snapshot throws SQLITE_BUSY_SNAPSHOT on this
        // same UPDATE, which the existing recovery path below already
        // handles by re-reading and mapping non-PUBLISHED -> AMBIGUOUS.
        const reclaim = storage.run(
          `UPDATE publications
             SET status = 'PENDING', request_json = ?, attempt_count = attempt_count + 1, updated_at = ?
           WHERE id = ? AND status = 'FAILED'`,
          [requestJson, nowISO(), raceExisting.id]
        );
        if (reclaim.changes === 1) {
          return { publicationId: raceExisting.id };
        }
        // Defensive fallback only: under SQLite's single-writer
        // serialization this WHERE guard should never actually miss
        // inside a transaction that just read the same row, but if it
        // ever does, treat it like any other claim race rather than
        // silently proceeding.
      }
      return { raced: true, existing: raceExisting };
    }
    const publicationId = crypto.randomUUID();
    storage.run(
      `INSERT INTO publications
        (id, content_version_id, media_artifact_id, provider, status, request_json, attempt_count, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'PENDING', ?, 1, ?, ?)`,
      [publicationId, contentVersion.id, mediaArtifact.id, provider, requestJson, nowISO(), nowISO()]
    );
    return { publicationId };
  });

  let claim;
  try {
    claim = attemptClaim();
  } catch (err) {
    // A stale-snapshot conflict on the claim transaction: this
    // connection's deferred-transaction read snapshot (established by
    // the raceExisting SELECT above) predates a commit made elsewhere
    // in the database, so SQLite refuses the subsequent write. This is
    // a storage-level condition, not a normal claim.raced outcome, so
    // it is caught narrowly by exact SQLite error code -- every other
    // exception (including plain SQLITE_BUSY) propagates unchanged.
    if (err.code !== 'SQLITE_BUSY_SNAPSHOT') {
      throw err;
    }

    // Let the failed transaction unwind completely (it already has,
    // since storage.transaction() has returned via throw), then take a
    // fresh autocommit read -- never from inside a transaction -- to
    // see whether the conflict was actually a competing Publication
    // claimant for this exact (content_version, provider) pair.
    const freshRow = storage.get(
      'SELECT * FROM publications WHERE content_version_id = ? AND provider = ?',
      [contentVersion.id, provider]
    );

    if (freshRow) {
      // A competing claimant is responsible for the conflict. Map its
      // status exactly the same way the ordinary claim.raced path
      // below does.
      if (freshRow.status === PUBLICATION_STATUS.PUBLISHED) {
        return { outcome: OUTCOME.ALREADY_PUBLISHED, publication: freshRow };
      }
      return { outcome: OUTCOME.AMBIGUOUS, reason: 'concurrent_attempt_in_progress', publication: freshRow };
    }

    // No competing Publication row: the conflict must have come from
    // some other writer elsewhere in the shared SQLite database. Give
    // this attempt exactly one more try, as a brand-new transaction
    // (and therefore a fresh snapshot) -- never a general retry loop.
    try {
      claim = attemptClaim();
    } catch (retryErr) {
      if (retryErr.code !== 'SQLITE_BUSY_SNAPSHOT') {
        throw retryErr;
      }
      // The single bounded retry itself hit another stale-snapshot
      // conflict. Do not retry again and do not call the provider;
      // report a defined, reconcilable outcome instead.
      return { outcome: OUTCOME.AMBIGUOUS, reason: 'busy_snapshot_retry_exhausted', publication: null };
    }
  }

  if (claim.raced) {
    // Another run already owns this attempt. Do not call the provider
    // twice for the same content_version/provider pair; report the
    // race's current state rather than guessing.
    if (claim.existing.status === PUBLICATION_STATUS.PUBLISHED) {
      return { outcome: OUTCOME.ALREADY_PUBLISHED, publication: claim.existing };
    }
    return { outcome: OUTCOME.AMBIGUOUS, reason: 'concurrent_attempt_in_progress', publication: claim.existing };
  }

  // --- 7. Perform the external side effect via the provider adapter.
  // The publication core never inspects YouTube-specific fields on the
  // result -- only the normalized PUBLICATION_RESULT_STATUS contract. ---
  let result;
  try {
    result = await adapter.publish(request);
  } catch (err) {
    // A provider adapter throwing is a programmer/contract error (see
    // PublicationProvider.js docstring), not a normal outcome -- but we
    // still must not leave the row silently PENDING forever, and we
    // must not guess success or failure, so this is treated as
    // ambiguous and requires reconciliation like any other
    // undetermined outcome.
    const ambiguousResult = { status: PUBLICATION_RESULT_STATUS.AMBIGUOUS, provider, reconciliationInfo: { note: `adapter_threw_${err.message}` } };
    const row = storage.transaction(() => {
      storage.run(
        `UPDATE publications SET status = 'AMBIGUOUS', result_json = ?, updated_at = ? WHERE id = ?`,
        [JSON.stringify(ambiguousResult), nowISO(), claim.publicationId]
      );
      return storage.get('SELECT * FROM publications WHERE id = ?', [claim.publicationId]);
    });
    logDecision(storage, {
      runId, subjectType: 'content_version', subjectId: contentVersion.id,
      decision: DECISION_LOG_DECISION.AMBIGUOUS, reason: `adapter_threw_${err.message}`
    }, nowISO);
    return { outcome: OUTCOME.AMBIGUOUS, reason: err.message, publication: row };
  }

  // --- 8. Interpret the normalized result and persist accordingly. ---
  if (result.status === PUBLICATION_RESULT_STATUS.EXPLICIT_FAILURE) {
    const row = storage.transaction(() => {
      storage.run(
        `UPDATE publications SET status = 'FAILED', result_json = ?, failure_reason = ?, updated_at = ? WHERE id = ?`,
        [JSON.stringify(result), result.errorClass ?? 'PROVIDER_FAILURE', nowISO(), claim.publicationId]
      );
      return storage.get('SELECT * FROM publications WHERE id = ?', [claim.publicationId]);
    });
    logDecision(storage, {
      runId, subjectType: 'content_version', subjectId: contentVersion.id,
      decision: DECISION_LOG_DECISION.PROVIDER_FAILURE, reason: `publication_${claim.publicationId}_failed_${result.errorClass}`
    }, nowISO);
    return { outcome: OUTCOME.PROVIDER_FAILURE, reason: result.errorClass, publication: row };
  }

  if (result.status === PUBLICATION_RESULT_STATUS.AMBIGUOUS) {
    const row = storage.transaction(() => {
      storage.run(
        `UPDATE publications SET status = 'AMBIGUOUS', result_json = ?, updated_at = ? WHERE id = ?`,
        [JSON.stringify(result), nowISO(), claim.publicationId]
      );
      return storage.get('SELECT * FROM publications WHERE id = ?', [claim.publicationId]);
    });
    logDecision(storage, {
      runId, subjectType: 'content_version', subjectId: contentVersion.id,
      decision: DECISION_LOG_DECISION.AMBIGUOUS, reason: `publication_${claim.publicationId}_ambiguous`
    }, nowISO);
    return { outcome: OUTCOME.AMBIGUOUS, publication: row };
  }

  // result.status === SUCCESS: this is the ONLY path that transitions
  // the lifecycle, and only now, with a confirmed provider item id in
  // hand (Publication v1 spec §13).
  if (result.status !== PUBLICATION_RESULT_STATUS.SUCCESS || !result.providerItemId) {
    throw new Error(`Publication provider "${provider}" returned an unrecognized or incomplete result: ${JSON.stringify(result)}`);
  }

  const published = storage.transaction(() => {
    const cv = storage.get('SELECT * FROM content_versions WHERE id = ?', [contentVersion.id]);
    let resultingState = cv.state;
    if (cv.state === 'PRODUCED') {
      if (!canTransition(cv.state, 'PUBLISHED')) {
        throw new InvalidTransitionError(`${cv.state} -> PUBLISHED is not a valid transition`);
      }
      resultingState = transition(cv.state, 'PUBLISHED');
      storage.run('UPDATE content_versions SET state = ? WHERE id = ?', [resultingState, cv.id]);
    }
    storage.run(
      `UPDATE publications
        SET status = 'PUBLISHED', provider_item_id = ?, provider_url = ?, result_json = ?, updated_at = ?
       WHERE id = ?`,
      [result.providerItemId, result.providerUrl ?? null, JSON.stringify(result), nowISO(), claim.publicationId]
    );
    logDecision(storage, {
      runId, subjectType: 'content_version', subjectId: contentVersion.id,
      decision: DECISION_LOG_DECISION.PUBLISHED, reason: `publication_${claim.publicationId}_persisted`, resultingState
    }, nowISO);
    return storage.get('SELECT * FROM publications WHERE id = ?', [claim.publicationId]);
  });

  return { outcome: OUTCOME.PUBLISHED, publication: published };
}

export default runPublication;
