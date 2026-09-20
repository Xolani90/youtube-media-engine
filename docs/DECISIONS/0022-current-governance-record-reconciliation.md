# ADR-0022 — Current Governance Record Reconciliation

**Status:** RECORDED — DOCUMENTATION-ONLY RECONCILIATION RECORD (Owner-authorized documentation task; committed at `8e596ec`; does not authorize implementation, does not alter historical records, and infers no missing authorization)
**Owner:** Xolani Tshabalala
**Baseline:** `a3a33dac2dc00d53bba94d7954c8f7772bc9d26a`
**Branch:** `main`
**Implementation:** NONE AUTHORIZED. This record changes no source, test, schema, migration, configuration, or runtime behaviour.

---

## 1. Purpose

A read-only governance audit at the baseline above found stale or contradictory status statements in existing governance records. This ADR records, for each, what the record says, what current repository evidence shows, and how the statement is to be read.

## 2. Rules of this record

- No historical record is rewritten by this ADR. Historical wording is preserved exactly as committed.
- Where a statement is stale, this ADR records that it is stale. It does not edit the statement.
- A statement being stale does not establish approval, authorization, or the opposite. This ADR infers no approval from commit history.
- This ADR does not recover, reconstruct, or certify any unrecoverable record (see ADR-0021 §6).
- This ADR creates no implementation authorization.

Classification vocabulary: STALE, CONTRADICTORY, HISTORICAL BUT VALID, AMBIGUOUS, EVIDENCE INSUFFICIENT.

## 3. Records reconciled

### 3.1 Brief specification

- **Record:** `docs/SPECIFICATIONS/brief-specification.md`, §1.
- **Statement:** the specification is accepted, with "IMPLEMENTATION NOT AUTHORIZED".
- **Current evidence:** a Brief implementation exists (`src/brief/*`, first commit `7537398`, the same commit that first added this specification), and it is present in the runner.
- **Classification:** CONTRADICTORY. The historical authorization statement conflicts with the existence of the current implementation. Surviving authorization evidence was not found (ADR-0021 §3.1).
- **Reading:** the statement is preserved as written. This ADR neither establishes nor denies Brief implementation authorization.

### 3.2 Script specification

- **Record:** `docs/SPECIFICATIONS/script-specification.md` (v0.1).
- **Statement:** it "describes the Script stage as implemented". It carries no status or authorization statement.
- **Classification:** EVIDENCE INSUFFICIENT. There is no status to reconcile and no authorization statement (ADR-0021 §3.2).

### 3.3 Fact-Check specification

- **Record:** `docs/SPECIFICATIONS/fact-check-specification.md`, header.
- **Statement:** "Status: DRAFT — UNDER RECONCILIATION (not committed, not approved, not frozen)".
- **Current evidence:** the file is committed (`c8bb476`, `32e5c8f`, `e34dfd3`), and `docs/DECISIONS/pending-fact-check-reconciliation-notes.md` records reconciliation work. ADR-0002 (D-A) closes Fact-Check P1 with no code change.
- **Classification:** STALE and CONTRADICTORY (the header says "not committed" while the file is committed). No approval is inferred from the commits.
- **Reading:** the header is preserved. Any normalization of its status would need a future explicit Owner-authorized status decision.

### 3.4 ADR-0013 §10

- **Record:** `docs/DECISIONS/0013-d-g2-rights-verification-implementation-authorization.md`, §10.
- **Statement:** "AUTHORIZED FOR IMPLEMENTATION — PUSH NOT YET AUTHORIZED".
- **Current evidence:** the implementation commit `9243f2e` ("Implement rights verification stage") is an ancestor of `origin/main`.
- **Classification:** STALE relative to the current remote state. The wording is HISTORICAL BUT VALID as a statement of the state when it was written.
- **Reading:** ADR-0013 is not rewritten. ADR-0014 §§12 and 15 record that the Owner separately authorized, outside Git, the push of `be9f998`; `9243f2e` is an ancestor of that commit. ADR-0014 also records that ADR-0013 §10 remains historically accurate for the point when ADR-0013 was written.

