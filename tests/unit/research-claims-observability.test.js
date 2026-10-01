import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractClaims, EXTRACTION_PARSE_OUTCOME, ExtractionFailureError } from '../../src/research/claims.js';
import { LLMRouter } from '../../src/providers/llm/router.js';
import { setTraceSink } from '../../src/diagnostics/trace.js';

// Observability for claim extraction: every completion must be classifiable
// (parsed with claims / parsed with zero claims / empty content / non-empty
// unparseable content) with metadata only -- never model output or source
// text -- and none of it may change what extractClaims() returns as claims
// or how it fails.

const SENTINEL_RESPONSE = 'SENTINEL-MODEL-OUTPUT-TEXT';
const SENTINEL_SOURCE = 'SENTINEL-SOURCE-TEXT';

// `completion` is spread over a baseline provider result, so a test can omit
// finishReason entirely (valid provider shape) or supply one.
function stubRouter(completion) {
  const registry = {
    'obs-stub': () => ({
      id: 'obs-stub', isPaid: false,
      async healthCheck() { return true; },
      async complete() {
        return {
          model: 'obs-model', requestId: null, inputTokens: 111, outputTokens: 222,
          estimatedCost: 0, isPaid: false,
          ...completion
        };
      }
    })
  };
  return new LLMRouter({ priority: ['obs-stub'], allowPaidProviders: false, registry });
}

const TWO_CLAIMS = JSON.stringify([
  { claim: 'The company reported $1B revenue.', claim_type: 'FACT', is_load_bearing: true },
  { claim: 'Analysts think this is impressive.', claim_type: 'OPINION', is_load_bearing: false }
]);

async function run(completion) {
  return extractClaims({ sourceText: SENTINEL_SOURCE, coreQuestion: 'q' }, stubRouter(completion));
}

// Captures only the extraction-result trace lines.
async function withTraceOn(fn) {
  const lines = [];
  const previousSink = setTraceSink((line) => lines.push(line));
  const previousEnv = process.env.DIAGNOSTIC_TRACE;
  process.env.DIAGNOSTIC_TRACE = 'true';
  try {
    const value = await fn();
    return { value, lines: lines.filter((l) => l.includes('research.claimExtraction.result')) };
  } finally {
    if (previousEnv === undefined) delete process.env.DIAGNOSTIC_TRACE;
    else process.env.DIAGNOSTIC_TRACE = previousEnv;
    setTraceSink(previousSink);
  }
}

test('valid multi-claim response: parsed_claims, count, token counts, content length, provider and model', async () => {
  const { claims, diagnostics } = await run({ text: TWO_CLAIMS, finishReason: 'stop' });
  assert.equal(claims.length, 2);
  assert.deepEqual(diagnostics, {
    provider: 'obs-stub',
    model: 'obs-model',
    inputTokens: 111,
    outputTokens: 222,
    contentLength: TWO_CLAIMS.length,
    finishReason: 'stop',
    parseOutcome: EXTRACTION_PARSE_OUTCOME.PARSED_CLAIMS,
    proposedClaimCount: 2,
    attempts: 1
  });
});

test('valid zero-claim response ("[]"): parsed_zero_claims, distinct from a parse failure', async () => {
  const { claims, diagnostics } = await run({ text: '[]', finishReason: 'stop' });
  assert.deepEqual(claims, []);
  assert.equal(diagnostics.parseOutcome, EXTRACTION_PARSE_OUTCOME.PARSED_ZERO_CLAIMS);
  assert.equal(diagnostics.proposedClaimCount, 0);
  assert.equal(diagnostics.contentLength, 2);
});

// Run a completion expected to FAIL extraction; returns the thrown error and
// how many times the provider was called (to prove the retry is bounded).
async function runFailing(completion) {
  let calls = 0;
  const registry = {
    'fail-stub': () => ({
      id: 'fail-stub', isPaid: false,
      async healthCheck() { return true; },
      async complete() {
        calls++;
        return { model: 'obs-model', requestId: null, inputTokens: 111, outputTokens: 222, estimatedCost: 0, isPaid: false, ...completion };
      }
    })
  };
  const router = new LLMRouter({ priority: ['fail-stub'], allowPaidProviders: false, registry });
  let error;
  try { await extractClaims({ sourceText: SENTINEL_SOURCE, coreQuestion: 'q' }, router); } catch (e) { error = e; }
  assert.ok(error instanceof ExtractionFailureError, 'must fail closed with ExtractionFailureError, not return zero claims');
  return { error, calls };
}

test('empty response: fails closed as empty_content after exactly one retry (2 attempts), never zero claims', async () => {
  const { error, calls } = await runFailing({ text: '' });
  assert.equal(error.parseOutcome, EXTRACTION_PARSE_OUTCOME.EMPTY_CONTENT);
  assert.equal(error.attempts, 2);
  assert.equal(calls, 2);
});

test('whitespace-only response is also empty_content failure, keeping its real content length', async () => {
  const { error } = await runFailing({ text: '  \n\t ' });
  assert.equal(error.parseOutcome, EXTRACTION_PARSE_OUTCOME.EMPTY_CONTENT);
  assert.equal(error.contentLength, 5);
});

