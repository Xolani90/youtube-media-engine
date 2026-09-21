import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  FAILURE_CLASS,
  CLASSIFIED_BY,
  EVIDENCE_NATURE,
  A4_NAMED_OUTCOMES,
  FailureClassificationInputError,
  createInvocationFailureTracker,
  describeDisposition
} from '../../src/state/FailureClassification.js';

// A4 Slice 3 WS1 (ADR-0026): pure classification core. These tests exercise
// only the pure module: no database, no stage, no provider.

const C = FAILURE_CLASS;
const fail = (over = {}) => ({ provider: 'pixabay', stage: 'asset-provisioning', itemId: 'item-A', ...over });
const ev = (nature, basis = 'explicit_structured_field') => ({ nature, basis });

// ---------------------------------------------------------------- A - E

test('A: explicit structured infrastructure evidence -> INFRASTRUCTURE', () => {
  const r = createInvocationFailureTracker().classify(fail({ evidence: ev('INFRASTRUCTURE') }));
  assert.equal(r.classification, C.INFRASTRUCTURE);
  assert.equal(r.classifiedBy, CLASSIFIED_BY.EXPLICIT_EVIDENCE);
  assert.equal(r.a4RetryEligible, false);
  assert.deepEqual(r.evidence, { nature: 'INFRASTRUCTURE', basis: 'explicit_structured_field' });
});

test('B: explicit structured provider-wide evidence -> PROVIDER_WIDE', () => {
  const r = createInvocationFailureTracker().classify(fail({ evidence: ev('PROVIDER_WIDE') }));
  assert.equal(r.classification, C.PROVIDER_WIDE);
  assert.equal(r.classifiedBy, CLASSIFIED_BY.EXPLICIT_EVIDENCE);
  assert.equal(r.a4RetryEligible, false);
  assert.equal(r.repetition.involved, false);
});

test('C: explicit transient evidence + named A4 outcome -> ITEM_TRANSIENT and advisory a4RetryEligible', () => {
  const r = createInvocationFailureTracker().classify(fail({ outcome: 'NO_ASSET_ACQUIRED', evidence: ev('TRANSIENT') }));
  assert.equal(r.classification, C.ITEM_TRANSIENT);
  assert.equal(r.a4RetryEligible, true);
  assert.equal(r.outcome, 'NO_ASSET_ACQUIRED');
});

test('D: explicit deterministic evidence -> ITEM_DETERMINISTIC, never eligible', () => {
  const r = createInvocationFailureTracker().classify(fail({ outcome: 'ASSET_CHECKSUM_MISMATCH', evidence: ev('DETERMINISTIC') }));
  assert.equal(r.classification, C.ITEM_DETERMINISTIC);
  assert.equal(r.a4RetryEligible, false);
});

test('E: single unexplained failure with a valid kind -> INCONCLUSIVE (not provider-wide, not transient, even for a named outcome)', () => {
  const r = createInvocationFailureTracker().classify(fail({ outcome: 'NO_ASSET_ACQUIRED', kind: 'NETWORK_ERROR' }));
  assert.equal(r.classification, C.INCONCLUSIVE);
  assert.equal(r.classifiedBy, CLASSIFIED_BY.NO_EXPLICIT_EVIDENCE);
  assert.equal(r.a4RetryEligible, false);
  assert.deepEqual(r.repetition, { involved: false, distinctItems: 1, itemIds: ['item-A'] });
  assert.deepEqual(r.pattern, { provider: 'pixabay', stage: 'asset-provisioning', kind: 'NETWORK_ERROR' });
});

// ---------------------------------------------------------------- F - H

test('F: the same item failing twice is still INCONCLUSIVE (same-item repetition never counts)', () => {
  const t = createInvocationFailureTracker();
  const r1 = t.classify(fail({ kind: 'K' }));
  const r2 = t.classify(fail({ kind: 'K' }));
  const r3 = t.classify(fail({ kind: 'K' }));
  for (const r of [r1, r2, r3]) {
    assert.equal(r.classification, C.INCONCLUSIVE);
    assert.equal(r.repetition.involved, false);
    assert.equal(r.repetition.distinctItems, 1);
  }
});

