// A4 Slice 3, WS1: pure failure-classification core (ADR-0026 sections 4, 6, 7).
//
// This module is a pure capability. It has no imports, performs no I/O, keeps
// no module-level mutable state, and knows nothing about any stage, provider or
// retry mechanism. Later workstreams consume it; nothing here executes a
// consequence of a classification.
//
// What it reads from a failure (and nothing else):
//   provider, stage, itemId   required opaque identifiers
//   outcome                   opaque; used ONLY for the advisory A4 named-outcome flag
//   kind                      opaque machine-readable failure-pattern identity;
//                             used ONLY for repetition tracking
//   thrown                    true when the failure escaped as a thrown error
//   evidence                  { nature, basis } declared by the caller; `nature`
//                             must be one of EVIDENCE_NATURE; `basis` is opaque
//                             and is never interpreted
// Any other field (message, error text, stderr, HTTP status, numeric code, ...)
// is never read and can never influence a classification.

export const FAILURE_CLASS = Object.freeze({
  INFRASTRUCTURE: 'INFRASTRUCTURE',
  PROVIDER_WIDE: 'PROVIDER_WIDE',
  ITEM_TRANSIENT: 'ITEM_TRANSIENT',
  ITEM_DETERMINISTIC: 'ITEM_DETERMINISTIC',
  INCONCLUSIVE: 'INCONCLUSIVE',
  UNCLASSIFIED: 'UNCLASSIFIED'
});

export const CLASSIFIED_BY = Object.freeze({
  EXPLICIT_EVIDENCE: 'EXPLICIT_EVIDENCE',
  INVOCATION_REPETITION: 'INVOCATION_REPETITION',
  NO_EXPLICIT_EVIDENCE: 'NO_EXPLICIT_EVIDENCE',
  THROWN_WITHOUT_EVIDENCE: 'THROWN_WITHOUT_EVIDENCE'
});

// The explicitly supported machine-readable evidence natures. Any other value
// (or an absent one) is treated as "no explicit evidence".
export const EVIDENCE_NATURE = Object.freeze({
  INFRASTRUCTURE: 'INFRASTRUCTURE',
  PROVIDER_WIDE: 'PROVIDER_WIDE',
  TRANSIENT: 'TRANSIENT',
  DETERMINISTIC: 'DETERMINISTIC'
});

// ADR-0026 section 3.1 (A4): the named outcomes that MAY enter bounded retry.
export const A4_NAMED_OUTCOMES = (() => {
  const set = new Set([
    'GENERATION_RETRY_EXHAUSTED',
    'STRUCTURAL_FAILURE',
    'NO_ASSET_ACQUIRED',
    'INVALID_PROVIDER_RESULT',
    'NARRATION_FAILED',
    'RENDER_FAILED',
    'VALIDATION_FAILED',
    'ASSET_CHECKSUM_MISMATCH'
  ]);
  // Freezing a Set does not stop add/delete/clear, so make them refuse.
  for (const method of ['add', 'delete', 'clear']) {
    Object.defineProperty(set, method, {
      value() { throw new TypeError('A4_NAMED_OUTCOMES is read-only'); }
    });
  }
  return Object.freeze(set);
})();

/**
 * Thrown for malformed failure identity. It is deliberately a distinct error
 * type so it can never be mistaken for a classification of the original
 * failure. It is raised before any tracker state is touched.
 */
export class FailureClassificationInputError extends TypeError {
  constructor(message) {
    super(`FailureClassification input error: ${message}`);
    this.name = 'FailureClassificationInputError';
  }
}

const isIdentifier = (v) => typeof v === 'string' && v.length > 0;

// Minimal safety check for tracker participation only. It gives `kind` no
// meaning: it rejects absent / non-string / empty / oversized values, control
// characters, and leading or trailing whitespace. No trimming, case-folding or
// other normalization is ever applied.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const MAX_KIND_LENGTH = 128;
function validKind(kind) {
  return typeof kind === 'string'
    && kind.length > 0
    && kind.length <= MAX_KIND_LENGTH
    && kind === kind.trim()
    && !CONTROL_CHARS.test(kind);
}

function explicitEvidence(evidence) {
  if (evidence === null || typeof evidence !== 'object') return null;
  const nature = evidence.nature;
  if (typeof nature !== 'string' || !Object.hasOwn(EVIDENCE_NATURE, nature)) return null;
  // `basis` is opaque caller evidence: carried through (JSON-safe) and never read.
  return { nature, basis: typeof evidence.basis === 'string' ? evidence.basis : null };
}

const EXPLICIT_CLASS = Object.freeze({
  [EVIDENCE_NATURE.INFRASTRUCTURE]: FAILURE_CLASS.INFRASTRUCTURE,
  [EVIDENCE_NATURE.PROVIDER_WIDE]: FAILURE_CLASS.PROVIDER_WIDE,
  [EVIDENCE_NATURE.TRANSIENT]: FAILURE_CLASS.ITEM_TRANSIENT,
  [EVIDENCE_NATURE.DETERMINISTIC]: FAILURE_CLASS.ITEM_DETERMINISTIC
});

// Pattern identity is exactly (provider, stage, kind). Nothing else.
const patternKey = (provider, stage, kind) => JSON.stringify([provider, stage, kind]);

// Presence check only, mirroring the existing A4 retry contract (a blank basis
// is no basis). The content of `basis` is never interpreted.
const hasBasis = (evidence) => typeof evidence.basis === 'string' && evidence.basis.trim().length > 0;

