// Deterministic virtual clock for pacing tests.
//
// Unlike a frozen clock paired with a no-op sleep (which models a world
// where waiting takes no time), `sleep()` here advances `now()` by the time
// it waited, so a pacing gate that re-checks the clock after waking sees
// consistent time. Timers fire in (due time, creation order) order. Each
// timer is pumped from setImmediate, i.e. only once every promise chain that
// can make progress without time passing has finished, so tests need no
// explicit run loop.
//
// `jitter(ms)` returns an extra delay (ms, may be negative) added to every
// timer, to simulate late / early timers and event-loop delay. A timer
// always takes at least 1ms when it was requested for >= 1ms, mirroring
// setTimeout's 1ms floor.

export function createVirtualClock({ start = 1_000_000, jitter = () => 0 } = {}) {
  let now = start;
  let seq = 0;
  const timers = [];

  function fireOne() {
    if (timers.length === 0) return;
    timers.sort((a, b) => a.at - b.at || a.seq - b.seq);
    const timer = timers.shift();
    now = Math.max(now, timer.at);
    timer.resolve();
  }

  function wait(ms) {
    return new Promise((resolve) => {
      const requested = Math.max(0, ms);
      const actual = requested >= 1 ? Math.max(1, requested + jitter(requested)) : requested;
      timers.push({ at: now + actual, seq: seq++, resolve });
      setImmediate(fireOne);
    });
  }

  return {
    now: () => now,
    /** Virtual wait; advances now() by (about) `ms`. */
    sleep: wait,
    /** Alias for simulating request latency inside a fake fetch. */
    delay: wait
  };
}

/** Gaps between consecutive numbers: [a, b, c] -> [b-a, c-b]. */
export function gaps(values) {
  return values.slice(1).map((value, i) => value - values[i]);
}

/**
 * Wiring for GeminiProvider pacing tests. Retry delays and pacing waits go
 * through SEPARATE seams (`sleepImpl` vs `pacingSleepImpl`) and are recorded
 * separately, so a test can assert "the provider waited 1s before retrying"
 * independently of "the provider waited for the global request slot". Both
 * advance the same virtual clock. `starts` holds the clock reading at every
 * fetch INVOCATION (the actual request-start boundary), via wrapFetch().
 */
export function createPacingRig({ jitter } = {}) {
  const clock = createVirtualClock({ jitter });
  const sleepCalls = []; // retry delays only
  const pacingCalls = []; // pacing-gate waits only
  const starts = [];
  return {
    clock,
    sleepCalls,
    pacingCalls,
    starts,
    opts: {
      nowImpl: clock.now,
      sleepImpl: async (ms) => { sleepCalls.push(ms); await clock.sleep(ms); },
      pacingSleepImpl: async (ms) => { pacingCalls.push(ms); await clock.sleep(ms); }
    },
    wrapFetch(fetchImpl) {
      return (...args) => {
        starts.push(clock.now());
        return fetchImpl(...args);
      };
    }
  };
}