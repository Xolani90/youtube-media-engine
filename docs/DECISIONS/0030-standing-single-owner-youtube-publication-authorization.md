# ADR-0030: Standing Single-Owner YouTube Publication Authorization (Amends / Clarifies ADR-0008 §3.1)

## 1. Status

**RECORDED, OWNER DECISION, GOVERNANCE ONLY. PUBLIC ACTIVATION GATED ON GATE 2. IMPLEMENTATION NOT AUTHORIZED.**

Owner: **Xolani Tshabalala**. Baseline at recording:
`04ccd03559f9845aedaa8904132e264f2a979894` (HEAD = origin/main).

This is a **GOVERNANCE RECORD**. It records the Owner's decision on the
publication authorization model. **It does not change any code, test,
configuration, migration or schema, it does not add any entry to
`config/authorized_external_actions.json`, and it authorizes no
implementation.** It **amends / clarifies ADR-0008 §3.1** as stated in section 4.
It does not rewrite ADR-0008; the text of ADR-0008 is unchanged.

## 2. Background and the ADR-0008 §3.1 ambiguity

ADR-0008 §3.1 states:

> Authorization is granted **per external action** — not for an entire run, and
> not for an entire content item's future actions in the abstract.

ADR-0008 §3.1 item 3 additionally requires that "the specific external action
has explicit Owner-controlled authorization."

At the baseline, the implementation authorizes exactly the string
`publish:${provider}:${contentVersionId}` (`src/publication/constants.js`,
`publicationActionId`), matched by exact string equality
(`src/state/SideEffectAuthorization.js`, `isActionAuthorized`), against a
file that is `[]` in the repository. Every content version therefore needs a
new Owner entry, and the engine cannot publish future content unattended.

The words "specific", "explicit", "per external action", "not for an entire
run" and "in the abstract" do **not** unambiguously permit or forbid a standing
Owner rule that is evaluated at each external action. The comments at
`src/publication/constants.js` (action-id convention) and
`src/publication/pipeline.js` (Step 5) read §3.1 as forbidding a blanket
`publish:<provider>` entry. Those comments are implementer interpretation, not
ADR text. This record does not pretend that ADR-0008 already unambiguously
permitted the model below; it resolves the ambiguity by amendment.

## 3. Owner policy decision (Model B)

The Owner authorizes a **standing single-owner authorization** for qualifying
future YouTube publication actions, as the Owner's intended authorization model:

- Provider: **YouTube** only.
- Action: **publish/upload** only.
- Channel: the **single configured Owner-controlled YouTube credential/channel**.
  No channel identity is represented separately.
- Standing visibility: **PUBLIC**.
- Publication cap: **NONE.** No per-run or per-day publication-count limit is
  imposed by this decision.
- Expiry: **NONE.** The authorization remains in force until the Owner revokes it
  (section 9).
- Existing eligible `PRODUCED` items: **INCLUDED.** They may use the standing
  authorization, subject to every safeguard in section 5.
- The standing rule applies to qualifying future YouTube publication actions, is
  evaluated at the concrete external-action boundary, and is freshly evaluated
  for every retry.
- The caller, stage, runner, provider and content item cannot self-authorize.
- SIMULATION remains an absolute veto.
- Other providers remain unauthorized. Other external actions remain
  unauthorized, including post-upload visibility changes (ADR-0008 §3.8).
- No SaaS, multi-user, customer-facing or generalized authorization system is
  authorized. This is a decision for the Owner's private, single-owner engine.

This record records a **PUBLIC** standing authorization only. It does not record
a standing authorization for any other visibility.

## 4. Amendment / clarification of ADR-0008 §3.1

ADR-0008 §3.1 is **amended / clarified** as follows, and only as follows:

1. An Owner-controlled **standing authorization** for the class "publish/upload
   to YouTube" is a permitted form of the "explicit Owner-controlled
   authorization" required by §3.1 item 3, provided it satisfies the conditions
   below.
2. "Per external action" is satisfied when authorization is **evaluated for each
   individual external action** immediately before it executes (ADR-0008 §3.4)
   and freshly on every retry (ADR-0008 §3.5). A standing entry is never reused
   from an earlier check.
3. "Not for an entire run" is unchanged: a standing authorization is not granted
   by, scoped to, or created by a run.
4. This amendment extends only to publish/upload to YouTube. It does not
   extend to any other provider or external action class.

ADR-0008 §3.2 (Owner-controlled, independent of calling code, minimal), §3.3
(SIMULATION), §3.4 (timing), §3.5 (retry semantics), §3.6 (no mandatory human
approval), §3.7 (no new lifecycle state) and §3.8 (scope) are unchanged.

ADR-0008 §3.2 deferred the storage/representation of authorization data to
implementation, and the baseline resolved it as a flat JSON array of strings
(`src/state/SideEffectAuthorization.js` header). The **representation** of a
standing entry remains within that deferral and within §3.2's requirement to
stay minimal. It is not fixed by this record (section 13). The authorization
**scope** was not deferred by ADR-0008; it is what this section amends.

## 5. Existing safeguards (unchanged)

