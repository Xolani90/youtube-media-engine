# ADR-0006: Monetization-Compliance Governance — Owner Ratification

## 1. Status

**RATIFIED — OWNER DECISION RECORDED — IMPLEMENTATION NOT AUTHORIZED**

Ratification establishes governance direction only. It does not authorize
implementation.

## 2. Owner authority

Project Owner: **Xolani Tshabalala**.

The fourteen decision points recorded in §4 were supplied explicitly by the Owner. They
are recorded here exactly as given — not reinterpreted, improved, weakened, or
broadened. Where a decision text below reads as a direct restatement of the Owner's
wording, that is intentional: this document's function is to make the Owner's decisions
part of the durable governance record, not to add new judgment on top of them.

Ratifying a governance decision is not the same act as authorizing its implementation.
Every decision below establishes *what the Owner has decided should eventually be built*;
none of them are, by virtue of this document, being built now.

## 3. Baseline

```text
Repository   = Xolani90/youtube-media-engine
HEAD         = 4294d4204af0af7bfbace5b3ee89969c0212a8ce
origin/main  = 4294d4204af0af7bfbace5b3ee89969c0212a8ce
working tree = clean, except the pre-existing untracked ADR-0005 file
```

## 4. Relationship to ADR-0005

`docs/DECISIONS/0005-proposed-monetization-compliance-governance.md` was the proposed
governance specification: twelve D-G decisions plus a two-item further-question set
(the `QUALITY_GATE`/Risk-stage question, and the `NEEDS_REVIEW` exit-transition
question), each offered to the Owner with evidence, options, and — where one existed —
an AI recommendation marked `PROPOSED — REQUIRES OWNER RATIFICATION`.

This document, ADR-0006, records the Owner's decisions on that proposal.

- Where ADR-0005 offered a recommendation, the Owner has accepted it, and that
  acceptance is recorded explicitly below rather than left implicit.
- Where ADR-0005 deliberately left a question open for the Owner rather than
  recommending an answer, the Owner has now resolved it:
  - **`QUALITY_GATE` vs ADR-0001 "Risk" stage** → Risk remains a separate, unrealized
    stage.
  - **`NEEDS_REVIEW` exit transition** → deferred.
- ADR-0006 supersedes the *"Owner decision required"* status of the D-G1–D-G12
  proposals by recording that the Owner has now decided them. It does not supersede or
  alter any decision outside that scope.
- **ADR-0005 itself remains unchanged.** It is not modified, deleted, or reworded by
  this document. It stands as the historical record of the proposal that was ratified.

## 5. Ratified decisions

Each entry states the Owner's decision exactly, then the architectural consequence that
decision establishes as governance direction, then whether it carries any
implementation authorization (none do).

---

### Architectural Decision A — `QUALITY_GATE` vs ADR-0001 "Risk" stage

**Owner decision:** Interpretation 2 — Risk is a separate, unrealized stage.
`risk_assessments` remains untouched.

**Recorded:**
- `QUALITY_GATE` is **not** being declared to be ADR-0001's Risk stage.
- The Risk stage described in ADR-0001's M0 chain remains unrealized — no state named
  `RISK` exists in `ContentStateMachine.STATES`, and none is authorized by this
  ratification.
- `risk_assessments` (defined in `0001_init.sql`) remains reserved for that unrealized
  Risk stage, consistent with the Fact-Check specification's repeated statement that the
  table "remains Risk's alone."
- Monetization compliance must not repurpose, read, or write `risk_assessments` under
  this ratification.
- This does not authorize implementation of a Risk stage, now or later, without separate
  authorization.

**Implementation authorization:** None.

---

### D-G1 — Compliance/Originality Stage

**Owner decision:** A — `FACT_CHECK → ORIGINALITY_CHECK → QUALITY_GATE`.

**Recorded:**
- `ORIGINALITY_CHECK` and `QUALITY_GATE` remain separate stages, not merged and not
  replaced by a newly inserted state.
