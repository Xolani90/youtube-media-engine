# Research Subsystem — Section 18 Owner-Authorized Freeze

**Status:** OWNER-AUTHORIZED — forward-governance freeze of the Research subsystem surface, effective from this decision onward.
**Decision date:** 2026-09-17
**Authority:** Project Owner (Xolani Tshabalala)
**Relation to baseline:** This record is the separate, correctly numbered governance decision required by Section 18 of `docs/DECISIONS/RESEARCH-GOVERNANCE-BASELINE.md`. It does not replace that document, does not alter RG-01 through RG-05 (all CLOSED), and does not amend Section 18's freeze procedure — it is the output of that procedure. The baseline remains authoritative for Research governance except where this decision establishes the forward frozen state.

---

## 1. Decision

The Project Owner explicitly authorizes a Research subsystem freeze under Section 18 of the Research Governance Baseline.

This is a **forward** governance freeze, effective from this decision onward. It does not retroactively freeze, certify, reconstruct, or otherwise validate any historical implementation.

## 2. Historical status (preserved, not altered)

- Research v0.4 remains **UNRECOVERED / NOT CERTIFIED**.
- This freeze does not reconstruct, recover, or certify Research v0.4.
- No historical Research freeze is asserted by this record.
- The freeze begins from this explicit Owner decision onward, not retroactively.

## 3. Preconditions satisfied

- The forward Research Governance Baseline was Owner-approved.
- RG-01 is CLOSED. RG-02 is CLOSED. RG-03 is CLOSED. RG-04 is CLOSED. RG-05 is CLOSED.
- The Section 18 Research Freeze Readiness Audit was performed (findings F-4, F-5, F-6, F-8; see baseline Change Log, 2026-09-17).
- The Owner-accepted limitations identified during that audit and during RG-05 closure are carried forward, unremediated, rather than fixed as a condition of this freeze.

This freeze does not claim production readiness, zero defects, or Research v0.4 conformity.

## 4. Frozen Research surface

The following are frozen as of this decision:

**Implementation:**
```
src/research/**
```

**Research-specific portions/contracts of shared files:**
```
src/db/migrations/0001_init.sql
src/db/migrations/0003_research_subsystem.sql
src/db/migrations/0012_remove_legacy_claim_columns.sql
config/research_policy.json
```
(Only the Research-related portions of the shared migration files are frozen; these files are not exclusively Research-owned and their non-Research content is not frozen by this decision.)

**Governance contracts/semantics also frozen:**
- Research eligibility semantics
- Research lifecycle semantics
- Research terminal-state semantics (`RESEARCH_COMPLETE`)
- Contradiction-detection semantics
- Evidence-grading and completeness semantics
- The Research → Brief eligibility contract, including the requirement that Brief eligibility depends on `RESEARCH_COMPLETE`
- The Research governance semantics established by RG-01 through RG-05 and by the baseline document

"Frozen" refers to this Research-specific surface and semantics only. It does not freeze the repository, the application, or any downstream subsystem.

## 5. Explicitly outside the freeze

The following remain mutable unless separately, explicitly frozen in a future governance decision:

- Discovery
- Brief implementation outside the Research handoff contract
- Script
- Fact-Check
- Originality
- Risk
- Production
- Publication
- Shared storage infrastructure outside Research-specific behavior
- Migration-runner infrastructure
- Generic `decision_log` infrastructure
- Unrelated application code

A downstream subsystem is not frozen merely because it consumes Research outputs or depends on the Research → Brief contract.

## 6. Accepted limitations carried forward

None of the following is remediated, implemented, or reopened by this freeze. Each retains its prior disposition from the baseline (RG-05 closure and the Section 18 Readiness Audit):

| Finding | Description | Disposition |
|---|---|---|
| F1-A | Claim insertion and claim-source linking are not transactionally atomic. | Accepted. No remediation authorized by this freeze. |
| F1-C | No Research project timeout/lease/retry/resume mechanism exists. | Accepted. No remediation authorized by this freeze. |
| Brief uniqueness | `content_briefs.research_project_id` has no database-level UNIQUE constraint; idempotency is application-level only. | Accepted downstream limitation. No remediation authorized by this freeze. |
| F-4 | Contradiction pipeline falls through to `NO_CONTRADICTION` for detector return values outside the documented four-state contract. | Accepted, LOW severity, non-blocking. No remediation authorized by this freeze. |
| F-5 | Crash/retry may produce duplicate source/claim rows. | Covered by F1-C; no separate remediation authorized. |
| F-8 | Local sandbox HEAD SHA previously diverged from authoritative `origin/main` due to `git am` recreation; content independently verified identical. | Informational bookkeeping only. Not a Research defect. |

No new findings are introduced by this record.

## 7. Governance-only meaning of "frozen"

This freeze is **governance-only**. It does not establish, and none of the following is authorized by this decision:

- Git branch protection
- CI enforcement
- Runtime hash/signature verification
- Filesystem immutability
- Automated code-locking
- A dedicated freeze branch or Git tag
- Deployment-level enforcement
- Any claim of production readiness

The freeze means: the identified Research surface is now governed as frozen. It is enforced by governance process, not by technical mechanism, unless the Owner separately and explicitly authorizes a technical enforcement mechanism in a future decision.

## 8. Future-change rule

Once this freeze is effective, any proposed change to the frozen Research surface — however small, corrective, defensive, or bug-fix-motivated it may appear — requires a new, separately numbered governance decision and explicit Owner authorization **before implementation**. No implicit authorization exists for any future change, regardless of who or what proposes it.

A future Owner decision may authorize a specific change, a defined remediation, a technical enforcement mechanism, or a modification to the freeze itself — but none of those is authorized by this record.

## 9. Scope of this record

This record authorizes only its own creation as a governance document. It does not authorize, and no other change was made to:

```
src/**
tests/**
config/**
```
or any database migration, schema, CI configuration, or dependency.

`docs/DECISIONS/RESEARCH-GOVERNANCE-BASELINE.md` is unchanged by this record. RG-01 through RG-05 remain CLOSED and unaltered. No `RG-06` is created.

---

## Status summary

```
SECTION 18 RESEARCH FREEZE RECORD — OWNER AUTHORIZED
Research v0.4 remains UNRECOVERED / NOT CERTIFIED.
RG-01 through RG-05 remain CLOSED.
No RG-06 created.
Freeze enforcement is GOVERNANCE-ONLY.
Future changes to the frozen Research surface require a new, separately numbered,
Owner-authorized governance decision before implementation.
```