The standing authorization does **not** waive, weaken or bypass any of the
following. Each remains mandatory and independent of the authorization policy:

- Fact-Check, Originality and Quality Gate requirements;
- Rights Verification, including the Publication-time re-read of asset
  verification status (ADR-0017);
- Media Production validation;
- publication eligibility (`src/publication/eligibility.js`) and the
  `PRODUCED` entry-state requirement;
- the durable `PENDING` publication claim, made before any provider call;
- unique `(content_version_id, provider)` duplicate protection;
- `AMBIGUOUS` terminal handling (section 11);
- provider confirmation: `PUBLISHED` only with a confirmed provider item id;
- existing retry and quarantine rules (ADR-0023);
- single-run protection (ADR-0024);
- the SIMULATION veto (ADR-0008 §3.3);
- any authorization check performed immediately before the external side
  effect.

Authorization is, and must remain: Owner-controlled; independent of any
caller-provided authorization; evaluated at the point of the external action;
revocable (section 9); and auditable through the existing system.

## 6. Gate 2 prerequisite

ADR-0006 D-G8 records that **both** compliance gates are required. Gate 2, the
pre-publication / final compliance gate at
`PRODUCED -> FINAL_COMPLIANCE -> PUBLISHED`, is deferred and does not exist at
the baseline (`FINAL_COMPLIANCE` is not a state in `ContentStateMachine`).

The Owner decides:

- Gate 2 **remains REQUIRED** before activation of unattended PUBLIC YouTube
  publication. It is **not waived**, and ADR-0006 D-G8 is **not reinterpreted**.
- The standing PUBLIC authorization is **recorded now** as the Owner's intended
  authorization model.
- The standing authorization **MUST NOT be activated** for unattended PUBLIC
  publication until Gate 2 / `FINAL_COMPLIANCE` exists and its required
  compliance behavior has been implemented and validated.
- Until then, the Gate 2 deferral remains a **repository implementation
  limitation**, and the Owner-controlled authorization configuration must not
  contain a standing PUBLIC entry.
- The Owner alone determines when this prerequisite is satisfied. This record
  defines no Gate 2 requirement beyond the existing governance record
  (ADR-0006), and it authorizes **no implementation of Gate 2**.

## 7. LIVE authorization

The Owner explicitly authorizes LIVE operation of the existing autonomous media
engine, subject to the safeguards in section 5:

- `RUN_MODE=LIVE` may be used.
- `AUTONOMOUS_ENABLED=true` may be used.
- The configured YouTube credential may be used for the Owner's single
  configured YouTube channel.
- This is authorization for the existing single-owner engine, not for a
  multi-user or generalized platform.
- No scheduler and no continuous-operation implementation is authorized.

LIVE authorization does **not** activate the standing authorization and does not
bypass the Gate 2 prerequisite for PUBLIC activation (section 6), publication
eligibility, rights verification, media validation, durable publication claims,
duplicate protection, `AMBIGUOUS` handling, provider confirmation, retry and
quarantine rules, single-run protection, authorization checks, or the SIMULATION
veto. It does not authorize any change to credential management.

ADR-0023 §9 and ADR-0024 §8 record that those decisions did not authorize LIVE
YouTube publication or credentials. Their text is unchanged; this section
supplies the Owner's LIVE authorization for the scope stated here.

## 8. Provider-returned visibility requirement

The requested publication visibility under the standing authorization is
**PUBLIC**.

A publication must **not** be represented as a successful PUBLIC publication
merely because YouTube returned a provider video id. If the requested visibility
is PUBLIC but the provider-confirmed returned privacy status is **not** PUBLIC:

- the requested PUBLIC publication must not be claimed as successful;
- the result must not be silently relabelled as PUBLIC;
- the provider-confirmed visibility must be preserved as factual evidence;
- the mismatch must be routed through an explicit non-success / error handling
  path appropriate to the existing publication state machine;
- no new recovery or reconciliation policy is created by this record.

This decision does not authorize automatic post-upload visibility changes.

At the baseline, the YouTube adapter records the provider-returned
`privacyStatus` (`YouTubeAdapter.js`, `_interpretUploadResult`) and the
publication pipeline stores the result verbatim, but it does not compare the
returned value with a requested visibility and records `PUBLISHED` on any
confirmed video id. This is a baseline limitation, not a change made here.

Constraint carried from existing safeguards: whichever existing path is chosen
for the mismatch, it must not permit an automatic re-upload of the same content
version (unique `(content_version_id, provider)` protection; `FAILED` rows are
reclaimable by the baseline claim logic, `AMBIGUOUS` rows are not). Selecting
that path is an implementation decision (section 14, item 2).

## 9. Revocation mechanics

Two instruments exist and are distinct:

- **This ADR** is the durable governance decision: it records the Owner's
  policy. It does not itself authorize any publication.
- **The Owner-controlled authorization configuration**
  (`config/authorized_external_actions.json`, ADR-0008 §3.2) is the operative
  instrument. A standing authorization is in force only while its entry is
  present there, and the entry must not be added before the section 6
  prerequisite is satisfied.

