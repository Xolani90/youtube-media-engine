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
 * Returns whether `action` currently appears in the Owner-controlled
 * authorization file at config.authorizedExternalActionsPath. Reads
 * fresh every call — never cached. Takes no path/source parameter of
 * any kind; the authorization source is not caller-selectable.
 */
export function isActionAuthorized(action) {
  return readAuthorizedActions().includes(action);
}

/**
 * Throws SideEffectDeniedError unless `action` is currently permitted
 * under all three D-C2 conditions. Call this immediately before
 * performing the external action itself (and again on every retry —
 * never reuse a prior result). If it does not throw, the action is
 * authorized at this instant; it does not return a token or flag
 * meant to be held onto or passed elsewhere.
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

  if (!isActionAuthorized(action)) {
    throw new SideEffectDeniedError(
      `External side effect "${action}" denied: not present in Owner-controlled ${config.authorizedExternalActionsPath}.`
    );
  }
}

export default assertExternalActionAllowed;
