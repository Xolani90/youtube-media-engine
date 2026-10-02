import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createLlmWorkload, guardRouter, classifyLlmFailure, WORKLOAD_FAILURE, BREAKER_STATE, WORKLOAD_ERROR_CODE, LlmWorkloadError
} from '../../src/research/llmWorkload.js';
import { extractClaims } from '../../src/research/claims.js';
import { detectContradiction } from '../../src/research/contradictionDetector.js';
import { verifyClaimAgainstSources, VERIFICATION_RESULT } from '../../src/research/evidenceVerification.js';
import { computeEvidenceStatus } from '../../src/research/evidenceGrading.js';

const ok = (text = '{}') => ({ result: { text, model: 'm', estimatedCost: 0, isPaid: false }, providerUsed: 'p' });
function router(impl) { const r = { calls: 0, async complete(req) { r.calls += 1; return impl(r.calls, req); } }; return r; }
function aggregated(status, message = 'boom', code = null) {
  const e = new Error(`All eligible LLM providers failed. Failures: p: ${message}`);
  e.failures = [{ id: 'p', error: message, status, code, finishReason: null }];
  return e;
}

test('1. a normal call consumes exactly one unit and succeeds unchanged', async () => {
  const w = createLlmWorkload({ max_calls_per_project: 5 });
  const inner = router(() => ok('hello'));
  const out = await guardRouter(inner, w).complete({ prompt: 'x' });
  assert.equal(out.result.text, 'hello');
  assert.equal(w.snapshot().used, 1);
  assert.equal(w.remaining(), 4);
  assert.equal(w.canConsume(), true);
});

test('2/3. extraction, contradiction and verification share one budget; exhaustion stops further calls', async () => {
  const w = createLlmWorkload({ max_calls_per_project: 3 });
  const inner = router((n) => ok(n === 1
    ? JSON.stringify({ claims: [] })
    : n === 2 ? JSON.stringify({ result: 'NO_CONTRADICTION' }) : JSON.stringify({ result: 'UNCERTAIN', quote: '' })));
  const g = guardRouter(inner, w);
  await extractClaims({ sourceText: 'Some source text about things.', coreQuestion: 'q' }, g).catch(() => {});
  assert.ok(w.snapshot().used >= 1);
  const afterExtract = w.snapshot().used;
  await detectContradiction({ id: 'a', claim: 'A is 1.' }, { id: 'b', claim: 'A is 2.' }, g).catch(() => {});
  assert.equal(w.snapshot().used, afterExtract + 1);
  // verification draws on the SAME guarded router
  const src = { id: 's1', url: 'https://example.com/x', content: 'A is 1 according to this long enough source text.' };
  while (w.remaining() > 0) await g.complete({ prompt: 'burn' });
  const innerBefore = inner.calls;
  const out = await verifyClaimAgainstSources({ claim: { claim: 'A is 1.' }, candidateSources: [src, { ...src, id: 's2' }], llmRouter: g });
  assert.equal(inner.calls, innerBefore, 'no provider call after exhaustion');
  assert.equal(out.decisions.length, 1, 'verification halts at the first workload refusal');
  assert.equal(out.decisions[0].workloadHalt, true);
  await assert.rejects(() => g.complete({ prompt: 'x' }), (e) => e instanceof LlmWorkloadError && e.code === WORKLOAD_ERROR_CODE.BUDGET_EXHAUSTED);
});

test('4. HTTP 402 opens the breaker immediately and stops repeated attempts', async () => {
  const w = createLlmWorkload({ max_calls_per_project: 50 });
  const inner = router(() => { throw aggregated(402, 'prepayment credits are depleted'); });
  const g = guardRouter(inner, w);
  await assert.rejects(() => g.complete({ prompt: 'x' }));
  assert.equal(w.snapshot().breaker, BREAKER_STATE.OPEN);
  assert.equal(w.snapshot().openReason, WORKLOAD_FAILURE.DEPLETED_CREDITS);
  for (let i = 0; i < 5; i++) {
    await assert.rejects(() => g.complete({ prompt: 'x' }), (e) => e.code === WORKLOAD_ERROR_CODE.BREAKER_OPEN);
  }
  assert.equal(inner.calls, 1);
  assert.equal(w.snapshot().used, 1);
});

test('authentication/configuration failure fails closed', async () => {
  const w = createLlmWorkload();
  const g = guardRouter(router(() => { throw aggregated(403, 'API key not valid'); }), w);
  await assert.rejects(() => g.complete({ prompt: 'x' }));
  assert.equal(w.snapshot().openReason, WORKLOAD_FAILURE.AUTH_CONFIG);
});

