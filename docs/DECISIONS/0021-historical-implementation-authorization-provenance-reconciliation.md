# ADR-0021 — Historical Implementation Authorization and Governance Provenance Reconciliation

**Status:** RECORDED — DOCUMENTATION-ONLY PROVENANCE RECORD (Owner-authorized documentation task; pending Owner review and commit)
**Owner:** Xolani Tshabalala
**Baseline:** `a3a33dac2dc00d53bba94d7954c8f7772bc9d26a`
**Branch:** `main`
**Implementation:** NONE AUTHORIZED. This record changes no source, test, schema, migration, configuration, or runtime behaviour.

---

## 1. Purpose

A read-only governance audit at the baseline above found implemented pipeline surfaces for which the original implementation-authorization evidence is not present in the surviving governance record. This ADR records the current provenance status of those surfaces, and of one remediation commit (LLM-FIND-01), exactly as the repository evidence shows it.

This ADR is a status record. It does not reconstruct history, does not recover missing authorization, and does not create authorization.

## 2. Governing principles of this record

- Absence of surviving authorization evidence does **not** prove that authorization never existed.
- This ADR does **not** claim to recover missing authorization.
- This ADR does **not** invent an Owner decision from historical circumstances (commit ordering, commit authorship, code existence, passing tests, runner inclusion, checkpoint statements, or source-code comments).
- This ADR does **not** certify unrecoverable historical records.
- This ADR does **not** authorize new implementation.
- This ADR does **not** modify existing implementation.
- This ADR establishes only the current provenance status.
- Commit-author metadata is recorded where relevant as a fact about the commit. It is not treated as authorization evidence.
- Source-code comments that cite an Owner brief, milestone, or frozen contract are recorded as observed attributions. They are not surviving governance records, and the documents they cite were not found under `docs/`.

Classification vocabulary used below:

- **IMPLEMENTATION OBSERVED** — code exists at the baseline.
- **ORIGINAL AUTHORIZATION EVIDENCE** — FOUND / NOT FOUND in surviving governance records.
- **RETROSPECTIVE RATIFICATION** — FOUND / NOT FOUND.
- **CURRENT BEHAVIOUR OBSERVED** — what the repository currently does, without judging authorization.
- **RECONSTRUCTING HISTORY?** — whether this ADR is reconstructing history (in every case below: NO).

## 3. Surface findings

### 3.1 Brief

1. **IMPLEMENTATION OBSERVED:** `src/brief/*`; first commit `7537398` (2026-09-10) "Implement Brief stage (D1-D16): …"; later touching commits `02e40ed` and `4e13b0e`. Tests: `tests/integration/brief-pipeline-e2e.test.js` and `tests/unit/brief-*.test.js`.
2. **ORIGINAL AUTHORIZATION EVIDENCE:** NOT FOUND. `docs/SPECIFICATIONS/brief-specification.md` §1 records the specification as accepted while stating "IMPLEMENTATION NOT AUTHORIZED". That file's only commit is `7537398`, the same commit that implemented the stage. No ADR or other record authorizing Brief implementation was found.
3. **RETROSPECTIVE RATIFICATION:** NOT FOUND.
4. **CURRENT BEHAVIOUR OBSERVED:** the stage is present in `buildStages()` in `src/autonomous/runner.js` as `brief`, with a selector in `src/autonomous/workSelection.js`.
5. **RECONSTRUCTING HISTORY?** NO.

### 3.2 Script

1. **IMPLEMENTATION OBSERVED:** `src/script/*`; first commit `a5a8e71` (2026-09-10) "feat: add bounded script stage"; later touching commits `02e40ed` and `4e13b0e`. Tests: `tests/integration/script-pipeline-e2e.test.js` and `tests/unit/script-*.test.js`.
2. **ORIGINAL AUTHORIZATION EVIDENCE:** NOT FOUND. `docs/SPECIFICATIONS/script-specification.md` (v0.1) states that it describes the Script stage "as implemented" and carries no status or authorization statement. Its only commit is `a5a8e71`.
3. **RETROSPECTIVE RATIFICATION:** NOT FOUND.
4. **CURRENT BEHAVIOUR OBSERVED:** the stage is present in `buildStages()` as `script`.
5. **RECONSTRUCTING HISTORY?** NO.

### 3.3 Quality Gate

