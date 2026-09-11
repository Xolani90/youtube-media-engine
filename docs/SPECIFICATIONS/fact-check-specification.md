# Fact-Check Specification

Status: DRAFT — UNDER RECONCILIATION (not committed, not approved, not frozen)
Depends on: Script stage (as implemented), Research stage (as implemented)
Does not depend on: Risk stage, Originality stage

Provenance note: this document is being added to the repository for the
first time as part of a specification-reconciliation task. No prior
version of this file existed in this repository. Two open items from that
reconciliation are marked inline below (P1, P2); P2 is resolved in this
revision, P1 is explicitly left unresolved pending a further Owner
decision — see the marked block in §14 and the new §14a.

## 1. Purpose

Fact-Check is a manual-trigger, deterministic verification stage that evaluates
a persisted Script against the Research evidence originally used to produce
it, and records a structured, versioned result. It exists to catch factual
drift or unsupported claims before a Script is allowed to advance toward
production.

## 2. Stage position

```
... → SCRIPT_DRAFT → FACT_CHECK → ORIGINALITY_CHECK → ...
```

Fact-Check is the gate immediately downstream of Script and upstream of
Originality. It is a distinct stage from Risk: Risk owns `risk_assessments`
and its own policy; Fact-Check owns `fact_checks` and its own decision logic.
Neither stage depends on the other.

## 3. Inputs

- The current persisted Script for a `script_id` (the row/version considered
  "current" by the existing Script stage contract).
- The Script's `claim_links`, which reference claims in the Research project
  that produced the Script.
- The Research project's persisted claims and their evidence status, as
  written by the Research stage. Fact-Check reads this data; it does not
  write to it.

Fact-Check does not accept ad hoc or externally supplied evidence. It only
evaluates what is already persisted by Research for the Script's originating
Research project.

## 4. Eligibility

### 4a. Definition of "current Script"

Throughout this specification, "the current Script" for a content item
means exactly: the `scripts` row identified by
`content_versions.script_id` for that content item's `content_versions`
row. This is the sole authoritative pointer.

Fact-Check MUST use `content_versions.script_id` and must not independently
derive "current" by, e.g., selecting the highest-`version` row from
`scripts` for a given `content_brief_id` (`ORDER BY version DESC LIMIT 1`).
That query is used internally by the Script stage's own pipeline as an
implementation detail of how it maintains `content_versions.script_id`, but
it is not a second definition of currentness that Fact-Check is permitted
to rely on independently — `content_versions.script_id` is expected to
already reflect it, and is the only value Fact-Check reads.

### 4b. Eligibility conditions

A Script is eligible for Fact-Check evaluation when:

- a current Script (§4a) exists for the given content item;
- the Script has a well-formed `claim_links` collection (see §11 for what
  "well-formed" means);
- every referenced claim ID resolves to a claim belonging to the Research
  project that produced this Script (not an unrelated Research project).

If any of these conditions fail, the request is a **structural failure**
(§11), not a Fact-Check `REJECT`.

## 5. Claim resolution

There is no direct `scripts.research_project_id` column. The originating
Research project for a Script MUST be resolved through exactly this join
path, and no other:

```
scripts.content_brief_id
  → content_briefs.research_project_id
    → claims.research_project_id
```

Concretely: given the current Script row, its `content_brief_id` identifies
the `content_briefs` row, whose `research_project_id` identifies the
authoritative Research project. Every claim referenced by the Script's
`claim_links` must belong to that project (`claims.research_project_id`
equal to that value).

Rules:

- Claims are resolved only from the Research project reached via the join
  path above. Fact-Check must not resolve, substitute, or fall back to
  claims from any other Research project, and must not infer a Research
  project from the claim IDs themselves (e.g. by searching for matching
  claim IDs across all projects). The project is always derived from the
  Script's own `content_brief_id`, never from the claims being looked up.
- Every claim ID in `claim_links` must resolve to an existing claim whose
  `research_project_id` matches the project resolved above. A claim ID that
  does not resolve, or that resolves to a claim in a different Research
  project, is a structural failure, not a missing/unsupported finding (see
  §11).
- Fact-Check does not fabricate claims that are absent from `claim_links`,
  and does not infer additional claims from Script prose.
- Fact-Check MUST NOT introduce a new Script-to-Research foreign key; the
  join above is performed at read time through the existing schema.

## 6. Research evidence resolution

For each resolved claim, Fact-Check reads two pieces of existing,
authoritative Research state, exactly as persisted:

1. `claims.evidence_status`, one of `VERIFIED`, `PARTIALLY_SUPPORTED`,
   `UNSUPPORTED`, `CONTESTED`.
2. Any applicable `claim_relations` row with `relation_type = 'CONTRADICTS'`
   where the resolved claim is either `claim_id` or `related_claim_id`
   (the relation is undirected) and the other side of the relation also
   belongs to the same Research project resolved in §5. A `CONTRADICTS`
   relation whose other side belongs to a different Research project is
   not applicable and must not be considered — this prevents
   cross-project relationship leakage.

Fact-Check:

- must not modify Research claims, `evidence_status`, or `claim_relations`;
- must not manufacture evidence status for a claim that Research has not
  evaluated;
- must not invent claim relationships that Research did not record;
- treats Research's evidence state as ground truth for the purposes of this
  evaluation.

## 7. Finding vocabulary

For each resolved claim, Fact-Check produces one finding. A finding is a
record containing at minimum:

- the claim identifier;
- the section heading in the Script where the claim is used, **when
  available** (see §7a — heading is an optional field, not a required one);
- the finding itself — Fact-Check's own per-claim severity, expressed in
  Fact-Check's own vocabulary rather than Research's internal representation
  or Risk's vocabulary. The per-claim severity vocabulary is exactly
  `PASS-compatible`, `REVIEW`, `REJECT` (see §8 for how each claim is
  assigned one of these).

Fact-Check owns this per-claim finding vocabulary. It is derived from, but
not identical to, Research's evidence states, and it is not shared with or
imported from RiskPolicy.

### 7a. Heading is optional (P2 reconciliation)

A `claim_links` entry MAY omit `heading`, or supply an empty/absent value.
This is not malformed input and MUST NOT be treated as a structural failure
under §11.

Representation rule:

- When a `claim_links` entry has no heading, the corresponding persisted
  finding's `section_heading` field is **omitted from the finding object
  entirely** (not present as a key), rather than persisted as `null` or as
  an empty string. This matches the "at minimum" framing of the finding
  record above — `section_heading` is not one of the fields a finding is
  guaranteed to carry.
- When a `claim_links` entry does supply a heading, the finding's
  `section_heading` field is present and populated exactly as before.
- An empty-string heading (`heading: ""`) is valid input (§11) but is
  treated as absent for decision-output purposes: the finding's
  `section_heading` key is omitted, exactly as for a fully absent heading.
- If `heading` is supplied but is not a string (of any length, including
  empty), this is a structural failure (§11), reported as
  `CLAIM_LINKS_INVALID_HEADING_TYPE` — distinct from, and not a
  reintroduction of, the removed `CLAIM_LINKS_MISSING_HEADING` failure,
  which applied to mere absence and no longer exists.
- Absence of a heading has no effect on claim identification or on the
  per-claim severity determination (§8) — those are computed identically
  regardless of whether a heading is present.
- The `findings` JSON persisted to `fact_checks.findings` (§9) follows this
  same rule: some array elements may have a `section_heading` key and
  others may not, depending on whether the source `claim_links` entry
  supplied one. This is a valid, deterministic representation — it does not
  make two runs over the same input non-deterministic, since the presence
  or absence of the key is itself fully determined by the input.

## 8. Decision rules

The persisted overall Fact-Check status is exactly one of:

- `PASS`
- `REVIEW`
- `REJECT`

No other persisted status may exist.

### Per-claim severity mapping

Each resolved claim's `evidence_status` (§6) maps to a per-claim severity
exactly as follows. This mapping is exhaustive and MUST NOT be altered or
extended by implementation:

| `claims.evidence_status` | Per-claim severity |
|---|---|
| `VERIFIED` | `PASS-compatible` |
| `PARTIALLY_SUPPORTED` | `REVIEW` |
| `UNSUPPORTED` | `REJECT` |
| `CONTESTED` | `REJECT` |

In addition, if the resolved claim has an applicable `CONTRADICTS` relation
(§6) to another claim in the same Research project, that claim's per-claim
severity is `REJECT`, **regardless of its own `evidence_status`** — an
applicable `CONTRADICTS` relation is never overridden by an otherwise
`VERIFIED` status.

### Overall decision (worst-case-wins)

The overall decision is computed deterministically from the set of
per-claim severities using worst-case-wins, ordered:

```
REJECT  (most severe)
REVIEW
PASS    (least severe)
```