test('5. transient failure stays bounded by the consecutive-failure breaker; success resets it', async () => {
  const w = createLlmWorkload({ max_calls_per_project: 50, max_consecutive_transient_failures: 3 });
  let mode = 'fail';
  const inner = router(() => { if (mode === 'fail') throw aggregated(503, 'unavailable'); return ok(); });
  const g = guardRouter(inner, w);
  await assert.rejects(() => g.complete({})); await assert.rejects(() => g.complete({}));
  mode = 'ok'; await g.complete({});
  assert.equal(w.snapshot().breaker, BREAKER_STATE.CLOSED);
  mode = 'fail';
  for (let i = 0; i < 3; i++) await assert.rejects(() => g.complete({}));
  assert.equal(w.snapshot().breaker, BREAKER_STATE.OPEN);
  await assert.rejects(() => g.complete({}), (e) => e.code === WORKLOAD_ERROR_CODE.BREAKER_OPEN);
  assert.equal(inner.calls, 6);
});

test('6. rate-limit failures are not hammered: breaker opens after the configured consecutive count', async () => {
  const w = createLlmWorkload({ max_consecutive_rate_limit_failures: 2 });
  const inner = router(() => { throw aggregated(429, 'RESOURCE_EXHAUSTED quota'); });
  const g = guardRouter(inner, w);
  await assert.rejects(() => g.complete({})); await assert.rejects(() => g.complete({}));
  await assert.rejects(() => g.complete({}), (e) => e.code === WORKLOAD_ERROR_CODE.BREAKER_OPEN);
  assert.equal(inner.calls, 2);
  assert.equal(w.snapshot().openReason, WORKLOAD_FAILURE.RATE_LIMIT);
});

test('router "cooling down" skip errors classify as rate limit (existing providerHealth semantics preserved)', () => {
  const e = new Error('No usable LLM provider available under current configuration. Attempted: gemini-free: cooling down after a recent rate limit (900ms remaining)');
  assert.equal(classifyLlmFailure(e), WORKLOAD_FAILURE.RATE_LIMIT);
});

test('empty/malformed completion is classified, does not trip the breaker, and the error is re-thrown unchanged', async () => {
  const w = createLlmWorkload();
  const err = aggregated(null, 'empty completion', 'EMPTY_COMPLETION');
  const g = guardRouter(router(() => { throw err; }), w);
  for (let i = 0; i < 5; i++) await assert.rejects(() => g.complete({}), (e) => e === err);
  assert.equal(classifyLlmFailure(err), WORKLOAD_FAILURE.EMPTY_OR_MALFORMED);
  assert.equal(w.snapshot().breaker, BREAKER_STATE.CLOSED);
});

test('extraction keeps its own bounded retry (2 attempts) on empty output through the guard', async () => {
  const w = createLlmWorkload({ max_calls_per_project: 50 });
  const inner = router(() => { throw aggregated(null, 'empty', 'EMPTY_COMPLETION'); });
  await assert.rejects(() => extractClaims({ sourceText: 'Some text here.', coreQuestion: 'q' }, guardRouter(inner, w)));
  assert.ok(inner.calls <= 2);
});

test('7. successful provider calls are unaffected (same result object, no extra calls)', async () => {
  const w = createLlmWorkload();
  const payload = ok('x');
  const inner = router(() => payload);
  const out = await guardRouter(inner, w).complete({ prompt: 'p' }, { runId: 'r' });
  assert.equal(out, payload);
  assert.equal(inner.calls, 1);
});

test('8. the guard cannot produce VERIFIED: it exposes no evidence API and a halted verifier adds no support', async () => {
  const w = createLlmWorkload({ max_calls_per_project: 1 });
  const g = guardRouter(router(() => ok()), w);
  await g.complete({});
  const out = await verifyClaimAgainstSources({
    claim: { claim: 'A is 1.' }, candidateSources: [{ id: 's', url: 'https://e.com/a', content: 'A is 1 per this source text.' }], llmRouter: g
  });
  assert.ok(out.decisions.every((d) => d.result === VERIFICATION_RESULT.UNCERTAIN && d.quoteAccepted === false));
  assert.deepEqual(Object.keys(w).sort(), ['canConsume', 'consume', 'recordFailure', 'recordSuccess', 'remaining', 'snapshot']);
  assert.equal(typeof computeEvidenceStatus, 'function');
});

test('guardRouter passes through a missing router unchanged', () => {
  assert.equal(guardRouter(null, createLlmWorkload()), null);
});