The standing authorization remains in force until the Owner revokes it. The
**operative revocation act is removal of the standing authorization entry** from
the Owner-controlled authorization configuration. Removal takes effect at the
**next authorization check**, because the configuration is read fresh at every
check and on every retry (ADR-0008 §3.4, §3.5). Revocation does **not**
interrupt an external upload that has already passed the authorization boundary
and begun execution.

A later governance record may document a revocation, but a governance record is
not a precondition for removal to take effect.

## 10. Existing per-item authorization

Existing per-item authorization semantics are **preserved**. At the baseline, an
exact `publish:youtube:<contentVersionId>` entry authorizes that one action, and
the resulting upload uses the adapter's default visibility (`private`,
`YouTubeAdapter.js` constructor default; `providerRegistry.js` passes no
override). An existing explicit per-item entry must not be silently
reinterpreted as a standing authorization, and a standing authorization must
not silently change the meaning of an existing per-item grant.

If both a standing YouTube PUBLIC entry and an explicit per-item entry exist for
the same action, the implementation must apply a **deterministic precedence**.
The precedence itself is **not decided here**. The minimum implementation
decision required, flagged for the separate implementation-authorization step,
is: *when both grants match one action, which grant determines the requested
visibility, and how is the matching grant recorded for audit?* Whatever is
chosen must be deterministic and must not change what a per-item grant alone
authorizes (section 14, item 1).

## 11. AMBIGUOUS public publication

Existing `AMBIGUOUS` behavior is preserved unchanged. A live external upload can
have occurred without durable provider confirmation. Such a case remains
`AMBIGUOUS` and is **never automatically retried**, including an interrupted
`PENDING` attempt found on a later run. **No reconciliation tooling is
authorized** by this record; ADR-0024 §8 is unchanged.

## 12. Relationship to other records

- **ADR-0008:** §3.1 amended / clarified (section 4); all other sections
  unchanged; §6 continues to require a separate implementation authorization.
- **ADR-0009:** records the D-C2 implementation and later corrections. Any
  change to the implemented D-C2 mechanism requires its own implementation
  authorization.
- **ADR-0006 (D-G6, D-G8, D-G10):** unchanged. Gate 2 is not waived (section 6).
  The D-G6 disclosure determination and the D-G10 `NEEDS_REVIEW` exit
  transition remain deferred exactly as recorded there.
- **ADR-0010 and the autonomous-operation checkpoint:** the runner stage order
  and the frozen Publication stage call are unchanged by this record.
- **ADR-0012:** no standalone Publication v1 specification exists in
  `docs/SPECIFICATIONS/`; this record does not create one.
- **ADR-0017, ADR-0023, ADR-0024:** unchanged. Their "not authorized" lists are
  not prohibitions; where this record supplies an Owner authorization (LIVE
  operation, publication without a volume cap, public visibility as a recorded
  intent) it does so expressly and only as stated.

## 13. Implementation boundary

**No implementation authorization is created by this ADR.** No change is made
to `src/**`, `tests/**`, `config/**`, any migration, schema or dependency, and
no standing entry is added to `config/authorized_external_actions.json`. The
following remain **separately unauthorized** and each requires its own explicit
Owner implementation authorization (ADR-0008 §6):

- any change to `SideEffectAuthorization.js`, including the representation of a
  standing entry and any change to what the guard returns;
- any change to Publication, `PublicationRequest`, or the YouTube adapter,
  including carrying, validating or applying a requested visibility;
- the provider-returned-visibility mismatch handling (section 8);
- the precedence between standing and per-item grants (section 10);
- audit recording of which grant authorized an action;
- Gate 2 / `FINAL_COMPLIANCE`, and any `ContentStateMachine` change;
- reconciliation tooling for `AMBIGUOUS` outcomes;
- automatic post-upload visibility changes;
- a scheduler or continuous operation;
- any other provider or external action;
- any publication cap or expiry mechanism (none is chosen);
- the activation of the standing authorization itself.

## 14. Open items for the separate implementation-authorization step

1. **Precedence** when a standing PUBLIC entry and a per-item entry both match
   one action (section 10).
2. **Mismatch mapping:** which existing publication path handles a PUBLIC
   request whose provider-confirmed status is not PUBLIC, under the constraint
   in section 8 (`publications.status` is limited to
   `PENDING`/`PUBLISHED`/`FAILED`/`AMBIGUOUS`, and whether `content_versions`
   may reach `PUBLISHED` on such an outcome is not decided here).
3. **Representation** of the standing entry within ADR-0008 §3.2's minimality
   requirement, and how the authorized visibility reaches the adapter without
   the content item or provider being able to supply it.

None of these is decided by this record.

## 15. Final status

```text
ADR-0030: RECORDED, OWNER DECISION. Governance only. Amends / clarifies ADR-0008 §3.1.
Model B (standing, single-owner, YouTube, PUBLIC, no cap, no expiry) recorded.
PUBLIC activation GATED on Gate 2 (ADR-0006 D-G8); Gate 2 not waived, not implemented.
LIVE operation authorized for the existing single-owner engine, subject to all safeguards.
No implementation authorized. No authorization entry added. No file other than this ADR created.
```
