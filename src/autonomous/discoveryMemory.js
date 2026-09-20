import crypto from 'node:crypto';

/**
 * Discovery Observation Memory Ledger (Owner-authorized workstream).
 *
 * Persistent, cross-invocation memory of Discovery OBSERVATIONS, kept in the
 * `discovery_observations` table (migration 0015). It records facts about
 * what Discovery has observed and how each observation was evaluated. It is
 * NOT downstream state: nothing about research / production / publication
 * is copied here, and the ledger is NOT a retry mechanism for any of them.
 *
 * Integration point: src/index.js, strictly between source normalization and
 * `runDiscoveryPipeline`, so an observation the policy suppresses never
 * reaches Discovery's LLM calls (Layer-3 dedup, proposition generation,
 * feature computation):
 *
 *   normalize -> deriveIdentity -> read memory -> apply cooldown policy
 *     -> [prepareDiscoveryMemory] only admitted observations enter Discovery
 *     -> existing, unmodified runDiscoveryPipeline
 *     -> [recordDiscoveryOutcomes] outcomes written back
 *
 * Suppression policy (the ONLY suppression this module performs):
 *   - `SCORED_NOT_SELECTED` observations are suppressed while
 *     (now - last_evaluated_at) < reconsideration.cooldownHours
 *     (config/discovery_policy.json). At exactly cooldownHours elapsed the
 *     cooldown has expired and the observation is admitted again.
 *   - Every other outcome (`NOT_EVALUATED`, `NOT_SCORED_UNRESOLVED`,
 *     `SELECTED`), unknown identities, and observations without a
 *     deterministic identity are NEVER suppressed by this module.
 *
 * ASSUMPTION / LIMITATION: sequential autonomous invocations against one
 * database (single writer). No lock, lease, RUNNING guard or other
 * concurrency control is provided; overlapping runs can both read "unknown"
 * and both evaluate. Concurrent execution is a separate, future workstream.
 */

export const OUTCOME = Object.freeze({
  NOT_EVALUATED: 'NOT_EVALUATED',
  SELECTED: 'SELECTED',
  SCORED_NOT_SELECTED: 'SCORED_NOT_SELECTED',
  NOT_SCORED_UNRESOLVED: 'NOT_SCORED_UNRESOLVED'
});

export const IDENTITY_KIND = Object.freeze({
  SOURCE_ID: 'SOURCE_ID',
  CANONICAL_URL: 'CANONICAL_URL',
  TITLE: 'TITLE'
});

export class DiscoveryMemoryConfigError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'DiscoveryMemoryConfigError';
  }
}

export class DiscoveryMemoryReadError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'DiscoveryMemoryReadError';
  }
}

export class DiscoveryMemoryWriteError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'DiscoveryMemoryWriteError';
  }
}

// ---------------------------------------------------------------------------
// Identity (deterministic, LLM-free, no similarity)
// ---------------------------------------------------------------------------

// Local copy of src/discovery/dedup.js `canonicalize` (module-private there,
// so it cannot be imported without modifying Discovery code). The function
// text below is intentionally IDENTICAL to the production function;
// tests/unit/discoveryMemory.test.js extracts the production text from
// dedup.js and asserts textual identity plus identical outputs, so any drift
// in either copy fails a test.
function canonicalize(url) {
  if (!url) return null;
  try {
    const u = new URL(url);
    u.hash = '';
    ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content'].forEach((p) => u.searchParams.delete(p));
    return u.toString().replace(/\/$/, '');
  } catch {
    return url;
  }
}

export { canonicalize as canonicalizeUrl };

