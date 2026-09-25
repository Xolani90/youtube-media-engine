import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  resetRunDiagnostics, snapshotRunDiagnostics, recordL3Call, recordRetrySleep,
  timeDiscovery, formatRunDiagnostics
} from '../../src/diagnostics/runWorkloadDiagnostics.js';
import { checkDuplicate, createDedupWorkloadBudget, DEDUP_RESULT } from '../../src/discovery/dedup.js';
import { LLMRouter } from '../../src/providers/llm/router.js';
import { GroqProvider } from '../../src/providers/llm/GroqProvider.js';
import { GeminiProvider } from '../../src/providers/llm/GeminiProvider.js';

const thresholds = { candidate_threshold: 0.3, confident_duplicate_threshold: 0.8 };

const DISTINCT_PAIR = () => ({
  a: { title: 'Cats and dogs playing outside', description: 'pets', sourceUrl: null, sourceId: null },
  b: { title: 'Quarterly earnings report released', description: 'finance', sourceUrl: null, sourceId: null }
});
const AMBIGUOUS_PAIR = () => ({
  a: { title: 'New AI model launched for small business automation workflows', description: '', sourceUrl: null, sourceId: null },
  b: { title: 'New AI model launched for enterprise automation workflows', description: '', sourceUrl: null, sourceId: null }
});

function stubRouter({ delayMs = 0, fail = false } = {}) {
  const registry = {
    stub: () => ({
      id: 'stub',
      isPaid: false,
      async healthCheck() { return true; },
      async complete() {
        if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
        if (fail) throw new Error('boom');
        return { text: '{"sameEvent": false, "distinctAngle": false}', model: 'stub', requestId: null, inputTokens: 1, outputTokens: 1, estimatedCost: 0, isPaid: false };
      }
    })
  };
  return new LLMRouter({ priority: ['stub'], allowPaidProviders: false, registry });
}

const jsonResponse = (status, body, headers = {}) => ({
  ok: status >= 200 && status < 300, status, headers: new Headers(headers),
  json: async () => body, text: async () => JSON.stringify(body)
});
const groqOk = () => jsonResponse(200, { id: 'r', model: 'm', choices: [{ message: { content: 'ok' } }], usage: {} });
const geminiOk = () => jsonResponse(200, { candidates: [{ content: { parts: [{ text: 'ok' }] } }], usageMetadata: {} });

beforeEach(() => resetRunDiagnostics());

test('reset zeroes every counter and snapshot exposes exactly the seven numeric fields', () => {
  recordL3Call(12);
  recordRetrySleep(500);
  resetRunDiagnostics();
  const snap = snapshotRunDiagnostics();
  assert.deepEqual(Object.keys(snap).sort(), [
    'discoveryElapsedMs', 'l2Comparisons', 'l3ElapsedMs', 'l3SemanticCalls',
    'l3Unresolved', 'llm429Count', 'retrySleepMs'
  ]);
  for (const v of Object.values(snap)) assert.equal(v, 0);
});

test('non-finite or negative durations are ignored, never NaN-poisoning a total', () => {
  recordL3Call(NaN);
  recordL3Call(-5);
  recordRetrySleep(undefined);
  const snap = snapshotRunDiagnostics();
  assert.equal(snap.l3SemanticCalls, 2);
  assert.equal(snap.l3ElapsedMs, 0);
  assert.equal(snap.retrySleepMs, 0);
});

test('dedup: L1 duplicate touches no counter; an L2-only decision counts one comparison and no L3', async () => {
  const dup = { title: 'Foo', sourceUrl: null, sourceId: 's1' };
  await checkDuplicate(dup, { title: 'Bar', sourceUrl: null, sourceId: 's1' }, { thresholds, llmRouter: stubRouter() });
  assert.equal(snapshotRunDiagnostics().l2Comparisons, 0);

  const { a, b } = DISTINCT_PAIR();
  const result = await checkDuplicate(a, b, { thresholds, llmRouter: stubRouter() });
  assert.equal(result.eventMatch, DEDUP_RESULT.DISTINCT);
  const snap = snapshotRunDiagnostics();
  assert.equal(snap.l2Comparisons, 1);
  assert.equal(snap.l3SemanticCalls, 0);
  assert.equal(snap.l3Unresolved, 0);
});