test('G: a second distinct item, same provider/stage/kind -> PROVIDER_WIDE via repetition', () => {
  const t = createInvocationFailureTracker();
  assert.equal(t.classify(fail({ itemId: 'A', kind: 'K' })).classification, C.INCONCLUSIVE);
  const r = t.classify(fail({ itemId: 'B', kind: 'K' }));
  assert.equal(r.classification, C.PROVIDER_WIDE);
  assert.equal(r.classifiedBy, CLASSIFIED_BY.INVOCATION_REPETITION);
  assert.deepEqual(r.repetition, { involved: true, distinctItems: 2, itemIds: ['A', 'B'] });
  assert.equal(r.a4RetryEligible, false);
});

test('H: explicit item-specific evidence is never overridden by repetition, in either order', () => {
  // Pattern already established as provider-wide by two inconclusive items...
  const t = createInvocationFailureTracker();
  t.classify(fail({ itemId: 'A', kind: 'K' }));
  assert.equal(t.classify(fail({ itemId: 'B', kind: 'K' })).classification, C.PROVIDER_WIDE);
  // ...a third item carrying explicit item-specific evidence keeps its own class.
  const transient = t.classify(fail({ itemId: 'C', kind: 'K', outcome: 'NO_ASSET_ACQUIRED', evidence: ev('TRANSIENT') }));
  assert.equal(transient.classification, C.ITEM_TRANSIENT);
  assert.equal(transient.classifiedBy, CLASSIFIED_BY.EXPLICIT_EVIDENCE);
  const deterministic = t.classify(fail({ itemId: 'D', kind: 'K', evidence: ev('DETERMINISTIC') }));
  assert.equal(deterministic.classification, C.ITEM_DETERMINISTIC);

  // Explicit evidence first, then an inconclusive item with the same pattern: no aggregation.
  const t2 = createInvocationFailureTracker();
  assert.equal(t2.classify(fail({ itemId: 'A', kind: 'K', evidence: ev('TRANSIENT'), outcome: 'NO_ASSET_ACQUIRED' })).classification, C.ITEM_TRANSIENT);
  const b = t2.classify(fail({ itemId: 'B', kind: 'K' }));
  assert.equal(b.classification, C.INCONCLUSIVE);
  assert.equal(b.repetition.distinctItems, 1);
});

// ---------------------------------------------------------------- I - K

test('I: a bare HTTP status (429) never classifies and never registers', () => {
  const t = createInvocationFailureTracker();
  for (const httpStatus of [429, 500, 401]) {
    for (const itemId of ['A', 'B']) {
      const r = t.classify(fail({ itemId, httpStatus, status: httpStatus, outcome: 'NO_ASSET_ACQUIRED' }));
      assert.equal(r.classification, C.INCONCLUSIVE);
      assert.equal(r.pattern, null);
    }
  }
  assert.deepEqual(t.snapshot(), []);
});

test('J: free-text message / error text alone never classifies', () => {
  const t = createInvocationFailureTracker();
  for (const text of ['rate limit exceeded, provider outage', 'ECONNRESET', 'quota exceeded']) {
    const r = t.classify(fail({ itemId: text, message: text, error: text, reason: text }));
    assert.equal(r.classification, C.INCONCLUSIVE);
    assert.equal(r.evidence, null);
    assert.equal(r.pattern, null);
  }
  assert.deepEqual(t.snapshot(), []);
});

test('K: stderr alone never classifies', () => {
  const t = createInvocationFailureTracker();
  const r = t.classify(fail({ provider: 'ffmpeg', stage: 'media-production', stderr: 'No space left on device ENOSPC', code: 'ENOSPC', signal: 'SIGKILL' }));
  assert.equal(r.classification, C.INCONCLUSIVE);
  assert.equal(r.evidence, null);
  assert.equal(JSON.stringify(r).includes('ENOSPC'), false, 'stderr / code text must not be carried into the record');
});

// ---------------------------------------------------------------- L - O

test('L: the same provider and kind in a different stage does not aggregate', () => {
  const t = createInvocationFailureTracker();
  t.classify(fail({ itemId: 'A', stage: 'asset-provisioning', kind: 'K' }));
  const r = t.classify(fail({ itemId: 'B', stage: 'media-production', kind: 'K' }));
  assert.equal(r.classification, C.INCONCLUSIVE);
  assert.equal(r.repetition.distinctItems, 1);
});