- The existing reserved ordering already present in `ContentStateMachine.STATES` is
  accepted as the ratified structure.
- No `ContentStateMachine` implementation, wiring, or transition logic is authorized by
  this ADR.

**Implementation authorization:** None.

---

### D-G2 — Asset/Rights Provenance

**Owner decision:** D — asset-level registry plus a usage relationship; `sources`
unchanged; construction deferred until Production.

**Recorded:**
- Rights and provenance are to be represented at the **asset level**, not at the
  content level or as an extension of `sources`.
- Asset-to-content usage is to be represented through a distinct usage relationship.
- The existing `sources` table (research-source provenance) remains unchanged and is not
  repurposed for media rights.
- Construction of any asset registry, usage-relationship table, or related schema is
  **explicitly deferred until Production/D-C2 is separately authorized**.
- This ratification does not authorize any asset-registry implementation.

**Implementation authorization:** None. Explicitly gated behind D-C2, which remains
deferred (§6).

---

### D-G3 — RiskPolicy Extension

**Owner decision:** A — extend `RiskPolicy.FLAG_SEVERITY` with monetization flags;
PASS/REVIEW/BLOCK mapping remains in the compliance stage, not in `RiskPolicy`.

**Recorded:**
- The single existing severity vocabulary (`RISK_LEVELS`: `PASS` / `WARNING` /
  `CRITICAL`, via `FLAG_SEVERITY` and `evaluateFlags()`) is the ratified place for
  monetization-relevant flags, consistent with the precedent already set by
  `src/discovery/riskGate.js`.
- **The distinction between severity/flag vocabulary and compliance outcome is
  preserved.** `RiskPolicy` continues to answer "how severe is this flag" (PASS /
  WARNING / CRITICAL); it does not itself decide PASS / REVIEW / BLOCK for a piece of
  content. That three-way compliance outcome (ratified under D-G7) is computed in the
  compliance stage, consuming `RiskPolicy` flags as one input among several.
- No fourth severity level, and no second/parallel severity framework, is authorized or
  implied.
- No `RiskPolicy` source change is authorized by this ADR.

**Implementation authorization:** None.

---

### D-G4 — Policy Versioning

**Owner decision:** C — hybrid: versioned JSON policy packs, with policy-pack version and
evaluated rule IDs persisted per compliance decision.

**Recorded:**
- JSON policy packs are the ratified **authored representation** of policy rules,
  consistent with the existing `config/*.json` + `"version"` convention.
- Each compliance decision is to retain the policy-pack version and the specific rule
  IDs it evaluated against — not the whole pack — for reproducibility.
- This is a governance decision about *representation*, not a persistence design. No
  policy-pack schema, no policy file, and no persistence mechanism is authorized by this
  ADR.

**Implementation authorization:** None.

---

### D-G5 — Originality vs Quality Gate

**Owner decision:** a — separate `ORIGINALITY_CHECK` and `QUALITY_GATE` stages, with a
one-directional dependency.

**Recorded:**
- The two stages remain separate, each owning distinct concerns (originality/
  repetition/reuse/provenance signals in one; adjudication in the other), per ADR-0005
  §7 D-G5.
- **No composite "AI quality score" is authorized.** Multiple compliance dimensions
  (originality, factual correctness, rights, advertiser suitability, production
  readiness) must not be collapsed into a single scalar. This prohibition is ratified
  explicitly, not left as an implementation preference.

**Implementation authorization:** None.

---

### D-G6 — AI/Synthetic Disclosure

**Owner decision:** Determinations 1–5 accepted exactly as proposed in ADR-0005.

**Recorded, verbatim in substance:**
1. Record AI usage provenance only; `provider_calls` remains the authoritative record of
   which model/provider generated which artifact.
2. The disclosure *determination* itself (whether content contains realistic
   meaningfully-altered or synthetic media requiring disclosure) is deferred until
   Production exists.
3. A hard block applies only at Gate 2, and only where realistic synthetic media
   requires disclosure and that disclosure has not been recorded.