function nonEmptyString(value) {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function buildIdentity(kind, scope, value) {
  return {
    kind,
    scope,
    value,
    key: crypto.createHash('sha256').update(JSON.stringify([kind, scope, value])).digest('hex')
  };
}

/**
 * Derives the deterministic identity of one normalized observation using the
 * Owner-authorized ladder (first usable rung wins):
 *
 *   1. SOURCE_ID      observation.sourceId, scoped to the feed
 *                     (observation.feedUrl, else the caller-supplied
 *                     `sourceScope`, i.e. the OpportunitySource id). A
 *                     sourceId with no scope is NOT usable: guids are only
 *                     unique within a feed, so it is skipped rather than
 *                     treated as global.
 *   2. CANONICAL_URL  canonicalize(observation.sourceUrl) (same behavior as
 *                     Discovery Layer 1).
 *   3. TITLE          (title || '').trim().toLowerCase() (same normalization
 *                     as Discovery Layer 1's exact-title comparison).
 *
 * Returns null when no rung is usable. No identity is ever fabricated.
 */
export function deriveIdentity(observation, { sourceScope = null } = {}) {
  if (!observation || typeof observation !== 'object') return null;

  const scope = nonEmptyString(observation.feedUrl) ?? nonEmptyString(sourceScope);
  const sourceId = nonEmptyString(observation.sourceId);
  if (sourceId && scope) {
    return buildIdentity(IDENTITY_KIND.SOURCE_ID, scope, sourceId);
  }

  const url = canonicalize(observation.sourceUrl);
  if (nonEmptyString(url)) {
    return buildIdentity(IDENTITY_KIND.CANONICAL_URL, null, url);
  }

  const title = typeof observation.title === 'string' ? observation.title.trim().toLowerCase() : '';
  if (title) {
    return buildIdentity(IDENTITY_KIND.TITLE, null, title);
  }

  return null;
}

// ---------------------------------------------------------------------------
// Policy (pure)
// ---------------------------------------------------------------------------

/**
 * Reads reconsideration.cooldownHours from the discovery policy. There is NO
 * default: a missing/invalid value fails closed (no invented duration).
 */
export function resolveCooldownMs(discoveryPolicy) {
  const hours = discoveryPolicy?.reconsideration?.cooldownHours;
  if (typeof hours !== 'number' || !Number.isFinite(hours) || hours < 0) {
    throw new DiscoveryMemoryConfigError(
      'discovery policy is missing a valid reconsideration.cooldownHours ' +
        '(config/discovery_policy.json); refusing to run Discovery without an explicit cooldown'
    );
  }
  return hours * 3_600_000;
}

/**
 * Decides whether an observation may enter Discovery, given its ledger row
 * (or undefined when the identity is unknown). Pure function.
 *
 * Only a SCORED_NOT_SELECTED row inside its cooldown suppresses. The
 * boundary is inclusive of expiry: at exactly cooldown elapsed the
 * observation is admitted.
 */
export function decideReconsideration(row, { nowMs, cooldownMs }) {
  if (!row) return { admit: true, reason: 'NEW_IDENTITY' };

  if (row.evaluation_outcome !== OUTCOME.SCORED_NOT_SELECTED) {
    return { admit: true, reason: `NOT_SUPPRESSING_OUTCOME:${row.evaluation_outcome}` };
  }

  const evaluatedMs = Date.parse(row.last_evaluated_at);
  if (!Number.isFinite(evaluatedMs)) {
    // Cannot prove the cooldown is running: never hide an observation on
    // unreadable data (cost of being wrong is one re-evaluation).
    return { admit: true, reason: 'UNPARSEABLE_EVALUATION_TIME' };
  }

  if (nowMs - evaluatedMs < cooldownMs) {
    return { admit: false, reason: 'COOLDOWN_ACTIVE' };
  }
  return { admit: true, reason: 'COOLDOWN_EXPIRED' };
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

const READ_CHUNK = 400;

function readRows(storage, keys) {
  const rows = new Map();
  for (let i = 0; i < keys.length; i += READ_CHUNK) {
    const chunk = keys.slice(i, i + READ_CHUNK);
    const placeholders = chunk.map(() => '?').join(', ');
    const found = storage.all(
      `SELECT * FROM discovery_observations WHERE identity_key IN (${placeholders})`,
      chunk
    );
    for (const row of found) rows.set(row.identity_key, row);
  }
  return rows;
}

function toDate(clockValue) {
  const d = clockValue instanceof Date ? clockValue : new Date(clockValue);
  if (Number.isNaN(d.getTime())) {
    throw new DiscoveryMemoryConfigError('discovery memory clock returned an invalid time');
  }
  return d;
}

/**
 * Steps 2-4 of the lifecycle. Call after source normalization and BEFORE
 * runDiscoveryPipeline.
 *
 *  - derives identities; observations with no identity are admitted
 *    unrecorded (never suppressed, not claimed as remembered)
 *  - reads the ledger (FAIL CLOSED on any read error)
 *  - applies the cooldown policy per identity
 *  - in ONE transaction (FAIL CLOSED on any write error):
 *      suppressed identity -> last_seen_at / times_seen bumped only
 *      admitted identity   -> upserted with outcome NOT_EVALUATED
 *                             (a SELECTED row keeps SELECTED)
 *
 * times_seen counts distinct invocations that observed the identity:
 * duplicates of one identity inside a single batch count once.
 *
 * @returns {{ admitted: object[], plan: object, summary: object }}
 *   `admitted` preserves the input order; pass it as Discovery's observations.
 */
export function prepareDiscoveryMemory({ storage, observations, sourceScope = null, discoveryPolicy, now = () => new Date() }) {
  const cooldownMs = resolveCooldownMs(discoveryPolicy);
  const runAt = toDate(now());
  const runAtIso = runAt.toISOString();

  const groups = new Map(); // identity key -> { identity, observations[] }
  let unidentified = 0;
  for (const observation of observations) {
    const identity = deriveIdentity(observation, { sourceScope });
    if (!identity) {
      unidentified++;
      continue;
    }
    let group = groups.get(identity.key);
    if (!group) {
      group = { identity, observations: [] };
      groups.set(identity.key, group);
    }
    group.observations.push(observation);
  }

  let rows;
  try {
    rows = readRows(storage, [...groups.keys()]);
  } catch (cause) {
    throw new DiscoveryMemoryReadError(
      `discovery memory could not be read (failing closed; Discovery not run): ${cause.message}`,
      { cause }
    );
  }

  for (const group of groups.values()) {
    group.decision = decideReconsideration(rows.get(group.identity.key), { nowMs: runAt.getTime(), cooldownMs });
  }

  try {
    storage.transaction(() => {
      for (const group of groups.values()) {
        if (group.decision.admit) {
          storage.run(
            `INSERT INTO discovery_observations
               (id, identity_key, identity_kind, identity_scope, identity_value,
                first_seen_at, last_seen_at, times_seen, last_evaluated_at,
                evaluation_outcome, opportunity_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, 1, NULL, 'NOT_EVALUATED', NULL)
             ON CONFLICT(identity_key) DO UPDATE SET
               last_seen_at = excluded.last_seen_at,
               times_seen = discovery_observations.times_seen + 1,
               evaluation_outcome = CASE
                 WHEN discovery_observations.evaluation_outcome = 'SELECTED' THEN 'SELECTED'
                 ELSE 'NOT_EVALUATED' END`,
            [
              crypto.randomUUID(), group.identity.key, group.identity.kind, group.identity.scope,
              group.identity.value, runAtIso, runAtIso
            ]
          );
        } else {
          storage.run(
            `UPDATE discovery_observations
                SET last_seen_at = ?, times_seen = times_seen + 1
              WHERE identity_key = ?`,
            [runAtIso, group.identity.key]
          );
        }
      }
    });
  } catch (cause) {
    throw new DiscoveryMemoryWriteError(
      `discovery memory could not be written before Discovery (failing closed; Discovery not run): ${cause.message}`,
      { cause }
    );
  }

  const suppressedObservations = new Set();
  let suppressedIdentities = 0;
  let admittedIdentities = 0;
  for (const group of groups.values()) {
    if (group.decision.admit) {
      admittedIdentities++;
    } else {
      suppressedIdentities++;
      for (const observation of group.observations) suppressedObservations.add(observation);
    }
  }

  const admitted = observations.filter((observation) => !suppressedObservations.has(observation));

  return {
    admitted,
    plan: { groups: [...groups.values()], cooldownMs, runAtIso },
    summary: {
      cooldownHours: cooldownMs / 3_600_000,
      observed: observations.length,
      unidentified,
      identities: groups.size,
      suppressedIdentities,
      suppressedObservations: suppressedObservations.size,
      admittedIdentities,
      admittedObservations: admitted.length
    }
  };
}

/**
 * Step 6 of the lifecycle: call ONLY after runDiscoveryPipeline returned
 * successfully. If Discovery threw, do not call this: the rows keep
 * NOT_EVALUATED (non-suppressing) and no outcome is recorded.
 *
 * Classification uses only what Discovery's return value reliably exposes
 * (observation object identity):
 *   in `selected`                       -> SELECTED
 *   in `scoredCandidates`, not selected -> SCORED_NOT_SELECTED
 *   anywhere else                       -> NOT_SCORED_UNRESOLVED
 * Discovery does not return why an unscored observation was rejected
 * (dedup / eligibility / proposition), so that is recorded as unresolved
 * and never inferred.
 *
 * A recorded SELECTED outcome is sticky: it is never overwritten by a later
 * pass. All writes happen in one transaction (FAIL CLOSED).
 */
export function recordDiscoveryOutcomes({ storage, plan, discoveryResult, now = () => new Date() }) {
  if (!Array.isArray(discoveryResult?.selected) || !Array.isArray(discoveryResult?.scoredCandidates)) {
    throw new DiscoveryMemoryWriteError(
      'discovery result does not expose selected/scoredCandidates; outcomes cannot be classified ' +
        '(observations remain NOT_EVALUATED)'
    );
  }

  const selectedByObservation = new Map(discoveryResult.selected.map((c) => [c.observation, c.id]));
  const scoredByObservation = new Map(discoveryResult.scoredCandidates.map((c) => [c.observation, c.id]));
  const evaluatedAtIso = toDate(now()).toISOString();

  const recorded = {
    [OUTCOME.SELECTED]: 0,
    [OUTCOME.SCORED_NOT_SELECTED]: 0,
    [OUTCOME.NOT_SCORED_UNRESOLVED]: 0
  };

  try {
    storage.transaction(() => {
      for (const group of plan.groups) {
        if (!group.decision.admit) continue;

        let outcome = OUTCOME.NOT_SCORED_UNRESOLVED;
        let opportunityId = null;
        for (const observation of group.observations) {
          if (selectedByObservation.has(observation)) {
            outcome = OUTCOME.SELECTED;
            opportunityId = selectedByObservation.get(observation);
            break;
          }
          if (outcome === OUTCOME.NOT_SCORED_UNRESOLVED && scoredByObservation.has(observation)) {
            outcome = OUTCOME.SCORED_NOT_SELECTED;
            opportunityId = scoredByObservation.get(observation);
          }
        }

        const result = storage.run(
          `UPDATE discovery_observations
              SET evaluation_outcome = ?, last_evaluated_at = ?, opportunity_id = ?
            WHERE identity_key = ? AND evaluation_outcome != 'SELECTED'`,
          [outcome, evaluatedAtIso, opportunityId, group.identity.key]
        );

        if (result.changes === 0) {
          const row = storage.get(
            'SELECT evaluation_outcome FROM discovery_observations WHERE identity_key = ?',
            [group.identity.key]
          );
          if (!row || row.evaluation_outcome !== OUTCOME.SELECTED) {
            throw new Error(`ledger row for identity ${group.identity.key} not found while recording outcome`);
          }
          // Sticky SELECTED: recorded outcome intentionally retained.
          continue;
        }
        recorded[outcome]++;
      }
    });
  } catch (cause) {
    throw new DiscoveryMemoryWriteError(
      `discovery memory outcomes could not be written (observations remain NOT_EVALUATED): ${cause.message}`,
      { cause }
    );
  }

  return { recorded, evaluatedAt: evaluatedAtIso };
}