function buildRecord({ classification, classifiedBy, provider, stage, itemId, outcome, kind, evidence, repetition, runId }) {
  const a4RetryEligible = classification === FAILURE_CLASS.ITEM_TRANSIENT
    && evidence !== null
    && evidence.nature === EVIDENCE_NATURE.TRANSIENT
    && hasBasis(evidence)
    && outcome !== null
    && A4_NAMED_OUTCOMES.has(outcome);
  return Object.freeze({
    classification,
    classifiedBy,
    provider,
    stage,
    itemId,
    outcome,
    kind,
    pattern: kind === null ? null : Object.freeze({ provider, stage, kind }),
    repetition: Object.freeze({
      involved: repetition.involved,
      distinctItems: repetition.distinctItems,
      itemIds: Object.freeze([...repetition.itemIds])
    }),
    a4RetryEligible,
    evidence: evidence === null ? null : Object.freeze({ nature: evidence.nature, basis: evidence.basis }),
    runId
  });
}

const NO_REPETITION = Object.freeze({ involved: false, distinctItems: 0, itemIds: Object.freeze([]) });

/**
 * Creates an invocation-scoped failure tracker. Every call returns a fully
 * independent instance; all state lives in this closure and is never shared,
 * exported or persisted.
 *
 * @param {{ runId?: string|null }} [options] runId is carried on records only;
 *   it takes no part in classification or pattern identity.
 */
export function createInvocationFailureTracker({ runId = null } = {}) {
  // patternKey -> ordered list of distinct itemIds that failed inconclusively.
  const buckets = new Map();

  return {
    runId,

    /**
     * Classifies one failure. Returns an immutable, JSON-safe record.
     * Throws FailureClassificationInputError (before any state change) when
     * provider, stage or itemId is not a non-empty string.
     */
    classify(failure) {
      if (failure === null || typeof failure !== 'object') {
        throw new FailureClassificationInputError('failure must be an object');
      }
      const { provider, stage, itemId } = failure;
      if (!isIdentifier(provider)) throw new FailureClassificationInputError('provider must be a non-empty string');
      if (!isIdentifier(stage)) throw new FailureClassificationInputError('stage must be a non-empty string');
      if (!isIdentifier(itemId)) throw new FailureClassificationInputError('itemId must be a non-empty string');

      const outcome = typeof failure.outcome === 'string' && failure.outcome.length > 0 ? failure.outcome : null;
      const kind = validKind(failure.kind) ? failure.kind : null;
      const evidence = explicitEvidence(failure.evidence);
      const base = { provider, stage, itemId, outcome, kind, evidence, runId };

      // 1. A thrown failure with no explicit structured evidence is UNCLASSIFIED.
      //    It never enters the repetition tracker.
      if (failure.thrown === true && evidence === null) {
        return buildRecord({
          ...base, classification: FAILURE_CLASS.UNCLASSIFIED,
          classifiedBy: CLASSIFIED_BY.THROWN_WITHOUT_EVIDENCE, repetition: NO_REPETITION
        });
      }

      // 2-5. Explicit structured evidence decides, and repetition is never
      //      consulted. Explicit evidence never enters the tracker.
      if (evidence !== null) {
        return buildRecord({
          ...base, classification: EXPLICIT_CLASS[evidence.nature],
          classifiedBy: CLASSIFIED_BY.EXPLICIT_EVIDENCE, repetition: NO_REPETITION
        });
      }

      // 6. Otherwise INCONCLUSIVE. Only a failure with a valid kind registers.
      if (kind === null) {
        return buildRecord({
          ...base, classification: FAILURE_CLASS.INCONCLUSIVE,
          classifiedBy: CLASSIFIED_BY.NO_EXPLICIT_EVIDENCE, repetition: NO_REPETITION
        });
      }

      const key = patternKey(provider, stage, kind);
      let items = buckets.get(key);
      if (!items) {
        items = [];
        buckets.set(key, items);
      }
      if (!items.includes(itemId)) items.push(itemId); // same-item repetition never counts

      if (items.length >= 2) {
        return buildRecord({
          ...base, classification: FAILURE_CLASS.PROVIDER_WIDE,
          classifiedBy: CLASSIFIED_BY.INVOCATION_REPETITION,
          repetition: { involved: true, distinctItems: items.length, itemIds: items }
        });
      }
      return buildRecord({
        ...base, classification: FAILURE_CLASS.INCONCLUSIVE,
        classifiedBy: CLASSIFIED_BY.NO_EXPLICIT_EVIDENCE,
        repetition: { involved: false, distinctItems: items.length, itemIds: items }
      });
    },

    /** Read-only copy of the current repetition buckets (for diagnostics/tests). */
    snapshot() {
      return [...buckets.entries()].map(([key, items]) => {
        const [provider, stage, kind] = JSON.parse(key);
        return { pattern: { provider, stage, kind }, itemIds: [...items] };
      });
    }
  };
}

/**
 * Pure, advisory description of the classification-level invocation
 * consequence. It executes nothing and encodes no invocation status, pacing
 * or quarantine decision.
 */
export function describeDisposition(record) {
  switch (record?.classification) {
    case FAILURE_CLASS.INFRASTRUCTURE:
    case FAILURE_CLASS.PROVIDER_WIDE:
    case FAILURE_CLASS.UNCLASSIFIED:
      return Object.freeze({ terminatesInvocation: true, timing: 'IMMEDIATE', contained: false });
    case FAILURE_CLASS.ITEM_TRANSIENT:
    case FAILURE_CLASS.ITEM_DETERMINISTIC:
    case FAILURE_CLASS.INCONCLUSIVE:
      return Object.freeze({ terminatesInvocation: false, timing: null, contained: true });
    default:
      throw new FailureClassificationInputError('record has no recognized classification');
  }
}
