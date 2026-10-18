import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FORMAT_DECISION,
  FORMAT_SELECTION_THRESHOLDS as T,
  decideVideoFormat,
  formatsForDecision,
  excludingDecisionForProvider
} from '../../src/media/formatSelection.js';
import { SHORT_FORM_RENDER_DEFAULTS } from '../../src/media/constants.js';

const CAP = SHORT_FORM_RENDER_DEFAULTS.MAX_DURATION_SECONDS;
const okSegment = (end = 45) => ({ selected: true, startSeconds: 0, endSeconds: end });

function signals(over = {}) {
  return {
    narrationDurationSeconds: 240,
    shortSegment: okSegment(45),
    verifiedClaims: T.LONG_FORM_MIN_VERIFIED_CLAIMS,
    distinctSources: T.LONG_FORM_MIN_DISTINCT_SOURCES,
    ...over
  };
}

test('deep material + a cuttable short -> BOTH, with reasons for each format', () => {
  const r = decideVideoFormat(signals());
  assert.equal(r.decision, FORMAT_DECISION.BOTH);
  assert.equal(r.rule, 'BOTH_VIABLE');
  assert.deepEqual(r.viable, { long: true, short: true });
  assert.deepEqual(r.missingSignals, []);
  assert.ok(r.reasons.some((x) => x.startsWith('short-form:')));
  assert.ok(r.reasons.some((x) => x.startsWith('long-form:')));
});

test('deep material but no valid short segment -> LONG_FORM_ONLY', () => {
  const r = decideVideoFormat(signals({ shortSegment: { selected: false, reason: 'NO_VALID_SEGMENT' } }));
  assert.equal(r.decision, FORMAT_DECISION.LONG_FORM_ONLY);
  assert.equal(r.rule, 'LONG_ONLY_NO_VIABLE_SHORT');
  assert.ok(r.reasons.some((x) => x.includes('NO_VALID_SEGMENT')));
});

test('thin evidence depth with a cuttable short -> SHORT_FORM_ONLY', () => {
  const r = decideVideoFormat(signals({ verifiedClaims: T.LONG_FORM_MIN_VERIFIED_CLAIMS - 1 }));
  assert.equal(r.decision, FORMAT_DECISION.SHORT_FORM_ONLY);
  assert.equal(r.rule, 'SHORT_ONLY_LONG_NOT_VIABLE');
  assert.ok(r.reasons.some((x) => x.includes('evidence depth below policy default')));
});

test('too few distinct sources also fails long-form depth', () => {
  const r = decideVideoFormat(signals({ distinctSources: T.LONG_FORM_MIN_DISTINCT_SOURCES - 1 }));
  assert.equal(r.decision, FORMAT_DECISION.SHORT_FORM_ONLY);
});

test('narration at or below the short cap: long-form adds nothing -> SHORT_FORM_ONLY', () => {
  const r = decideVideoFormat(signals({ narrationDurationSeconds: CAP, shortSegment: okSegment(CAP) }));
  assert.equal(r.decision, FORMAT_DECISION.SHORT_FORM_ONLY);
  assert.ok(r.reasons.some((x) => x.includes('adds nothing over the short')));
});

test('one second over the cap with deep material is long-viable', () => {
  const r = decideVideoFormat(signals({ narrationDurationSeconds: CAP + 1 }));
  assert.equal(r.viable.long, true);
});

test('a segment below the minimum short length is not a viable short', () => {
  const r = decideVideoFormat(signals({ shortSegment: okSegment(T.SHORT_FORM_MIN_SECONDS - 1) }));
  assert.equal(r.viable.short, false);
  assert.equal(r.decision, FORMAT_DECISION.LONG_FORM_ONLY);
  assert.ok(r.reasons.some((x) => x.includes('below the')));
});

test('segment exactly at the minimum is viable (boundary)', () => {
  const r = decideVideoFormat(signals({ shortSegment: okSegment(T.SHORT_FORM_MIN_SECONDS) }));
  assert.equal(r.viable.short, true);
});

test('neither format proven viable falls back to UNDECIDED (legacy: both formats eligible), flagged as fallback', () => {
  const r = decideVideoFormat(signals({
    verifiedClaims: 0,
    shortSegment: { selected: false, reason: 'NO_VALID_SEGMENT' }
  }));
  assert.equal(r.decision, FORMAT_DECISION.UNDECIDED);
  assert.equal(r.rule, 'FALLBACK_NO_FORMAT_PROVEN');
  assert.deepEqual(r.viable, { long: false, short: false });
  assert.deepEqual(formatsForDecision(r.decision), { longForm: true, shortForm: true });
});