test('M: the same stage and kind under a different provider does not aggregate', () => {
  const t = createInvocationFailureTracker();
  t.classify(fail({ itemId: 'A', provider: 'pixabay', kind: 'K' }));
  const r = t.classify(fail({ itemId: 'B', provider: 'groq-free', kind: 'K' }));
  assert.equal(r.classification, C.INCONCLUSIVE);
  assert.equal(r.repetition.distinctItems, 1);
});

test('N: two independent trackers hold completely independent state (nothing persists across invocations)', () => {
  const t1 = createInvocationFailureTracker({ runId: 'run-1' });
  const t2 = createInvocationFailureTracker({ runId: 'run-2' });
  t1.classify(fail({ itemId: 'A', kind: 'K' }));
  const r = t2.classify(fail({ itemId: 'B', kind: 'K' }));
  assert.equal(r.classification, C.INCONCLUSIVE);
  assert.equal(r.runId, 'run-2');
  assert.deepEqual(t1.snapshot().map((b) => b.itemIds), [['A']]);
  assert.deepEqual(t2.snapshot().map((b) => b.itemIds), [['B']]);
  // A brand-new tracker starts empty even after both others recorded failures.
  assert.deepEqual(createInvocationFailureTracker().snapshot(), []);
});

test('O: a missing or invalid kind is never registered for repetition', () => {
  const invalidKinds = [undefined, null, '', ' K', 'K ', 'K\nX', 42, {}, ['K'], 'x'.repeat(129)];
  const t = createInvocationFailureTracker();
  invalidKinds.forEach((kind, i) => {
    const r = t.classify(fail({ itemId: `item-${i}`, kind }));
    assert.equal(r.classification, C.INCONCLUSIVE, `kind ${JSON.stringify(kind)}`);
    assert.equal(r.kind, null);
    assert.equal(r.pattern, null);
    assert.deepEqual(r.repetition, { involved: false, distinctItems: 0, itemIds: [] });
  });
  assert.deepEqual(t.snapshot(), []);
  // A valid kind afterwards starts from a clean bucket.
  assert.equal(t.classify(fail({ itemId: 'later', kind: 'K' })).repetition.distinctItems, 1);
});

// ---------------------------------------------------------------- P - S

test('P: one item with explicit provider-wide evidence is sufficient (no repetition needed)', () => {
  const t = createInvocationFailureTracker();
  const r = t.classify(fail({ evidence: ev('PROVIDER_WIDE'), kind: 'K' }));
  assert.equal(r.classification, C.PROVIDER_WIDE);
  assert.equal(r.repetition.involved, false);
  assert.equal(r.repetition.distinctItems, 0);
});

test('Q: explicit deterministic failures are never promoted by repetition', () => {
  const t = createInvocationFailureTracker();
  for (const itemId of ['A', 'B', 'C', 'D']) {
    const r = t.classify(fail({ itemId, kind: 'K', evidence: ev('DETERMINISTIC') }));
    assert.equal(r.classification, C.ITEM_DETERMINISTIC);
    assert.equal(r.repetition.involved, false);
  }
  assert.deepEqual(t.snapshot(), []);
});

test('R: explicit infrastructure evidence classifies immediately, on the first item, with no tracker involvement', () => {
  const t = createInvocationFailureTracker();
  const r = t.classify(fail({ evidence: ev('INFRASTRUCTURE'), kind: 'K' }));
  assert.equal(r.classification, C.INFRASTRUCTURE);
  assert.equal(r.repetition.distinctItems, 0);
  assert.deepEqual(t.snapshot(), []);
});

test('S: the classifier never accesses storage', () => {
  const trap = new Proxy({}, {
    get(_t, prop) { throw new Error(`storage accessed: ${String(prop)}`); },
    has() { throw new Error('storage accessed: has'); },
    ownKeys() { throw new Error('storage accessed: ownKeys'); },
    getOwnPropertyDescriptor() { throw new Error('storage accessed: descriptor'); },
    set() { throw new Error('storage accessed: set'); }
  });
  const t = createInvocationFailureTracker({ runId: 'run-S', storage: trap });
  const inputs = [
    fail({ storage: trap, kind: 'K' }),
    fail({ itemId: 'B', storage: trap, kind: 'K' }),
    fail({ storage: trap, evidence: ev('TRANSIENT'), outcome: 'RENDER_FAILED' }),
    fail({ storage: trap, thrown: true })
  ];
  for (const input of inputs) t.classify(input);
  t.snapshot();
});