Concretely:

- If every resolved claim's severity is `PASS-compatible`, the overall
  decision is `PASS`.
- If no resolved claim's severity is `REJECT`, and at least one is
  `REVIEW`, the overall decision is `REVIEW`.
- If at least one resolved claim's severity is `REJECT` (whether from
  `UNSUPPORTED`, `CONTESTED`, or an applicable `CONTRADICTS` relation), the
  overall decision is `REJECT`, regardless of how many other claims were
  `PASS-compatible`.

This logic is independent of, and must not import or depend on, RiskPolicy.
Risk's worst-case-wins pattern is used as a conceptual precedent only;
Fact-Check's implementation must own its own decision function and finding
vocabulary — the table above, not Risk's, is authoritative for Fact-Check.

Decision evaluation is deterministic: the same Script version and the same
underlying Research evidence state must always produce the same findings and
the same overall status.

## 9. Persistence

Fact-Check results are persisted to a dedicated table:

```sql
CREATE TABLE fact_checks (
  id TEXT PRIMARY KEY,
  script_id TEXT NOT NULL REFERENCES scripts(id),
  version INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('PASS', 'REVIEW', 'REJECT')),
  findings TEXT NOT NULL,
  notes TEXT,
  created_at TEXT NOT NULL
);

CREATE UNIQUE INDEX idx_fact_checks_script_id_version
  ON fact_checks(script_id, version);
```

Column notes:

- `id` — primary key, following existing repository ID conventions.
- `script_id` — references the persisted Script; a Fact-Check result always
  belongs to exactly one Script.
- `version` — an explicit integer, append-only, scoped per `script_id`. Not
  derived from or interchangeable with timestamps.
- `status` — exactly one of `PASS`, `REVIEW`, `REJECT`.
- `findings` — required, persisted as a JSON array. Each element contains
  the claim identifier, the section heading where available (§7a), and the
  finding for that claim (§7).
- `notes` — optional free-text field.
- `created_at` — required, following existing repository timestamp
  conventions.

`risk_assessments` is not read, written, or referenced by Fact-Check in any
way.

`(script_id, version)` uniqueness is enforced at the database level via the
unique index above, not merely in application logic.

## 10. Versioning / reruns

- Fact-Check results are append-only: an existing `fact_checks` row is
  never updated or deleted by normal operation.
