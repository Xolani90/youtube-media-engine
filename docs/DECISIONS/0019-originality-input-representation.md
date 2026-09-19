# ADR-0019 — Originality Input Representation

**Status:** ACCEPTED — OWNER-AUTHORIZED IMPLEMENTATION CONTRACT
**Implementation:** AUTHORIZED ONLY WITHIN THIS ADR
**Owner:** Xolani Tshabalala
**Baseline:** `4e13b0ec996388c82e2043c42650f19582b4f833`
**Branch:** `main`

---

## 1. Context

Originality (D-G1 v1) sits between Fact-Check and Quality Gate in the autonomous media pipeline.

The current Originality implementation compares the current Script against persisted Scripts using token-set Jaccard similarity. The current implementation tokenizes the persisted `scripts.body` value directly.

For Structured Form Scripts, `scripts.body` is a JSON serialization of structured Script content. Consequently, using the serialized body itself as the similarity representation causes structural serialization artifacts to participate in the measurement.

This ADR establishes the representation that Originality must measure.

The decision is intentionally owned by Originality. It does not redefine Script persistence, Media narration conversion, Discovery similarity/tokenization, or Quality Gate semantics.

---

## 2. Decision

Originality measures **substantive textual content**, not incidental serialization structure.

For a valid Structured Form Script, the **Originality Text** is constructed from exactly these fields, in this order:

1. `hook`
2. `narrative`
3. each section's `content`, in array order
4. `counterpoints`
5. `conclusion`

The following are excluded:

* section `heading`
* section `claim_ids`
* `call_to_action`
* JSON field names
* JSON object/array structure
* serialization formatting
* unknown or unlisted properties

The selected string values are decoded through normal JSON parsing and joined using whitespace.

No labels, connective prose, or synthetic punctuation are added by the representation layer.

The existing tokenizer remains responsible for its established normalization and tokenization behavior.

Originality does not import or reuse the Media narration converter.

---

# 3. Evidence

## E-01 — Current Originality input

**OBSERVED**

The current Originality pipeline tokenizes persisted `scripts.body` values directly.

The corpus query is:

```sql
SELECT id, body
FROM scripts
WHERE id != ?
ORDER BY id ASC
```

Relevant implementation:

```text
src/originality/pipeline.js
```

---

## E-02 — Existing tokenizer and similarity

**OBSERVED**

The shared tokenizer:

* lowercases input;
* replaces characters outside `[a-z0-9\s]` with spaces;
* removes tokens of length one or less;
* removes the established stop-word list.

Similarity is calculated using token sets and Jaccard similarity.

Relevant implementation:

```text
src/discovery/similarity.js
```

---

## E-03 — Shared tokenizer consumption

**OBSERVED**

The same tokenizer/Jaccard implementation is consumed by Discovery and Originality.

This ADR changes the input representation supplied to Originality.

It does not authorize modification of the shared tokenizer or similarity implementation.

---

## E-04 — Script persistence representation

**OBSERVED**

Script persistence serializes six fields into `scripts.body`:

```text
hook
narrative
sections
counterpoints
conclusion
call_to_action
```

The persisted value is produced through JSON serialization.

---

## E-05 — Structured Script section shape

**OBSERVED**

Structured Script sections contain:

```text
heading
content
claim_ids
```

Existing validation requires consumed structured fields and requires section `heading` and `content` to be non-empty, with `claim_ids` represented as a non-empty string array.

---

## E-06 — Call-to-action policy

**OBSERVED**

The call to action may be persisted as `null` when policy does not permit one.

The shipped policy currently has:

```text
allow_call_to_action = false
```

The call to action is nevertheless explicitly excluded from Originality Text regardless of its persisted value.

---

## E-07 — Serialization artifacts

**INFERRED FROM E-04/E-05**

Raw JSON serialization introduces structural material that is not substantive Script prose, including:

* JSON field names;
* claim identifiers;
* JSON punctuation;
* escaping;
* serialization whitespace;
* structural delimiters.

These values are not intended to represent the substantive textual content measured by Originality.

---

## E-08 — Synthetic representation probes

**OBSERVED**

Synthetic probes demonstrated that raw JSON similarity can be affected by structural material and claim identifiers.

Examples showed that:

