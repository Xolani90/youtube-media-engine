# ADR-0032: Gate 2 / FINAL_COMPLIANCE Governance Resolution (Resolves ADR-0031 Section 13)

## 1. Status

**RECORDED, OWNER DECISIONS, GOVERNANCE RESOLUTION. IMPLEMENTATION SEPARATELY AUTHORIZED (a separate Owner implementation authorization is required; none is granted by this record).**

Owner: **Xolani Tshabalala**. Baseline at recording:
`494cfd8c1daa706bfff44a2b593610b4e284843f` (HEAD = origin/main).

This is a **GOVERNANCE RECORD**. It **resolves all five open implementation
decisions listed in ADR-0031 section 13**. It does **not** itself perform
implementation. It **establishes the exact implementation boundary** for the
subsequent, separate Owner implementation authorization.

This record does not change any code, test, configuration, migration or
schema, does not alter authorization behavior, does not modify ADR-0030 or
ADR-0031, and does not add any entry to
`config/authorized_external_actions.json` (which remains `[]`).

## 2. Relationship to ADR-0031

ADR-0031 recorded the Owner decisions G1-G6 and left five items open in its
section 13: (1) the concrete v1 rule set; (2) stale-PASS semantics for an item
already in `FINAL_COMPLIANCE`; (3) the identity and fingerprint fields used for
binding; (4) handling of existing `PRODUCED` items; (5) policy-version-change
semantics.

This record resolves those five items. ADR-0031 is not edited; its text stands
as written, and where its section 13 describes an item as open, this record
supplies the resolution. All ADR-0031 section 9 safety invariants remain
unchanged (section 18).

## 3. Gate 2 v1 rule set

Gate 2 v1 contains **exactly five deterministic rules**:

| Rule ID | Name |
|---|---|
| GC-001 | FINAL_MEDIA_INTEGRITY |
| GC-002 | ASSET_RIGHTS |
| GC-003 | FINAL_METADATA_PRESENCE |
| GC-004 | SCRIPT_MEDIA_CONSISTENCY |
| GC-005 | EXISTING_PROVENANCE |

Overall result:

- **ANY BLOCK -> BLOCK**
- **No BLOCK and one or more REVIEW -> REVIEW**
- **ALL PASS -> PASS**

Missing evidence maps to **REVIEW** unless the specific rule defines the
condition as a BLOCK.

## 4. GC-001 FINAL_MEDIA_INTEGRITY

Evidence: the `media_artifacts` row; `artifact_path`; the persisted
`artifact_checksum`; the actual artifact file.

- **PASS:** the artifact exists, the required evidence exists, and the actual
  SHA-256 of the file matches the persisted `artifact_checksum`.
- **REVIEW:** the artifact row, the file, or required evidence is missing.
- **BLOCK:** checksum mismatch.

## 5. GC-002 ASSET_RIGHTS

The append-only `asset_verifications` history is **authoritative**. The
mutable `assets.verification_status` cache is not the authoritative Gate 2
result.

For every applicable asset, the latest applicable authoritative verification
record is used, determined deterministically by insertion ordering.

- `VERIFIED` -> PASS
- `NOT_VERIFIED` / insufficient evidence -> REVIEW
- `DISPUTED` -> BLOCK
- **Zero applicable assets -> vacuous PASS.**

The compliance record references the actual `asset_verifications` record IDs
relied upon. If applicability cannot be established deterministically, the
result is conservatively **REVIEW**.

## 6. GC-003 FINAL_METADATA_PRESENCE

Evidence: the current `working_title` and `viewer_promise`.

- **PASS** only if both are strings and non-empty after trimming.
- Null, missing, non-string or whitespace-only -> **REVIEW**.
- **No BLOCK condition exists for GC-003.**
- The publication fallback `"Untitled (<id>)"` never satisfies this rule.

No other semantic validation is part of v1 (no length limits, prohibited-term
lists, advertiser suitability, classifiers or scoring).

## 7. GC-004 SCRIPT_MEDIA_CONSISTENCY

Verify the current relationships among `content_versions.script_id`,
`productions.script_id`, `scripts.id`, `scripts.version`, and
`media_artifacts.id` / the associated production-media identity.

- **PASS** only when the current script, production and final-media lineage
  are internally consistent.
- **BLOCK** when they are inconsistent.

