import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractClaims, EXTRACTION_PARSE_OUTCOME } from '../../src/research/claims.js';
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
    proposedClaimCount: 2
  });
});

test('valid zero-claim response ("[]"): parsed_zero_claims, distinct from a parse failure', async () => {
  const { claims, diagnostics } = await run({ text: '[]', finishReason: 'stop' });
  assert.deepEqual(claims, []);
  assert.equal(diagnostics.parseOutcome, EXTRACTION_PARSE_OUTCOME.PARSED_ZERO_CLAIMS);
  assert.equal(diagnostics.proposedClaimCount, 0);
  assert.equal(diagnostics.contentLength, 2);
});

test('empty response: empty_content with contentLength 0, no throw, zero claims', async () => {
  const { claims, diagnostics } = await run({ text: '', finishReason: 'length' });
  assert.deepEqual(claims, []);
  assert.equal(diagnostics.parseOutcome, EXTRACTION_PARSE_OUTCOME.EMPTY_CONTENT);
  assert.equal(diagnostics.contentLength, 0);
  assert.equal(diagnostics.proposedClaimCount, 0);
});

test('whitespace-only response is also empty_content, but keeps its real content length', async () => {
  const { claims, diagnostics } = await run({ text: '  \n\t ' });
  assert.deepEqual(claims, []);
  assert.equal(diagnostics.parseOutcome, EXTRACTION_PARSE_OUTCOME.EMPTY_CONTENT);
  assert.equal(diagnostics.contentLength, 5);
});

test('malformed/truncated JSON: parse_failed (not empty), zero claims, no throw, content length recorded', async () => {
  const truncated = TWO_CLAIMS.slice(0, TWO_CLAIMS.length - 20);
  const { claims, diagnostics, rawOutput } = await run({ text: truncated, finishReason: 'length', outputTokens: 2048 });
  assert.deepEqual(claims, [], 'behavior unchanged: an unparseable response still yields zero claims');
  assert.equal(diagnostics.parseOutcome, EXTRACTION_PARSE_OUTCOME.PARSE_FAILED);
  assert.equal(diagnostics.contentLength, truncated.length);
  assert.equal(diagnostics.outputTokens, 2048);
  assert.equal(diagnostics.finishReason, 'length');
  assert.equal(diagnostics.proposedClaimCount, 0);
  assert.equal(rawOutput, truncated, 'rawOutput is still the exact, unmodified model output');
});

test('valid JSON that is not an array: parsed_non_array (still zero claims, no throw)', async () => {
  const { claims, diagnostics } = await run({ text: JSON.stringify({ claim: 'not an array' }) });
  assert.deepEqual(claims, []);
  assert.equal(diagnostics.parseOutcome, EXTRACTION_PARSE_OUTCOME.PARSED_NON_ARRAY);
});

test('a single-fence-wrapped valid array is still parsed_claims', async () => {
  const { claims, diagnostics } = await run({ text: '```json\n' + TWO_CLAIMS + '\n```' });
  assert.equal(claims.length, 2);
  assert.equal(diagnostics.parseOutcome, EXTRACTION_PARSE_OUTCOME.PARSED_CLAIMS);
});

test('finish reason present: passed through verbatim from the completion result', async () => {
  const { diagnostics } = await run({ text: TWO_CLAIMS, finishReason: 'length' });
  assert.equal(diagnostics.finishReason, 'length');
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
    ['contentLength', 'finishReason', 'inputTokens', 'model', 'outputTokens', 'parseOutcome', 'proposedClaimCount', 'provider']
  );
});

test('trace event (DIAGNOSTIC_TRACE=true) reports the classification and no content', async () => {
  const truncated = '[{"claim":"' + SENTINEL_RESPONSE.slice(0, 10);
  const { value, lines } = await withTraceOn(() => run({ text: truncated, finishReason: 'length', outputTokens: 2048 }));
  assert.deepEqual(value.claims, []);
  assert.equal(lines.length, 1, 'exactly one extraction-result event per completion');
  const line = lines[0];
  assert.match(line, /provider=obs-stub/);
  assert.match(line, /model=obs-model/);
  assert.match(line, /inputTokens=111/);
  assert.match(line, /outputTokens=2048/);
  assert.match(line, new RegExp(`contentLength=${truncated.length}`));
  assert.match(line, /finishReason=length/);
  assert.match(line, /parseOutcome=parse_failed/);
  assert.match(line, /proposedClaimCount=0/);
  assert.ok(!line.includes(SENTINEL_RESPONSE.slice(0, 10)), 'trace line must not contain model output');
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