* structurally similar JSON can share tokens despite different substantive prose;
* disjoint prose can receive non-zero similarity when incidental serialized material overlaps;
* formatting can affect tokenization in some circumstances;
* escaped serialization artifacts can affect the measured token set.

These probes support separating substantive text from serialization structure.

---

## E-09 — Existing Originality specification

**OBSERVED**

Existing Originality governance fixes the algorithm, corpus, and stage placement but does not explicitly define the intended textual representation supplied to the tokenizer.

---

## E-10 — Existing algorithm version

**OBSERVED**

Existing persisted Originality results use:

```text
algorithm_version = v1
```

---

## E-11 — Version interpretation

**INFERRED**

The existing `v1` records describe what the previous implementation computed.

This ADR does not retroactively reinterpret those historical measurements as having used the new representation.

The new representation defined here is a new measurement definition.

---

## E-12 — Representation persistence schema

**OBSERVED**

There is currently no dedicated Originality representation column.

This ADR does not require one.

---

## E-13 — Historical row treatment

**DECIDED**

Existing Originality rows are historical measurements.

They are immutable.

They must not be rewritten or migrated merely because the representation defined by this ADR differs from the historical behavior.

---

## E-14 — Version semantics

**DECIDED**

`algorithm_version` identifies the complete Originality measurement definition, including:

1. input representation;
2. tokenizer/similarity binding;
3. corpus rule.

A change to any of these measurement-defining components requires a separately governed measurement version.

The shared tokenizer remains separately governed.

No modification to `src/discovery/similarity.js` is authorized by this ADR.

---

## E-15 — Authorized version

**OWNER-DECIDED**

The representation-based Originality measurement defined by this ADR uses:

```text
algorithm_version = 'v2'
```

Historical `v1` rows remain immutable.

No other version label is authorized by this ADR.

---

## E-16 — Media narration converter

**OBSERVED**

B-01 introduced:

```text
scriptBodyToNarrationText()
```

This converter is a Script → Media narration conversion.

It includes headings and call-to-action handling, excludes claim IDs, and adds punctuation appropriate to narration.

It is not an Originality representation contract.

---

## E-17 — Media consumer boundary

**OBSERVED**

The B-01 converter is consumed by Media-related code.

Originality currently performs its own independent representation handling.

---

## E-18 — Originality / Media separation

**DECIDED**

Originality must not import or reuse:

```text
src/media/**
```

for its representation.

No shared Script-to-text converter is authorized by this ADR.

The fact that Media and Originality both consume Script content does not establish a shared representation contract.

---

## E-19 — Existing tests

**OBSERVED**

Existing Originality tests primarily exercise plain-text/synthetic bodies and do not fully exercise the actual Structured Script JSON persistence path.

---

## E-20 — Test requirement

**DECIDED**

The implementation tests for this ADR must exercise the actual producer/persistence representation path sufficiently to prove that Structured Form serialization is converted into the defined Originality Text.

---

## E-21 — Quality Gate

**OBSERVED**

The current Quality Gate checks for the existence of an Originality result.

It does not inspect `algorithm_version`.

---

## E-22 — Quality Gate version dependency

**INFERRED**

Because the current Quality Gate does not inspect `algorithm_version`, a historical `v1` row could satisfy an existence-only Quality Gate check.

This ADR does not resolve that issue.

---

# 4. Representation Contract

## 4.1 Structured Originality Text

For a valid Structured Form, Originality Text consists exactly of:

```text
hook
narrative
sections[0].content
sections[1].content
...
sections[n].content
counterpoints
conclusion
```

in that order.

The values are treated as decoded strings.

They are joined using whitespace.

The representation layer does not add semantic labels, connective words, punctuation, or other content.

---

## 4.2 No representation-level normalization

The representation layer does not perform linguistic normalization.

It does not:

* lowercase;
* remove punctuation;
* remove stop words;
* remove short tokens;
* normalize whitespace semantically;
* alter wording.

Those behaviors remain the responsibility of the existing tokenizer.

Serialization formatting itself must not alter the resulting decoded Originality Text.

---

## 4.3 Serialization invariance

Equivalent JSON serializations of the same Structured Form must produce equivalent Originality Text.

This includes, where semantically equivalent:

* compact versus indented JSON;
* whitespace between JSON tokens;
* equivalent JSON escaping, such as an escaped character versus its equivalent decoded character.

A distinction must be maintained between serialization-format invariance and tokenizer behavior.

For example, whether a newline inside a decoded string behaves equivalently to a literal space is governed by the existing tokenizer and is not a representation-layer normalization rule.

---

## 4.4 Body classification

Classification is deterministic and occurs after trimming the body only for the purpose of classification.

### Empty body

An empty body has:

```text
no representation
```

### Body beginning with `{`

A body beginning with `{` is a Structured candidate.

It is Structured Form only if:

1. it parses as one valid JSON object; and
2. the resulting object satisfies the existing Structured Script validation requirements.

If parsing or structural validation fails:

```text
no representation
```

There is no fallback to legacy prose.

### Body beginning with `[`

A body beginning with `[` has:

```text
no representation
```

It is never treated as legacy prose.

Array parsing is not attempted.

### Anything else

Any body not covered above is treated as legacy prose.

For legacy prose, the complete persisted `scripts.body` is the Originality input as written.

---

## 4.5 Current Script failure and corpus exclusion

A current Script with no valid Originality representation is a representation failure.

The current Script:

* must not produce an Originality result row;
* must not fall back to raw serialized JSON;
* must not fall back to Media narration conversion;
* must use the existing established `decision_log` failure path;
* must not transition as though Originality succeeded.

The existing `decision_log` path is established for current-Script structural failure.

### Corpus rows

Corpus rows with no valid Originality representation are excluded deterministically.

An excluded corpus row:

* does not contribute to similarity;
* cannot become the selected maximum;
* is not counted as an eligible comparison;
* does not alter deterministic corpus ordering among eligible rows.

The implementation must not invent a new durable persistence mechanism for individual corpus exclusions.

In particular, it must not create:

* a new exclusion table;
* a new exclusion column;
* a migration;
* a new audit mechanism;
* individual `decision_log` events for corpus rows unless the existing `decision_log` contract independently establishes that such events fit its existing semantics without schema or semantic modification.

The existing evidence establishes that `decision_log` can record the current Script's failure path. It does not establish that one durable event per excluded corpus input is part of its established semantics.

Therefore, corpus exclusion remains a deterministic measurement rule without newly invented per-row durable persistence.

The implementation must expose exclusion information through an existing in-memory or returned evaluation outcome only where such an outcome already exists in the Originality execution contract.

If no such existing outcome exists, the implementation must not invent a new persistence mechanism merely for this purpose.

If all corpus rows are excluded, the existing empty-corpus outcome applies.

Durable per-corpus-row exclusion auditability is a separate future governance decision.

---

## 4.6 Separation from B-01

The Originality representation is Originality-owned.

B-01's Media narration representation is Media-owned.

Originality must not import or reuse the B-01 converter.

No shared converter is authorized by this ADR.

---

## 4.7 Measurement version

The complete measurement definition consists of:

1. representation;
2. tokenizer/similarity binding;
3. corpus rule.

The representation defined by this ADR changes the measurement definition.

Therefore the implementation must persist:

```text
algorithm_version = 'v2'
```

for new Originality measurements produced under this contract.

Historical `v1` rows are immutable and remain measurements of the previous implementation behavior.

No historical `v1` row may be rewritten as `v2`.

The shared tokenizer remains separately governed.

This ADR does not authorize a change to the tokenizer or similarity implementation.

Any future change to representation, tokenizer/similarity binding, or corpus rule requires a separately governed measurement version.

---

# 5. Non-Goals

This ADR does not authorize:

* modification of `src/discovery/similarity.js`;
* modification of the shared tokenizer;
* modification of Discovery;
* modification of Research;
* modification of Brief;
* modification of Script generation;
* modification of Fact-Check;
* modification of Quality Gate;
* modification of Media;
* modification of Publication;
* reuse of B-01's narration converter;
* creation of an Originality representation database column;
* creation of a corpus-exclusion table;
* expansion of `decision_log` semantics;
* rewriting historical Originality rows;
* migration of historical `v1` measurements;
* implementation of B-02b;
* implementation of B-02c;
* implementation of B-02d;
* unrelated asset-query changes;
* unrelated environment fixes.

