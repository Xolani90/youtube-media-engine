# ADR-0026: A4 Slice 3, Failure Classification, Evidence Requirements, Pattern Identity and Invocation Outcomes

## 1. Status

**RECORDED, OWNER-FROZEN DECISIONS**

Owner: **Xolani Tshabalala**. Authoritative baseline at recording:
`b03b4bbe43496a4fbfb69d3986374a5641590546` (HEAD = origin/main).

This is a **GOVERNANCE RECORD**. It records Owner decisions only. **No
implementation is authorized by this record itself** (see section 15).

## 2. Scope

In scope: every A4 named-outcome stage, Asset Provisioning provider evidence,
Media local tools, Publication invocation-level provider-wide behavior, and the
runner's invocation outcome.

Out of scope: Research (governed separately by ADR-0027), Production and
Publication attempt counting (ADR-0023), Rights Verification, Discovery, and the
B/C workstreams.

## 3. Authoritative text: A1-A9 and classification rules 1-6

The Owner's A1-A9 policy decisions (recorded at baseline `db8c7f7` and refined
afterwards) are transcribed here because their full text otherwise exists
nowhere in the repository. Rules 1-6 are the Owner's frozen classification rules.

### 3.1 A1-A9

- **A1.** Failure handling depends on classification (item-specific versus
  provider-wide).
- **A2.** Classification uses both provider-supplied structured error fields and
  repetition across distinct items. Provider-wide repetition threshold = 2
  distinct affected items in the same invocation, used together with structured
  evidence, and never overriding structured evidence that says item-specific.
- **A3.** Provider-outage response differs per provider type. Provider-wide
  failure for Groq, Tavily, Pixabay and YouTube = invocation FAILED, with no
  automatic paid-provider fallback and no silent substitution. Alternates need
  separate Owner authorization. The per-provider evidence maps are in section 11.
- **A4.** Bounded retry applies ONLY to these named outcomes:
  - `GENERATION_RETRY_EXHAUSTED` (Brief, Script);
  - `STRUCTURAL_FAILURE` (Fact-check, Originality, Quality Gate);
  - `NO_ASSET_ACQUIRED` and `INVALID_PROVIDER_RESULT` (Asset Provisioning);
  - `NARRATION_FAILED`, `RENDER_FAILED`, `VALIDATION_FAILED` and
    `ASSET_CHECKSUM_MISMATCH` (Media Production).

  Explicitly OUT: `NO_ELIGIBLE_KEY_CLAIMS`, `ARTIFACT_MISSING`,
  `AUTHORIZATION_DENIED`, `AMBIGUOUS`, deterministic Fact-check REJECT/BLOCK, and
  provider-wide failures.
- **A5.** Bounded retry for non-throw repeating outcomes applies only to the A4
  named outcomes. There is no generic bounded retry.
  `AUTHORIZATION_DENIED` is never quarantined merely for being denied.
- **A6.** Deterministic content failure -> terminal state/exclusion.
  Item-specific transient failure -> bounded retry, then quarantine.
  Provider-wide failure -> invocation FAILED unless an explicitly authorized
  fallback exists (none is authorized).
- **A7.** Run status: contained item failures with other items completing =
  COMPLETED; provider-wide outage = FAILED; infrastructure failure = FAILED. No
  PARTIAL or DEGRADED status.
- **A8.** Reactivation is Owner-only, on the same rule as the existing
  reactivation.
- **A9.** Reopening of the Research stuck-RESEARCHING limitation (ADR-0005 F1-C)
  is governed by ADR-0027. Research is NOT an A4 retry stage.

### 3.2 Classification rules 1-6

1. **Provider-wide** = explicit, sufficiently reliable, structured provider-wide
   evidence (a single item is sufficient), OR two distinct domain items with the
   same provider, same stage, same invocation and same failure pattern when
   structured evidence is absent.
2. **Item-specific** = explicit, sufficiently reliable, structured item-specific
   evidence only.
3. **Same-item repetition never counts.** Repetition never overrides explicit
   item-specific evidence. A bare HTTP status alone is insufficient.
4. **Dispositions.** Deterministic -> terminal/exclusion. Item-specific
   transient -> bounded retry -> quarantine, for named A4 outcomes only.
   Provider-wide -> invocation FAILED. Infrastructure -> invocation FAILED.
   Contained item failures with other items succeeding -> COMPLETED.
5. **No fallback is authorized.** Reactivation is Owner-only.
6. **Research A9** is locked as specified in ADR-0027. Production and Publication
   keep ADR-0023 counting. `NO_ELIGIBLE_KEY_CLAIMS` stays outside this framework.
   ADR-0024 is unaffected.