// ---------------------------------------------------------------- additional required cases

test('thrown without structured evidence -> UNCLASSIFIED, never registered', () => {
  const t = createInvocationFailureTracker();
  const r = t.classify(fail({ thrown: true, kind: 'K', message: 'boom' }));
  assert.equal(r.classification, C.UNCLASSIFIED);
  assert.equal(r.classifiedBy, CLASSIFIED_BY.THROWN_WITHOUT_EVIDENCE);
  assert.equal(r.a4RetryEligible, false);
  assert.deepEqual(t.snapshot(), []);
  // Two distinct thrown items never become provider-wide by repetition.
  assert.equal(t.classify(fail({ itemId: 'B', thrown: true, kind: 'K' })).classification, C.UNCLASSIFIED);
  // An unsupported evidence nature is "no explicit evidence": still UNCLASSIFIED when thrown.
  assert.equal(t.classify(fail({ itemId: 'C', thrown: true, evidence: { nature: 'UNESTABLISHED', basis: 'x' } })).classification, C.UNCLASSIFIED);
});

test('thrown with structured infrastructure evidence -> INFRASTRUCTURE', () => {
  const r = createInvocationFailureTracker().classify(fail({ thrown: true, evidence: ev('INFRASTRUCTURE') }));
  assert.equal(r.classification, C.INFRASTRUCTURE);
  assert.equal(r.classifiedBy, CLASSIFIED_BY.EXPLICIT_EVIDENCE);
});

test('different status / code values with the same kind do not alter pattern identity', () => {
  const t = createInvocationFailureTracker();
  t.classify(fail({ itemId: 'A', kind: 'K', status: 429, code: 'E1', httpStatus: 429 }));
  const r = t.classify(fail({ itemId: 'B', kind: 'K', status: 503, code: 'E2', httpStatus: 503 }));
  assert.equal(r.classification, C.PROVIDER_WIDE);
  assert.deepEqual(r.pattern, { provider: 'pixabay', stage: 'asset-provisioning', kind: 'K' });
});

test('outcome is not part of pattern identity, and never makes a failure transient', () => {
  const t = createInvocationFailureTracker();
  t.classify(fail({ itemId: 'A', kind: 'K', outcome: 'NO_ASSET_ACQUIRED' }));
  const r = t.classify(fail({ itemId: 'B', kind: 'K', outcome: 'INVALID_PROVIDER_RESULT' }));
  assert.equal(r.classification, C.PROVIDER_WIDE);
  for (const outcome of A4_NAMED_OUTCOMES) {
    assert.equal(createInvocationFailureTracker().classify(fail({ outcome, kind: 'K' })).classification, C.INCONCLUSIVE, outcome);
  }
});

test('kind matching is case-sensitive and never normalized', () => {
  const t = createInvocationFailureTracker();
  t.classify(fail({ itemId: 'A', kind: 'Network_Error' }));
  const r = t.classify(fail({ itemId: 'B', kind: 'network_error' }));
  assert.equal(r.classification, C.INCONCLUSIVE);
  assert.equal(r.repetition.distinctItems, 1);
  assert.equal(t.snapshot().length, 2);
});

test('a4RetryEligible is true only for explicit TRANSIENT evidence on a named A4 outcome', () => {
  const t = createInvocationFailureTracker();
  assert.equal(t.classify(fail({ evidence: ev('TRANSIENT'), outcome: 'SOME_OTHER_OUTCOME' })).a4RetryEligible, false);
  assert.equal(t.classify(fail({ evidence: ev('TRANSIENT'), outcome: 'AMBIGUOUS' })).a4RetryEligible, false);
  assert.equal(t.classify(fail({ evidence: ev('TRANSIENT'), outcome: 'PROVIDER_FAILURE' })).a4RetryEligible, false);
  assert.equal(t.classify(fail({ evidence: ev('TRANSIENT') })).a4RetryEligible, false);
  for (const outcome of A4_NAMED_OUTCOMES) {
    assert.equal(t.classify(fail({ itemId: `t-${outcome}`, evidence: ev('TRANSIENT'), outcome })).a4RetryEligible, true, outcome);
    for (const nature of ['INFRASTRUCTURE', 'PROVIDER_WIDE', 'DETERMINISTIC']) {
      assert.equal(t.classify(fail({ itemId: `n-${outcome}-${nature}`, evidence: ev(nature), outcome })).a4RetryEligible, false, `${outcome}/${nature}`);
    }
    assert.equal(t.classify(fail({ itemId: `u-${outcome}`, outcome })).a4RetryEligible, false, `${outcome}/none`);
  }
  assert.equal(A4_NAMED_OUTCOMES.size, 8);
});