1. **IMPLEMENTATION OBSERVED:** `src/quality-gate/*`; first commit `60eeb51` (2026-09-15) "feat: implement Gate 1 Quality Gate / Production Readiness (ADR-0006 D-G8)"; later touching commit `7718efc`. Tests: `tests/integration/quality-gate-pipeline-e2e.test.js`, `tests/unit/quality-gate-checks.test.js`.
2. **ORIGINAL AUTHORIZATION EVIDENCE:** NOT FOUND. `docs/DECISIONS/0006-monetization-compliance-governance-ratification.md` §1 is "RATIFIED — OWNER DECISION RECORDED — IMPLEMENTATION NOT AUTHORIZED", and its D-G8 records "Implementation authorization: None". Source comments in `src/quality-gate/pipeline.js` cite an "Owner Gate-1 decision". Source comments in `src/quality-gate/checks.js` and `src/quality-gate/constants.js` record the "evidence-existence only" behaviour. No corresponding Owner decision record was found under `docs/`. These comments are observed attributions only and are not treated as authorization.
3. **RETROSPECTIVE RATIFICATION:** NOT FOUND for the stage. ADR-0020 is an Owner decision on the Originality-evidence contract of the existing check. It is not an implementation authorization for the Quality Gate stage.
4. **CURRENT BEHAVIOUR OBSERVED:** present in `buildStages()` as `quality-gate`. Behaviour of its Originality evidence check is as recorded in ADR-0020.
5. **RECONSTRUCTING HISTORY?** NO.

### 3.4 Production

1. **IMPLEMENTATION OBSERVED:** `src/production/*`; first commit `0e639be` (2026-09-15) "feat: implement Production MVP (PRODUCTION_READY -> PRODUCED)"; later touching commit `7718efc`. Tests: `tests/integration/production-pipeline-e2e.test.js`, `tests/unit/production-manifest.test.js`.
2. **ORIGINAL AUTHORIZATION EVIDENCE:** NOT FOUND. `src/production/constants.js` refers to an "Owner Production MVP brief"; that document was not found under `docs/`. ADR-0002 (D-C2) and ADR-0008 concern the external side-effect authorization requirement, not authorization of the Production stage. ADR-0006 records "Implementation authorization: None" for every decision including D-G8, and refers to Production as something to be "separately authorized" (e.g. the Production/D-C2 boundary paragraph); it does not itself authorize the Production stage.
3. **RETROSPECTIVE RATIFICATION:** NOT FOUND for the stage. ADR-0009 is provenance for the D-C2 mechanism only.
4. **CURRENT BEHAVIOUR OBSERVED:** present in `buildStages()` as `production`.
5. **RECONSTRUCTING HISTORY?** NO.

### 3.5 Asset Provisioning

See section 4 for the specific distinction the audit found.

1. **IMPLEMENTATION OBSERVED:** `src/asset-provisioning/*`; first commit `70d324b` (2026-09-16) "feat: add asset provisioning stage"; later touching commits `7718efc` and `a424359`. Tests: `tests/integration/asset-provisioning-pipeline-e2e.test.js`, `tests/unit/asset-provisioning-pipeline.test.js`.
2. **ORIGINAL AUTHORIZATION EVIDENCE:** NOT FOUND in surviving governance records. `src/asset-provisioning/constants.js` calls the stage "Milestone D". The following are recorded strictly as **OBSERVED SOURCE-CODE ATTRIBUTIONS**; they are not surviving governance authorization, and no authorization is inferred from them:
   - `src/autonomous/runner.js` (comment above `buildStages()`) describes Asset Provisioning as inserted between Production and Media Production "per its own frozen contract" and points to `src/asset-provisioning/pipeline.js`.
   - `src/asset-provisioning/pipeline.js` (header comment on the stage function) describes the runner insertion as "Owner-authorized … (ADR-0013)".
   - ADR-0013 §5 authorizes the Rights Verification insertion ("Asset Provisioning → Rights Verification → Media Production"), not creation of Asset Provisioning itself.
   No governance record authorizing creation or insertion of Asset Provisioning was found under `docs/`.
3. **RETROSPECTIVE RATIFICATION:** NOT FOUND for the stage's creation. ADR-0016 records provenance for F5-01 (`a424359`, concurrent provisioning-claim enforcement) only, and treats the stage as already existing.
4. **CURRENT BEHAVIOUR OBSERVED:** present in `buildStages()` as `asset-provisioning`, between `production` and `rights-verification`.
5. **RECONSTRUCTING HISTORY?** NO.

### 3.6 Media Production