**Frozen wording for the apparent tension.** Explicit structured provider-wide
evidence from a single item is sufficient (rule 1). "A single failure is NOT
provider-wide" applies only to a failure without such evidence. Evidence must
still satisfy the bare-status rule and the reliability definition in D3.

## 4. Terms

- **Domain item**: the stage's retry subject: `research_project_id` (Brief),
  `content_brief_id` (Script), `content_version_id` (Fact-check, Originality,
  Quality Gate, Asset Provisioning, Media).
- **Provider identity**: the provider's id (`tavily`, `groq-free`, `pixabay`,
  `youtube`). For local tools, the canonical tool name (`espeak-ng`, `ffmpeg`,
  `ffprobe`). The canonical tool identifier is REQUIRED IMPLEMENTATION.
- **Stage scope**: the runner stage name.
- **Failure kind**: a machine-readable kind from the failure envelope.
- **Pattern identity**: `(provider identity, stage, failure kind)`. Status/code
  specificity is applied only where the evidence map declares it. None is
  declared at freeze.
- **Inconclusive**: a returned (non-throw) failure of a named outcome with no
  explicit classifying evidence. It is not deterministic by default and is never
  converted to item-specific transient by outcome name.
- **Unclassified**: a thrown error, or a failure with no class.

## 5. Owner decisions D1-D4

**D1. Single unexplained failure.** A single unexplained named-outcome failure is
inconclusive. It consumes no retry budget, is not quarantined, is not
provider-wide, and is never converted into item-specific transient by outcome
name. It consumes the per-invocation pacing slot, so the item is not re-called
in that invocation. No A4 attempt is recorded. No retroactive accounting.

**D2. Pixabay envelope and pattern equality.** Pixabay moves from bare `null` to
a structured envelope. Bare `null` is never a failure-pattern class. Pattern
equality is the same failure kind, with status/code as optional additional
specificity. Default identity = provider + stage + kind. An explicit
no-hit/no-candidate is DETERMINISTIC and consumes no budget.

**D3. Reliability.** Only machine-readable structured fields establish
classification. Free-text messages never do.

**D4. Invocation outcomes.**
- Inconclusive failures are contained failures.
- Unclassified thrown errors stay run-fatal (FAILED).
- Contained failures with no successful items produce FAILED.
- Infrastructure and provider-wide failures fail immediately (D8).

**D5 (Research)** is recorded in ADR-0027, not here. **D9 (documentation
structure):** two governance records (this ADR and ADR-0027); no silent
renumbering; the ADR-0005 / ADR-0011 / checkpoint inconsistency is recorded in
`ERRATUM-adr-0005-numbering-inconsistency.md` and the checkpoint update.

## 6. Evaluation order at a failure

1. An error that escapes the stage unclassified -> run-fatal FAILED. No silent
   conversion (D4).
2. Explicit structured infrastructure evidence -> INFRASTRUCTURE -> FAILED
   immediately.
3. Explicit structured provider-wide evidence -> provider-wide -> FAILED
   immediately.
4. Explicit structured item-specific evidence:
   - TRANSIENT on a named outcome -> bounded retry;
   - DETERMINISTIC -> terminal/exclusion;
   - repetition is ignored.
5. Otherwise the failure is inconclusive: no attempt, no quarantine, pacing slot
   consumed. The `(provider, stage, kind, item)` tuple is registered in the
   invocation tracker. If two distinct items now share a pattern -> provider-wide
   -> FAILED immediately.
6. An inconclusive failure with no machine-readable kind joins no repetition set.

## 7. Evidence and tracker

- **Evidence.** Structured fields only. Free-text message, error strings and
  stderr never classify. A bare HTTP status never classifies.
- **Tracker.** In-memory and invocation-scoped, with evidence rows in
  `decision_log` (provider, stage, `config_snapshot` JSON, `run_id`). Nothing is
  persisted across invocations.
- **No retroactive accounting.** Attempts recorded before a provider-wide
  classification stand. Nothing is un-counted.

## 8. D2 Pixabay contract

Pixabay returns a structured result distinguishing at minimum: no-hit /
no-candidate, provider/configuration failure, transport/network failure,
HTTP/provider failure, malformed response, download/acquisition failure. Field
names are fixed at implementation. Bare `null` is retired as a failure signal.
Sub-kinds for local filesystem failures inside the download path are an open item
(U-10).

## 9. D4 invocation outcomes (normative)

- Provider-wide or infrastructure -> FAILED immediately.
- Unclassified thrown error -> FAILED (run-fatal). The entrypoint must not supply
  `onStageError`.
- Contained failures (inconclusive, item-specific, deterministic) with at least
  one successful item -> COMPLETED.
- Contained failures with no successful item -> FAILED.

The definition of "successful item" per stage is an open item (U-2).

