# ADR-0010: Autonomous Operation Scope and Discovery Deferral

## 1. Status

**RECORDED — OWNER DECISION — DOCUMENTATION ONLY, NO IMPLEMENTATION CHANGE**

## 2. Purpose

This document records two related Owner decisions carried forward from
`docs/CHECKPOINTS/autonomous-operation-checkpoint.md`:

- **B** — the scope boundary of the Autonomous Operation runner relative to
  Discovery.
- **C** — deferral of reconciling a missing "Discovery v0.6" specification
  document.

This document does not change `src/autonomous/runner.js`,
`src/autonomous/workSelection.js`, or anything under `src/discovery/`. It
records the Owner's decision about scope; it does not implement, extend, or
narrow that scope.

## 3. Decision B — Autonomous Operation scope boundary

**Owner decision: B1 — Discovery stays outside the Autonomous Operation
runner.**

The boundary is:

```text
Discovery → HANDED_TO_RESEARCH → Autonomous Operation begins at Research
```

Recorded:

- Discovery (`src/discovery/*`: `pipeline.js`, `scoring.js`, `dedup.js`,
  `diversity.js`, `eligibility.js`, `proposition.js`, `riskGate.js`,
  `rssParser.js`, `similarity.js`, `weightReview.js`, `constants.js`) is
  intentionally outside the Autonomous Operation runner. This is a deliberate
  scope boundary, not an oversight or an omission to be corrected.
- The Autonomous Operation runner (`src/autonomous/runner.js`) begins at the
  `HANDED_TO_RESEARCH` boundary and proceeds through the following stage
  order, unchanged by this decision and not authorized to change without a
  separate governance decision:

  1. Research
  2. Brief
  3. Script
  4. Fact Check
  5. Originality Check
  6. Quality Gate
  7. Production
  8. Media Production
  9. Publication

- `src/autonomous/workSelection.js` governs work selection on the Autonomous-
  Operation side of the boundary. This decision does not authorize any change
  to `workSelection.js` that would move, blur, or eliminate the
  `HANDED_TO_RESEARCH` boundary.
- Discovery is not to be added to the Autonomous Operation runner's stage
  list as a consequence of this decision or any decision in this document.
- Nothing in this record authorizes any change to `src/discovery/*`.

**Implementation authorization: None.** This is a scope-boundary record only.

## 4. Decision C — Discovery specification deferral

**Owner decision: C3 — defer reconciliation of the missing "Discovery v0.6"
specification.**

Recorded:

- A specification document referred to as Discovery "v0.6" is not present in
  this repository. Its absence has not been independently investigated or
  resolved by this decision.
- This decision does **not** reconstruct a replacement for the missing v0.6
  specification.
- This decision does **not** write a new specification to stand in for it.
- The existing Discovery implementation (`src/discovery/*`) and its tests
  remain the only current evidence of Discovery's actual behavior; they are
  not, by virtue of this record, elevated to the status of a specification
  document.
- Reconciliation of the missing specification — whether that means locating
  it, reconstructing it, or formally superseding it with a new one — is
  deferred with no timeline set. A future session may take up this
  reconciliation only under its own separate, explicit authorization.

**Implementation authorization: None.**

## 5. What this document does not do

- It does not modify `src/autonomous/runner.js`.
- It does not modify `src/autonomous/workSelection.js`.
- It does not modify anything under `src/discovery/`.
- It does not add Discovery to the Autonomous Operation runner.
- It does not reconstruct, draft, or imply the contents of the missing
  Discovery "v0.6" specification.
- It does not change the `HANDED_TO_RESEARCH` boundary.

## 6. Final status

```text
RECORDED — DOCUMENTATION ONLY — NO IMPLEMENTATION CHANGE
```
