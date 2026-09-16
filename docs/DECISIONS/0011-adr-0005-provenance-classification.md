# ADR-0011: ADR-0005 Provenance Classification

## 1. Status

**CLASSIFIED — MISSING / UNRECOVERABLE — DOCUMENTATION ONLY**

## 2. Purpose

This document records the provenance status of
`docs/DECISIONS/0005-proposed-monetization-compliance-governance.md`
("ADR-0005"), referred to extensively by ADR-0006 as the proposed
specification that ADR-0006 subsequently ratified, but not present in this
repository at the time of this classification.

## 3. Classification

**ADR-0005 = MISSING / UNRECOVERABLE.**

- `docs/DECISIONS/0005-proposed-monetization-compliance-governance.md` does
  not exist in the repository as of this record.
- No other file in `docs/DECISIONS/` or elsewhere in the repository contains
  the original text of ADR-0005.
- ADR-0006 (`docs/DECISIONS/0006-monetization-compliance-governance-ratification.md`)
  references ADR-0005 repeatedly — describing it as "the proposed governance
  specification: twelve D-G decisions plus a two-item further-question set,"
  and recording, decision-by-decision, the Owner's ratification of what
  ADR-0005 had proposed.

## 4. Critical distinction — description is not recovery

**ADR-0006's description of ADR-0005 does not constitute recovery of ADR-0005
itself.**

ADR-0006 records outcomes: which of ADR-0005's proposals the Owner accepted,
which open questions the Owner resolved, and what architectural consequence
each ratified decision establishes. It does this to make the Owner's
decisions part of the durable governance record. It does not — and does not
attempt to — reproduce ADR-0005's original framing, evidence, options,
per-decision AI recommendations, or exact wording. A summary of what was
decided is not the same artifact as the proposal that presented the choices
in the first place, and ADR-0006 does not claim otherwise: §4 of ADR-0006
states explicitly that "ADR-0005 itself remains unchanged. It is not
modified, deleted, or reworded by this document. It stands as the historical
record of the proposal that was ratified" — a statement that presupposes
ADR-0005 exists as a separate artifact, not that ADR-0006 substitutes for it.

Therefore, this document does **not**:

- reconstruct ADR-0005's content from ADR-0006's summary,
- fabricate ADR-0005's original wording,
- create a replacement document and present it as the historical ADR-0005, or
- alter ADR-0006 in any way.

## 5. What remains recoverable

Only the following survive as evidence of ADR-0005's existence and content:

- ADR-0006's decision-by-decision summary of what ADR-0005 proposed and what
  the Owner decided (twelve D-G decisions: D-G1 through D-G12, plus the
  `QUALITY_GATE`/Risk-stage question and the `NEEDS_REVIEW` exit-transition
  question).
- The fact, recorded in ADR-0006 §3, that at ADR-0006's baseline commit the
  working tree was "clean, except the pre-existing untracked ADR-0005 file" —
  indicating ADR-0005 existed as an untracked file in the working tree at
  that point in time, but was never committed to Git history and is not
  otherwise recoverable from this repository's history.

Neither of these is treated as the original ADR-0005 document.

## 6. Consequences

- Any future reference to "what ADR-0005 said" must cite ADR-0006's summary
  explicitly as a summary, not as a direct quotation of or substitute for
  ADR-0005.
- No future document may present a reconstructed or paraphrased ADR-0005 as
  though it were the original.
- The twelve D-G decisions and the two further-question resolutions remain
  governed by ADR-0006's ratification text, which is unaffected by ADR-0005's
  absence.

## 7. What this document does not do

- It does not reconstruct ADR-0005.
- It does not alter ADR-0006.
- It does not create a replacement historical ADR.
- It does not change any source code, test, configuration, or migration.

## 8. Final status

```text
CLASSIFIED — MISSING / UNRECOVERABLE — DOCUMENTATION ONLY
```