## 10. D6 Publication, D7 local tools, D8 timing

**D6 Publication.** Provider-wide failure fails the invocation. Evidence is
explicit structured adapter fields when surfaced; otherwise same-kind repetition
across two distinct content items. `AMBIGUOUS` never counts toward attempts or
provider-wide repetition. ADR-0023 counting is unchanged.

**D7 Local tools.** Accepted evidence fields: `code`, `signal`, `status` only.
The classification table is normative. Any kind not in the table, including a
non-zero exit with no approved structured mapping, is inconclusive.

| Kind | Class |
|---|---|
| ENOENT, ENOSPC, EACCES, EIO, ENOBUFS | INFRASTRUCTURE |
| Signal termination | INFRASTRUCTURE |
| Non-zero exit | Inconclusive unless a structured mapping is later approved |
| Timeout | Not classified (not observable) |

Repetition applies (same tool, stage, kind, two distinct items). Item-specific
transient requires explicit structured item-specific evidence (none exists
today). Deterministic Media failures (`ASSET_CHECKSUM_MISMATCH`, script-body
violations) stay outside retry. A non-zero exit is never classified from the
number alone.

**D8 Timing.** Fail immediately once provider-wide or infrastructure
classification is established. Remaining items in that stage and all later
stages do not run. Scope stays same-stage.

## 11. A3 evidence maps

Existing fields were verified in source at the recording baseline. Anything else
is REQUIRED IMPLEMENTATION.

| Provider / type | Identifier | Existing envelope | Existing provider-wide fields | Existing item-specific fields | Insufficient alone | REQUIRED IMPLEMENTATION | Repetition | A4 |
|---|---|---|---|---|---|---|---|---|
| Tavily (Research) | `tavily` (EXISTS) | `{candidates:[], failures:[{error:string}]}`, never throws | None machine-readable | None | `failures[].error` (free text embedding status) | Machine-readable kind per failure (missing credentials, network, HTTP, malformed response, missing results, invalid query) and numeric HTTP status | Yes (same kind, distinct projects) | No (Research) |
| Research retrieval | None (per-URL fetch) | `{status: SUCCESS\|FAILED\|CONTENT_UNPARSEABLE, content, error:string\|null}`, 10 s timeout | None | `status` (source-level, persisted as `retrieval_status`) | `error` (free text) | None | No | No |
| Groq | `groq-free` (EXISTS) | Thrown Error on non-2xx: `status`, `retryAfter`, `rateLimit`, `providerBody`, `message` | `status`, `retryAfter`, `rateLimit` exist; no combination is enumerated as sufficient | None (`providerBody` is text) | status alone; message; providerBody text | Provider error type/code from parsed JSON where present | Yes, but unreachable for thrown errors (O-1) | Only via non-throw `GENERATION_RETRY_EXHAUSTED` |
| Pixabay | `pixabay` (EXISTS) | Bare `null` (8 sites) or a throw (empty query, mkdirSync) | None | None | Everything | The full D2 envelope, including `res.status` and the transport error object | Yes (D2) | `NO_ASSET_ACQUIRED`, `INVALID_PROVIDER_RESULT` |
| YouTube Publication | `youtube` (EXISTS) | Normalized `{status, provider, errorClass, retryable}` | None surfaced. `ProviderExplicitError.details.{httpStatus, errorBody}` EXISTS but is dropped | None surfaced | `errorClass` strings embedding a status (`upload_rejected_<status>`) | Surface `httpStatus` and `errorBody` in the result. Whether `errorBody` holds a machine-readable reason field is not verified | Yes (D6) | No (ADR-0023) |
| Local Media tools | Not in code (`NARRATION_ENGINE` constant only) | Thrown Node error: `code`, `status`, `signal`, `stderr`, `message` (per Node behavior, not exercised in-repo). Only `err.message` is stored today. `validate.js` returns `{valid:false, reason}` | `code`, `signal` per D7 | None | Non-zero status alone; message; stderr | Structured capture; canonical tool ids; split narration try block; handle mediaDir throw | Yes (D7) | Named outcomes only |

Existing evidence sites retained: Brief/Script `GENERATION_RETRY_EXHAUSTED`
TRANSIENT (pipeline-structured internal-loop exhaustion, not provider free text);
Fact-check, Originality, Quality Gate and Media checksum deterministic defaults.

## 12. Exclusions

`NO_ELIGIBLE_KEY_CLAIMS`, `ARTIFACT_MISSING`, `AUTHORIZATION_DENIED`,
`AMBIGUOUS`, deterministic Fact-check REJECT/BLOCK, provider-wide failures from
retry/quarantine, and anything not named.

## 13. Relationships to other records

