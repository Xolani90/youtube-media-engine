# ADR-0013: D-G2 Rights Verification — Implementation Authorization

## 1. Status

**AUTHORIZED — OWNER DECISION RECORDED — IMPLEMENTATION PROCEEDING**

## 2. Purpose

This document records the Owner's explicit implementation authorization for
the Rights Verification stage designed in F2 (Rights Verification Design
Specification) and audited in F2-G (Rights Verification Governance
Authorization Preparation Audit). It follows the same authorization-
provenance pattern established by ADR-0007 (D-G1) and ADR-0009 (D-C2):
ratification reference, explicit Owner authorization statement, authorized
scope, and (once shipped) the resulting implementation commit.

## 3. Ratification reference

`docs/DECISIONS/0006-monetization-compliance-governance-ratification.md`
(ADR-0006) ratified D-G2's architecture direction (asset-level rights/
provenance registry, separate from `sources`) while explicitly stating
"Implementation authorization: None" and deferring construction until
Production/D-C2 was separately authorized. That deferred construction was
later authorized and shipped as migration `0007_asset_rights_provenance.sql`.

Neither ADR-0006 nor any later ADR (0007–0012) authorized a verification
policy, a Rights Verification stage, an `asset_verifications` table,
automatic promotion to `VERIFIED`, or a verification state machine. F2
(design) and F2-G (governance audit) both confirmed this gap explicitly and
declined to resolve it themselves, consistent with this repository's
established rule that ratification and implementation authorization are
distinct acts, and that only the Owner may perform the latter.

## 4. Owner authorization

The Owner (Xolani Tshabalala) has now given that authorization, explicitly
and directly, covering exactly the seven items identified in F2-G §3/§6:

1. Creation of the `asset_verifications` migration/table.
2. Creation and insertion of the Rights Verification stage
   (Asset Provisioning → Rights Verification → Media Production).
3. Implementation of the automated verification policy, including the
   provider-specific evidence and license rules defined by F2.
4. Implementation of the `UNVERIFIED → VERIFIED` automatic promotion rule
   defined by F2 §8.
5. Persistence of Rights Verification decision records using the F2 §6
   schema.
6. Policy versioning and lazy re-verification as defined by F2 §15.
7. Human-only resolution of `DISPUTED` assets as defined by F2 §7.

This authorization is limited strictly to the F2/F2-G implementation scope
(§5 below) and explicitly excludes everything listed in §6 below. It does
not authorize anything beyond that scope, and does not retroactively
authorize or reopen any other closed finding, migration, or stage.

## 5. Authorized scope

Exactly the F2 §19 / F2-G §3 implementation surface:

- `src/db/migrations/0011_asset_verification.sql` — new `asset_verifications`
  table.
- `src/rights-verification/pipeline.js`, `eligibility.js`, `constants.js`,
  `policy/pixabay.js` — the stage itself.
- `src/state/AssetVerification.js` — repository class.
- One insertion in `src/autonomous/runner.js`'s `buildStages()`: Asset
  Provisioning → Rights Verification → Media Production.

No other file, table, stage, or runner-order change is in scope.

## 6. Explicit exclusions

This authorization does **not** cover, and implementation must not include:

- legal-clearance semantics, or any claim of copyright-free/zero-legal-risk
  status;
- ownership determination of any depicted subject;
- model/property-release verification;
- trademark/logo clearance;
- automatic human-review simulation (any `verifier_type = 'human'` decision
  must originate from an actual human action, never from the automated
  stage);
- Publication redesign (F2-G Open Decision 1 remains open and unresolved);
- broad provenance refactor beyond the additive fields this scope requires;
- retroactive mass re-verification of existing assets;
- runner redesign beyond the single authorized stage insertion;
- modification of existing Quality Gate, Production, Media Production,
  Publication, or `ContentStateMachine` behavior, except where the F2 design
  explicitly requires additive integration (i.e., these stages continue to
  read `assets.verification_status` exactly as they do today — see F2 §12–§14).

## 7. Implementation condition

Implementation proceeds under this authorization exactly as scoped above.
Per F2 §18/§22, F3 is complete only when the full F2 acceptance-criteria
checklist is satisfied, including a full test suite per F2 §21 and this
ADR itself existing as the recorded authorization artifact.

## 8. Resulting implementation

Recorded upon completion of F3, in the same style as ADR-0007 §5 and
ADR-0009 §4 — see the F3 implementation report following this ADR.

## 9. Push authorization

Not yet given. Per this repository's established convention (ADR-0007 §6,
ADR-0009 §5), commit and push authorization are separate acts from
implementation authorization and are recorded separately once given.

## 10. Final status

```text
AUTHORIZED FOR IMPLEMENTATION — PUSH NOT YET AUTHORIZED
```