test('a4RetryEligible requires a non-empty basis: TRANSIENT still classifies as ITEM_TRANSIENT without one', () => {
  const t = createInvocationFailureTracker();
  const named = 'NO_ASSET_ACQUIRED';

  // 1. TRANSIENT + named A4 outcome + non-empty basis -> eligible
  const withBasis = t.classify(fail({ itemId: 'b1', outcome: named, evidence: { nature: 'TRANSIENT', basis: 'stage_established_cause' } }));
  assert.equal(withBasis.classification, C.ITEM_TRANSIENT);
  assert.equal(withBasis.a4RetryEligible, true);

  // 2. empty basis -> still ITEM_TRANSIENT, NOT eligible (blank counts as empty)
  for (const basis of ['', '   ', '\t\n']) {
    const r = t.classify(fail({ itemId: `empty-${JSON.stringify(basis)}`, outcome: named, evidence: { nature: 'TRANSIENT', basis } }));
    assert.equal(r.classification, C.ITEM_TRANSIENT, JSON.stringify(basis));
    assert.equal(r.a4RetryEligible, false, JSON.stringify(basis));
  }

  // 3. missing basis (absent, null, non-string) -> still ITEM_TRANSIENT, NOT eligible
  for (const evidence of [{ nature: 'TRANSIENT' }, { nature: 'TRANSIENT', basis: null }, { nature: 'TRANSIENT', basis: 42 }]) {
    const r = t.classify(fail({ itemId: `missing-${JSON.stringify(evidence)}`, outcome: named, evidence }));
    assert.equal(r.classification, C.ITEM_TRANSIENT, JSON.stringify(evidence));
    assert.equal(r.a4RetryEligible, false, JSON.stringify(evidence));
    assert.equal(r.evidence.basis, null);
  }

  // 4. non-A4 outcome + non-empty basis -> ITEM_TRANSIENT, NOT eligible
  for (const outcome of ['SOME_OTHER_OUTCOME', 'AMBIGUOUS', 'PROVIDER_FAILURE', undefined]) {
    const r = t.classify(fail({ itemId: `non-a4-${outcome}`, outcome, evidence: { nature: 'TRANSIENT', basis: 'stage_established_cause' } }));
    assert.equal(r.classification, C.ITEM_TRANSIENT, String(outcome));
    assert.equal(r.a4RetryEligible, false, String(outcome));
  }

  // Every named A4 outcome behaves the same way.
  for (const outcome of A4_NAMED_OUTCOMES) {
    assert.equal(t.classify(fail({ itemId: `ok-${outcome}`, outcome, evidence: ev('TRANSIENT', 'x') })).a4RetryEligible, true, outcome);
    assert.equal(t.classify(fail({ itemId: `blank-${outcome}`, outcome, evidence: ev('TRANSIENT', ' ') })).a4RetryEligible, false, outcome);
  }
  // The basis text itself is never interpreted: any non-blank string qualifies, whatever it says.
  assert.equal(t.classify(fail({ itemId: 'odd', outcome: named, evidence: ev('TRANSIENT', 'provider_wide infrastructure outage') })).a4RetryEligible, true);
});

test('third and subsequent distinct items remain PROVIDER_WIDE', () => {
  const t = createInvocationFailureTracker();
  t.classify(fail({ itemId: 'A', kind: 'K' }));
  for (const [n, itemId] of [[2, 'B'], [3, 'C'], [4, 'D']]) {
    const r = t.classify(fail({ itemId, kind: 'K' }));
    assert.equal(r.classification, C.PROVIDER_WIDE);
    assert.equal(r.repetition.distinctItems, n);
  }
  // Re-failing an existing item after establishment stays PROVIDER_WIDE and adds no item.
  const again = t.classify(fail({ itemId: 'A', kind: 'K' }));
  assert.equal(again.classification, C.PROVIDER_WIDE);
  assert.equal(again.repetition.distinctItems, 4);
});

