# ADR-0014 — F3 Work-Selection Scope Retrospective Ratification

**Status:** Accepted — Retrospective Owner Ratification
**Decision Date:** 2026-09-16
**Decision Type:** Governance Reconciliation
**Related Authorization:** ADR-0013
**Related Implementation:** `9243f2e1e4f87d9fad6ad08827f061dd9801a7b7`

---

## 1. Decision

The Owner retrospectively ratifies the already-shipped addition of:

`src/autonomous/workSelection.js`

as part of the F3 Rights Verification implementation.

This is a subsequent governance decision concerning the historical F3 implementation. It does not rewrite or amend the original F3 authorization recorded in ADR-0013.

---

## 2. Original Authorization

ADR-0013 authorized implementation of F3 Rights Verification.

ADR-0013 §5 explicitly identified the authorized implementation files and the authorized insertion in `src/autonomous/runner.js`.

ADR-0013 §5 also stated:

> No other file, table, stage, or runner-order change is in scope.

`src/autonomous/workSelection.js` was not explicitly named in that authorization.

Accordingly, this record does not claim that ADR-0013 originally authorized `workSelection.js`.

---

## 3. Historical Implementation

The F3 implementation recorded at commit:

`9243f2e1e4f87d9fad6ad08827f061dd9801a7b7`

included a change to:

`src/autonomous/workSelection.js`

The change added a rights-verification work-selection pre-filter based on content versions in the `PRODUCED` state.

The implementation functions as an efficiency pre-filter within the existing work-selection pattern.

Detailed rights-verification eligibility remains governed by:

`src/rights-verification/eligibility.js`

The evidence reviewed did not establish that `workSelection.js` became a separate rights-policy authority.

---

## 4. Evidence Classification

The evidence audit classified the `workSelection.js` addition as:

**Classification C — technically necessary and architecturally consistent, but not explicitly or implicitly authorized by the original authorization text.**

No contemporaneous authorization record expressly authorizing the additional `workSelection.js` change was identified.

That historical finding remains unchanged.

---

## 5. Retrospective Ratification

The Owner now retrospectively ratifies the specific, already-shipped `src/autonomous/workSelection.js` addition as part of F3.

This ratification resolves the identified governance scope discrepancy.

It applies only to the change that was actually implemented and recorded in the F3 implementation history.

It is not a blanket authorization for future changes to work selection, rights verification, the autonomous runner, publication, production, or other pipeline components.

---

## 6. Historical Integrity

The permanent historical record is:

1. ADR-0013 authorized F3 implementation.
2. ADR-0013 explicitly identified its authorized scope.
3. `src/autonomous/workSelection.js` was not explicitly listed in ADR-0013 §5.
4. The F3 implementation nevertheless included that file.
5. The evidence audit found no contemporaneous authorization for the addition.
6. The addition was classified as technically necessary and architecturally consistent, but outside the written authorization.
7. The Owner subsequently ratifies that specific shipped addition through this ADR.
8. ADR-0013 remains unchanged.

The retrospective nature of this decision is intentional.

---

## 7. F2/F2-G Boundary

The missing historical decisions remain unresolved:

**F2/F2-G: UNRECOVERABLE FROM CURRENT REPOSITORY AND GIT HISTORY**

This ADR does not reconstruct, infer, or substitute for F2 or F2-G.

No missing F2/F2-G acceptance artifact or authorization is inferred from ADR-0013 or from the F3 implementation.

This ADR therefore does not claim that an unrecovered F2/F2-G decision authorized `workSelection.js`.

---

## 8. Test Evidence Context

A fresh full-suite evidence run reported:

* **616 total**
* **609 pass**
* **7 fail**
* **0 skipped**

The command used was:

`node --test tests/unit/*.test.js tests/integration/*.test.js`

The seven failures correspond to the previously documented Decision F narration/media-production failures.

The evidence review did not identify those seven failures as F3 Rights Verification failures.

This ADR therefore does not represent the full test suite as green and does not close or authorize fixes for the Decision F failures.

---

## 9. Other Governance Matters

This ADR does not resolve or modify the separate governance status of:

* the historical Decision F failures;
* the stale autonomous-operation checkpoint;
* the historical Groq implementation;
* missing F2/F2-G artifacts;
* future publication or production architecture;
* future work-selection changes.

Those matters require their own evidence and governance records.

---

## 10. No New Implementation Scope

This ADR authorizes no new source-code, migration, test, runtime, or architectural changes.

It does not authorize modification of:

* `src/autonomous/workSelection.js`;
* `src/autonomous/runner.js`;
* `src/rights-verification/*`;
* database migrations;
* tests;
* provider integrations; or
* publication/production systems.

Its sole purpose is to record the Owner's retrospective disposition of the already-shipped F3 `workSelection.js` scope discrepancy.

---

## 11. No General Precedent

This retrospective ratification is specific to the identified F3 scope discrepancy.

It must not be interpreted as standing permission for future implementations to exceed written authorization.

Future scope additions require explicit governance authorization through the repository's established process.

Where a historical scope discrepancy is discovered, its disposition must be separately recorded rather than silently assumed.

---

## 12. Push Authorization

This ADR does **not** authorize a push.

Implementation authorization and push authorization remain separate governance acts.

ADR-0013 §10 remains historically unchanged:

> AUTHORIZED FOR IMPLEMENTATION — PUSH NOT YET AUTHORIZED

No push authorization is granted by this ADR.

---

## 13. Final Decision

The specific question resolved by this ADR is:

> Should the already-shipped `src/autonomous/workSelection.js` addition be retrospectively accepted as part of F3 despite not being explicitly listed in ADR-0013 §5?

**Owner decision: YES.**

The Owner retrospectively ratifies that specific shipped addition as part of F3.

This decision does not alter the historical fact that the file was outside the explicit written scope of ADR-0013.

---

## 14. Record Status

**ACCEPTED — RETROSPECTIVE OWNER RATIFICATION**

This ADR is the permanent governance record for the specific F3 `workSelection.js` scope discrepancy.

No source-code change is implied by this document.
