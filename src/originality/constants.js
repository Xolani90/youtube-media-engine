// D-G1 v1 — Originality measurement stage. Originality owns this
// vocabulary; it is not shared with or imported from Fact-Check or
// RiskPolicy.

export const ORIGINALITY_STAGE = 'ORIGINALITY_CHECK';

// The exact corpus rule in force for v1 (Owner Decision): every persisted
// `scripts` row except the exact current script_id. Earlier drafts of the
// same content_brief_id are NOT excluded.
export const CORPUS_DEFINITION = 'all_prior_scripts_excluding_current_script_id';

export const ALGORITHM = 'jaccard_token_set';
export const ALGORITHM_VERSION = 'v1';

// Recorded verbatim into every persisted result row (Owner Decision: known
// limitations must be data, not just a source comment). Deliberately does
// not assert anything this measurement cannot support.
export const KNOWN_LIMITATIONS =
  'Lexical (token-overlap) similarity only, not semantic; cannot establish ' +
  'legal originality, copyright ownership, fair use, or YouTube ' +
  'reused-content-policy eligibility; not a quality or monetization ' +
  'signal; corpus-growth bias is accepted for v1 (maximum similarity may ' +
  'rise over time purely because the corpus grows, independent of actual ' +
  'repetitiveness); earlier drafts of the same content brief remain in ' +
  'the corpus and may inflate similarity for unrelated reasons.';

export const DECISION_LOG_DECISION = Object.freeze({
  STRUCTURAL_FAILURE: 'STRUCTURAL_FAILURE',
  ORIGINALITY_EVALUATED: 'ORIGINALITY_EVALUATED',
  ORIGINALITY_EVALUATED_EMPTY_CORPUS: 'ORIGINALITY_EVALUATED_EMPTY_CORPUS'
});