test('dedup: an ambiguous pair counts one L2 comparison, one L3 call, and measured L3 elapsed', async () => {
  const { a, b } = AMBIGUOUS_PAIR();
  await checkDuplicate(a, b, { thresholds, llmRouter: stubRouter({ delayMs: 30 }) });
  const snap = snapshotRunDiagnostics();
  assert.equal(snap.l2Comparisons, 1);
  assert.equal(snap.l3SemanticCalls, 1);
  assert.ok(snap.l3ElapsedMs >= 15, `expected >= 15ms of L3 time, got ${snap.l3ElapsedMs}`);
  assert.ok(snap.l3ElapsedMs < 2000);
});

test('dedup: a throwing L3 call is still counted and timed, and the error still propagates', async () => {
  const { a, b } = AMBIGUOUS_PAIR();
  await assert.rejects(
    () => checkDuplicate(a, b, { thresholds, llmRouter: stubRouter({ delayMs: 20, fail: true }) }),
    /All eligible LLM providers failed/
  );
  const snap = snapshotRunDiagnostics();
  assert.equal(snap.l3SemanticCalls, 1);
  assert.ok(snap.l3ElapsedMs >= 10);
});

test('dedup: L3 ceiling counts an unresolved pair without an L3 call; L2 ceiling counts neither', async () => {
  const { a, b } = AMBIGUOUS_PAIR();
  const l3Capped = createDedupWorkloadBudget({ l2Cap: 10, l3Cap: 0 });
  const r1 = await checkDuplicate(a, b, { thresholds, llmRouter: stubRouter(), budget: l3Capped });
  assert.equal(r1.ceilingReason, 'L3');
  let snap = snapshotRunDiagnostics();
  assert.equal(snap.l2Comparisons, 1);
  assert.equal(snap.l3SemanticCalls, 0);
  assert.equal(snap.l3Unresolved, 1);

  resetRunDiagnostics();
  const l2Capped = createDedupWorkloadBudget({ l2Cap: 0, l3Cap: 10 });
  const r2 = await checkDuplicate(a, b, { thresholds, llmRouter: stubRouter(), budget: l2Capped });
  assert.equal(r2.ceilingReason, 'L2');
  snap = snapshotRunDiagnostics();
  assert.deepEqual([snap.l2Comparisons, snap.l3SemanticCalls, snap.l3Unresolved], [0, 0, 0]);
});

test('dedup: diagnostics do not alter the returned result shape or budget accounting', async () => {
  const { a, b } = AMBIGUOUS_PAIR();
  const budget = createDedupWorkloadBudget({ l2Cap: 5, l3Cap: 5 });
  assert.deepEqual(budget, { l2Cap: 5, l3Cap: 5, l2Used: 0, l3Used: 0 });
  const r = await checkDuplicate(a, b, { thresholds, llmRouter: stubRouter(), budget });
  assert.deepEqual(Object.keys(r).sort(), ['ceilingReason', 'distinctAngle', 'eventMatch', 'layersUsed', 'llmCallMade', 'llmEvidence']);
  assert.deepEqual(budget, { l2Cap: 5, l3Cap: 5, l2Used: 1, l3Used: 1 });
});

test('Groq: 429 then success counts one 429 and the requested retry delay', async () => {
  const responses = [jsonResponse(429, { error: {} }, { 'retry-after': '3' }), groqOk()];
  const sleeps = [];
  const provider = new GroqProvider({
    fetchImpl: async () => responses.shift(), apiKeyProvider: () => 'k', sleepImpl: async (ms) => { sleeps.push(ms); }
  });
  await provider.complete({ prompt: 'p' });
  const snap = snapshotRunDiagnostics();
  assert.equal(snap.llm429Count, 1);
  assert.equal(snap.retrySleepMs, 3000);
  assert.deepEqual(sleeps, [3000], 'retry behavior itself is unchanged');
});

test('Groq: an exhausted 429 counts both 429s but only the one retry sleep (fallback delay)', async () => {
  const sleeps = [];
  const provider = new GroqProvider({
    fetchImpl: async () => jsonResponse(429, { error: {} }), apiKeyProvider: () => 'k', sleepImpl: async (ms) => { sleeps.push(ms); }
  });
  await assert.rejects(() => provider.complete({ prompt: 'p' }), /429/);
  const snap = snapshotRunDiagnostics();
  assert.equal(snap.llm429Count, 2);
  assert.equal(snap.retrySleepMs, sleeps[0]);
  assert.equal(sleeps.length, 1);
});

