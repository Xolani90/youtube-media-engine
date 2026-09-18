# ADR-0017: F2-G Open Decision 1 — Publication Rights-Verification Gate

## 1. Status

**AUTHORIZED — OWNER DECISION RECORDED — IMPLEMENTATION COMPLETE — PUSH NOT YET AUTHORIZED**

## 2. Purpose

This document records the Owner's decision closing F2-G Open Decision 1
("Publication redesign remains open and unresolved," ADR-0013 §6) and the
resulting implementation, following the same authorization-provenance
pattern established by ADR-0007 (D-G1), ADR-0009 (D-C2), ADR-0013 (D-G2),
and ADR-0016 (F5-01).

## 3. Background

ADR-0013 §6 explicitly excluded "Publication redesign (F2-G Open Decision 1
remains open and unresolved)" from D-G2's implementation authorization, and
noted that Production, Media Production, and Publication would continue to
read `assets.verification_status` exactly as they did at the time (i.e.
Publication read it not at all). A subsequent read-only decision-preparation
audit (not itself a governance artifact) established, without recommending a
resolution, that:

- Publication contained no rights-verification gate of any kind;
- Production and Media Production each independently re-read
  `assets.verification_status` fresh at their own execution time;
- no DB or application-level guarantee prevents an asset from moving from
  `VERIFIED` to `DISPUTED`/`UNVERIFIED` after an earlier stage observed it as
  `VERIFIED`, meaning Publication could reach its external side effect
  without ever having read a rights status.

Neither ADR-0013 nor any later ADR (0014-0016) resolved Open Decision 1.

## 4. Owner decision

The Owner (Xolani Tshabalala) has decided:

> Publication MUST re-read the current `assets.verification_status`
> immediately before performing the external publication side effect. If the
> current status is `UNVERIFIED` or `DISPUTED`, Publication MUST NOT call the
> external provider adapter.

This closes F2-G Open Decision 1 in favor of a **publication-time blocking
rights gate**, using the existing `UNVERIFIED` / `VERIFIED` / `DISPUTED`
vocabulary unchanged (no new verification state was introduced).

## 5. Authorized scope

- `src/publication/pipeline.js` — a new gate, placed after the existing
  media-artifact-existence check and before the existing D-C2 authorization
  check, that re-reads the content_version's assets via
  `AssetProvenanceRepository.getAssetsForContent()` (the identical
  relationship Production and Media Production already use) and returns
  `ASSET_RIGHTS_BLOCKED` without calling the provider adapter, claiming a
  `publications` row, or transitioning `content_versions.state`, when any
  attached asset's current `verification_status` is `DISPUTED` or
  `UNVERIFIED`.
- `src/publication/constants.js` — adds `ASSET_RIGHTS_BLOCKED` to
  Publication's own `OUTCOME` and `DECISION_LOG_DECISION` vocabularies,
  mirroring (not importing) the identical value already used independently
  by Production and Media Production, per this repository's established
  per-stage decoupling convention.
- `tests/unit/publication-pipeline.test.js` — five new tests covering
  `VERIFIED` (proceeds), `UNVERIFIED` (blocked), `DISPUTED` (blocked), a
  status change from `VERIFIED` to `DISPUTED` between an earlier
  observation and Publication's own check (blocked, proving the fresh-read
  behavior rather than a cached/stale one), and no-assets-attached
  (unaffected, matching prior behavior).

No other file, table, stage, runner order, D-C2 semantics, provider adapter,
or retry/idempotency behavior was changed.

## 6. Explicit exclusions

This authorization does **not** cover, and this implementation does not
include:

- re-running Rights Verification from Publication;
- any change to Rights Verification, Asset Provisioning, Production, or
  Media Production behavior;
- any change to the autonomous runner's stage order;
- any change to D-C2 authorization semantics or the provider adapter
  boundary;
- any schema/migration change (none was required — `verification_status`
  and its CHECK constraint already existed on `assets`, unchanged since
  `0007_asset_rights_provenance.sql`);
- a new terminal `publications` row status for a rights-blocked attempt —
  none was needed, since the gate runs before any `publications` row is
  claimed, exactly mirroring where Media Production's own
  `ASSET_RIGHTS_BLOCKED` check runs relative to its own artifact
  persistence.

## 7. Historical limitation

The original F2/F2-G specification text that first framed Open Decision 1
remains unrecoverable. This ADR does not reconstruct it and does not claim
to represent what F2/F2-G originally intended beyond the one summary line
quoted in ADR-0013 §6. This implementation is based on the Owner's present
decision (§4 above), not on reconstructed F2/F2-G history.

## 8. Resulting implementation

Scope in §5 implemented on top of HEAD `9fa1ef3c754b769782d9b620bc05fda7d3d0527e`.
Commit not yet made — see §9.

## 9. Push authorization

Not yet given. Per this repository's established convention (ADR-0007 §6,
ADR-0009 §5, ADR-0013 §9, ADR-0016), commit and push authorization are
separate acts from implementation authorization and are recorded separately
once given.

## 10. Final status

```text
IMPLEMENTATION COMPLETE — COMMIT NOT MADE — PUSH NOT AUTHORIZED
```
