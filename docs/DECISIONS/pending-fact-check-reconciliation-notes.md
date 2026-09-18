# Fact-Check Spec Reconciliation — Notes (carried from prior session)

**Status: RECONCILED against repository evidence as of the read-only
three-way audit (governance record ↔ specification ↔ implementation ↔
tests ↔ git history) completed this session.**

The statements previously here — that the specification file was "the
original uploaded document, unmodified" and that the §7a/§14a amendments
"were NOT actually re-applied to the file" — were accurate for the session
in which they were originally written, but are now stale. Git history shows
two later documentation commits actually applied these amendments to the
specification:

- `32e5c8f docs(fact-check): reconcile P1 specification` — updated both
  the specification (§14a) and this reconciliation note for P1.
- `e34dfd3 docs(fact-check): reconcile P3-A and P3-B specification` —
  updated the specification (§11) and the integration test file, but did
  **not** update this note — which is why P3-A and P3-B were still
  described as "open" below until this reconciliation.

Current repository evidence (this session):
- `docs/SPECIFICATIONS/fact-check-specification.md` **does** contain §7a
  (heading-optional, P2) and §14a (FACT_CHECK → REJECTED, P1,
  Owner-ratified per ADR-0002 D-A) in full.
- §11 of the specification **already lists** `CLAIM_LINKS_EMPTY` as a
  structural-failure trigger and **already documents** the
  `subject_type='content_brief'` fallback as the "P3-B documentation
  exception."
- `src/fact-check/validate.js` and `decision.js` implement
  `CLAIM_LINKS_INVALID_HEADING_TYPE` and `CLAIM_LINKS_EMPTY`;
  `CLAIM_LINKS_MISSING_HEADING` does not exist anywhere in `src/` or
  `tests/` (only referenced historically, as removed, in the spec).
- `src/fact-check/pipeline.js` implements both the P1
  `FACT_CHECK → REJECTED` transition and the P3-B `content_brief`
  fallback.
- Test evidence, actually executed this session:
  `node --test tests/unit/fact-check-validate.test.js
  tests/unit/fact-check-decision.test.js` → **36 pass, 0 fail** (pure
  logic, no DB dependency).
- Test evidence **not established** this session:
  `node --test tests/integration/fact-check-pipeline-e2e.test.js`,
  including AC17/AC18/AC19 (P1's integration coverage), could not execute
  in this environment — `better_sqlite3.node: invalid ELF header`,
  `ERR_DLOPEN_FAILED`. This is an environmental/native-binding limitation
  of this container, not an assertion failure, and it blocks every subtest
  in that file, not only the P1-related ones. AC17/18/19 are therefore
  **unverified in this environment**, not passing and not failing.

This reconciliation does not claim every Fact-Check concern is closed, and
does not claim the SQLite environment issue is resolved — it only brings
this note into alignment with the specification and implementation as they
already exist.

## Reported items (Owner decisions)
- **P1 (major, RESOLVED and OWNER-RATIFIED — see ADR-0002, decision D-A)**:
  if a Script passes Fact-Check (state -> `FACT_CHECK`) and a later forced
  rerun on the same `script_id` produces `REJECT`, `content_versions.state`
  transitions to `REJECTED`. (Note: an earlier draft of this note
  incorrectly said the state "stays at `FACT_CHECK`" — that was wrong; the
  Owner-ratified and implemented behavior is the `FACT_CHECK → REJECTED`
  transition, per `src/fact-check/pipeline.js` and tests AC17/AC18/AC19.)
  The Owner has accepted this as implemented; P1 is closed with no
  `ContentStateMachine` change. See
  `docs/DECISIONS/0002-governance-cost-and-prompt-trust-boundary.md` for the
  authoritative record of this decision.
- **P2 (moderate, RESOLVED and IMPLEMENTED)**: `parseClaimLinks()` no
  longer treats an absent or empty heading as a structural failure.
  `CLAIM_LINKS_MISSING_HEADING` has been removed; a present-but-non-string
  heading now returns `CLAIM_LINKS_INVALID_HEADING_TYPE` instead (see spec
  §7a/§11). `decision.js`'s finding builder omits the `section_heading` key
  when the source heading is absent or an empty string, and preserves it
  otherwise. Verified: focused Fact-Check suite 61/61, full repository
  suite 300/300, real runs. `src/fact-check/validate.js`,
  `src/fact-check/decision.js`, `tests/unit/fact-check-validate.test.js`,
  and `tests/unit/fact-check-decision.test.js` were the only files changed
  for this implementation.
- **P3-A (minor, RESOLVED — specification reconciled)**: `CLAIM_LINKS_EMPTY`
  is now explicitly listed as a structural-failure trigger in spec §11
  (`claim_links` resolves to zero total claims across all sections). This
  reconciliation was made in commit
  `e34dfd3 docs(fact-check): reconcile P3-A and P3-B specification`, which
  updated the specification and integration test but did not update this
  note at the time — that gap is what this reconciliation closes.
  Implementation: `src/fact-check/validate.js`. Tests:
  `tests/unit/fact-check-validate.test.js` (part of the 36/36 pass result
  above).
- **P3-B (minor, RESOLVED — specification reconciled)**: spec §11 now
  explicitly documents the `decision_log.subject_type='content_brief'`
  fallback for `CONTENT_VERSION_NOT_FOUND` / `NO_CURRENT_SCRIPT` /
  `CURRENT_SCRIPT_NOT_FOUND` as the "P3-B documentation exception,"
  reconciled in the same `e34dfd3` commit. Implementation:
  `src/fact-check/pipeline.js`.

## What to do next session
1. P1 is resolved and implemented — no further action needed on the
   decision itself. AC17/18/19 integration coverage remains unverified in
   this container due to the SQLite native-binding issue; re-run once that
   environment limitation is addressed, rather than assuming pass or fail.
2. P2 is implemented (see above) — no further action needed.
3. P3-A and P3-B are resolved in the specification and implementation —
   no further action needed beyond the note reconciliation performed here.
