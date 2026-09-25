import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  traceEnabled, traceAsync, traceSync, traceEvent, startTrace, setTraceSink, safeHost, safeUrl
} from '../../src/diagnostics/trace.js';
import { LLMRouter } from '../../src/providers/llm/router.js';
import { GroqProvider } from '../../src/providers/llm/GroqProvider.js';

const SECRET_PROMPT = 'SUPER-SECRET-PROMPT-TEXT with spaces';
const SECRET_KEY = 'gsk_SECRET_API_KEY_123';

async function withTrace(enabled, fn) {
  const lines = [];
  const previousSink = setTraceSink((line) => lines.push(line));
  const previousEnv = process.env.DIAGNOSTIC_TRACE;
  if (enabled) process.env.DIAGNOSTIC_TRACE = 'true';
  else delete process.env.DIAGNOSTIC_TRACE;
  try {
    const value = await fn(lines);
    return { value, lines };
  } finally {
    if (previousEnv === undefined) delete process.env.DIAGNOSTIC_TRACE;
    else process.env.DIAGNOSTIC_TRACE = previousEnv;
    setTraceSink(previousSink);
  }
}

// ---------------------------------------------------------------- inert by default

test('trace is inert when DIAGNOSTIC_TRACE is absent: pass-through, no output, no listeners', async () => {
  const exitListeners = process.listenerCount('exit');
  const { lines } = await withTrace(false, async () => {
    assert.equal(traceEnabled(), false);

    // Same promise object comes back -- not a wrapper promise.
    const pending = Promise.resolve({ ok: true });
    assert.strictEqual(traceAsync('x', { a: 1 }, () => pending), pending);

    assert.equal(traceSync('y', {}, () => 42), 42);

    // Errors are the original error object, sync and async.
    const boom = new Error('boom');
    assert.throws(() => traceSync('z', {}, () => { throw boom; }), (e) => e === boom);
    await assert.rejects(traceAsync('w', {}, () => Promise.reject(boom)), (e) => e === boom);

    traceEvent('e', { a: 1 });
    startTrace();
  });
  assert.deepEqual(lines, []);
  assert.equal(process.listenerCount('exit'), exitListeners);
});

test('only the exact value "true" enables tracing', async () => {
  for (const value of ['1', 'TRUE', 'yes', 'false', '']) {
    const previous = process.env.DIAGNOSTIC_TRACE;
    process.env.DIAGNOSTIC_TRACE = value;
    try {
      assert.equal(traceEnabled(), false, `value ${JSON.stringify(value)} must not enable tracing`);
    } finally {
      if (previous === undefined) delete process.env.DIAGNOSTIC_TRACE;
      else process.env.DIAGNOSTIC_TRACE = previous;
    }
  }
});

// ---------------------------------------------------------------- enabled: markers

test('enabled: BEGIN/END with timestamp, elapsedMs, nesting, and a pending BEGIN before END', async () => {
  const { lines } = await withTrace(true, async (captured) => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const outer = traceAsync('outer.op', { provider: 'p1' }, async () => {
      await traceAsync('inner.op', { attempt: 2 }, () => gate, (r) => ({ status: r }));
      return 'done';
    });
    // While the inner operation is pending: BEGIN lines exist, no END yet.
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(captured.some((l) => l.includes(' BEGIN outer.op')));
    assert.ok(captured.some((l) => l.includes(' BEGIN inner.op')));
    assert.ok(!captured.some((l) => l.includes(' END ')));
    release(200);
    assert.equal(await outer, 'done');
  });
  const text = lines.join('\n');
  assert.match(lines[0], /^\[trace\] \d{4}-\d\d-\d\dT[\d:.]+Z \+\d+ms BEGIN outer\.op /);
  assert.match(text, /BEGIN inner\.op in=outer\.op attempt=2/);
  assert.match(text, /END inner\.op elapsedMs=\d+ status=200/);
  assert.match(text, /END outer\.op elapsedMs=\d+/);
  assert.match(text, /provider=p1/);
});

test('enabled: FAIL logs error name and status only, then re-throws the original error', async () => {
  const boom = Object.assign(new TypeError('secret detail that must not be printed'), { status: 429 });
  const { lines } = await withTrace(true, async () => {
    await assert.rejects(traceAsync('op', {}, () => Promise.reject(boom)), (e) => e === boom);
    assert.throws(() => traceSync('op2', {}, () => { throw boom; }), (e) => e === boom);
  });
  const text = lines.join('\n');
  assert.match(text, /FAIL op elapsedMs=\d+ error=TypeError status=429/);
  assert.match(text, /FAIL op2 /);
  assert.ok(!text.includes('secret detail'));
});

test('enabled: unsafe field values are omitted and URLs lose their query string', async () => {
  const { lines } = await withTrace(true, async () => {
    traceEvent('fields', {
      prompt: SECRET_PROMPT,
      long: 'a'.repeat(300),
      ok: 'groq-free',
      n: 7,
      flag: true,
      missing: undefined
    });
    traceEvent('urls', {
      host: safeHost('https://user:pw@api.example.com/v1/x?key=SECRET_URL_KEY'),
      url: safeUrl('https://api.example.com/v1/x?key=SECRET_URL_KEY#frag')
    });
  });
  const text = lines.join('\n');
  assert.match(text, /prompt=\[omitted\] long=\[omitted\] ok=groq-free n=7 flag=true(?!.*missing)/);
  assert.ok(!text.includes('SUPER-SECRET'));
  assert.ok(!text.includes('SECRET_URL_KEY'));
  assert.ok(!text.includes('pw@'));
  assert.match(text, /host=api\.example\.com url=api\.example\.com\/v1\/x/);
});