- Each `script_id` has its own independent version sequence, starting at 1.
- A different Script version (a new current Script for the same or a
  different `script_id`, per the Script stage's own versioning) starts its
  own independent Fact-Check history; a Fact-Check result recorded against
  an older Script version does not carry forward.
- A forced rerun creates a new Fact-Check result at the next version number
  for that `script_id`. It never overwrites a prior result.
- An ordinary, non-forced rerun request returns the most recent existing
  persisted result for the current Script version's `script_id`, per the
  version sequence, rather than creating a new row.
- Version ordering (the integer `version` column), not `created_at`
  timestamps, is the authoritative ordering mechanism for "most recent."
- Database-level uniqueness on `(script_id, version)` is what prevents two
  concurrent writers from producing duplicate versions; version allocation
  must be implemented so that it relies on this constraint (e.g. by letting
  a conflicting insert fail) rather than assuming allocation is inherently
  race-free.

## 11. Malformed-input / structural-failure behavior

The following are structural failures, distinct from a persisted `REJECT`:

- `claim_links` is missing, not a valid collection, or otherwise malformed;
- `claim_links` contains an entry of the wrong data type;
- `claim_links` contains an entry whose `heading` is present but not a
  string (`CLAIM_LINKS_INVALID_HEADING_TYPE`) — a distinct case from mere
  absence, which is explicitly not a structural failure (§7a);
- `claim_links` contains a claim ID that does not resolve to any claim in
  the originating Research project;
- `claim_links` references a claim belonging to a different Research
  project than the one that produced the Script;
- `claim_links` contains duplicate references where the specification's
  resolution model (§5) requires distinct claims.

A `claim_links` entry with an absent or empty `heading` is explicitly NOT a
structural failure (§7a).

On structural failure:

- no `fact_checks` row is persisted;
- no lifecycle transition occurs (state remains `SCRIPT_DRAFT`);
- exactly one `decision_log` entry is written, using the repository's
  existing `decision_log` convention (the same shape/discipline as Script's
  and Brief's `logDecision` helpers — `stage` is a first-class column, never
  encoded into `decision`/`reason`), with these fields:

  | `decision_log` field | Value |
  |---|---|
  | `stage` | `'FACT_CHECK'` |
  | `subject_type` | `'script'` |
  | `subject_id` | the current Script's `id` (§4a) |
  | `decision` | `'STRUCTURAL_FAILURE'` |
  | `reason` | a deterministic, structured description of which structural check failed (e.g. which claim ID did not resolve, or which project mismatch occurred) |
  | `resulting_state` | `'SCRIPT_DRAFT'` |

  Other `decision_log` columns (`run_id`, `provider`, `config_snapshot`,
  `confidence`, `risk_level`, `created_at`) follow the repository's existing
  conventions for optional/derived fields; no new `decision_log` column is
  introduced.

  `STRUCTURAL_FAILURE` is explicitly not a persisted Fact-Check status (§8)
  — it never appears in `fact_checks.status`, only in `decision_log.decision`.

- a structured failure is returned to the caller, distinguishable from a
  persisted `REJECT` result.

Open item (P3-B, not resolved by this revision): the field table above
presumes a current Script already exists, and therefore a `script`
`subject_type`/`subject_id` to log against. When eligibility fails because
no current Script exists at all (§4b), there is no Script id available.
This case is not addressed by the table above and remains an open
documentation question.

## 12. Lifecycle behavior

Fact-Check uses the existing `FACT_CHECK` lifecycle state already defined
in `src/state/ContentStateMachine.js`. No new lifecycle state is
introduced.

| Fact-Check outcome   | Persistence            | Lifecycle transition          |
|----------------------|-------------------------|--------------------------------|
| `PASS`               | `fact_checks` row written | `SCRIPT_DRAFT → FACT_CHECK` |
| `REVIEW`             | `fact_checks` row written | `SCRIPT_DRAFT → FACT_CHECK` |
| `REJECT`             | `fact_checks` row written | remains `SCRIPT_DRAFT`      |
| Structural failure   | no row written            | remains `SCRIPT_DRAFT`      |

This table describes the outcome of a Fact-Check run evaluated against a
Script that is still at `SCRIPT_DRAFT` at the time of that run. See §14a
for the currently unresolved question of what happens when a later,
forced rerun against a Script already at `FACT_CHECK` produces `REJECT`.

Transitions must go through the existing state-machine conventions
(`src/state/ContentStateMachine.js`) rather than mutating stored state
directly.

## 13. Atomicity requirement

When the outcome is `PASS` or `REVIEW`, persistence of the `fact_checks` row
and the `SCRIPT_DRAFT → FACT_CHECK` lifecycle transition must occur within a
single atomic transaction. Either both succeed or neither is applied: a
partial state where a result is persisted but the lifecycle did not advance
(or vice versa) must not be possible.

When the outcome is `REJECT`, persistence of the `fact_checks` row occurs
without any lifecycle transition (state simply remains `SCRIPT_DRAFT`); this
persistence is not required to share a transaction with anything else, since
there is no accompanying state change to keep atomic with it.

This requirement extends to whatever lifecycle behavior §14a eventually
defines: once that behavior is specified, its transition (if any) and its
`fact_checks` row must also be atomic with each other, for the same reason.

## 14. Current-Script-version invariant

The following invariant must hold and must be the only invariant Fact-Check
exposes downstream:

> If `content_versions.state = FACT_CHECK` for a given content item, then
> `content_versions.script_id` for that content item's current content
> version identifies a Script for which a persisted `fact_checks` row
> exists with `fact_checks.script_id` equal to that same `scripts.id` and
> `status` in (`PASS`, `REVIEW`).

"Current Script" here uses the §4a definition (`content_versions.script_id`)
exclusively; no other notion of currentness satisfies this invariant.

Consequences for implementation:

- A `fact_checks` row is only valid evidence for this invariant if its
  `script_id` matches the exact value of `content_versions.script_id` at
  the time the invariant is checked. A Fact-Check result recorded against a
  Script version that is no longer pointed to by `content_versions.script_id`
  must not be treated as satisfying this invariant for a newer Script
  version, even if it belongs to the same `content_brief_id`.
- Advancing lifecycle state must only ever happen for the exact Script
  identified by `content_versions.script_id` at the time of evaluation; the
  implementation must not advance the wrong Script/content version.

**P1 reconciliation note:** as literally written, this invariant is
satisfied by the existence of *any* persisted PASS/REVIEW row for the
current `script_id` — it does not require that row to be the *latest* one
for that `script_id`. The Owner has decided (P1 = Option B) that this
literal reading is insufficient: a later `REJECT` against the same current
`script_id` must not leave the Script appearing to have successfully
cleared Fact-Check. That decision is recorded here, but its implementation
is deliberately incomplete — see §14a.

## 14a. Lifecycle destination after a later REJECT — OWNER DECISION PENDING

This section is new in this revision and intentionally does not resolve
the question it raises. **Do not implement against this section until it
is completed by an explicit Owner decision.**

**Decided:** a forced Fact-Check rerun against a Script's current
`script_id` that produces `REJECT` after an earlier `PASS`/`REVIEW` on that
same `script_id` must change `content_versions.state` away from
`FACT_CHECK` — the Script must no longer appear to have successfully
cleared Fact-Check (P1 = Option B, recorded in §14).

**Not yet decided — the destination state itself.** Investigation of the
existing `src/state/ContentStateMachine.js` (read-only; not modified by
this reconciliation) establishes the following constraints on what the
destination *can* be, without settling which of the remaining options it
*should* be:

- `content_versions.state` cannot revert to `SCRIPT_DRAFT` through the
  existing `canTransition`/`transition` functions: they permit only a
  forward move to the immediate next state in `STATES`, or a move to any
  state in `FAILURE_STATES` (`REJECTED`, `BLOCKED`, `NEEDS_REVIEW`,
  `FAILED`) from any state. A `FACT_CHECK → SCRIPT_DRAFT` move is backward
  and is rejected by `canTransition` as currently written. Achieving a
  reversion to `SCRIPT_DRAFT` would require changing
  `src/state/ContentStateMachine.js` itself, which §16 lists as an
  explicitly protected area for any Fact-Check change — so this option is
  not available without a separate, broader decision to lift that
  protection.
- The remaining mechanically-available destinations are therefore the four
  existing `FAILURE_STATES`: `REJECTED`, `BLOCKED`, `NEEDS_REVIEW`,
  `FAILED`. All four are already reachable from `FACT_CHECK` per
  `canTransition`, without any state-machine change.
- No pipeline currently implemented in this repository (Discovery, Brief,
  Script, or the current Fact-Check implementation) has ever actually set
  `content_versions.state` to any of these four failure states. Every use
  of strings like `REJECTED`/`FAILED` found elsewhere in the codebase is
  either a `decision_log.decision` audit label or a value of the
  unrelated, separately-defined `opportunities.status` column — neither of
  which is `content_versions.state`. There is therefore no existing
  precedent in this repository that makes one of the four failure states
  the "obviously correct" choice; nothing here is being decided by
  convenience or inertia.
- Choosing among `REJECTED`, `BLOCKED`, `NEEDS_REVIEW`, and `FAILED` for
  this specific case is a product decision about what a "Script that
  passed Fact-Check once but has since failed it again" *means* for the
  rest of the pipeline (e.g., is it terminal, or can a further Script
  revision re-enter Fact-Check?). That meaning is not established anywhere
  in the current repository and must be supplied by the Owner, not
  inferred here.

Until this section is completed with an explicit destination state (and,
if `NEEDS_REVIEW`/`BLOCKED` is chosen, whatever downstream re-entry
semantics that implies), no implementation of the P1 decision is
authorized, per §13's atomicity note above and per the Owner's own
instruction that this destination must be spec-defined before code is
written.

## 15. Manual execution boundary

Fact-Check is manually triggered. It is not scheduled, not automatically
invoked on Script creation, and does not run in the background. This
specification does not define any automatic-execution behavior.

## 16. Protected areas

The following are explicitly out of scope for any Fact-Check change, now or
during future implementation:

- `src/research/` and Research migrations
- `src/brief/` and the Brief policy/specification
- `src/script/` and the Script policy/specification
- `src/db/migrations/0004_script_subsystem.sql`
- `src/state/ContentStateMachine.js`
- `src/db/migrations/0001_init.sql` (including `risk_assessments`)
- all previously closed audit findings

No previously closed audit finding is reopened by this specification.

## 17. Implementation file boundary

The following files now exist in the repository as of this reconciliation
task's baseline (they were added by a separate implementation task, not by
this one):