---

# 6. Quality Gate Dependency

## OPEN GOVERNANCE DEPENDENCY — QUALITY GATE VERSION AWARENESS

**OBSERVED:** The current Quality Gate checks for the existence of an Originality result and does not inspect `algorithm_version`.

**INFERRED:** An existing `v1` Originality row could therefore satisfy the current existence-only Quality Gate.

This ADR does not authorize a Quality Gate change.

Whether Quality Gate must require the current Originality measurement version is a separate Owner decision.

No implementation under this ADR may silently modify Quality Gate to resolve this dependency.

---

# 7. Corpus and Persistence Rules

The existing Originality corpus remains:

```sql
SELECT id, body
FROM scripts
WHERE id != ?
ORDER BY id ASC
```

The current Script is excluded from its own corpus.

For each corpus row:

1. classify its body;
2. derive its representation according to §4.4;
3. exclude rows with no representation;
4. calculate similarity only against eligible representations;
5. preserve deterministic ordering and tie behavior.

The corpus rule itself is part of the `v2` measurement definition.

Originality result persistence remains append-only.

Historical rows are not modified.

---

# 8. Test Contract

The implementation must provide tests sufficient to establish the following.

## T-01 — Structured representation

A valid Structured Script produces Originality Text from exactly the five defined content sources.

## T-02 — Section ordering

Section `content` is included in persisted array order.

## T-03 — Heading exclusion

Changing a section `heading` without changing substantive included content does not change the Originality representation.

## T-04 — Serialization-format invariance

Equivalent serializations of the same Structured Form produce equivalent Originality Text.

Tests must cover, where applicable:

* compact versus indented JSON;
* whitespace between JSON tokens;
* equivalent JSON escaping.

Whitespace normalization inside decoded string values remains a tokenizer-governed concern and must not be asserted as a representation-layer transformation.

## T-05 — Claim-ID exclusion

Changing `claim_ids` without changing substantive included content does not change Originality representation.

## T-06 — CTA exclusion

Changing `call_to_action` without changing substantive included content does not change Originality representation.

## T-07 — Unknown-property exclusion

Adding or changing an unlisted property does not change Originality representation or similarity.

## T-08 — Field coverage

Each of the five defined content sources contributes to the Originality Text.

## T-09 — Substantive field-change measurement

Use controlled fixtures in which each defined field has distinct vocabulary.

Use a corpus containing exactly one eligible comparison Script.

Replace one field with unique marker vocabulary.

Assert the exact expected Jaccard result and establish that it is below `1.0`.

Do not assert the universal proposition that every arbitrary textual change must alter a Jaccard score.

## T-10 — Legacy prose

A non-structured body is treated as legacy prose and compared using the complete persisted body as written.

## T-11 — Array-start classification

A body beginning with `[` receives no representation.

It must not be interpreted as legacy prose.

## T-12 — Invalid structured candidate

A body beginning with `{` that fails JSON parsing or Structured Form validation receives no representation.

It must not fall back to legacy prose.

## T-13 — Current-Script failure

A current Script with no valid representation:

* creates no Originality result row;
* follows the established failure path;
* does not fall back to raw JSON;
* does not fall back to Media narration.

## T-14 — Corpus exclusion

An invalid/no-representation corpus Script:

* cannot contribute to similarity;
* cannot become the maximum;
* does not change eligible corpus ordering;
* does not require a newly invented durable exclusion mechanism.

## T-15 — Empty corpus

If all candidate corpus rows are excluded, the existing empty-corpus outcome is produced.

## T-16 — Version

New Originality result rows produced under this ADR persist:

```text
algorithm_version = 'v2'
```

Historical `v1` rows remain unchanged.

## T-17 — Append-only behavior

Existing Originality result rows are not updated or rewritten.

## T-18 — Deterministic tie behavior

Equivalent maximum similarities preserve the existing deterministic corpus ordering and tie behavior.

## T-19 — Real producer/persistence path

At least one test must exercise the actual Structured Script producer/persistence representation path rather than relying exclusively on manually constructed plain-text fixtures.

## T-20 — Tokenizer boundary

Tests must establish that the representation implementation does not modify the shared tokenizer.

