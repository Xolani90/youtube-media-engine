import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { GeminiProvider, createPacingState } from '../../src/providers/llm/GeminiProvider.js';
import { resetProviderHealth } from '../../src/providers/llm/providerHealth.js';
import { createPacingRig, gaps } from '../helpers/virtualClock.js';

// The production invariant under test:
//   requestStart[n] - requestStart[n-1] >= 4500ms
// for EVERY actual outbound Gemini HTTP attempt (first attempts, 429 / 5xx /
// network retries, separate provider instances sharing pacing state, and
// concurrent callers), while every retry delay and retry count is unchanged.
// "requestStart" is the virtual-clock reading at each fetch INVOCATION
// (rig.wrapFetch), i.e. the real request-start boundary, not a sleep call.

const FLOOR = 4500;

beforeEach(() => resetProviderHealth());

const ok = () => ({
  ok: true, status: 200, headers: new Headers(),
  json: async () => ({ candidates: [{ content: { parts: [{ text: 'x' }] }, finishReason: 'STOP' }] }),
  text: async () => ''
});
const errResp = (status, body = {}, headers = {}) => ({
  ok: false, status, headers: new Headers(headers),
  json: async () => body, text: async () => JSON.stringify(body)
});
const r429 = (retryDelay) => errResp(429, {
  error: { code: 429, message: 'q', status: 'RESOURCE_EXHAUSTED', details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay }] }
});
const net = () => new TypeError('fetch failed');

// Scripted fetch: each invocation consumes the next step (default: success).
function scripted(steps = [], { latency = () => 0, rig } = {}) {
  let i = 0;
  return async () => {
    const step = steps[i++] ?? 'ok';
    const lat = latency();
    if (lat > 0) await rig.clock.delay(lat);
    const r = typeof step === 'function' ? step() : step === 'ok' ? ok() : step;
    if (r instanceof Error) throw r;
    return r;
  };
}

function provider(rig, steps, state, extra = {}) {
  return new GeminiProvider({
    fetchImpl: rig.wrapFetch(scripted(steps, { rig, ...extra })),
    apiKeyProvider: () => 'k',
    pacingState: state,
    ...rig.opts
  });
}

function assertInvariant(rig, label = '') {
  const g = gaps(rig.starts);
  assert.ok(g.every((x) => x >= FLOOR), `${label} request-start gaps must all be >= ${FLOOR}, got ${JSON.stringify(g)}`);
}

const P = { prompt: 'p' };

// --- Deterministic scenarios ------------------------------------------------

test('1. success -> success', async () => {
  const rig = createPacingRig();
  const p = provider(rig, [], createPacingState());
  await p.complete(P);
  await p.complete(P);
  assert.equal(rig.starts.length, 2);
  assert.deepEqual(gaps(rig.starts), [FLOOR]);
  assert.deepEqual(rig.sleepCalls, [], 'no retry delays');
});

test('2. 429 -> retry: the retry attempt still waits out the floor after its own (unchanged) retry delay', async () => {
  const rig = createPacingRig();
  const p = provider(rig, [r429('0.5s')], createPacingState());
  await p.complete(P);
  assert.equal(rig.starts.length, 2);
  assert.deepEqual(rig.sleepCalls, [500], 'RetryInfo retryDelay honored exactly');
  assert.deepEqual(rig.pacingCalls, [4000], 'pacing only tops up the remaining 4000ms');
  assert.deepEqual(gaps(rig.starts), [FLOOR]);
});

test('2b. 429 with a long RetryInfo delay: retry delay alone already satisfies the floor, no extra pacing wait', async () => {
  const rig = createPacingRig();
  const p = provider(rig, [r429('22s')], createPacingState());
  await p.complete(P);
  assert.deepEqual(rig.sleepCalls, [22000]);
  assert.deepEqual(rig.pacingCalls, []);
  assert.deepEqual(gaps(rig.starts), [22000]);
});

test('2c. 429 Retry-After header takes precedence over RetryInfo (unchanged)', async () => {
  const rig = createPacingRig();
  const p = provider(rig, [errResp(429, { error: { details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '9s' }] } }, { 'retry-after': '2' })], createPacingState());
  await p.complete(P);
  assert.deepEqual(rig.sleepCalls, [2000]);
  assertInvariant(rig);
});