4. Uncertainty about realism or meaningfulness of an alteration routes to REVIEW, not an
   automatic determination either way.
5. Retained evidence, once applicable: the generating model/provider, the disclosure
   determination and its reason, the policy version under which it was made, and the
   disclosure state eventually submitted at upload.
- The Production/D-C2 boundary is preserved: none of items 2, 3, or 5 can be acted on
  before Production is separately authorized.
- No disclosure logic, detection mechanism, or Studio-upload integration is authorized
  by this ADR.

**Implementation authorization:** None. Items 2, 3, and 5 additionally gated behind
D-C2/Production.

---

### D-G7 — Compliance Enforcement Model

**Owner decision:** Three-way PASS/REVIEW/BLOCK model accepted. Vocabulary: **ii** —
`BLOCK` used in a new compliance record. Score magnitude alone must never produce BLOCK.

**Recorded:**
- **PASS** = no known disqualifying condition and no material unresolved question.
- **REVIEW** = uncertainty requiring human judgment; autonomy stops here.
- **BLOCK** = a certain, confirmed disqualifying condition.
- The vocabulary `BLOCK` is used specifically for the new compliance record and is
  **distinct from, and does not replace,** the existing `REJECT` terminology already in
  use by `fact_checks.status` and `risk_assessments.status`. Those existing CHECK
  constraints and their `REJECT` value are not touched by this ratification.
- Ratified explicitly: a risk-score magnitude, however high, must never by itself
  produce a BLOCK outcome. Certainty about a disqualifying condition is the governing
  test, not severity.
- No compliance-record schema, table, or evaluation logic is authorized by this ADR.

**Implementation authorization:** None.

---

### D-G8 — Two-Stage Compliance Gate

**Owner decision:** Both gates required.

**Recorded:**
- **Gate 1** — pre-production compliance gate, evaluated at
  `ORIGINALITY_CHECK → QUALITY_GATE → PRODUCTION_READY`, using evidence available before
  production (research, sources, brief, script, fact-check, originality signals,
  reuse/provenance status, known policy risks, known AI usage).
- **Gate 2** — pre-publication/final compliance gate, evaluated at
  `PRODUCED → FINAL_COMPLIANCE → PUBLISHED`, using evidence only available after
  production (final video, final audio, title, thumbnail, description, tags, actual
  media assets).
- Gate 2 exists because YouTube's advertiser-friendly guidelines evaluate the final
  package — video, thumbnail, title, description, and tags — none of which exists at
  Gate 1.
- **A Gate 1 PASS is not, and must never be represented as, publication approval.**
- Gate 2 and its `FINAL_COMPLIANCE` state remain **deferred behind D-C2/Production**,
  consistent with §6.
- No Production, Publishing, or state-machine implementation is authorized by this ADR.

**Implementation authorization:** None. Gate 2 additionally gated behind D-C2.

---

### D-G9 — Compliance Audit Trail

**Owner decision:** C — `decision_log` records the decision event; a dedicated
append-only compliance record stores structured evidence; authoritative evidence is
referenced rather than duplicated.

**Recorded:**
- `decision_log` remains the audit mechanism for the *decision event itself* (that a
  compliance decision occurred, its outcome, reason, confidence, stage, resulting state,
  and config snapshot) — no new mechanism replaces it.
- A future dedicated compliance record is the ratified location for structured evidence
  that `decision_log`'s flat shape cannot hold (policy-pack version, rule IDs evaluated,
  per-signal values and confidences, advertiser-suitability assessment, AI-disclosure
  determination, human-review outcome).
- Evidence already owned elsewhere — Fact-Check results, research sources, rights
  records, model/provider attribution — is to be **referenced**, not duplicated, by the
  compliance record.
- Consistent with Architectural Decision A: `risk_assessments` remains untouched and is
  not the destination for this evidence.
- No new table, migration, or persistence mechanism is authorized by this ADR.

**Implementation authorization:** None.

---

### D-G10 — Human Review Boundary

**Owner decision:** Accept the proposed boundary.