test('empty content with finishReason length/MAX_TOKENS is classified truncated', async () => {
  for (const finishReason of ['length', 'MAX_TOKENS']) {
    const { error } = await runFailing({ text: '', finishReason });
    assert.equal(error.parseOutcome, EXTRACTION_PARSE_OUTCOME.TRUNCATED);
    assert.equal(error.finishReason, finishReason);
  }
});

test('malformed JSON (no truncation signal): parse_failed failure, no partial recovery, 2 attempts', async () => {
  const truncated = TWO_CLAIMS.slice(0, TWO_CLAIMS.length - 20);
  const { error, calls } = await runFailing({ text: truncated, finishReason: 'stop', outputTokens: 2048 });
  assert.equal(error.parseOutcome, EXTRACTION_PARSE_OUTCOME.PARSE_FAILED);
  assert.equal(error.contentLength, truncated.length);
  assert.equal(error.outputTokens, 2048);
  assert.equal(calls, 2);
  assert.ok(!error.message.includes('Acme') && !error.message.includes(SENTINEL_SOURCE), 'metadata only');
});

test('truncated output (finishReason length / MAX_TOKENS) is a failure even when the text parses', async () => {
  for (const finishReason of ['length', 'MAX_TOKENS', 'max_tokens']) {
    const { error } = await runFailing({ text: TWO_CLAIMS, finishReason });
    assert.equal(error.parseOutcome, EXTRACTION_PARSE_OUTCOME.TRUNCATED, finishReason);
    assert.equal(error.finishReason, finishReason);
  }
});

test('valid JSON that is not an array: parsed_non_array failure, not zero claims', async () => {
  const { error } = await runFailing({ text: JSON.stringify({ claim: 'not an array' }) });
  assert.equal(error.parseOutcome, EXTRACTION_PARSE_OUTCOME.PARSED_NON_ARRAY);
});

test('a bad first attempt followed by a good retry succeeds, with attempts=2 recorded', async () => {
  let calls = 0;
  const registry = {
    'flaky-stub': () => ({
      id: 'flaky-stub', isPaid: false,
      async healthCheck() { return true; },
      async complete() {
        calls++;
        const text = calls === 1 ? TWO_CLAIMS.slice(0, 30) : TWO_CLAIMS;
        return { text, model: 'obs-model', requestId: null, inputTokens: 1, outputTokens: 1, estimatedCost: 0, isPaid: false, finishReason: 'stop' };
      }
    })
  };
  const router = new LLMRouter({ priority: ['flaky-stub'], allowPaidProviders: false, registry });
  const { claims, diagnostics } = await extractClaims({ sourceText: 'x', coreQuestion: 'q' }, router);
  assert.equal(claims.length, 2);
  assert.equal(diagnostics.attempts, 2);
  assert.equal(calls, 2);
});

test('a legitimate zero-claim "[]" is NOT a failure and is not retried', async () => {
  let calls = 0;
  const registry = {
    'zero-stub': () => ({
      id: 'zero-stub', isPaid: false,
      async healthCheck() { return true; },
      async complete() { calls++; return { text: '[]', model: 'm', requestId: null, inputTokens: 1, outputTokens: 1, estimatedCost: 0, isPaid: false, finishReason: 'stop' }; }
    })
  };
  const router = new LLMRouter({ priority: ['zero-stub'], allowPaidProviders: false, registry });
  const { claims, diagnostics } = await extractClaims({ sourceText: 'x', coreQuestion: 'q' }, router);
  assert.deepEqual(claims, []);
  assert.equal(diagnostics.parseOutcome, EXTRACTION_PARSE_OUTCOME.PARSED_ZERO_CLAIMS);
  assert.equal(calls, 1);
});

test('Gemini-style EMPTY_COMPLETION provider error is classified empty_content/truncated and retried once', async () => {
  let calls = 0;
  const registry = {
    'gem-stub': () => ({
      id: 'gem-stub', isPaid: false,
      async healthCheck() { return true; },
      async complete() {
        calls++;
        throw Object.assign(new Error('no usable completion text'), { code: 'EMPTY_COMPLETION', finishReason: 'MAX_TOKENS' });
      }
    })
  };
  const router = new LLMRouter({ priority: ['gem-stub'], allowPaidProviders: false, registry });
  await assert.rejects(
    () => extractClaims({ sourceText: 'x', coreQuestion: 'q' }, router),
    (e) => e instanceof ExtractionFailureError && e.parseOutcome === EXTRACTION_PARSE_OUTCOME.TRUNCATED && e.finishReason === 'MAX_TOKENS' && e.attempts === 2
  );
  assert.equal(calls, 2);
});

test('transport/provider failure is provider_failed and NOT retried at the extraction level', async () => {
  let calls = 0;
  const registry = {
    'down-stub': () => ({
      id: 'down-stub', isPaid: false,
      async healthCheck() { return true; },
      async complete() { calls++; throw Object.assign(new Error('HTTP 503'), { status: 503 }); }
    })
  };
  const router = new LLMRouter({ priority: ['down-stub'], allowPaidProviders: false, registry });
  await assert.rejects(
    () => extractClaims({ sourceText: 'x', coreQuestion: 'q' }, router),
    (e) => e instanceof ExtractionFailureError && e.parseOutcome === EXTRACTION_PARSE_OUTCOME.PROVIDER_FAILED && /HTTP 503/.test(e.message)
  );
  assert.equal(calls, 1);
});