### 3.5 ADR-0015 §10

- **Record:** `docs/DECISIONS/0015-research-source-provider-tavily-search.md`, §10.
- **Statement:** "AUTHORIZED FOR IMPLEMENTATION — PUSH NOT YET AUTHORIZED".
- **Current evidence:** the implementation commit `8500833` ("feat(research): add Tavily search source provider") is an ancestor of `origin/main`.
- **Classification:** STALE, HISTORICAL BUT VALID. Same reading as 3.4.

### 3.6 ADR-0010

- **Record:** `docs/DECISIONS/0010-autonomous-operation-scope-and-discovery-deferral.md`, §3 (Decision B).
- **Statement:** a nine-stage order, "unchanged by this decision and not authorized to change without a separate governance decision".
- **Current evidence:** `buildStages()` in `src/autonomous/runner.js` and the checkpoint §2 describe eleven stages, adding `asset-provisioning` and `rights-verification`.
- **Classification:** HISTORICAL BUT VALID: the nine-stage scope remains a historical record of ADR-0010. Current repository evidence shows an eleven-stage runner, with Rights Verification later authorized by ADR-0013 and Asset Provisioning authorization not found in surviving governance records. ADR-0010 is not rewritten to match today's pipeline.
- **Governance notes:**
  - For Rights Verification, ADR-0013 (§4-5) is a governance record that authorizes its insertion.
  - For Asset Provisioning, no surviving separate governance decision for the stage's insertion was located. See ADR-0021 §4.
  - ADR-0010's Discovery decisions (B1, C3) are unaffected by this reading.

### 3.7 Checkpoint

- **Record:** `docs/CHECKPOINTS/autonomous-operation-checkpoint.md`.
- **Stale items (recorded here, not corrected):**

| Location | Statement | Classification |
|---|---|---|
| §1 Verified Baseline (HEAD / origin/main) | `29cf5cc26cc16ec8a69676211445659616146549` | STALE: current baseline is `a3a33da`. |
| §2 | "as of current baseline `699c9b6`" | STALE / AMBIGUOUS (baseline references differ across sections). |
| §2 | "prior 9-stage description recorded at the `611abc3` baseline" | HISTORICAL BUT VALID. |
| §2 | Asset Provisioning and Rights Verification "were added via ADR-0013/0014" | CONTRADICTORY / EVIDENCE INSUFFICIENT as to Asset Provisioning authorization: ADR-0013 authorizes Rights Verification and its insertion after Asset Provisioning; ADR-0014 retrospectively ratifies `workSelection.js`; no surviving governance record authorizing creation or insertion of Asset Provisioning was found (see ADR-0021 §4). Rights Verification remains separately supported by ADR-0013 (§§4-5). |
| §4 and §5 test-count statements | "707 tests" | STALE. A point-in-time count. This ADR does not re-establish a current count. |
| §7 execution order | reconciled "against current repository state `611abc3`" | STALE. |
| governance references | omits ADR-0019 (`506f6f6`) and ADR-0020 (`a3a33da`) | STALE. |

- **Treatment:** the checkpoint is NOT updated by this ADR. Its correction is a separate current-documentation reconciliation item that needs its own Owner authorization. Its prohibitions and deferred list are unchanged by this ADR.

### 3.8 ADR-0019 and ADR-0020

ADR-0019 §6 still reads as an open governance dependency. ADR-0020 §6 explicitly closes it. The absence of a back-reference in ADR-0019 is a navigational gap, not a contradiction. ADR-0019 is not amended by this ADR.

## 4. Out of scope

This ADR makes no decision about, and creates no authorization for: the NEEDS_REVIEW exit lifecycle, FINAL_COMPLIANCE or Gate 2, the scheduler, learning or metrics, monthly budget, Discovery, additional LLM providers, or `contentId` wiring.

## 5. Final status

RECORDED — NO HISTORICAL RECORD REWRITTEN — NO IMPLEMENTATION AUTHORIZED.