test('3. 429 -> retry -> independent request', async () => {
  const rig = createPacingRig();
  const p = provider(rig, [r429('0.5s')], createPacingState());
  await p.complete(P);
  await p.complete(P);
  assert.equal(rig.starts.length, 3);
  assertInvariant(rig);
});

test('4. network failure -> retry (1s backoff unchanged)', async () => {
  const rig = createPacingRig();
  const p = provider(rig, [net()], createPacingState());
  await p.complete(P);
  assert.equal(rig.starts.length, 2);
  assert.deepEqual(rig.sleepCalls, [1000]);
  assert.deepEqual(rig.pacingCalls, [3500]);
  assertInvariant(rig);
});

test('5. network failure -> retry -> independent request', async () => {
  const rig = createPacingRig();
  const p = provider(rig, [net()], createPacingState());
  await p.complete(P);
  await p.complete(P);
  assert.equal(rig.starts.length, 3);
  assertInvariant(rig);
});

test('6. 5xx -> retry, exponential backoff 1s then 2s, 3 attempts, retry count unchanged', async () => {
  const rig = createPacingRig();
  const p = provider(rig, [errResp(503), errResp(503), errResp(503)], createPacingState());
  await assert.rejects(() => p.complete(P), (e) => e.status === 503);
  assert.equal(rig.starts.length, 3, 'exactly 3 attempts (2 retries)');
  assert.deepEqual(rig.sleepCalls, [1000, 2000]);
  assertInvariant(rig);
});

test('6b. 5xx Retry-After honored (and the cap behavior is unchanged)', async () => {
  const rig = createPacingRig();
  const p = provider(rig, [errResp(503, {}, { 'retry-after': '7' })], createPacingState());
  await p.complete(P);
  assert.deepEqual(rig.sleepCalls, [7000]);
  assertInvariant(rig);

  const rig2 = createPacingRig();
  const p2 = provider(rig2, [errResp(503, {}, { 'retry-after': '120' })], createPacingState());
  await assert.rejects(() => p2.complete(P), (e) => e.status === 503);
  assert.equal(rig2.starts.length, 1, 'over-cap Retry-After still fails without retrying');
  assert.deepEqual(rig2.sleepCalls, []);
});

test('7. multiple retry events in one call (network, 503, 429) -> success', async () => {
  const rig = createPacingRig();
  const p = provider(rig, [net(), errResp(503), r429('0.2s')], createPacingState());
  await p.complete(P);
  assert.equal(rig.starts.length, 4);
  assert.deepEqual(rig.sleepCalls, [1000, 1000, 200], 'network 1s, 5xx first backoff 1s, RetryInfo 0.2s');
  assertInvariant(rig);
});

test('7b. persistent 429 is retried exactly once (2 attempts), then throws', async () => {
  const rig = createPacingRig();
  const p = provider(rig, [r429('1s'), r429('1s'), r429('1s')], createPacingState());
  await assert.rejects(() => p.complete(P), (e) => e.status === 429);
  assert.equal(rig.starts.length, 2);
  assertInvariant(rig);
});

test('8. multiple provider instances sharing one pacing state', async () => {
  const rig = createPacingRig();
  const state = createPacingState();
  const a = provider(rig, [net()], state);
  const b = provider(rig, [r429('0.2s')], state);
  await a.complete(P);
  await b.complete(P);
  await a.complete(P);
  assert.equal(rig.starts.length, 5);
  assertInvariant(rig);
});

test('8b. instances with SEPARATE pacing state do not pace each other (private state preserved)', async () => {
  const rig = createPacingRig();
  const a = provider(rig, [], createPacingState());
  const b = provider(rig, [], createPacingState());
  await a.complete(P);
  await b.complete(P);
  assert.deepEqual(gaps(rig.starts), [0]);
});

