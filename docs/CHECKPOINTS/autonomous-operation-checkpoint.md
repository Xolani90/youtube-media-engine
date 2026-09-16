# Autonomous Operation Checkpoint

## Status

**CONTINUITY / GOVERNANCE RECORD — NOT AN IMPLEMENTATION AUTHORIZATION**

This document exists to carry context across sessions. It records what is
verified, what is approved-but-not-yet-created, what is deferred, and what is
missing/unrecoverable, as of the baseline below. It authorizes nothing beyond
what is explicitly marked "approved for creation" — and even those items
require the next session to create them as a distinct, reviewable step, not
to treat this checkpoint itself as the artifact.

No convention for a checkpoint document existed anywhere in this repository
prior to this file (searched: no `docs/CHECKPOINTS/` directory, no other
checkpoint-file naming pattern; `docs/DECISIONS/0003-corrective-checkpoint-closure.md`
is an ADR about closing a prior ad hoc checkpoint, not a reusable format).
This file establishes the location going forward: `docs/CHECKPOINTS/`.

## 1. Verified Baseline

```
Repository:  github.com/Xolani90/youtube-media-engine
Branch:      main
HEAD:        9463eb2606cf7525ae0a2705f8a3f865e2edb292
origin/main: 9463eb2606cf7525ae0a2705f8a3f865e2edb292
Commit:      fix: enforce autonomous run mode for publication authorization
```

Verified by direct `git fetch`/`git rev-parse` against the live remote at the
time this checkpoint was written. The next session MUST re-verify this SHA
before acting on anything below — this document records a baseline, it does
not freeze the remote.

## 2. Current Architecture State

Autonomous Operation stage order (`src/autonomous/runner.js`), unchanged and
not authorized to change without a separate governance decision:

1. Research
2. Brief
3. Script
4. Fact Check
5. Originality Check
6. Quality Gate
7. Production
8. Media Production
9. Publication

Boundary (Owner-decided, current scope):

```
Discovery → HANDED_TO_RESEARCH → Autonomous Operation begins at Research
```

Discovery is intentionally outside the autonomous runner. This is not an
oversight — it is Decision B (B1), recorded below.

## 3. D-C2 State (Closed)

D-C2 mode propagation is implemented and verified at `9463eb2`. The critical
invariant, verified by a real, unmocked regression test
(`tests/unit/autonomous-runner.test.js`, test `D-C2: a SIMULATION autonomous
run does not reach the Publication provider even though process-global
config.runMode is LIVE and the action is authorized`):

- The autonomous run's mode is persisted by `SystemRunRecorder`.
- The persisted/started mode is propagated into the Publication stage.
- `runPublication()`'s call to `assertExternalActionAllowed()` receives the
  actual run mode, not process-global `config.runMode`.
- A SIMULATION run cannot reach the external Publication provider even when
  process-global configuration is LIVE.

Test results at this baseline:
- Targeted (`autonomous-runner.test.js` + `publication-pipeline.test.js` +
  `side-effect-authorization.test.js`): **46/46 pass**
- Full suite (`npm test`): **536 tests, 529 pass, 7 fail**

**This item is CLOSED. Do not reopen it in the next session** except to
re-verify the test counts still hold if the baseline SHA has moved.

## 4. Known Media Production State (Open — Investigation Authorized, Fix Not Authorized)

Seven tests fail at this baseline, all sharing the signature
`Expected 'RENDERED', got 'NARRATION_FAILED'` (or an equivalent direct
narration-assertion failure):

1. `end-to-end: production manifest -> narration -> render spec -> FFmpeg -> FFprobe -> persisted media artifact`
2. `multiple visual assets + a longer script: sequencing is reflected in the persisted render spec and a valid multi-segment MP4 is produced`
3. `repeated media production for the same content_version returns the existing record, no duplicate row`
4. `crash recovery: orphaned tmp files from a killed prior run do not block or corrupt a fresh render`
5. `crash recovery: a validated video.mp4 left on disk from a run killed before DB commit is safely re-rendered and persisted exactly once`
6. `end-to-end: PRODUCED -> real rendered media artifact -> D-C2 authorized publish -> confirmed PUBLISHED` (fails upstream, before its own Publication/D-C2 assertions are reached)
7. `synthesizeNarration: produces an audio artifact with a measurable positive duration`

Root cause has **not** been established. These failures are confirmed
unrelated to D-C2 (same failures present before and after the D-C2 fix,
independently reproduced on both a pre-fix and post-fix clean clone).

**Decision F (below) authorizes investigation only. No fix is authorized.**

## 5. Governance Decisions Already Made (Owner-Confirmed)

