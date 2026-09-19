// D-G1 — Originality measurement stage. Originality owns this
// vocabulary; it is not shared with or imported from Fact-Check or
// RiskPolicy.

export const ORIGINALITY_STAGE = 'ORIGINALITY_CHECK';

// The exact corpus rule in force (Owner Decision): every persisted
// `scripts` row except the exact current script_id. Earlier drafts of the
// same content_brief_id are NOT excluded. Rows with no valid Originality
// representation (see ./representation.js) are excluded deterministically
// per ADR-0019 §4.5/§7; that exclusion does not change this corpus rule's
// text, since exclusion happens after this row set is read, not as a
// different SQL definition of the corpus.
export const CORPUS_DEFINITION = 'all_prior_scripts_excluding_current_script_id';

export const ALGORITHM = 'jaccard_token_set';

// ADR-0019 §4.7 (Owner-decided, E-15): `algorithm_version` identifies the
// complete measurement definition (representation + tokenizer/similarity
// binding + corpus rule). The input-representation change in ADR-0019 is
// a new measurement definition, so all NEW Originality result rows must
// persist 'v2'. Historical rows already persisted as 'v1' describe the
// previous implementation's behavior and are immutable — they are never
// migrated or reinterpreted as 'v2' (ADR-0019 E-13/G-04).
export const ALGORITHM_VERSION = 'v2';

// Recorded verbatim into every persisted result row (Owner Decision: known
// limitations must be data, not just a source comment). Deliberately does
// not assert anything this measurement cannot support.
export const KNOWN_LIMITATIONS =
  'Lexical (token-overlap) similarity only, not semantic; cannot establish ' +
  'legal originality, copyright ownership, fair use, or YouTube ' +
  'reused-content-policy eligibility; not a quality or monetization ' +
  'signal; corpus-growth bias is accepted (maximum similarity may ' +
  'rise over time purely because the corpus grows, independent of actual ' +
  'repetitiveness); earlier drafts of the same content brief remain in ' +
  'the corpus and may inflate similarity for unrelated reasons; corpus ' +
  'rows and the current Script with no valid Originality representation ' +
  '(ADR-0019 §4.4) are excluded deterministically and are not otherwise ' +
  'flagged in this record.';

export const DECISION_LOG_DECISION = Object.freeze({
  STRUCTURAL_FAILURE: 'STRUCTURAL_FAILURE',
  ORIGINALITY_EVALUATED: 'ORIGINALITY_EVALUATED',
  ORIGINALITY_EVALUATED_EMPTY_CORPUS: 'ORIGINALITY_EVALUATED_EMPTY_CORPUS'
});

// ADR-0019 §4.4/§4.5: reason recorded via the existing STRUCTURAL_FAILURE
// decision_log path when the current Script has no valid Originality
// representation (empty body, invalid/malformed structured candidate, or
// array-shaped body). No new decision_log decision value is introduced —
// this reuses DECISION_LOG_DECISION.STRUCTURAL_FAILURE, exactly the
// mechanism already established for NO_CURRENT_SCRIPT and the other
// eligibility failures in ./eligibility.js.
export const NO_ORIGINALITY_REPRESENTATION_REASON = 'NO_ORIGINALITY_REPRESENTATION';
