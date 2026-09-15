# ADR-0003: Corrective Checkpoint Closure — D-B1 / D-D1 / D-D2

## Status
Closed (Owner-ratified). Documentation-only governance record — no
implementation changes are contained in this commit.

## Context
ADR-0002 approved D-B1 (LLMRouter-level cost enforcement), D-D1 (prompt
trust boundary), and D-D2 (derived content remains DERIVED/UNTRUSTED).
An initial implementation landed those decisions; a subsequent
post-implementation verification audit found two concrete defects (D-B1
not wired into any real production execution path; a forgeable fixed
delimiter in the prompt trust boundary). A corrective implementation
fixed both, and a final verification audit confirmed the fixes. This
record closes that corrective cycle at commit `738c01a` (parent
`02e40ed`).

## Closed / Passed

### D-B1 — LLMRouter-level cost enforcement: PASS
Evidence:
- Production `src/index.js` constructs the `LLMRouter`.
- The existing `CostTracker` instance already constructed there is
  passed into that router (`costTracker: costs`).
- `router.complete()` performs `CostTracker` enforcement before provider
  invocation.
- A rejected, over-budget request prevents provider invocation — the
  provider is never called.
- No direct production `provider.complete()` bypass exists; every
  completion in `src/` goes through `router.complete()`.
- The current production provider path (`local-stub`) is free/non-paid.
- No authoritative provider/model pricing table currently exists
  anywhere in the repository.

The enforcement boundary is production-wired and operational, but the
current production configuration does not exercise a real paid-provider
monetary ceiling because no usable paid provider and authoritative
pricing input are currently active. This is a stated limitation of the
current M0 configuration, not a defect in the D-B1 implementation.

### D-D1 — Prompt trust boundary: PASS
Evidence:
- Source content is enclosed using the shared `fence()` mechanism in
  `src/providers/llm/promptTrust.js`.
- Each fence receives a fresh, cryptographically random 64-bit nonce
  (`crypto.randomBytes(8)`), generated at prompt-construction time.
- The nonce is generated independently of attacker-controlled body
  content — it does not exist until after the body is already fixed.
- The nonce appears in both the authoritative BEGIN and END markers.
- Adversarial source content containing forged, untagged markers cannot
  manufacture the active (tagged) delimiter — confirmed against the
  actual final constructed prompt, not merely the helper's output.

The security claim is practical/cryptographic infeasibility (roughly
1-in-2^64 per blind guess), not mathematical impossibility, and is a
guarantee about the constructed prompt text being unambiguous — not a
guarantee that a model will always attend to that text correctly.

### D-D2 — Derived content remains DERIVED/UNTRUSTED: PASS
Evidence:
- `derivedContentBlock()` uses the same hardened `fence()` mechanism as
  D-D1.
- The Research → Brief and Brief → Script paths inherit the nonce
  protection with no additional code changes required in
  `brief/generate.js` or `script/generate.js`.
- Adversarial derived content (a poisoned Research claim, poisoned Brief
  fields) cannot practically manufacture the active delimiter.
- Verified against the actual final constructed prompt in both the
  Brief and Script generation paths.

## Known Architectural Consideration — Pre-Call Accounting on Provider Failure

1. `CostTracker` accounting now occurs before provider invocation.
2. This ordering is necessary for the D-B1 pre-call enforcement boundary
   to actually prevent an over-budget call from reaching the provider.
3. If accounting succeeds (`CostTracker.record()` returns) but the
   provider subsequently fails, the accounting row remains recorded —
   there is no rollback.
4. This differs from the former `index.js` post-call accounting pattern,
   where a provider failure occurred before `costs.record()` was ever
   reached, leaving no row.
5. This behavior is not currently observable with the active
   `local-stub` provider, which does not fail.
6. No correction is being made in this checkpoint.
7. Any future reservation/reconciliation/refund semantics require an
   explicit Owner-approved governance decision and implementation scope
   of their own — this consideration does not fold into D-B2 or D-B3,
   and is not itself an approval of either.

This is a known consideration to carry forward, not an open blocker for
this checkpoint.

## Test Evidence
Full suite: 324/324 passing (verified on the Windows development
environment; the Linux sandbox used for intermediate audits in this
cycle cannot run the `better-sqlite3`-dependent portion of the suite due
to a known, unrelated native-binary/environment mismatch).

Corrective test groups added in this cycle:
- `tests/unit/llm-router-cost-wiring.test.js` — 6 tests
- `tests/unit/prompt-trust-delimiter-forgery.test.js` — 7 tests

## Still Deferred
Passing D-B1/D-D1/D-D2 does not imply approval or implementation of any
of the following. They remain deferred per ADR-0002 and are untouched by
this checkpoint:
- D-B2 — cumulative per-content budget
- D-B3 — monthly budget enforcement
- D-C2 — stronger Production/Publishing side-effect authorization
- D-E — Phase 2 requirement (no current implementation)
- D-F — Phase 2 requirement for paid providers and Publishing (no
  current implementation)

## Consequences
This corrective cycle is closed. No further implementation work is
authorized by this record. Any future work — including addressing the
pre-call accounting consideration above, or implementing any deferred
decision — requires a separate, explicit Owner-approved governance
decision and its own implementation scope.