test('a throwing endFields callback never affects the result', async () => {
  const { value } = await withTrace(true, async () =>
    traceAsync('op', {}, async () => 'value', () => { throw new Error('bad endFields'); }));
  assert.equal(value, 'value');
});

// ---------------------------------------------------------------- integration: call sites

function fakeRouterRegistry() {
  return {
    stub: () => ({
      id: 'stub-provider',
      isPaid: false,
      healthCheck: async () => true,
      complete: async () => ({
        text: 'ok', model: 'stub-model', requestId: null, inputTokens: 3, outputTokens: 4, estimatedCost: 0, isPaid: false
      })
    })
  };
}

test('LLMRouter: identical result with tracing on/off; markers name provider/model but never the prompt', async () => {
  const request = { prompt: SECRET_PROMPT, maxTokens: 250 };
  const router = () => new LLMRouter({ priority: ['stub'], allowPaidProviders: false, registry: fakeRouterRegistry() });

  const off = await withTrace(false, () => router().complete(request));
  const on = await withTrace(true, () => router().complete(request));

  assert.deepEqual(on.value, off.value);
  assert.deepEqual(off.lines, []);
  const text = on.lines.join('\n');
  assert.match(text, /BEGIN llm\.complete provider=stub-provider maxTokens=250 promptChars=\d+/);
  assert.match(text, /END llm\.complete elapsedMs=\d+ model=stub-model inTokens=3 outTokens=4/);
  assert.ok(!text.includes('SUPER-SECRET'));
});

test('GroqProvider: 429 retry path marks request/status, sleep delay and body; never prints key or prompt; same result as untraced', async () => {
  const makeFetch = () => {
    const responses = [
      { ok: false, status: 429, headers: { get: (h) => (h === 'retry-after' ? '7' : null) }, text: async () => '{"error":{"message":"rate limited"}}' },
      { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ id: 'req-1', model: 'm1', choices: [{ message: { content: 'hello' } }], usage: { prompt_tokens: 1, completion_tokens: 2 } }) }
    ];
    return async () => responses.shift();
  };
  const run = () => {
    const sleeps = [];
    const provider = new GroqProvider({
      fetchImpl: makeFetch(),
      apiKeyProvider: () => SECRET_KEY,
      sleepImpl: async (ms) => { sleeps.push(ms); }
    });
    return provider.complete({ prompt: SECRET_PROMPT, maxTokens: 10 }).then((result) => ({ result, sleeps }));
  };

  const off = await withTrace(false, run);
  const on = await withTrace(true, run);

  assert.deepEqual(on.value, off.value);
  assert.deepEqual(on.value.sleeps, [7000]);
  const text = on.lines.join('\n');
  assert.match(text, /BEGIN llm\.http\.request .*provider=groq-free model=\S+ attempt=1/);
  assert.match(text, /END llm\.http\.request elapsedMs=\d+ status=429/);
  assert.match(text, /BEGIN llm\.retry\.sleep .*delayMs=7000/);
  assert.match(text, /END llm\.retry\.sleep /);
  assert.match(text, /BEGIN llm\.http\.request .*attempt=2/);
  assert.match(text, /END llm\.http\.body /);
  assert.ok(!text.includes(SECRET_KEY));
  assert.ok(!text.includes('SUPER-SECRET'));
  assert.ok(!text.includes('rate limited'));
});

// Kept last: startTrace() registers a once-per-process exit listener and timer.
test('startTrace (enabled) emits a start marker and a heartbeat listing the open span', async () => {
  const previousEnv = process.env.DIAGNOSTIC_TRACE;
  const previousHb = process.env.DIAGNOSTIC_TRACE_HEARTBEAT_MS;
  const lines = [];
  setTraceSink((line) => lines.push(line));
  process.env.DIAGNOSTIC_TRACE = 'true';
  process.env.DIAGNOSTIC_TRACE_HEARTBEAT_MS = '20';
  try {
    startTrace();
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const pending = traceAsync('stuck.op', {}, () => gate);
    await new Promise((resolve) => setTimeout(resolve, 120));
    release();
    await pending;
  } finally {
    if (previousEnv === undefined) delete process.env.DIAGNOSTIC_TRACE;
    else process.env.DIAGNOSTIC_TRACE = previousEnv;
    if (previousHb === undefined) delete process.env.DIAGNOSTIC_TRACE_HEARTBEAT_MS;
    else process.env.DIAGNOSTIC_TRACE_HEARTBEAT_MS = previousHb;
    setTraceSink(() => {}); // silence the process.exit marker at test-process exit
  }
  const text = lines.join('\n');
  assert.match(text, /EVENT trace\.start pid=\d+ node=v/);
  assert.match(text, /HEARTBEAT open=stuck\.op@\d+ms/);
});