**Recorded:**
- Every REVIEW outcome requires human review before the content may proceed.
- A reviewer may resolve REVIEW to PASS.
- A reviewer may resolve REVIEW to BLOCK.
- **A reviewer may not override a BLOCK** reached independently of review — BLOCK is
  reserved for conditions the system is certain about, and overriding it should require
  changing the underlying facts, not the verdict.
- Review decisions expire when the reviewed content changes; a subsequent change to
  script, media, or metadata invalidates a prior review and requires re-evaluation.
- **Critically, this ratification does not authorize the state-machine mechanism
  required to operationalize any of these transitions.** See D-G10 — `NEEDS_REVIEW` exit
  transition, immediately below, which governs that mechanism separately.

**Implementation authorization:** None.

---

### D-G10 — `NEEDS_REVIEW` exit transition

**Owner decision:** Defer.

**Recorded:**
- No `ContentStateMachine` change is authorized now.
- `ContentStateMachine.canTransition()` currently permits only forward transitions
  between states present in `ORDER`; `FAILURE_STATES` (including `NEEDS_REVIEW`) are not
  in `ORDER`, so there is presently no legal transition out of `NEEDS_REVIEW`. This
  ratification does not resolve that condition.
- The lifecycle for exiting `NEEDS_REVIEW` remains unresolved at the implementation
  level and will be handled under a **separately authorized architectural change**,
  coordinated with D-C2/Production.
- No transition is to be created. `ContentStateMachine` is not to be modified under this
  ratification.
- This is recorded as a **deferral** — it is neither an authorization to make the change
  nor a refusal to ever make it.

**Implementation authorization:** None. Explicitly deferred pending a separate
architectural authorization.

---

### D-G11 — Discovery vs Final Compliance

**Owner decision:** Propositions 1–3 accepted.

**Recorded:**
1. Discovery remains an early, opportunity-level screen, evaluated before content
   exists.
2. Final compliance independently reassesses the actual content, as if Discovery had
   never run.
3. Discovery and final compliance may share a signal vocabulary (per D-G3's ratified
   `RiskPolicy` extension) but remain two separate gates evaluating two different
   subjects at two different times.
- **A Discovery PASS can never pre-authorize publication.**
- No Discovery-pipeline implementation change is authorized by this ADR.

**Implementation authorization:** None.

---

### D-G12 — YouTube Policy Drift

**Owner decision:** B — re-evaluate in-flight unpublished content automatically;
re-evaluate published content only on explicit Owner designation; never perform a
blanket recheck of all published content.

**Recorded:**
- Unpublished content still in the pipeline is to be re-evaluated automatically against
  the current policy-pack version, since no publication cost has yet been incurred.
- Published content is re-evaluated **only** when the Owner explicitly designates a
  specific policy change as material to specific content — never automatically and never
  as a blanket recheck of the back catalogue.
- Policy interpretation — turning a detected YouTube policy change into rule edits — 
  remains Owner-controlled and is never autonomous. The engine may surface that the
  official changelog has changed; it does not interpret that change into policy-pack
  edits by itself.
- Historical compliance decisions remain historical records of what was decided and why,
  under the policy-pack version in force at the time; they are not retroactively
  invalidated by a later policy change.
- No re-evaluation automation, policy-drift detection mechanism, or policy-pack tooling
  is authorized by this ADR.

**Implementation authorization:** None.

---

## 6. Closed and deferred boundaries — preserved unchanged

This ratification changes none of the following. They are restated here for the audit
record, not reopened, reinterpreted, or modified.

**Closed (unchanged):**
- D-B1 — LLMRouter-level cost enforcement.
- D-B2 — cumulative per-content cost enforcement.
- D-D1 — prompt trust boundary.
- D-D2 — derived-content trust boundary.

**Deferred (unchanged):**
- D-B3 — monthly budget enforcement.
- D-C2 — stronger side-effect authorization for Production/Publishing.
- D-E.
- D-F.

