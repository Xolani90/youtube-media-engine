# ADR-0016: F5-01 Implementation Authorization — Provenance Record

## 1. Purpose

This document records, retrospectively, the Owner's implementation authorization for
F5-01 (concurrent provisioning-claim enforcement in Asset Provisioning). F5-01 was
already implemented and shipped before this provenance record was created. This ADR
authorizes nothing new: it does not authorize any source-code, test, or migration
change, does not reopen F5 or F5-01, and does not alter any accepted limitation. F5-01
remains CLOSED — PASS both before and after this record.

This document follows the same retrospective-provenance pattern established by
ADR-0007 (D-G1) and ADR-0009 (D-C2): an implementation whose Owner authorization
occurred outside the repository's Git history, made reconstructable from the
repository itself after the fact.

## 2. Disposition trail reference

The following sequence is recorded in the repository (`src/db/migrations/0014_asset_usages_provisioning_claim.sql`
header comment) and is restated here without alteration:

```text
F5 Failure/Recovery/Idempotency Audit
→ F5-01 finding
→ F5-01 Owner disposition: Option A
→ F5-01 identity audit
→ F5-01 Mechanism 2 design: Candidate A
→ Owner-authorized implementation
→ commit a4243591a651c1297a5005851d31a94c6464e738
```

No dates, timestamps, meeting records, approval channels, or external documents are
asserted for any step in this trail beyond what is stated here; none are established
by repository evidence, and none are invented by this record.

## 3. Owner authorization

The Owner (Xolani Tshabalala) authorized the Option A disposition and the Candidate A
design outside of Git, prior to implementation. This authorization was given
out-of-band relative to the repository — no commit, tag, or file existed to record it
at the time it was given. No independent timestamp or approval mechanism for that
authorization is established by repository evidence, and this document does not
invent one.

## 4. Authorized scope

The Owner's authorization for F5-01 (Option A / Candidate A) covered exactly:

- A nullable `asset_usages.provisioning_claim` column, additive only — no rewrite of
  existing rows, no change to any other column.
- A partial `UNIQUE` index on `content_version_id WHERE provisioning_claim IS NOT
  NULL`, enforcing at most one automated-provisioning claim per `content_version_id`
  at the database level.
- An automated-provisioning identity (`PROVISIONING_CLAIM =
  'asset-provisioning:auto-visual-v1'`) kept strictly separate from the existing,
  shared, free-text `usage_context` field — the F5-01 identity audit explicitly
  rejected reusing `usage_context` as an exclusive identity, since it already carries
  open-vocabulary descriptive metadata used independently by other writers and
  fixtures.
- An in-transaction race re-check immediately before persistence, mirroring the
  precedent in `src/publication/pipeline.js`'s `attemptClaim()` and
  `src/media/pipeline.js`.
- Resolution of the losing side of a race to the existing `ALREADY_PROVISIONED`
  outcome — no new outcome was introduced.

This is the narrow F5-01 Option A / Candidate A implementation only.

## 5. Explicit exclusions

This ADR does not authorize, and none of the following is in scope:

- Any new or repeated implementation of F5-01.
- Reopening F5 or F5-01, or altering their CLOSED — PASS disposition.
- Any broader Asset Provisioning redesign.
- A provider claim-before-call architecture (the provider is still invoked before the
  database-level guard resolves the race — see §7).
- Any new retry, lease, or resumability mechanism.
- Any change to `usage_context`'s existing shared, free-text semantics or vocabulary.
- Any change to the existing many-to-many asset/content-version model (one
  `content_version` may use several assets; one asset may be reused across several
  content_versions — both remain fully intact).
- Any new requirement concerning raw `SQLITE_BUSY_SNAPSHOT` / `UNIQUE`
  driver-level constraint-violation handling (see §7).
- Any change to Media Production, Publication, or the autonomous runner.

None of the accepted limitations in §7 is converted into a new requirement by this
record.

## 6. Resulting implementation

The scope in §4 was implemented and shipped as commit:

```text
a4243591a651c1297a5005851d31a94c6464e738
fix(asset-provisioning): enforce concurrent provisioning claim
```

Files changed (5 files, 418 insertions, 13 deletions — verified against the commit
diff):

- `src/asset-provisioning/constants.js` — adds the `PROVISIONING_CLAIM` identity
  constant and its documenting comment.
- `src/asset-provisioning/pipeline.js` — adds the in-transaction race re-check
  before persistence and the `ALREADY_PROVISIONED` resolution for the losing side of
  a race.
- `src/db/migrations/0014_asset_usages_provisioning_claim.sql` — adds the nullable
  `provisioning_claim` column and the partial `UNIQUE` index.
- `src/state/AssetProvenance.js` — adds the `provisioningClaim` parameter (default
  `null`) to `AssetProvenanceRepository.recordUsage()` and wires it into the
  `INSERT INTO asset_usages` statement, so this repository method is the actual
  persistence path for the new column, not a comment-only change. Every existing
  caller omits the parameter and continues to get the `NULL` it always received; only
  `src/asset-provisioning/pipeline.js`'s automated path supplies it.
- `tests/unit/f5-01-provisioning-claim.test.js` — 8 tests, including migration
  application against an empty and a populated database, multi-asset/multi-context
  behavior, the DB-level partial-unique rejection, and a concurrency test confirming
  the losing invocation resolves to `ALREADY_PROVISIONED`.

## 7. Accepted limitations

The following limitations are carried forward as previously accepted, bounded
architectural facts. They are **not remediated, reopened, or expanded by this ADR**:

1. Raw `SQLITE_BUSY_SNAPSHOT` / `UNIQUE`-violation handling at the storage-driver
   level remains a known, non-blocking follow-up. The in-transaction re-check in §4
   resolves the common interleaving to a clean outcome; the partial `UNIQUE` index is
   the actual backstop for interleavings the re-check can still miss, and a raw
   constraint-violation exception from that backstop is not separately handled.
2. Concurrent external provider-acquisition duplication remains an accepted
   architectural boundary: the provider is still called before the database-level
   persistence guard resolves the race, so two concurrent invocations may both
   acquire an asset from the provider even though only one persists.

## 8. Provenance / final status

This ADR is documentation-only. It changes no source code, test, migration, or
runtime behavior. F5-01 remains **CLOSED — PASS**. Its sole purpose is to make the
historical Owner authorization for F5-01 (Option A / Candidate A) reconstructable
from repository governance records, in the same manner ADR-0007 and ADR-0009 did for
D-G1 and D-C2 respectively.
