# ADR-0012: Publication Specification Provenance

## 1. Status

**RECORDED — SPECIFICATION MISSING — RECOVERY DEFERRED — DOCUMENTATION ONLY**

## 2. Purpose

This document records the Owner's decision (E3) on how to treat the absence
of a standalone Publication v1 specification document, given that a
Publication implementation, its tests, and related governance/ADR material
already exist and are in active use.

This document does not change Publication behavior in any way.

## 3. Current state of Publication evidence

- **Implementation exists:** `src/publication/pipeline.js`
  (`runPublication`), `src/publication/PublicationProvider.js`,
  `src/publication/PublicationRequest.js`, `src/publication/eligibility.js`,
  `src/publication/constants.js`, `src/publication/providerRegistry.js`, and
  the `src/publication/youtube/` provider directory.
- **Tests exist:** `tests/integration/publication-pipeline-e2e.test.js`,
  `tests/unit/publication-pipeline.test.js`,
  `tests/unit/publication-eligibility.test.js`.
- **Governance/ADR material exists:** ADR-0008 (D-C2 ratification, which
  governs the external side-effect authorization boundary that Publication's
  `runPublication()` must pass through) and ADR-0009 (D-C2 implementation
  provenance, including the mode-propagation correction specific to
  Publication authorization).
- **A standalone Publication v1 specification document does not exist.**
  Unlike Brief, Fact-Check, and Script — each of which has a dedicated
  specification under `docs/SPECIFICATIONS/`
  (`brief-specification.md`, `fact-check-specification.md`,
  `script-specification.md`) — no equivalent
  `publication-specification.md` or similarly named document is present in
  this repository.

## 4. Owner decision — E3

**Owner decision: E3 — preserve implementation provenance; defer formal
Publication v1 specification recovery/supersession.**

Recorded:

- The existing implementation, tests, and governance/ADR material listed in
  §3 remain in force exactly as they are. Nothing about them changes as a
  result of this decision.
- They are retained as **historical evidence only** of what Publication does
  and how it was authorized to be built — not as a substitute for, or
  equivalent to, a standalone specification document.
- **Existing implementation, tests, and ADRs must not be presented as though
  they are the missing original specification.** A test asserting a
  behavior, or an ADR ratifying an authorization boundary, is not the same
  artifact as a specification that would have described Publication's
  intended design, scope, and constraints in the way
  `brief-specification.md`, `fact-check-specification.md`, and
  `script-specification.md` do for their respective stages.
- Formal recovery or supersession of a Publication v1 specification —
  whether that means reconstructing what such a document would have said,
  or authoring a new one from scratch — is **deferred, with no timeline
  set**. A future session may take this up only under its own separate,
  explicit authorization.
- **No Publication behavior is changed as part of this decision.** This
  includes, without limitation: `runPublication()`, Publication concurrency
  or claim-reclaim logic, provider registry behavior, eligibility rules, and
  the D-C2 authorization boundary Publication depends on.

**Implementation authorization: None.**

## 5. What this document does not do

- It does not reconstruct a Publication v1 specification.
- It does not change `src/publication/pipeline.js` or any other Publication
  source file.
- It does not change Publication concurrency or reclaim behavior.
- It does not change any Publication test.
- It does not alter ADR-0008 or ADR-0009.
- It does not change any configuration, migration, or dependency.

## 6. Final status

```text
RECORDED — SPECIFICATION MISSING — RECOVERY DEFERRED — DOCUMENTATION ONLY
```