1. **IMPLEMENTATION OBSERVED:** `src/media/*`; first commit `f786851` (2026-09-15) "Real Media Production v1: production_manifest -> narration -> render spec -> FFmpeg -> FFprobe -> validated .mp4"; further commits in `src/media` through `dc7267c`. Tests: `tests/integration/media-production-pipeline-e2e.test.js` and `tests/unit/media-*.test.js`.
2. **ORIGINAL AUTHORIZATION EVIDENCE:** NOT FOUND. `src/media/constants.js` describes "Real Media Production v1"; no corresponding governance record was found. The checkpoint's Decision F concerns the reconciliation of historical narration/media-production test failures, and is not an authorization of the stage.
3. **RETROSPECTIVE RATIFICATION:** NOT FOUND.
4. **CURRENT BEHAVIOUR OBSERVED:** present in `buildStages()` as `media-production`.
5. **RECONSTRUCTING HISTORY?** NO.

## 4. Asset Provisioning — distinction recorded precisely

`docs/CHECKPOINTS/autonomous-operation-checkpoint.md` §2 states that Asset Provisioning and Rights Verification "were added via ADR-0013/0014". The surviving records say:

- **ADR-0013** authorizes the Rights Verification stage (§4-5) and places it after Asset Provisioning ("Asset Provisioning → Rights Verification → Media Production"). It does not authorize creation of Asset Provisioning itself.
- **ADR-0014** retrospectively ratifies `src/autonomous/workSelection.js`. It does not authorize creation of Asset Provisioning itself.
- **ADR-0016** records provenance for F5-01 only.

Classification, without claiming the stage was authorized and without claiming it was unauthorized:

**CURRENT IMPLEMENTATION OBSERVED; ORIGINAL IMPLEMENTATION AUTHORIZATION EVIDENCE NOT FOUND IN SURVIVING GOVERNANCE RECORDS.**

## 5. LLM-FIND-01 remediation (recorded separately)

- **Finding record:** the identifier "LLM-FIND-01" appears in `tests/unit/prompt-trust-boundary.test.js` (comment beginning "LLM-FIND-01 remediation" and three test names). No finding document under `docs/` was found.
- **Remediation commit:** `d5b04a9` (2026-09-17) "fix: fence discovery RSS content at LLM boundaries". It changed `src/discovery/dedup.js`, `src/discovery/featureComputation.js`, `src/discovery/proposition.js`, and `tests/unit/prompt-trust-boundary.test.js`, and it is present in the history of `origin/main`.
- **Current behaviour observed:** those three Discovery modules import from `src/providers/llm/promptTrust.js`, and the test file asserts RSS-derived observation content is delimited as untrusted data.
- **Related governance text:** ADR-0002 D-D1 is a general Owner-accepted requirement that untrusted external material inserted into prompts be structurally delimited and labelled. The test comment cites D-D1. No surviving record states whether D-D1 was the authorization for this Discovery remediation. This ADR does not decide that.
- **Authorization record:** no surviving ADR or Owner record was found. This ADR does not claim the remediation was unauthorized.
- **Context:** Discovery is outside the autonomous runner (ADR-0010, Decision B1), and the Discovery v0.6 specification is UNRECOVERABLE / NOT RECOVERED (ADR-0010, Decision C3).

Classification:

**AUTHORIZATION EVIDENCE NOT FOUND / HISTORICAL PROVENANCE UNRECOVERED.**

## 6. Historical records preserved as unrecoverable

The following remain historical and are **not** reconstructed, replaced, or certified by this ADR:

- ADR-0005 — UNRECOVERABLE / NOT RECOVERED (see ADR-0011).
- Research v0.4 specification — UNRECOVERED / NOT CERTIFIED (see the Research governance baseline; RG-01).
- Discovery v0.6 specification — UNRECOVERABLE / NOT RECOVERED (see ADR-0010).
- Publication v1 specification — MISSING, recovery deferred (see ADR-0012).
- F2 and F2-G original evidence — UNRECOVERABLE / NOT RECOVERED (see ADR-0014 §7, ADR-0017 §7).
- The "Autonomous Operation Checkpoint" as originally cited in code comments — recorded as missing in the current checkpoint.
- Any other authorization artifact referenced by source comments but absent from `docs/`.

## 7. Out of scope

This ADR makes no decision about, and creates no authorization for: the NEEDS_REVIEW exit lifecycle, FINAL_COMPLIANCE or Gate 2, the scheduler, learning or metrics, monthly budget enforcement, Discovery, additional LLM providers, or `contentId` wiring. Those remain as recorded in ADR-0002, ADR-0006, ADR-0010 and the checkpoint.

This ADR does not amend ADR-0006, ADR-0010, ADR-0013, ADR-0014, ADR-0016, ADR-0019, ADR-0020, or any specification. Current status discrepancies in existing records are recorded separately in ADR-0022.

## 8. Final status

RECORDED — PROVENANCE ONLY — NO IMPLEMENTATION AUTHORIZED — NO HISTORY RECONSTRUCTED.