test('explicit evidence does not register in the tracker', () => {
  const t = createInvocationFailureTracker();
  for (const [itemId, nature] of [['A', 'TRANSIENT'], ['B', 'DETERMINISTIC'], ['C', 'INFRASTRUCTURE'], ['D', 'PROVIDER_WIDE']]) {
    t.classify(fail({ itemId, kind: 'K', evidence: ev(nature) }));
  }
  assert.deepEqual(t.snapshot(), []);
  // A single later inconclusive item is therefore alone in its bucket.
  assert.equal(t.classify(fail({ itemId: 'E', kind: 'K' })).classification, C.INCONCLUSIVE);
});

test('no retroactive mutation: earlier records are immutable and unchanged by later failures', () => {
  const t = createInvocationFailureTracker();
  const first = t.classify(fail({ itemId: 'A', kind: 'K' }));
  const firstJson = JSON.stringify(first);
  const second = t.classify(fail({ itemId: 'B', kind: 'K' }));
  assert.equal(second.classification, C.PROVIDER_WIDE);
  assert.equal(first.classification, C.INCONCLUSIVE);
  assert.equal(JSON.stringify(first), firstJson);
  assert.deepEqual(first.repetition.itemIds, ['A'], 'earlier record must not alias the live bucket');
  assert.ok(Object.isFrozen(first) && Object.isFrozen(first.repetition) && Object.isFrozen(first.repetition.itemIds));
  assert.throws(() => { 'use strict'; first.classification = C.PROVIDER_WIDE; }, TypeError);
});

test('evidence.basis is opaque: it is carried but never interprets or alters the classification', () => {
  const t = createInvocationFailureTracker();
  const odd = ['', 'rate limit exceeded (provider outage) - infrastructure!', undefined, 42];
  for (const [i, basis] of odd.entries()) {
    const r = t.classify(fail({ itemId: `b${i}`, evidence: { nature: 'TRANSIENT', basis }, outcome: 'RENDER_FAILED' }));
    assert.equal(r.classification, C.ITEM_TRANSIENT);
    assert.equal(r.evidence.basis, typeof basis === 'string' ? basis : null);
  }
  // Text in basis never promotes an inconclusive failure.
  assert.equal(t.classify(fail({ itemId: 'x', evidence: { basis: 'provider_wide infrastructure' } })).classification, C.INCONCLUSIVE);
});

test('evidence with an unsupported or malformed nature is treated as no explicit evidence', () => {
  const t = createInvocationFailureTracker();
  for (const evidence of [{ nature: 'UNESTABLISHED' }, { nature: 'transient' }, { nature: 'toString' }, { nature: 7 }, { basis: 'x' }, 'TRANSIENT', null, []]) {
    const r = t.classify(fail({ evidence, outcome: 'RENDER_FAILED' }));
    assert.equal(r.classification, C.INCONCLUSIVE, JSON.stringify(evidence));
    assert.equal(r.evidence, null);
    assert.equal(r.a4RetryEligible, false);
  }
});

test('input safety: malformed identity throws FailureClassificationInputError, changes no state, and is not a classification', () => {
  const t = createInvocationFailureTracker();
  t.classify(fail({ itemId: 'A', kind: 'K' }));
  const before = JSON.stringify(t.snapshot());
  const bad = [
    null, undefined, 'x', 5,
    { ...fail(), provider: '' }, { ...fail(), provider: undefined }, { ...fail(), provider: 7 },
    { ...fail(), stage: '' }, { ...fail(), stage: null },
    { ...fail(), itemId: '' }, { ...fail(), itemId: undefined }, { ...fail(), itemId: {} }
  ];
  for (const input of bad) {
    assert.throws(() => t.classify(input), (err) => {
      assert.ok(err instanceof FailureClassificationInputError);
      assert.ok(err instanceof TypeError);
      assert.match(err.message, /^FailureClassification input error: /);
      return true;
    }, JSON.stringify(input));
  }
  assert.equal(JSON.stringify(t.snapshot()), before, 'validation errors must not touch tracker state');
  // Identity is opaque: no provider- or stage-specific validation.
  assert.equal(t.classify({ provider: 'any thing', stage: 'ANY/STAGE', itemId: '\u00e9' }).classification, C.INCONCLUSIVE);
});

