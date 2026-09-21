# ERRATUM: ADR-0005 numbering inconsistency

## 1. Status

**DOCUMENTATION ERRATUM: NOT AN ADR, NOT A REPLACEMENT.** It carries no ADR
number and renumbers nothing. Recorded alongside ADR-0026 and ADR-0027.

## 2. The inconsistency

- `docs/DECISIONS/0005-research-subsystem-freeze.md` is the current ADR-0005: the
  Research Section 18 freeze, decision date 2026-09-17 (committed as `7789b6e`).
- ADR-0011 (`0011-adr-0005-provenance-classification.md`) uses "ADR-0005" for a
  different historical document, `0005-proposed-monetization-compliance-governance.md`,
  and classifies it MISSING / UNRECOVERABLE.
- The autonomous-operation checkpoint, section 9.4, lists "ADR-0005 (see ADR-0011)"
  as unrecoverable.
- These references cannot all be true of the same file. The repository now
  contains a file numbered ADR-0005 while two records still describe ADR-0005 as
  absent.

## 3. Handling

- **No existing ADR is silently renamed or renumbered.** No file is renamed.
- **For the present governance chain, the current file
  `0005-research-subsystem-freeze.md` is authoritative for the identity
  "ADR-0005"** (this is what ADR-0026 and ADR-0027 mean by it).
- ADR-0011's reference is preserved as a historical record of a different,
  missing monetization/compliance proposal. ADR-0011 is not edited. ADR-0006
  remains the surviving summary of that missing proposal's outcomes.
- The checkpoint carries a pointer to this erratum. Its section 9.4 line is not
  rewritten.
- The Owner has not decided whether to later rename the missing monetization
  document's identifier. That question is left open and is not resolved here.

## 4. Not done

No reconstruction of the missing document; no edit to ADR-0005, ADR-0006 or
ADR-0011; no source, test, configuration or migration change.
