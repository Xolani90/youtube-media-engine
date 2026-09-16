# ADR-0009: D-C2 Implementation Authorization — Provenance Record

## 1. Purpose

This document records, retrospectively, the Owner's implementation authorization
for the D-C2 external side-effect authorization mechanism. It exists to close a
governance provenance gap: ADR-0008 ratified the D-C2 architecture but explicitly
did not authorize implementation, and the implementation was subsequently
authorized by the Owner outside the repository's Git history. This record makes
that authorization chain reconstructable from the repository itself, going
forward — following the same pattern ADR-0007 established for D-G1.

This document does not authorize anything new. D-C2 is already implemented and
shipped at the commits referenced in §4. Nothing here changes ADR-0008, the
D-C2 implementation, its tests, or `src/state/SideEffectAuthorization.js`.

**This document is documentation/provenance only. It does not modify the D-C2
implementation, reopen D-C2, or alter any test.**

## 2. Ratification reference

`docs/DECISIONS/0008-d-c2-side-effect-authorization-ratification.md` (ADR-0008)
ratified the D-C2 architecture: the three-condition authorization model (LIVE +
`AUTONOMOUS_ENABLED` + explicit per-action Owner-controlled authorization), the
Owner-controlled-source invariant, the absolute SIMULATION deny, per-check
authorization timing, and fresh-per-retry semantics.

ADR-0008 is ratification only. It states this explicitly:

- §1: `RATIFIED — OWNER DECISION RECORDED — IMPLEMENTATION NOT AUTHORIZED`.
- §6, Implementation Authorization Boundary: this ADR does not authorize
  source-code changes, database migrations, `ContentStateMachine` changes,
  tests, or any other implementation artifact for D-C2, and "[a]ny
  implementation of the architecture recorded in §3 must receive a separate,
  explicit implementation authorization after this ratification. Ratification
  is not that authorization."

**ADR-0008 did not authorize implementation, and this document does not claim
otherwise.** ADR-0008 is unmodified by this record and remains the historical
statement that ratifying an architecture and authorizing its implementation are
distinct acts.

## 3. Owner authorization

After ADR-0008's ratification, the Owner (Xolani Tshabalala) subsequently gave
explicit authorization, outside of Git, to implement D-C2 within the scope
ratified in ADR-0008 §3, and later to correct a self-authorization defect found
during post-implementation verification, and later still to correct a mode-
propagation defect found during further verification. These authorizations were
given out-of-band relative to the repository — no commit, tag, or file existed
in the repository to record them at the time they were given. No specific
timestamp or approval mechanism for any of these authorizations is recorded
here, since none is independently established by repository evidence; this
document does not invent one.

## 4. Resulting implementation — three commits, three distinct authorizations

The D-C2 implementation was delivered across three separate commits, each
addressing a distinct authorized scope:

### 4.1 Original implementation — `5bd81ca`

`5bd81caa298c73fcf9b69f9b5606a759437b99e0` — "feat: implement D-C2 external
side-effect authorization"

Implements the ADR-0008 §3 guard: an external side effect is permitted only
when the run is `LIVE`, `AUTONOMOUS_ENABLED` is true, and the specific action is
explicitly present in the Owner-controlled
`config/authorized_external_actions.json` allowlist (empty by default).
`SIMULATION` denies unconditionally. Authorization is read fresh from disk on
every check, never cached. Delivered:
`src/state/SideEffectAuthorization.js`,
`config/authorized_external_actions.json`, the `authorizedExternalActionsPath`
config wire-up, and `tests/unit/side-effect-authorization.test.js` (Cases A–G).

### 4.2 Owner-controlled-source hardening — `48918ec`

`48918ecee2eb7fc390cfbcfd9f7d3d4cdfc1ae60` — "fix: pin D-C2 authorization to
owner-controlled source"

Corrects a defect found during post-implementation verification: the original
guard accepted a `filePath` option on `isActionAuthorized()` /
`assertExternalActionAllowed()`, which let a caller substitute a file it
controlled for the Owner-controlled allowlist — functionally equivalent to
self-authorization, and a violation of the ADR-0008 §3.2 invariant that
authorization must originate from Owner-controlled state independent of the
calling code. The fix removed the parameter entirely; both functions now
always read `config.authorizedExternalActionsPath` with no override of any
kind. All other ADR-0008 gates (mode/autonomous-enabled overrides,
fresh-read-per-check, exact action-id matching) were unchanged and re-verified.

### 4.3 Mode-propagation correction — `9463eb2`

`9463eb2606cf7525ae0a2705f8a3f865e2edb292` — "fix: enforce autonomous run mode
for publication authorization"

Corrects a defect found during further verification: an autonomous run's
persisted/started mode (recorded by `SystemRunRecorder`) was not being
propagated into the Publication stage, so `runPublication()`'s call to
`assertExternalActionAllowed()` could receive process-global `config.runMode`
instead of the actual run's mode. The fix propagates the real run mode into
Publication, so a `SIMULATION` run cannot reach the external Publication
provider even when process-global configuration is `LIVE` — restoring the
ADR-0008 §3.3 absolute-SIMULATION-deny guarantee at the call site that matters.
Verified by a real, unmocked regression test in
`tests/unit/autonomous-runner.test.js` (D-C2 invariant test).

## 5. Push authorization

Separately from the implementation authorizations in §3, the Owner authorized
pushing each of the three resulting commits to `origin/main`. As with the
implementation authorizations, these push authorizations were given outside of
Git, and no repository artifact recorded them at the time. This document does
not fabricate one; it records only that the authorizations were given and that
the pushes they authorized are the ones reflected in the current `origin/main`
history (`... → 5bd81ca → 48918ec → 9463eb2`).

## 6. Provenance status

This record is being added retrospectively. The implementation and push
authorizations described above were all given by the Owner outside the
repository's Git workflow, prior to this document's creation. Its purpose is
future auditability — so that the authorization chain (ADR-0008 ratification →
implementation authorization → implementation → post-implementation
verification → corrective authorization → correction → further verification →
second corrective authorization → correction → push authorization) can be
reconstructed from repository contents alone — not to retroactively alter,
backdate, or reinterpret repository history.

## 7. What this document does not do

- It does not modify `src/state/SideEffectAuthorization.js`, `runner.js`,
  `publication/pipeline.js`, or any other D-C2-related source file.
- It does not modify any D-C2-related test.
- It does not reopen D-C2 for further changes.
- It does not claim ADR-0008 authorized implementation. ADR-0008 explicitly did
  not.
- It does not alter ADR-0008 in any way.

## 8. Final status

```text
DOCUMENTED — PROVENANCE ONLY — NO IMPLEMENTATION CHANGE
```