No new generalized content identity or hash framework is created.

## 8. GC-005 EXISTING_PROVENANCE

Only existing `decision_log` evidence and existing repository relationships
are used.

- **Script provenance:** the script-generation ACCEPTED row keyed by the
  current content brief, with the current `scripts.content_brief_id`.
- **Brief provenance:** the brief-generation ACCEPTED row keyed by the brief's
  research project, with the current `content_briefs.research_project_id`.
- **Research/source provenance, where the chain exists:**
  `content_briefs.key_claims`, `claim_sources`, `sources`, and existing
  claim-extraction rows keyed by the linked source IDs.

Not used or created: `provider_calls` / `contentId` wiring, a new provenance
subsystem, a new hash or ID, or inference from provider configuration.

Conservative interpretation:

- exactly one applicable accepted-generation row is required where the lineage
  requires it;
- absent required provenance -> **REVIEW**;
- ambiguous provenance -> **REVIEW**;
- multiple extraction rows, where that makes source evidence ambiguous ->
  **REVIEW**;
- lineage is never invented.

GC-005 has no BLOCK condition.

## 9. PASS binding

Every persisted PASS binds:

- **Content:** `content_version_id`; `content_versions.script_id`;
  `scripts.id`; `scripts.version`.
- **Production/media:** `productions.script_id`; `media_artifacts.id`;
  `media_artifacts.artifact_checksum`.
- **Final metadata:** the exact current `working_title` and `viewer_promise`,
  in a deterministic representation.
- **Policy:** the policy pack version; the exact evaluated rule-ID set.
- **Evidence:** relevant `asset_verifications` references; relevant
  `decision_log` references; media artifact / checksum evidence.

No generalized identity or fingerprint framework is introduced.

## 10. Compliance record semantics

Compliance records are **append-only**. "Current" means the **newest
compliance record for the `content_version_id`**. UUIDs and timestamps are
insufficient to establish newest ordering, so the new compliance table's
SQLite insertion ordering / `rowid` is the deterministic ordering mechanism.

A newer REVIEW or BLOCK supersedes an older PASS. An older PASS never
overrides a newer non-PASS.

## 11. Stale PASS

A PASS is **non-authorizing** if any bound value, the policy version, or the
exact rule-ID set no longer matches.

A stale PASS is not a BLOCK, not `NEEDS_REVIEW`, not `FAILED`, and not a new
state. The item's existing state remains unchanged until the final-compliance
stage evaluates it.

For an item in `FINAL_COMPLIANCE`:

- fresh PASS -> append the PASS and remain `FINAL_COMPLIANCE`, without a
  same-state transition;
- REVIEW -> `NEEDS_REVIEW`;
- BLOCK -> `BLOCKED`.

For an item in `PRODUCED`:

- fresh PASS -> `FINAL_COMPLIANCE`;
- REVIEW -> `NEEDS_REVIEW`;
- BLOCK -> `BLOCKED`.

There is no same-state transition and no backward
`FINAL_COMPLIANCE -> PRODUCED` transition. `NEEDS_REVIEW` and `BLOCKED` remain
terminal because their exit workflows are separately deferred.

## 12. Existing PRODUCED items

**No grandfathering.** Every qualifying `PRODUCED` item with a media artifact
must obtain a current Gate 2 PASS before publication. Already-`PUBLISHED`
content is not retroactively evaluated. The final-compliance stage itself
determines whether a PASS is currently valid. Selectors are efficiency filters
only.

## 13. Policy versioning

Gate 2 uses a new explicit, versioned JSON policy pack containing **exactly
the five v1 rule IDs**. The pack is read **fresh** at every Gate 2 evaluation
and at every publication-boundary verification.

A persisted PASS is non-authorizing when the policy version differs or the
exact rule-ID set differs.

There is no automatic global re-evaluation (ADR-0006 D-G12 automation remains
deferred), no policy database and no policy migration framework.

If the policy pack is missing, malformed, unparseable, or does not contain
exactly the five required v1 rule IDs:

- no PASS is established;
- no existing PASS is accepted;
- no state transition occurs;
- REVIEW or BLOCK is not fabricated;
- the deterministic policy-load failure is reported.

## 14. Final lifecycle and runner stage

The canonical stage sequence becomes:

```text
research
-> brief
-> script
-> fact-check
-> originality
-> quality-gate
-> production
-> asset-provisioning
-> rights-verification
-> media-production
-> final-compliance
-> publication
```

The final-compliance stage processes qualifying `PRODUCED` items, and
`FINAL_COMPLIANCE` items whose PASS is no longer valid; evaluates Gate 2;
persists the result; performs the authorized state transition; and **never
publishes**.

## 15. Publication boundary

Gate 2 is enforced **at the publication boundary**, not only in selectors or
the runner. Existing short-circuits for `PUBLISHED`, `AMBIGUOUS`,
`VISIBILITY_MISMATCH`, `PENDING` and quarantine are preserved.

Gate 2 verification occurs **after** the existing media-file check and the
existing rights re-read, and **before** authorization, the durable `PENDING`
claim, and any provider call. It applies to every attempt capable of reaching
the provider, including reclaim of `FAILED` rows.

The publication boundary independently verifies:

1. the current content version;
2. the newest compliance record;
3. decision = PASS;
4. content binding;
5. script binding;
6. production/script consistency;
7. media artifact identity;
8. the actual file checksum;
9. final metadata binding;
10. the current policy version;
11. the current exact rule-ID set;
12. the required evidence references.

Any invalid binding makes the PASS non-authorizing.

Media checksum at publication: (1) resolve the current artifact; (2) confirm
the file exists; (3) compute its SHA-256; (4) compare it to
`media_artifacts.artifact_checksum`; (5) compare that checksum to the checksum
bound in the PASS. Any mismatch makes the PASS non-authorizing.

## 16. Publication-success state coupling

After Gate 2, `FINAL_COMPLIANCE -> PUBLISHED` is the successful publication
transition. A successful provider upload must not depend on a subsequent
incompatible local transition. No `PRODUCED -> PUBLISHED` path may bypass
`FINAL_COMPLIANCE`.

## 17. Implementation boundary and explicit non-scope

The subsequent Owner implementation authorization is limited to: the
`FINAL_COMPLIANCE` state; the state migration; the append-only compliance
table; the versioned Gate 2 policy JSON; the deterministic five-rule
evaluator; compliance persistence; the final-compliance runner stage; the
selection domain in sections 12 and 14; publication-boundary verification;
the publication-success transition; and tests and affected test updates.

This resolution does **not** authorize: scheduler changes; analytics;
learning or autonomous optimization; new providers; SaaS, accounts, tenants,
RBAC or dashboards; workflow builders; generalized risk frameworks;
`RiskPolicy`; `risk_assessments`; synthetic-media detection or disclosure
generation; thumbnail or tag generation; `provider_calls` / `contentId`
wiring; a new retry framework; `FailureClassification` changes; ADR-0030
changes; authorization-config activation; standing PUBLIC authorization; a
`NEEDS_REVIEW` exit workflow; a `BLOCKED` exit workflow; retroactive
`PUBLISHED` compliance; same-state transitions; or a backward
`FINAL_COMPLIANCE -> PRODUCED` transition.

## 18. Preserved safety invariants

All ADR-0031 section 9 safety invariants remain unchanged, including:
Fact-Check, Originality and Quality Gate; Rights Verification and the
publication-time rights re-read; Media Production validation; publication
eligibility; the durable `PENDING` claim before any provider call; unique
`(content_version_id, provider)` publication protection; `AMBIGUOUS`
handling; provider confirmation; retry and quarantine rules; single-run
protection; the SIMULATION veto; and the immediate authorization check.

Gate 2 remains mandatory before unattended PUBLIC YouTube publication. The
ADR-0030 standing authorization remains dormant, and
`config/authorized_external_actions.json` remains `[]`.

## 19. Authorization status

This ADR records the final governance resolution. It does **not** itself
constitute the implementation operation. The Owner may now issue a separate,
explicit implementation authorization bounded exactly by this ADR. No
authorization configuration is activated by recording this ADR.

```text
ADR-0032: RECORDED, OWNER DECISIONS. Governance resolution of ADR-0031 section 13.
All five section 13 items resolved. Gate 2 v1 = GC-001..GC-005.
Implementation NOT performed and NOT authorized by this record;
a separate Owner implementation authorization is required.
ADR-0030 and ADR-0031 unchanged. config/authorized_external_actions.json remains [].
No source, test, config, migration or schema change.
```
