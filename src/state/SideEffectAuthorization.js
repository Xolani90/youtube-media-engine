import fs from 'node:fs';
import { config } from '../config/index.js';

/**
 * D-C2 (ADR-0002 §"D-C2"; architecture ratified in ADR-0008; this
 * implementation authorized separately from ratification, per ADR-0008
 * §6-7).
 *
 * Guard at the boundary between internal computation and an external,
 * state-changing action (publishing/uploading, scheduling publication,
 * changing external visibility/state, submitting external metadata,
 * etc. — ADR-0008 §3.8). An external side effect may proceed only when
 * ALL of the following hold:
 *
 *   1. the run is LIVE (ADR-0008 §3.1.1);
 *   2. AUTONOMOUS_ENABLED is enabled (ADR-0008 §3.1.2);
 *   3. the specific action is explicitly present in the Owner-controlled
 *      authorization file below (ADR-0008 §3.1.3, §3.2).
 *
 * SIMULATION denies unconditionally (§3.3) — no authorization state,
 * however explicit, can override it. This mirrors the existing
 * two-factor precedent for paid LLM providers
 * (config.allowPaidProviders + explicit presence in
 * config.llmProviderPriority — see src/providers/llm/router.js),
 * extended here to a third, independent condition.
 *
 * Authorization representation (deferred to implementation by
 * ADR-0008 §3.2, resolved here): a flat JSON array of action-id
 * strings at config.authorizedExternalActionsPath
 * (config/authorized_external_actions.json), analogous to this repo's
 * other config/*.json policy files — but, unlike those, read fresh
 * from disk on every single check rather than cached at startup. That
 * deviation is required by ADR-0008 §3.4 (authorization must be
 * evaluated at the point of the external action, not assumed to
 * persist from an earlier check) and §3.5 (every retry needs a fresh
 * check — a prior authorization is never reused). Revoking an action
 * is just editing the file; no persistence infrastructure is
 * introduced.
 *
 * The caller identifies the action (a plain string) but supplies no
 * "authorized" flag of its own, and none is accepted — the guard's
 * signature has no such parameter, so a caller passing
 * `{ action, authorized: true }` has no effect: authorization comes
 * only from the Owner-controlled file (ADR-0008 §3.2, "the calling
 * code may identify or name the action ... it must never be able to
 * declare that action authorized itself").
 *
 * SECURITY FIX (post-implementation verification defect): the public
 * functions below previously also accepted a caller-suppliable
 * `filePath` override, which let a caller substitute an authorization
 * source of its own choosing — functionally equivalent to
 * self-authorization, since it displaced the Owner-controlled file
 * entirely. Neither function accepts any path-related parameter now;
 * both always read `config.authorizedExternalActionsPath` and nothing
 * else. There is no parameter, option, or code path in this module by
 * which a caller can name a different authorization source.
 */

export class SideEffectDeniedError extends Error {}

function readAuthorizedActions() {
  const filePath = config.authorizedExternalActionsPath;
  if (!fs.existsSync(filePath)) return [];
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    throw new Error(
      `${filePath} is not valid JSON (D-C2 authorization file must be a JSON array of action-id strings): ${err.message}`
    );
  }
  if (!Array.isArray(parsed) || !parsed.every((a) => typeof a === 'string')) {
    throw new Error(`${filePath} must contain a JSON array of action-id strings.`);
  }
  return parsed;
}

/**
 * ADR-0030 (Model B) — standing single-owner YouTube PUBLIC authorization.
 *
 * DORMANT MECHANISM. The Owner-controlled authorization file remains `[]`
 * unless and until the Owner later adds this literal after Gate 2 exists
 * (ADR-0030 §6). Nothing in this module ever writes to that file.
 *
 * `standing:publish:youtube:public` is recognised as ONE explicit literal,
 * compared by exact string equality — no wildcard, regex, or pattern
 * syntax exists. It means exactly: "Owner has authorized publication/upload
 * to the configured YouTube channel with requested visibility PUBLIC." It
 * authorizes no other provider, no other external action, and no other
 * visibility.
 *
 * PRECEDENCE (deterministic; ADR-0030 §10):
 *   1. An exact per-item entry (e.g. `publish:youtube:<contentVersionId>`)
 *      that matches the action wins. It keeps its baseline meaning: it
 *      authorizes that one action and supplies NO requested visibility, so
 *      the provider adapter's default (private) applies exactly as before.
 *   2. Otherwise, if the action is a YouTube publish action
 *      (`publish:youtube:<non-empty id>`) and the standing literal is
 *      present, the standing grant applies and supplies requested
 *      visibility `public`.
 *   3. Otherwise the action is denied.
 * When both match, (1) wins — the grant that actually authorized the
 * action is reported back so the pipeline can audit-log it.
 *
 * The standing literal is reserved: it can never be matched as an ordinary
 * exact action id, so a caller naming the literal as its `action` gains
 * nothing. The grant is selected only from the Owner-controlled file plus
 * the action string; content data, provider data, caller input and runner
 * input have no way to choose it.
 */