test('a single-fence-wrapped valid array is still parsed_claims', async () => {
  const { claims, diagnostics } = await run({ text: '```json\n' + TWO_CLAIMS + '\n```' });
  assert.equal(claims.length, 2);
  assert.equal(diagnostics.parseOutcome, EXTRACTION_PARSE_OUTCOME.PARSED_CLAIMS);
});

test('finish reason present: passed through verbatim from the completion result', async () => {
  const { diagnostics } = await run({ text: TWO_CLAIMS, finishReason: 'STOP' });
  assert.equal(diagnostics.finishReason, 'STOP');
});

test('finish reason absent (valid provider shape): recorded as null, extraction unaffected', async () => {
  const { claims, diagnostics } = await run({ text: TWO_CLAIMS });
  assert.equal(claims.length, 2);
  assert.equal(diagnostics.finishReason, null);
});

test('missing token counts are recorded as null rather than undefined', async () => {
  const { diagnostics } = await run({ text: '[]', inputTokens: null, outputTokens: undefined });
  assert.equal(diagnostics.inputTokens, null);
  assert.equal(diagnostics.outputTokens, null);
});

test('diagnostics carry metadata only: neither model output nor source text appears in them', async () => {
  const text = JSON.stringify([{ claim: SENTINEL_RESPONSE, claim_type: 'FACT', is_load_bearing: true }]);
  const { diagnostics } = await run({ text, finishReason: 'stop' });
  const serialized = JSON.stringify(diagnostics);
  assert.ok(!serialized.includes(SENTINEL_RESPONSE), 'model output must not leak into diagnostics');
  assert.ok(!serialized.includes(SENTINEL_SOURCE), 'source text must not leak into diagnostics');
  assert.deepEqual(
    Object.keys(diagnostics).sort(),
    ['attempts', 'contentLength', 'finishReason', 'inputTokens', 'model', 'outputTokens', 'parseOutcome', 'proposedClaimCount', 'provider']
  );
});

test('trace event (DIAGNOSTIC_TRACE=true) reports the classification and no content', async () => {
  const text = JSON.stringify([{ claim: SENTINEL_RESPONSE, claim_type: 'FACT', is_load_bearing: true }]);
  const { value, lines } = await withTraceOn(() => run({ text, finishReason: 'stop', outputTokens: 2048 }));
  assert.equal(value.claims.length, 1);
  assert.equal(lines.length, 1, 'exactly one extraction-result event per completion');
  const line = lines[0];
  assert.match(line, /provider=obs-stub/);
  assert.match(line, /model=obs-model/);
  assert.match(line, /inputTokens=111/);
  assert.match(line, /outputTokens=2048/);
  assert.match(line, new RegExp(`contentLength=${text.length}`));
  assert.match(line, /finishReason=stop/);
  assert.match(line, /parseOutcome=parsed_claims/);
  assert.match(line, /proposedClaimCount=1/);
  assert.match(line, /attempts=1/);
  assert.ok(!line.includes(SENTINEL_RESPONSE), 'trace line must not contain model output');
  assert.ok(!line.includes(SENTINEL_SOURCE), 'trace line must not contain source text');
});

test('trace event names an absent finish reason explicitly instead of silently omitting the field', async () => {
  const { lines } = await withTraceOn(() => run({ text: '[]' }));
  assert.equal(lines.length, 1);
  assert.match(lines[0], /finishReason=absent/);
  assert.match(lines[0], /parseOutcome=parsed_zero_claims/);
});

test('trace is inert by default: no extraction-result line without DIAGNOSTIC_TRACE', async () => {
  const lines = [];
  const previousSink = setTraceSink((line) => lines.push(line));
  const previousEnv = process.env.DIAGNOSTIC_TRACE;
  delete process.env.DIAGNOSTIC_TRACE;
  try {
    await run({ text: TWO_CLAIMS });
  } finally {
    if (previousEnv !== undefined) process.env.DIAGNOSTIC_TRACE = previousEnv;
    setTraceSink(previousSink);
  }
  assert.deepEqual(lines, []);
});

test('provider errors still propagate unchanged and emit no extraction-result event', async () => {
  const registry = {
    'boom-stub': () => ({
      id: 'boom-stub', isPaid: false,
      async healthCheck() { return true; },
      async complete() { throw new Error('provider exploded'); }
    })
  };
  const router = new LLMRouter({ priority: ['boom-stub'], allowPaidProviders: false, registry });
  const { lines } = await withTraceOn(async () => {
    await assert.rejects(
      () => extractClaims({ sourceText: 'text', coreQuestion: 'q' }, router),
      /All eligible LLM providers failed.*boom-stub: provider exploded/
    );
  });
  assert.deepEqual(lines, []);
});
