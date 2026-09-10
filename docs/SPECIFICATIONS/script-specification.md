# Script Specification (v0.1)

Scope: the Script stage of the content pipeline, immediately downstream of
Brief. Builds directly on the verified Brief stage (Brief Specification,
D1-D16). This document describes the Script stage as implemented; it does
not modify Research, Brief, or any of D1-D16.

## §1. Purpose

Script turns an eligible Content Brief into a structured, claim-linked
Script: a hook, narrative framing, an ordered set of sections (each
optionally citing specific Brief claims), counterpoints, a conclusion, and
an optional call to action.

## §2. Authoritative input

The Brief is the **sole authoritative input** to Script. Script does not
re-query `research_projects` or `claims` beyond what the Brief already
recorded in `key_claims`, and does not re-run any Research or Brief
validation. A persisted `content_briefs` row could only exist because
`createBrief` already enforced `RESEARCH_COMPLETE` (Brief D1); Script
trusts that gate rather than duplicating it.

## §3. Content contract

Generation must produce a strict JSON object with exactly these fields:

| Field | Type | Notes |
|---|---|---|
| `hook` | non-empty string | |
| `narrative` | non-empty string | |
| `sections` | non-empty array of `{heading, content, claim_ids}` | `claim_ids` may be empty but must be an array of strings |
| `counterpoints` | non-empty string | |
| `conclusion` | non-empty string | |
| `call_to_action` | string or `null` | governed by `allow_call_to_action` policy, §9 |

`claim_links` (persisted alongside `body`) is derived deterministically
from `sections`: `[{heading, claim_ids}]`, one entry per section, in
generation order.

## §4. Eligibility

A Brief is eligible for Script generation iff:

- the `content_briefs` row exists, and
- every one of its 12 required string fields (`working_title`,
  `core_question`, `target_audience`, `viewer_promise`, `hook`, `angle`,
  `narrative_structure`, `counterpoints`, `original_insights`,
  `visual_ideas`, `monetization_opportunities`, `risk_assessment`) is a
  non-empty string, and
- `key_claims` parses to a non-empty JSON array of non-empty strings.

An absent Brief is rejected as `BRIEF_NOT_FOUND`. An incomplete Brief is
rejected per-field as `INELIGIBLE_BRIEF_MISSING_FIELD_<field>`. Invalid
`key_claims` is rejected as `INELIGIBLE_BRIEF_INVALID_KEY_CLAIMS`.

There is no path for a raw, non-persisted Brief object to be supplied —
`createScript` takes a `contentBriefId` and always reads the row itself.

## §5. Claim traceability

Every `claim_ids` entry across every section is validated referentially
against the Brief's own `key_claims` set — never a broader pool, and never
re-checked against the live `claims` table's current `evidence_status`.
This is an explicit, acknowledged limitation (see §11): if a claim's
`evidence_status` were mutated after the Brief was created, Script would
still accept a reference to it, because Script does not re-run Research.

Nonexistent or invented claim ids are rejected as
`INVALID_CLAIM_REFERENCE_<id>`. Malformed `claim_ids` shape (non-array, or
containing non-string entries) is rejected at the structural-validation
layer as `INVALID_SECTION_CLAIM_IDS_SHAPE`, before claim-reference
checking runs.

## §6. Generation and validation

The LLM proposes; deterministic code validates. Generation retries up to
`policy.generation.max_attempts` times on either structural-validation
failure or claim-reference-validation failure. Retry exhaustion rejects
with `GENERATION_RETRY_EXHAUSTED_<lastReason>` and persists nothing — no
partial Script, no lifecycle transition, and (on a failed regeneration)
the prior valid Script row is left completely untouched, since persistence
only ever happens after successful validation, inside a single
transaction, on a newly inserted row.

Structural validation is shape-only (required fields present, `sections`
non-empty and well-formed, `call_to_action` respecting policy). It is not,
and cannot be, semantic/factual verification — the same acknowledged
limitation as Brief D11.

## §7. Idempotency

A `createScript` call without `regenerate: true`, when a Script already
exists for the Brief, returns the existing (most recent) Script unchanged
— no LLM call, no re-validation. This is checked before any generation
work begins.

## §8. Versioning (append-only)

Unlike Brief (which overwrites its single row in place on regeneration),
Script is **append-only**: each successful regeneration inserts a new
`scripts` row with `version = previous_max_version + 1`, preserving all
prior versions. `content_versions.script_id` always points at the current
(most recently persisted) version for that Brief.

**Concurrency guarantee.** The "read the current version, then compute
next version" step happens *inside* the same `storage.transaction()`
closure that performs the insert — not before it, and not based on any
read taken earlier in the call (e.g. the idempotency-fast-path read, which
may be stale by the time generation's `await`s resolve). Under this
repository's single-connection `SqliteStorageDriver`, that makes
read-then-increment atomic: no other transaction on the same storage
instance can interleave between the read and the write. A
`UNIQUE(content_brief_id, version)` index (migration `0004`) is the
second, DB-enforced line of defense, so a duplicate-version insert fails
loudly rather than silently succeeding even against a different
connection or process sharing the same database file.

The `BRIEF_CREATED -> SCRIPT_DRAFT` lifecycle transition happens only on
first-version creation, never on regeneration (the pipeline is already at
`SCRIPT_DRAFT` by then).

## §9. Call-to-action policy

`config/script_policy.json`'s `allow_call_to_action` flag (default
`false`) is passed explicitly into `createScript({ policy })` by the
caller, matching Brief's pattern of parameterizing the pipeline rather
than reading global config from inside it.

- When `false`: the generation prompt instructs the model to set
  `call_to_action: null`. Validation rejects (does not silently drop) any
  non-null value with `CALL_TO_ACTION_NOT_PERMITTED` — a model that
  ignores the instruction fails that attempt and consumes a retry.
  Persistence additionally forces `call_to_action: null` as
  defense-in-depth.
- When `true`: `call_to_action` must be a non-empty string; a missing or
  empty value is rejected as `MISSING_OR_EMPTY_FIELD_call_to_action`.

## §10. Automatic execution

Script has no scheduler or route wiring in this repository. It is a
manual trigger surface, in the same "run once, any driver may invoke it"
style as `createBrief`.

## §11. Known limitations

- Structural validation only — no semantic/NLI fact-checking (same
  acknowledged limit as Brief D11).
- Claim-reference validation checks Brief-membership only, not the live
  `evidence_status` of the referenced claim at Script-generation time.
- Old Script versions cannot be mistaken for current, since
  `content_versions.script_id` is the single pointer to "current" — but a
  caller querying `scripts` directly without going through that pointer
  (or an explicit `ORDER BY version DESC`) could pick the wrong row. This
  is a caller-discipline concern, not a defect in the implemented
  contract.

## §12. Scope boundary

This specification and its implementation do not modify Research, Brief,
or any of D1-D16. No migration alters or drops any existing table; the
only schema change is the additive index described in §8.