test('9. concurrent callers (4 instances, one shared state) start strictly one floor apart, FIFO', async () => {
  const rig = createPacingRig();
  const state = createPacingState();
  const order = [];
  const ps = [0, 1, 2, 3].map((i) => {
    const p = new GeminiProvider({
      fetchImpl: rig.wrapFetch(async () => { order.push(i); return ok(); }),
      apiKeyProvider: () => 'k', pacingState: state, ...rig.opts
    });
    return p.complete(P);
  });
  await Promise.all(ps);
  assert.deepEqual(order, [0, 1, 2, 3], 'FIFO: callers pass the gate in arrival order');
  assert.deepEqual(gaps(rig.starts), [FLOOR, FLOOR, FLOOR]);
});

test('9b. concurrent callers with retries mixed in', async () => {
  const rig = createPacingRig();
  const state = createPacingState();
  const ps = [provider(rig, [net()], state), provider(rig, [r429('0.1s')], state), provider(rig, [errResp(503)], state)];
  await Promise.all(ps.map((p) => p.complete(P)));
  assert.equal(rig.starts.length, 6);
  assertInvariant(rig);
});

test('a throwing / non-retried attempt never wedges the shared queue', async () => {
  const rig = createPacingRig();
  const state = createPacingState();
  const bad = provider(rig, [errResp(400)], state);
  const good = provider(rig, [], state);
  const results = await Promise.allSettled([bad.complete(P), good.complete(P), bad.complete(P)]);
  assert.equal(results[0].status, 'rejected');
  assert.equal(results[1].status, 'fulfilled');
  assert.equal(results[2].status, 'fulfilled');
  assertInvariant(rig);
});

// --- Timer jitter / event-loop delay ---------------------------------------

for (const [label, jitter] of [
  ['no jitter', () => 0],
  ['early timers (-1ms)', () => -1],
  ['early timers (-30%)', (ms) => -Math.floor(ms * 0.3)],
  ['late timers (+50ms)', () => 50],
  ['late timers (+300ms, heavy event-loop delay)', () => 300],
  ['erratic early/late', (ms) => ((ms * 7919) % 401) - 200]
]) {
  test(`jitter: ${label}, simultaneous callers with retries and latency`, async () => {
    const rig = createPacingRig({ jitter });
    const state = createPacingState();
    const lat = () => 120;
    const ps = [
      provider(rig, [net(), 'ok'], state, { latency: lat }),
      provider(rig, [errResp(503), 'ok'], state, { latency: lat }),
      provider(rig, [r429('0.3s')], state, { latency: lat }),
      provider(rig, [], state, { latency: lat })
    ];
    await Promise.all(ps.map(async (p) => { await p.complete(P); await p.complete(P); }));
    assert.ok(rig.starts.length >= 8);
    assertInvariant(rig, label);
  });
}

// --- Wall-clock steps -------------------------------------------------------

for (const [label, step] of [['+10 second', 10_000], ['-1 hour', -3_600_000]]) {
  test(`clock step: a ${label} wall-clock jump cannot change pacing (default clock is monotonic performance.now)`, async (t) => {
    // Virtual MONOTONIC time drives performance.now(); the wall clock
    // (Date.now) is replaced by a separately-stepping clock.
    const rig = createPacingRig();
    let wallOffset = 0;
    t.mock.method(performance, 'now', () => rig.clock.now());
    t.mock.method(Date, 'now', () => 1_700_000_000_000 + rig.clock.now() + wallOffset);

    const state = createPacingState();
    const p = new GeminiProvider({
      fetchImpl: rig.wrapFetch(async () => ok()),
      apiKeyProvider: () => 'k',
      pacingState: state,
      pacingSleepImpl: rig.opts.pacingSleepImpl, // default nowImpl (performance.now) is deliberately NOT overridden
      sleepImpl: rig.opts.sleepImpl
    });

    await p.complete(P);
    await rig.clock.sleep(100); // 100ms of real (monotonic) time passes...
    wallOffset += step; // ...and the wall clock steps
    await p.complete(P);

    assert.deepEqual(rig.pacingCalls, [4400], 'waits exactly the remaining monotonic time, regardless of the wall-clock step');
    assert.deepEqual(gaps(rig.starts), [FLOOR]);
  });
}

