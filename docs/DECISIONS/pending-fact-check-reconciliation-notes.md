# Fact-Check Spec Reconciliation — Notes (carried from prior session)

**Status: NOT independently re-verified this session — treat as a starting
point, not ground truth. Re-derive before relying on it, per the standing
lesson in SESSION_HANDOFF.md.**

This session did not redo the line-by-line spec audit. What follows is
what the prior session's handoff reported. The spec file placed at
`docs/SPECIFICATIONS/fact-check-specification.md` in this package is the
**original uploaded document, unmodified** — the §7a/§14a amendments
described below were NOT actually re-applied to the file this session;
only the source code, tests, and migration were placed and verified.

## Reported open items (Owner decisions)
- **P1 (major, OPEN)**: if a Script passes Fact-Check (state -> `FACT_CHECK`)
  and a later forced rerun on the same `script_id` produces `REJECT`,
  `content_versions.state` stays at `FACT_CHECK`. Owner chose "must not
  look like it cleared Fact-Check" (Option B) but did NOT pick a
  destination state. Only `REJECTED` / `BLOCKED` / `NEEDS_REVIEW` /
  `FAILED` are mechanically reachable without touching
  `src/state/ContentStateMachine.js` (protected per spec §16), and none
  has any precedent elsewhere in this repo's `transition()` call sites.
  **Nothing should be implemented for P1 until a destination is chosen.**
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
- **P3-A (minor, open)**: `CLAIM_LINKS_EMPTY` is a sixth structural-failure
  trigger not listed among the spec's five in §11.
- **P3-B (minor, open)**: `decision_log.subject_type` falls back to
  `'content_brief'` when no current Script exists; the spec's field table
  doesn't anticipate this case.

## What to do next session
1. Decide P1's destination state (or confirm lifting the §16 protection
   instead), then implement the transition + a regression test.
2. P2 is implemented (see above) — no further action needed.
3. Resolve or explicitly defer P3-A / P3-B.