**D-C2 remains deferred.** As a direct consequence:
- Production remains entirely outside this ratification.
- Publishing remains entirely outside this ratification.
- `FINAL_COMPLIANCE` implementation (Gate 2, D-G8) remains outside this ratification.
- Asset acquisition and any asset-registry construction (D-G2) remains outside this
  ratification.
- No paid-provider work of any kind is authorized by this ratification.

## 7. Future architecture direction

**RATIFIED GOVERNANCE DIRECTION — NOT IMPLEMENTED**

```text
FACT_CHECK
    ↓
ORIGINALITY_CHECK
    ↓
QUALITY_GATE
    ↓
PRODUCTION_READY
    ↓
PRODUCTION            ← deferred behind D-C2; not authorized
    ↓
FINAL_COMPLIANCE       ← deferred behind D-C2; not authorized;
    ↓                    state does not yet exist in ContentStateMachine
PUBLISHED
```

This diagram shows the direction the Owner has ratified, not implemented architecture.
Specifically:

- `FACT_CHECK → ORIGINALITY_CHECK → QUALITY_GATE → PRODUCTION_READY` uses states already
  reserved in `ContentStateMachine.STATES`; none of them are wired, and no transition
  logic exists.
- `PRODUCTION` remains deferred; no production capability exists or is authorized.
- `FINAL_COMPLIANCE` remains deferred and does not currently exist as a state; its
  insertion would renumber `PUBLISHED`, `ANALYZING`, and `LEARNED`, and requires its own
  explicit authorization alongside D-C2.
- The necessary `ContentStateMachine` changes for any of the above — including the
  `NEEDS_REVIEW` exit transition — are not authorized by this document.

## 8. Human review boundary (consolidated)

Per D-G10: every REVIEW outcome stops autonomous progress and requires a human decision.
A reviewer may resolve REVIEW to PASS or to BLOCK; a reviewer may not override an
independently-reached BLOCK; review decisions expire when the reviewed content changes.
The mechanism by which content exits `NEEDS_REVIEW` in the state machine is separately
deferred (D-G10 — `NEEDS_REVIEW` exit transition) and is not resolved by this section.

## 9. Policy-versioning direction (consolidated)

Per D-G4: JSON policy packs, versioned, are the ratified authored representation of
policy rules. Per D-G12: policy interpretation is Owner-controlled and never autonomous;
in-flight content is re-evaluated automatically on a policy-pack change, published
content only on explicit Owner designation. No schema, file, or automation is authorized.

## 10. Implementation Authorization Boundary

This ADR does **NOT** authorize:

- source-code changes
- database migrations
- new tables
- configuration changes
- policy files
- `ContentStateMachine` changes
- `RiskPolicy` changes
- `risk_assessments` changes
- Fact-Check changes
- Production
- Publishing
- `FINAL_COMPLIANCE` implementation
- asset registry implementation
- human-review workflow implementation
- policy re-evaluation automation implementation
- new dependencies
- tests beyond documentation validation
- refactors
- D-B3
- D-C2
- D-E
- D-F

Any implementation of any decision recorded in §5 must receive a **separate, explicit
implementation authorization** after this ratification. Ratification is not that
authorization.

## 11. Governance consequences

- The `PROPOSED — OWNER DECISION REQUIRED — NOT IMPLEMENTED` status attached to
  ADR-0005's D-G1–D-G12 proposals is now superseded, for those twelve decisions, by the
  Owner's ratification recorded in §5 of this document.
- ADR-0005 itself is unmodified and remains the historical record of the proposal.
- No claim is made, or should be inferred, that monetization compliance has been
  implemented.
- No claim is made, or should be inferred, that YouTube monetization is guaranteed for
  any content the engine produces now or in the future. YouTube retains the final
  monetization decision in all cases.
- The engine's actual behavior is unchanged by this document. Every stage, table, and
  transition described above as "ratified direction" remains exactly as unimplemented as
  it was before this ADR.

## 12. Final status

```text
RATIFIED — OWNER DECISION RECORDED — IMPLEMENTATION NOT AUTHORIZED
```