test('zero verified claims is a real zero, not a missing signal', () => {
  const r = decideVideoFormat(signals({ verifiedClaims: 0, distinctSources: 0 }));
  assert.deepEqual(r.missingSignals, []);
  assert.equal(r.viable.long, false);
});

for (const [name, over, missing] of [
  ['missing narration duration', { narrationDurationSeconds: null }, 'narration_duration'],
  ['non-positive narration duration', { narrationDurationSeconds: 0 }, 'narration_duration'],
  ['NaN narration duration', { narrationDurationSeconds: NaN }, 'narration_duration'],
  ['missing evidence claims', { verifiedClaims: null }, 'evidence_depth'],
  ['missing evidence sources', { distinctSources: null }, 'evidence_depth'],
  ['negative claim count', { verifiedClaims: -1 }, 'evidence_depth'],
  ['missing short segment result', { shortSegment: null }, 'short_segment'],
  ['malformed short segment result', { shortSegment: { reason: 'x' } }, 'short_segment']
]) {
  test(`decisive signal missing (${name}) -> UNDECIDED, named explicitly, never guessed`, () => {
    const r = decideVideoFormat(signals(over));
    assert.equal(r.decision, FORMAT_DECISION.UNDECIDED);
    assert.equal(r.rule, 'DECISIVE_SIGNAL_MISSING');
    assert.ok(r.missingSignals.includes(missing), `expected ${missing} in ${r.missingSignals}`);
    assert.deepEqual(r.viable, { long: null, short: null });
  });
}

test('invalid / absent signal objects never throw and yield UNDECIDED', () => {
  for (const bad of [undefined, null, 42, 'x', [], {}]) {
    const r = decideVideoFormat(bad);
    assert.equal(r.decision, FORMAT_DECISION.UNDECIDED);
    assert.ok(r.missingSignals.length >= 1);
  }
});

test('decision is deterministic and does not mutate its input', () => {
  const input = signals();
  const frozen = JSON.stringify(input);
  const a = decideVideoFormat(input);
  const b = decideVideoFormat(input);
  assert.deepEqual(a, b);
  assert.equal(JSON.stringify(input), frozen);
});

test('only the three format decisions + UNDECIDED can ever be produced', () => {
  const allowed = new Set(Object.values(FORMAT_DECISION));
  const grid = [];
  for (const d of [null, 10, 60, 61, 600]) {
    for (const c of [null, 0, 4, 5, 50]) {
      for (const seg of [null, { selected: false, reason: 'X' }, okSegment(10), okSegment(15), okSegment(59)]) {
        grid.push({ narrationDurationSeconds: d, verifiedClaims: c, distinctSources: c, shortSegment: seg });
      }
    }
  }
  for (const g of grid) assert.ok(allowed.has(decideVideoFormat(g).decision));
});

test('formatsForDecision: UNDECIDED and unknown values keep legacy behaviour (both formats allowed)', () => {
  assert.deepEqual(formatsForDecision(FORMAT_DECISION.LONG_FORM_ONLY), { longForm: true, shortForm: false });
  assert.deepEqual(formatsForDecision(FORMAT_DECISION.SHORT_FORM_ONLY), { longForm: false, shortForm: true });
  assert.deepEqual(formatsForDecision(FORMAT_DECISION.BOTH), { longForm: true, shortForm: true });
  assert.deepEqual(formatsForDecision(FORMAT_DECISION.UNDECIDED), { longForm: true, shortForm: true });
  assert.deepEqual(formatsForDecision(undefined), { longForm: true, shortForm: true });
});

test('excludingDecisionForProvider maps providers to the decision that excludes their target', () => {
  assert.equal(excludingDecisionForProvider('youtube'), FORMAT_DECISION.SHORT_FORM_ONLY);
  assert.equal(excludingDecisionForProvider('youtube_shorts'), FORMAT_DECISION.LONG_FORM_ONLY);
  assert.equal(excludingDecisionForProvider('tiktok'), FORMAT_DECISION.LONG_FORM_ONLY);
  assert.equal(excludingDecisionForProvider('facebook_reels'), FORMAT_DECISION.LONG_FORM_ONLY);
});
