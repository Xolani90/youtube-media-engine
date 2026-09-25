// In-process, per-provider rate-limit cooldown memory.
//
// WHY THIS EXISTS: GroqProvider/GeminiProvider already retry a 429 once,
// honoring Retry-After/retryDelay (see M3-B). That retry is per-call --
// it has no memory of a provider having just been rate-limited a moment
// ago on a *different*, independent complete() call. When both configured
// free providers are simultaneously rate-limited, every independent call
// pays the same real provider-supplied sleep again, because nothing
// upstream remembers the provider is currently exhausted. This module is
// that memory: LLMRouter consults it (see router.js's
// _selectEligibleProviders) to skip a provider that is still cooling down,
// instead of selecting it and paying its retry sleep again.
//
// Scope: one autonomous run == one process invocation. Module-level
// singleton because LLM providers are instantiated fresh per router call
// (see candidates.js's REGISTRY factories), so this state cannot live on
// a provider instance -- same reasoning as runWorkloadDiagnostics.js's
// process-wide counters.
//
// DIAGNOSTICS-ADJACENT BUT NOT DIAGNOSTICS-ONLY: unlike
// runWorkloadDiagnostics.js, this module's state DOES influence a
// decision (LLMRouter's eligibility check) -- that is its entire purpose.
//
// This module never parses a provider's HTTP response itself. A provider
// (GroqProvider/GeminiProvider) computes its own effective retry delay
// from its own Retry-After/retryDelay parsing and passes the resulting
// duration in; this module only tracks the resulting cooldown window.

let cooldownUntilByProvider = new Map();

/** Tests only: clears all recorded cooldowns. */
export function resetProviderHealth() {
  cooldownUntilByProvider = new Map();
}

/**
 * Records that `providerId` is rate-limited for `cooldownMs` milliseconds
 * starting at `now` (defaults to Date.now(), injectable for deterministic
 * tests). A provider that reports a new, shorter cooldown while an existing
 * longer cooldown is still in effect never shortens it -- the later
 * `cooldownUntil` timestamp always wins (see the "important edge case" in
 * the Phase 1 authorization: repeated rate-limit events must not
 * accidentally shrink an existing cooldown).
 *
 * A non-finite or negative `cooldownMs` is a no-op -- this function is
 * only ever meant to be called with a duration a provider has already
 * established from an actual 429 response; it is not a general-purpose
 * scheduler and does not validate provider identity.
 */
export function recordProviderRateLimit(providerId, cooldownMs, now = Date.now()) {
  if (!Number.isFinite(cooldownMs) || cooldownMs < 0) return;
  const cooldownUntil = now + cooldownMs;
  const existing = cooldownUntilByProvider.get(providerId);
  if (existing === undefined || cooldownUntil > existing) {
    cooldownUntilByProvider.set(providerId, cooldownUntil);
  }
}

/** True while `providerId`'s most recently recorded cooldown has not yet elapsed. */
export function isProviderCoolingDown(providerId, now = Date.now()) {
  const until = cooldownUntilByProvider.get(providerId);
  return typeof until === 'number' && now < until;
}

/** Milliseconds remaining on `providerId`'s cooldown; 0 if none is recorded or it has expired. */
export function providerCooldownRemainingMs(providerId, now = Date.now()) {
  const until = cooldownUntilByProvider.get(providerId);
  if (typeof until !== 'number') return 0;
  return Math.max(0, until - now);
}