test('Groq: a non-429 failure and a first-try success record nothing', async () => {
  const bad = new GroqProvider({ fetchImpl: async () => jsonResponse(500, { error: {} }), apiKeyProvider: () => 'k' });
  await assert.rejects(() => bad.complete({ prompt: 'p' }));
  const good = new GroqProvider({ fetchImpl: async () => groqOk(), apiKeyProvider: () => 'k' });
  await good.complete({ prompt: 'p' });
  const snap = snapshotRunDiagnostics();
  assert.equal(snap.llm429Count, 0);
  assert.equal(snap.retrySleepMs, 0);
});

test('Gemini: 429 then success counts one 429 and the requested retry delay', async () => {
  const responses = [jsonResponse(429, { error: { code: 429, status: 'RESOURCE_EXHAUSTED' } }, { 'retry-after': '4' }), geminiOk()];
  const sleeps = [];
  const provider = new GeminiProvider({
    fetchImpl: async () => responses.shift(), apiKeyProvider: () => 'k', sleepImpl: async (ms) => { sleeps.push(ms); }
  });
  await provider.complete({ prompt: 'p' });
  const snap = snapshotRunDiagnostics();
  assert.equal(snap.llm429Count, 1);
  assert.equal(snap.retrySleepMs, 4000);
  assert.deepEqual(sleeps, [4000]);
});

test('Gemini: pacing-floor sleeps are NOT counted as retry sleep', async () => {
  const sleeps = [];
  const provider = new GeminiProvider({
    fetchImpl: async () => geminiOk(), apiKeyProvider: () => 'k',
    sleepImpl: async (ms) => { sleeps.push(ms); }, nowImpl: () => 1000
  });
  await provider.complete({ prompt: 'a' });
  await provider.complete({ prompt: 'b' });
  assert.equal(sleeps.length, 1, 'second call was paced');
  const snap = snapshotRunDiagnostics();
  assert.equal(snap.llm429Count, 0);
  assert.equal(snap.retrySleepMs, 0);
});

test('Gemini: an exhausted 429 counts both 429s and a single retry sleep', async () => {
  const sleeps = [];
  const provider = new GeminiProvider({
    fetchImpl: async () => jsonResponse(429, { error: { code: 429, status: 'RESOURCE_EXHAUSTED' } }),
    apiKeyProvider: () => 'k', sleepImpl: async (ms) => { sleeps.push(ms); }
  });
  await assert.rejects(() => provider.complete({ prompt: 'p' }), /429/);
  const snap = snapshotRunDiagnostics();
  assert.equal(snap.llm429Count, 2);
  assert.equal(snap.retrySleepMs, sleeps[0]);
});

test('timeDiscovery: records elapsed, returns the wrapped result, and still records when the wrapped call throws', async () => {
  const value = await timeDiscovery(async () => { await new Promise((r) => setTimeout(r, 25)); return 'result'; });
  assert.equal(value, 'result');
  const first = snapshotRunDiagnostics().discoveryElapsedMs;
  assert.ok(first >= 15, `expected >= 15ms, got ${first}`);

  await assert.rejects(() => timeDiscovery(async () => { await new Promise((r) => setTimeout(r, 25)); throw new Error('x'); }), /x/);
  assert.ok(snapshotRunDiagnostics().discoveryElapsedMs >= first + 15, 'totals accumulate across calls');
});

test('formatRunDiagnostics emits one numeric-only line: no prompt text, no key material', async () => {
  const provider = new GroqProvider({
    fetchImpl: async () => jsonResponse(429, { error: { message: 'SECRET-BODY' } }), apiKeyProvider: () => 'SECRET-KEY', sleepImpl: async () => {}
  });
  await assert.rejects(() => provider.complete({ prompt: 'SECRET-PROMPT' }));
  const line = formatRunDiagnostics();
  assert.match(line, /^\[discovery-workload-diagnostic\] \{.*\}$/);
  assert.ok(!/SECRET/.test(line));
  for (const v of Object.values(JSON.parse(line.slice(line.indexOf('{'))))) assert.equal(typeof v, 'number');
});