- **ADR-0023.** Counting unchanged. This record supersedes only the "nothing else
  consumes the slot" statement for A4 stages, as ADR-0025 already does in
  practice. ADR-0023 is not edited. Publication provider-wide failure ends the
  invocation FAILED; any attempt already recorded for the triggering item stands.
- **ADR-0024.** Unaffected. FAILED uses the existing finish path.
- **ADR-0025.** Amended by the same documentation commit (ADR-0025 sections
  1, 2, 3 and 5). ADR-0025 remains the Slice 1/2 record.
- **ADR-0027.** Governs Research A9, reactivation and Research provider-wide
  handling. Detection of Research provider-wide failure follows this record.
- **ADR-0005.** Not edited. Cross-referenced by ADR-0027.

## 14. Migration impact

None required by the frozen decisions alone: no `stage_retry_state` / history
CHECK change (no `RETRY_STAGE` widening), no status CHECK change, `system_runs`
status is free text and already accepts FAILED, `decision_log` decision is free
text and already carries provider, stage and `config_snapshot`.

## 15. Explicit implementation boundary

- **No implementation authorization is created merely by this ADR.**
- WS0 (governance records) is the only workstream this record covers. WS1-WS7
  remain separately gated by Owner authorization.
- WS1-WS5 remain **blocked wherever an unresolved U-item (section 16) is a
  dependency.**
- Research remains separately governed by ADR-0027 (WS6).
- **Not authorized:** cross-stage repetition; timeout implementation; stderr
  classification; any change to Publication counting; any retry counter for
  Research; fallback providers.

## 16. OPEN OWNER QUESTIONS, IMPLEMENTATION BLOCKERS

**Every item below is UNRESOLVED. None is an authorized decision. Nothing in this
ADR answers any of them, and no implementation audit may treat any of them as
decided.**

| # | Unresolved question | Blocks |
|---|---|---|
| U-1 | How the normal selector distinguishes an Owner-reactivated RESEARCHING project from a crashed (P1), provider-blocked or single-failure one. These share status and fields. | WS6 |
| U-2 | The definition of "successful item" and the per-stage mapping of outcomes to success or contained failure (D4). | WS2 |
| U-3 | What "terminal/exclusion" means for an Asset Provisioning explicit no-hit. Under the existing contract the item stays eligible and is re-called each sweep. Also whether deterministic results consume the pacing slot. | WS3 |
| U-4 | Whether a structured configuration-failure kind (missing key) is explicit provider-wide or infrastructure evidence on a single item. Not stated. | WS3 |
| U-5 | Whether Publication `MEDIA_FILE_MISSING` and `CREDENTIALS_UNAVAILABLE` (non-provider or config kinds) participate in D6 repetition. | WS5 |
| U-6 | No combination of HTTP status plus other structured fields is enumerated as explicit provider-wide evidence for Tavily, Groq, Pixabay or YouTube. Until enumerated, those providers rely on repetition. | WS5 (listed dependency); affects the evidence maps in section 11 for all four providers |
| U-7 | ADR-0005 section 6 says F-5 is "covered by F1-C"; the freeze decision says do not reopen F-5, while deduplication is required. Whether deduplication is confined to reactivated cycles or applies to all `runResearchProject` re-entry. | WS6 |
| U-8 | Source identity (no URL canonicalization exists) and the treatment of previously FAILED or CONTENT_UNPARSEABLE source rows on reactivation, without mutating history. | WS6 |
| U-9 | Whether D7's filesystem codes (ENOSPC, EACCES, EIO) also cover Node `fs` errors from Media-stage file operations. They cannot arise from a child process's `err.code`. Also that a non-zero exit with no approved structured mapping defaults to inconclusive. | WS4 |
| U-10 | Local filesystem failures inside Pixabay's download (mkdir throws; write/stat failures return null) fall in D2's download bucket and need a sub-kind. | WS3 |

"Blocks" is taken from the workstream dependency table in the Owner's freeze
specification. WS1 (classification core) depends only on this ADR. WS7
(regression and alignment) depends on all other workstreams.

## 17. Observations (documentation only)

- **O-1.** Groq repetition is unreachable for thrown errors, because the first
  unclassified throw ends the run.
- **O-2.** Research has no pacing, so the `research:undefined` pacing key is never
  triggered while Research has no retry counter.
- **K-14.** ENOSPC counts as an attempt in Production (ADR-0023) but is
  INFRASTRUCTURE in Media. Accepted by the A4 retention clause; documentation only.

## 18. Final status

```text
A4 SLICE 3 CLASSIFICATION RECORD: RECORDED, OWNER-FROZEN DECISIONS
GOVERNANCE ONLY. No implementation authorized by this record.
U-1 through U-10 remain UNRESOLVED.
```