test('describeDisposition: classification-level consequence only, no status / pacing / quarantine', () => {
  const terminate = { terminatesInvocation: true, timing: 'IMMEDIATE', contained: false };
  const contained = { terminatesInvocation: false, timing: null, contained: true };
  for (const classification of [C.INFRASTRUCTURE, C.PROVIDER_WIDE, C.UNCLASSIFIED]) {
    assert.deepEqual(describeDisposition({ classification }), terminate, classification);
  }
  for (const classification of [C.ITEM_TRANSIENT, C.ITEM_DETERMINISTIC, C.INCONCLUSIVE]) {
    assert.deepEqual(describeDisposition({ classification }), contained, classification);
  }
  assert.throws(() => describeDisposition({ classification: 'NOPE' }), FailureClassificationInputError);
  assert.throws(() => describeDisposition(null), FailureClassificationInputError);
  // Works on real records too.
  const t = createInvocationFailureTracker();
  assert.deepEqual(describeDisposition(t.classify(fail({ evidence: ev('INFRASTRUCTURE') }))), terminate);
  assert.deepEqual(describeDisposition(t.classify(fail({ itemId: 'Z', kind: 'K' }))), contained);
});

test('records are JSON-safe and carry exactly the specified fields', () => {
  const r = createInvocationFailureTracker({ runId: 'run-x' }).classify(fail({ kind: 'K', outcome: 'RENDER_FAILED', message: 'ignored', stderr: 'ignored', httpStatus: 500 }));
  assert.deepEqual(Object.keys(r).sort(), [
    'a4RetryEligible', 'classification', 'classifiedBy', 'evidence', 'itemId', 'kind',
    'outcome', 'pattern', 'provider', 'repetition', 'runId', 'stage'
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(r)), JSON.parse(JSON.stringify({ ...r })));
  assert.equal(r.runId, 'run-x');
  assert.equal(createInvocationFailureTracker().classify(fail()).runId, null);
});

test('module state: exports are frozen and no mutable module-level tracker exists', () => {
  assert.ok(Object.isFrozen(FAILURE_CLASS) && Object.isFrozen(CLASSIFIED_BY) && Object.isFrozen(EVIDENCE_NATURE));
  assert.ok(Object.isFrozen(A4_NAMED_OUTCOMES));
  for (const method of ['add', 'delete', 'clear']) {
    assert.throws(() => A4_NAMED_OUTCOMES[method]('X'), /read-only/, method);
  }
  assert.equal(A4_NAMED_OUTCOMES.size, 8);
  assert.deepEqual(Object.keys(FAILURE_CLASS), ['INFRASTRUCTURE', 'PROVIDER_WIDE', 'ITEM_TRANSIENT', 'ITEM_DETERMINISTIC', 'INCONCLUSIVE', 'UNCLASSIFIED']);
});

// ---------------------------------------------------------------- source-level boundary

test('boundary: the module has no imports and references no retry, persistence, runner or stage concepts', () => {
  const src = fs.readFileSync(fileURLToPath(new URL('../../src/state/FailureClassification.js', import.meta.url)), 'utf8');
  assert.equal(/^\s*import\s/m.test(src), false, 'no static imports');
  assert.equal(/\bimport\s*\(/.test(src), false, 'no dynamic imports');
  assert.equal(/\brequire\s*\(/.test(src), false, 'no require');
  for (const term of [
    'recordFailedAttempt', 'isQuarantined', 'reactivateQuarantined', 'storage',
    'decision_log', 'runner', 'Research', 'Publication', 'Production', 'StageRetryPolicy'
  ]) {
    assert.equal(src.toLowerCase().includes(term.toLowerCase()), false, `module must not reference "${term}"`);
  }
  assert.equal(/^(let|var)\s/m.test(src), false, 'no module-level mutable bindings');
  assert.equal(/^const\s+\w+\s*=\s*new\s+(Map|Set|WeakMap)\b/m.test(src), false, 'no module-level Map/Set state');
});