// --- Randomized fuzz --------------------------------------------------------

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomSteps(rand) {
  const len = Math.floor(rand() * 4);
  const out = [];
  for (let i = 0; i < len; i++) {
    const k = rand();
    if (k < 0.2) out.push(net());
    else if (k < 0.4) out.push(errResp(503, {}, rand() < 0.3 ? { 'retry-after': String(Math.floor(rand() * 40)) } : {}));
    else if (k < 0.6) out.push(rand() < 0.5 ? r429(`${Math.floor(rand() * 20) + 0.5}s`) : errResp(429, { error: { message: 'q' } }));
    else if (k < 0.65) out.push(errResp(400));
    else out.push('ok');
  }
  return out;
}

test('fuzz: 400 randomized scenarios (1-4 concurrent callers, random latency, jitter, retry scripts) -> zero violations of the 4500ms invariant', async () => {
  let violations = 0;
  let totalAttempts = 0;
  let minGap = Infinity;
  for (let seed = 1; seed <= 400; seed++) {
    const r = rng(seed * 7919);
    const callers = 1 + Math.floor(r() * 4);
    const jitterMax = [0, 1, 50, 400][Math.floor(r() * 4)];
    const latencyMax = [0, 100, 3000][Math.floor(r() * 3)];
    const jr = rng(seed);
    // late up to jitterMax; early by up to 1ms (a timer always takes >= 1ms)
    const jitter = (ms) => Math.max(Math.floor(jr() * (jitterMax + 2)) - 1, -(ms - 1));
    const rig = createPacingRig({ jitter });
    const lr = rng(seed + 12345);
    const latency = () => (latencyMax ? Math.floor(lr() * latencyMax) : 0);
    const state = createPacingState();
    const tasks = Array.from({ length: callers }, () => {
      const p = provider(rig, randomSteps(r), state, { latency });
      return (async () => {
        for (let n = 0; n < 2; n++) {
          try { await p.complete(P); } catch { /* terminal errors are part of the scenario */ }
        }
      })();
    });
    await Promise.all(tasks);
    const g = gaps(rig.starts);
    totalAttempts += rig.starts.length;
    if (g.length) minGap = Math.min(minGap, ...g);
    if (g.some((x) => x < FLOOR)) violations++;
  }
  assert.equal(violations, 0, `scenarios with a gap < ${FLOOR}ms (min seen ${minGap}ms over ${totalAttempts} attempts)`);
  assert.ok(totalAttempts > 400, 'fuzz exercised real traffic');
});

// --- Queue poisoning: a failed attempt must never wedge or reject the shared FIFO chain ---

// A provider whose fetch rejects (not retried: RangeError) on its first call(s), then succeeds.
function failingProvider(rig, state, { failures = 1, how = 'reject' } = {}) {
  let n = 0;
  return new GeminiProvider({
    fetchImpl: rig.wrapFetch(async () => {
      if (n++ < failures) {
        if (how === 'throw-sync') throw new RangeError('boom-sync');
        throw new RangeError('boom');
      }
      return ok();
    }),
    apiKeyProvider: () => 'k', pacingState: state, ...rig.opts
  });
}

for (const how of ['reject', 'throw-sync']) {
  test(`queue poisoning (${how}): failure -> already-queued success; later caller C still enters normally`, async () => {
    const rig = createPacingRig();
    const state = createPacingState();
    const A = failingProvider(rig, state, { how });
    const B = provider(rig, [], state);
    const C = provider(rig, [], state);
    // A, B queued synchronously, back to back, BEFORE A's fetch has run.
    const pa = A.complete(P);
    const pb = B.complete(P);
    const settled = await Promise.allSettled([pa, pb]);
    assert.equal(settled[0].status, 'rejected');
    assert.match(String(settled[0].reason.message), /boom/, "A's failure propagates unchanged");
    assert.equal(settled[1].status, 'fulfilled', 'B queued behind the failed A is still released');
    await C.complete(P); // C arrives after the failure has fully settled
    assert.equal(rig.starts.length, 3);
    assertInvariant(rig, 'failure->success');
    assert.deepEqual(rig.pacingCalls, [FLOOR, FLOOR], 'B and C each waited out the floor after the previous attempt');
    assert.equal(state.tail instanceof Promise, true);
    await state.tail; // the shared chain is still a resolving promise, never rejected
  });
}