- `src/fact-check/constants.js`
- `src/fact-check/eligibility.js`
- `src/fact-check/validate.js`
- `src/fact-check/decision.js`
- `src/fact-check/pipeline.js`
- `src/db/migrations/0005_fact_check_subsystem.sql`
- `tests/unit/fact-check-eligibility.test.js`
- `tests/unit/fact-check-validate.test.js`
- `tests/unit/fact-check-decision.test.js`
- `tests/integration/fact-check-pipeline-e2e.test.js`

This specification reconciliation task did not modify any of them. The P2
change recorded in §7a and the P1 open question recorded in §14a both
require implementation follow-up that is explicitly not authorized by this
task.

## 18. Explicit non-goals

This specification does not define, and future implementation must not
introduce:

- Originality design or implementation (only the single invariant in §14 is
  exposed downstream);
- any UI;
- publishing behavior;
- automatic/scheduled execution;
- any dependency on or import of RiskPolicy;
- any new lifecycle state (see §14a — the destination for a later REJECT
  must be chosen from existing states);
- any modification to `risk_assessments` or Research evidence data.

## 19. Testing requirements for future implementation

A future implementation must include tests that exercise, at minimum:

- eligibility: well-formed vs. malformed `claim_links`, missing claims,
  claims from an unrelated Research project;