export const STANDING_YOUTUBE_PUBLIC_ENTRY = 'standing:publish:youtube:public';

export const AUTHORIZATION_GRANT = Object.freeze({
  PER_ITEM: 'PER_ITEM',
  STANDING_YOUTUBE_PUBLIC: 'STANDING_YOUTUBE_PUBLIC'
});

const YOUTUBE_PUBLISH_ACTION_PREFIX = 'publish:youtube:';

function isYouTubePublishAction(action) {
  return action.startsWith(YOUTUBE_PUBLISH_ACTION_PREFIX) && action.length > YOUTUBE_PUBLISH_ACTION_PREFIX.length;
}

// Reads the Owner-controlled file fresh and resolves which grant (if any)
// authorizes `action`. Returns null when none does. Pure w.r.t. everything
// except that one file read.
function resolveGrant(action) {
  const entries = readAuthorizedActions();
  if (action !== STANDING_YOUTUBE_PUBLIC_ENTRY && entries.includes(action)) {
    return Object.freeze({ grant: AUTHORIZATION_GRANT.PER_ITEM, requestedVisibility: null });
  }
  if (isYouTubePublishAction(action) && entries.includes(STANDING_YOUTUBE_PUBLIC_ENTRY)) {
    return Object.freeze({ grant: AUTHORIZATION_GRANT.STANDING_YOUTUBE_PUBLIC, requestedVisibility: 'public' });
  }
  return null;
}

/**
 * Returns whether `action` is currently authorized by any grant (exact
 * per-item, or the standing YouTube PUBLIC entry for YouTube publish
 * actions) in the Owner-controlled authorization file at
 * config.authorizedExternalActionsPath. Reads fresh every call — never
 * cached. Takes no path/source parameter of any kind; the authorization
 * source is not caller-selectable.
 */
export function isActionAuthorized(action) {
  return resolveGrant(action) !== null;
}

/**
 * Throws SideEffectDeniedError unless `action` is currently permitted
 * under all three D-C2 conditions. On success returns a frozen
 * `{ grant, requestedVisibility }` descriptor (see resolveGrant and the
 * ADR-0030 precedence notes above). Call this immediately before
 * performing the external action itself (and again on every retry —
 * never reuse a prior result). If it does not throw, the action is
 * authorized at this instant. The returned descriptor is audit and
 * visibility evidence for this one action only -- not a token or flag
 * meant to be held onto, cached, or passed elsewhere.
 *
 * mode/autonomousEnabled default to the live config so ordinary
 * callers need only pass `action`; tests may override either to
 * exercise specific cases without mutating global config. There is no
 * equivalent override for the authorization source itself — it is
 * always config.authorizedExternalActionsPath (see isActionAuthorized
 * above). Tests that need a temporary authorization file do so by
 * pointing config.authorizedExternalActionsPath itself at a fixture
 * for the duration of the test and restoring it afterward — the same
 * config object every caller reads, not a parallel path only tests
 * can reach.
 */
export function assertExternalActionAllowed({
  action,
  mode = config.runMode,
  autonomousEnabled = config.autonomousEnabled
} = {}) {
  if (typeof action !== 'string' || action.length === 0) {
    throw new Error('assertExternalActionAllowed requires a non-empty string `action`.');
  }

  // §3.3: SIMULATION is absolute and checked first — no other condition,
  // including a valid authorization, can override it.
  if (mode !== 'LIVE') {
    throw new SideEffectDeniedError(
      `External side effect "${action}" denied: run mode is ${mode}, not LIVE.`
    );
  }

  if (!autonomousEnabled) {
    throw new SideEffectDeniedError(
      `External side effect "${action}" denied: AUTONOMOUS_ENABLED is false.`
    );
  }

  const grant = resolveGrant(action);
  if (!grant) {
    throw new SideEffectDeniedError(
      `External side effect "${action}" denied: not present in Owner-controlled ${config.authorizedExternalActionsPath}.`
    );
  }

  // ADR-0030: report WHICH grant authorized this action and the
  // authorization-derived requested visibility (null = no visibility
  // supplied; the provider default applies). This is evidence for audit
  // logging and visibility propagation only — it is not a token to hold
  // or reuse; every external action must call this again.
  return grant;
}

export default assertExternalActionAllowed;