test('queue poisoning: failure -> queued failure -> queued success', async () => {
  const rig = createPacingRig();
  const state = createPacingState();
  const A = failingProvider(rig, state);
  const B = failingProvider(rig, state);
  const C = provider(rig, [], state);
  const settled = await Promise.allSettled([A.complete(P), B.complete(P), C.complete(P)]);
  assert.deepEqual(settled.map((s) => s.status), ['rejected', 'rejected', 'fulfilled']);
  assert.equal(rig.starts.length, 3, 'every caller reached its own attempt, in order');
  assertInvariant(rig, 'fail->fail->success');
  const D = provider(rig, [], state); // and the chain remains usable afterwards
  await D.complete(P);
  assertInvariant(rig, 'after chain');
});

test('queue poisoning: concurrent callers with one failed fetch in the middle', async () => {
  const rig = createPacingRig();
  const state = createPacingState();
  const ps = [provider(rig, [], state), failingProvider(rig, state), provider(rig, [], state), provider(rig, [net()], state), provider(rig, [], state)];
  const settled = await Promise.allSettled(ps.map((p) => p.complete(P)));
  assert.deepEqual(settled.map((s) => s.status), ['fulfilled', 'rejected', 'fulfilled', 'fulfilled', 'fulfilled']);
  assert.equal(rig.starts.length, 6, '5 callers + 1 network retry');
  assertInvariant(rig, 'mixed');
});

test('queue poisoning: a non-retried HTTP error and an exhausted retry budget both leave the chain usable', async () => {
  const rig = createPacingRig();
  const state = createPacingState();
  const a = provider(rig, [errResp(400)], state);
  const b = provider(rig, [net(), net()], state); // network retry budget exhausted -> rejects
  const c = provider(rig, [], state);
  const settled = await Promise.allSettled([a.complete(P), b.complete(P), c.complete(P)]);
  assert.deepEqual(settled.map((s) => s.status), ['rejected', 'rejected', 'fulfilled']);
  assertInvariant(rig, 'terminal errors');
});

test('queue poisoning: a failure INSIDE the pacing gate (pacing sleep rejects) releases the slot for the next caller', async () => {
  const rig = createPacingRig();
  const state = createPacingState();
  let failOnce = true;
  const flaky = new GeminiProvider({
    fetchImpl: rig.wrapFetch(async () => ok()), apiKeyProvider: () => 'k', pacingState: state,
    nowImpl: rig.opts.nowImpl, sleepImpl: rig.opts.sleepImpl,
    pacingSleepImpl: async (ms) => { if (failOnce) { failOnce = false; throw new Error('sleep-failed'); } return rig.opts.pacingSleepImpl(ms); }
  });
  const first = provider(rig, [], state);
  await first.complete(P); // establishes lastRequestStartedAt so the next caller must wait
  const settled = await Promise.allSettled([flaky.complete(P), provider(rig, [], state).complete(P)]);
  assert.equal(settled[0].status, 'rejected');
  assert.match(settled[0].reason.message, /sleep-failed/);
  assert.equal(settled[1].status, 'fulfilled');
  assertInvariant(rig, 'gate failure');
});

test('queue poisoning: a throw between acquiring the slot and fetch (setTimeout fails) still releases the slot', async (t) => {
  const rig = createPacingRig();
  const state = createPacingState();
  const real = globalThis.setTimeout;
  let armed = true;
  t.mock.method(globalThis, 'setTimeout', (fn, ms, ...rest) => {
    if (armed && ms === 120000) { armed = false; throw new Error('timer-create-failed'); } // only the request-timeout timer
    return real(fn, ms, ...rest);
  });
  const A = provider(rig, [], state);
  const B = provider(rig, [], state);
  const settled = await Promise.allSettled([A.complete(P), B.complete(P)]);
  assert.equal(settled[0].status, 'rejected');
  assert.match(settled[0].reason.message, /timer-create-failed/);
  assert.equal(settled[1].status, 'fulfilled', 'B queued behind A is released even though A never reached fetch');
  assert.equal(rig.starts.length, 1, 'A never started a request, so it is not a request start');
  await provider(rig, [], state).complete(P);
  assertInvariant(rig, 'pre-fetch throw');
});