- decision logic: `PASS`, `REVIEW`, and `REJECT` conditions, including
  worst-case-wins across mixed findings;
- persistence: append-only writes, `(script_id, version)` uniqueness
  enforcement, independent version sequences per `script_id`;
- rerun semantics: ordinary rerun returns the latest existing result;
  forced rerun creates a new version; prior results are unchanged;
- lifecycle: correct transition for `PASS`/`REVIEW`, no transition for
  `REJECT` or structural failure;
- atomicity: persistence and lifecycle transition succeed or fail together
  for `PASS`/`REVIEW` outcomes;
- the current-Script-version invariant (§14), including that an older
  Fact-Check result cannot satisfy the invariant for a newer Script
  version;
- heading-optional representation (§7a): a `claim_links` entry with a
  heading and one without must both be valid, and the persisted finding's
  `section_heading` key must be present only in the former case;
- once §14a is resolved: PASS/REVIEW followed by a later forced REJECT on
  the same current `script_id` must produce the specified destination
  state, atomically with the new `fact_checks` row.

## 20. Owner decisions

- Persistence: dedicated `fact_checks` table; `risk_assessments` untouched
  and remains Risk's alone.
- Lifecycle: `SCRIPT_DRAFT → FACT_CHECK` on `PASS`/`REVIEW` only; `REJECT`
  leaves state at `SCRIPT_DRAFT`; no new lifecycle state.
- Re-run persistence: append-only, explicit integer `version` per
  `script_id`, `(script_id, version)` DB-enforced uniqueness, no timestamp
  ordering.
- Malformed `claim_links`: no row persisted, no lifecycle change,
  `decision_log` entry plus structured failure to caller; explicitly
  distinct from a persisted `REJECT`.
- RiskPolicy: no dependency/import; independent worst-case-wins decision
  logic over Fact-Check's own finding vocabulary.
- Originality: undesigned; single exposed invariant only (`FACT_CHECK`
  state implies a persisted `PASS`/`REVIEW` result exists for the current
  Script version).
- Heading (P2): optional; absent heading omits `section_heading` from the
  persisted finding rather than nulling it or treating it as a structural
  failure (§7a).
- Lifecycle-must-reflect-latest-result (P1, principle only): a later
  REJECT on the current `script_id` must move the Script off `FACT_CHECK`.
  The destination state is explicitly NOT decided by this revision — see
  §14a.

## 21. Remaining owner decisions

- P1 (destination state, §14a): which of `REJECTED`, `BLOCKED`,
  `NEEDS_REVIEW`, `FAILED` — or a decision to lift the §16 protection on
  `src/state/ContentStateMachine.js` in order to allow reversion to
  `SCRIPT_DRAFT` instead — is the intended destination when a later forced
  rerun produces `REJECT` after an earlier `PASS`/`REVIEW` on the same
  `script_id`. Also open: whether that destination is terminal, or whether
  a further Script revision can re-enter Fact-Check from it.
- P3-A: whether an empty resolved claim set (`CLAIM_LINKS_EMPTY`) should be
  formally added to §11 as a sixth structural-failure trigger, or removed
  from the implementation if not intended. Not resolved by this revision.
- P3-B: how `decision_log.subject_type`/`subject_id` should be defined for
  the no-current-Script eligibility-failure case, where no Script id
  exists to log against (§11). Not resolved by this revision.