No change to `src/discovery/similarity.js` is authorized.

---

# 9. Governance Gates

## G-01 — Quality Gate

Quality Gate must remain unchanged.

The open Quality Gate version-awareness dependency must not be resolved by this implementation.

## G-02 — Decision-log boundary

Before implementation, verify the existing current-Script `decision_log` failure path.

For corpus exclusions, verify that implementation does not introduce unauthorized per-row persistence or expand `decision_log` semantics.

The implementation must not stop merely because individual corpus exclusions cannot be represented as separate `decision_log` events.

The accepted contract explicitly defines deterministic corpus exclusion without newly invented durable per-row persistence.

## G-03 — Version

New measurements must use exactly:

```text
v2
```

No implementation-time version selection remains open.

## G-04 — Historical immutability

Historical `v1` Originality rows must remain unchanged.

## G-05 — B-01 boundary

The implementation must not import or reuse the B-01 Media narration converter.

## G-06 — Tokenizer boundary

No tokenizer or shared similarity change is authorized.

---

# 10. Acceptance Criteria

ADR-0019 is satisfied when:

1. Structured Script content is represented using exactly the five defined content sources.
2. Structural metadata and serialization artifacts are excluded.
3. Legacy prose remains deterministic and unchanged in representation.
4. `{` and `[` classification is deterministic.
5. Invalid Structured candidates do not fall back to prose.
6. Corpus exclusions are deterministic.
7. Excluded corpus rows cannot affect similarity.
8. Current-Script representation failure follows the established failure path.
9. No unauthorized corpus-exclusion persistence mechanism is introduced.
10. New Originality measurements use `algorithm_version='v2'`.
11. Historical `v1` measurements remain immutable.
12. The tokenizer remains unchanged.
13. B-01 remains independent.
14. Quality Gate remains unchanged.
15. Originality persistence remains append-only.
16. Tests exercise the actual Structured Script persistence path.
17. No unrelated workstream is modified.

---

# 11. Implementation Boundary

Implementation authorized by this ADR is limited to the Originality input-representation change and the tests required to establish this contract.

No implementation authorization extends to:

* Discovery;
* Research;
* Brief;
* Script generation;
* Fact-Check;
* Quality Gate;
* Production;
* Asset Provisioning;
* Rights Verification;
* Media;
* Publication;
* shared tokenizer changes;
* schema expansion;
* unrelated provider changes;
* unrelated bug fixes.

Any requirement discovered during implementation that conflicts with this ADR must stop the implementation and return to Owner governance rather than being silently resolved.

---

# 12. Governance History

This ADR was developed after evidence review of the existing Originality implementation and its interaction with Structured Script persistence.

The initial draft identified six contract issues:

1. ambiguity around `{` versus `[` classification;
2. insufficiently bounded `decision_log` assumptions;
3. incomplete measurement-version semantics;
4. conflation of serialization invariance with tokenizer whitespace behavior;
5. an overbroad substantive-change test assertion;
6. insufficiently explicit Quality Gate version-awareness dependency.

Those issues were resolved before acceptance.

The implementation preflight subsequently identified two additional governance questions:

1. whether individual corpus exclusions fit the established `decision_log` semantics;
2. which new measurement version should be used.

The Owner decisions incorporated into this accepted ADR are:

```text
algorithm_version = 'v2'
```

and:

```text
corpus exclusions are deterministic and must not receive newly invented
per-row durable persistence through decision_log or another mechanism.
```

Current-Script representation failure continues to use the already-established `decision_log` failure path.

Durable per-corpus-row exclusion auditability remains outside this ADR.

---

# 13. Final Decision

**ACCEPTED.**

Originality will measure substantive Script content rather than raw JSON serialization.

For Structured Form, Originality Text consists only of:

```text
hook
narrative
sections[*].content
counterpoints
conclusion
```

in the specified order.

New measurements under this contract use:

```text
algorithm_version = 'v2'
```

Historical `v1` measurements remain immutable.

The tokenizer remains unchanged.

B-01 remains separate.

Quality Gate remains unchanged.

Corpus exclusions are deterministic and cannot influence similarity, while no new durable per-row corpus-exclusion mechanism is authorized.

Implementation is authorized only within the boundaries of this ADR.