| Decision | Owner's choice | Approved artifact (not yet created) | Constraints |
|---|---|---|---|
| A — D-C2 implementation provenance | CONFIRMED — implementation at `5bd81ca`/`48918ec`/`9463eb2` was Owner-authorized | `docs/DECISIONS/0009-d-c2-implementation-authorization-provenance.md` | Documentation only; no source/test/migration/`ContentStateMachine`/authorization-behavior change |
| B — Autonomous Operation scope | B1 — Discovery stays outside the runner | (recorded jointly with C, see next row) | No change to `runner.js` stage list, `workSelection.js`, or `src/discovery/*` |
| C — Discovery specification | C3 — defer reconciliation of missing "v0.6" spec | `docs/DECISIONS/0010-autonomous-operation-scope-and-discovery-deferral.md` | Do not reconstruct v0.6; do not write a replacement spec yet |
| D — ADR-0005 | D1 — classify `MISSING / UNRECOVERABLE` | `docs/DECISIONS/0011-adr-0005-provenance-classification.md` | Do not reconstruct its contents; must distinguish ADR-0006's summary of outcomes from the actual missing document |
| E — Publication specification | E3 — defer formal recovery; existing code/tests/ADRs stand as historical evidence only | `docs/DECISIONS/0012-publication-specification-provenance.md` | Do not modify Publication code; do not present inline comments as a reconstructed spec |
| F — Media Production | AUTHORIZE read-only investigation | (investigation output — evidence report, not a governance artifact) | Investigation only: reproduce, isolate `synthesizeNarration`, trace exact failure path, inspect binaries/config/credentials, classify cause (environment / dependency / credential / provider / logic / inconclusive), determine if all 7 share one cause, document evidence, propose smallest corrective scope **without implementing it** |

None of the four documentation artifacts (0009–0012) have been created yet.
They were scoped and approved for creation in the prior session but explicitly
deferred to the next session per the execution order below.

## 6. Hard Prohibitions (Carry Forward Unconditionally)

The next session must NOT, under any of the above decisions or this
checkpoint:

- Modify source code
- Modify tests
- Modify migrations
- Modify dependencies or package manifests/lockfiles
- Modify configuration
- Modify `src/discovery/*`
- Add Discovery to the autonomous runner's stage list
- Modify `workSelection.js` to change the `HANDED_TO_RESEARCH` boundary
- Modify `src/state/SideEffectAuthorization.js`
- Modify Publication concurrency/reclaim logic
- Implement real LLM providers
- Add `contentId` wiring
- Implement the scheduler
- Implement performance-metrics/learning-events schema
- Reconstruct any missing specification (Discovery v0.6, Publication v1, ADR-0005)
- Create replacement historical ADRs presented as if original
- Fix the Media Production narration failures during the F investigation
- Use `git reset`, `git reset --hard`, `git restore`, `git stash`, or `git rebase`
- Amend commits
- Push

## 7. Next Session Execution Order

1. Re-verify baseline (`git fetch` + `git rev-parse` against `origin/main`); confirm it still matches `9463eb2606cf7525ae0a2705f8a3f865e2edb292` or report the actual current SHA if it has moved.
2. Create `docs/DECISIONS/0009-d-c2-implementation-authorization-provenance.md` (Decision A).
3. Create `docs/DECISIONS/0010-autonomous-operation-scope-and-discovery-deferral.md` (Decisions B/C).
4. Create `docs/DECISIONS/0011-adr-0005-provenance-classification.md` (Decision D).
5. Create `docs/DECISIONS/0012-publication-specification-provenance.md` (Decision E).
6. Perform the Decision F read-only Media Production investigation.
7. Report evidence and a proposed corrective scope (description only, not implemented).
8. STOP before implementing any fix — a separate, explicit authorization is required to act on the F findings.

## 8. Summary

| Category | Items |
|---|---|
| **Complete / Closed** | D-C2 mode propagation (`9463eb2`); Publication concurrency/`SQLITE_BUSY_SNAPSHOT` handling |
| **Approved, not yet created** | ADRs 0009, 0010, 0011, 0012 (Decisions A, B/C, D, E) |
| **Authorized, not yet performed** | Decision F read-only investigation |
| **Deferred (no timeline set)** | Real LLM providers; `contentId`/cost-identity wiring; `NEEDS_REVIEW` exit transition; performance metrics; learning events; scheduler implementation; Discovery v0.6 spec recovery; Publication v1 spec recovery |
| **Missing / Unrecoverable** | ADR-0005 (file absent, only ADR-0006's summary of outcomes survives); Discovery "v0.6" spec document; "Autonomous Operation Checkpoint" as previously cited in code comments (this file now fills that role going forward, but does not retroactively reconstruct whatever the code comments originally pointed to) |
| **Open, unresolved investigation** | Root cause of the 7 narration/media-production test failures |
