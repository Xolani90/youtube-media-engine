// Opt-in diagnostic TRACE. Answers "where is the process spending its time?"
// for a run that is otherwise silent until it finishes.
//
// INERT BY DEFAULT: unless process.env.DIAGNOSTIC_TRACE === 'true', every
// exported function is a pass-through -- traceAsync/traceSync return exactly
// what `fn()` returns (same promise, same thrown error), nothing is written,
// no timer is created, no listener is registered. Turning the trace on never
// changes a return value or an error: a span re-throws the original error
// after logging it, and nothing in this module can throw into caller code.
//
// SAFETY: only short, whitelisted scalar values are ever printed. A string
// field that is not a short token (no whitespace, <= 200 chars, plain
// identifier/URL-ish characters) is printed as [omitted], so a prompt, model
// output, source text or error message cannot leak through a field by
// accident. Callers pass lengths/counts/ids/provider names -- never content.
// Errors are reported by name (and numeric HTTP status) only, never message.
// URLs are reduced to host (safeHost) or host+path without query (safeUrl),
// because a query string can carry an API key.
//
// Output is one line per marker on STDERR:
//   [trace] <ISO time> +<ms since process start>ms BEGIN <label> in=<parent> k=v ...
//   [trace] <ISO time> +<ms>ms END   <label> elapsedMs=<n> k=v ...
//   [trace] <ISO time> +<ms>ms FAIL  <label> elapsedMs=<n> error=<name> status=<n>
//   [trace] <ISO time> +<ms>ms EVENT <label> k=v ...
//   [trace] <ISO time> +<ms>ms HEARTBEAT open=<label>@<ageMs>ms;...
// A BEGIN with no matching END/FAIL is the operation the process is stuck in.
// The heartbeat (unref'd, so it never keeps the process alive) also shows
// what is open while the event loop is idle (sleeping, awaiting a socket).
// It cannot fire while a synchronous child process blocks the event loop --
// in that case the last BEGIN line is the evidence.

const SAFE_TOKEN = /^[A-Za-z0-9_.:/@+,-]{1,200}$/;
const processStart = performance.now();

let sink = (line) => process.stderr.write(`${line}\n`);
let started = false;
let nextSpanId = 1;
const openSpans = new Map(); // insertion order == nesting order (execution is sequential)

export function traceEnabled() {
  return process.env.DIAGNOSTIC_TRACE === 'true';
}

/** Tests only: redirect trace lines. Returns the previous sink. */
export function setTraceSink(fn) {
  const previous = sink;
  sink = fn;
  return previous;
}

/** Host only, e.g. "api.groq.com". Never includes path, query or credentials. */
export function safeHost(url) {
  try {
    return new URL(String(url)).host;
  } catch {
    return 'unparseable-url';
  }
}

/** Host + path, no query string, no credentials. */
export function safeUrl(url) {
  try {
    const u = new URL(String(url));
    return `${u.host}${u.pathname}`;
  } catch {
    return 'unparseable-url';
  }
}

function formatFields(fields) {
  if (!fields || typeof fields !== 'object') return '';
  let out = '';
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === null) continue;
    if (typeof value === 'number' || typeof value === 'boolean') {
      out += ` ${key}=${value}`;
    } else if (typeof value === 'string' && SAFE_TOKEN.test(value)) {
      out += ` ${key}=${value}`;
    } else {
      out += ` ${key}=[omitted]`;
    }
  }
  return out;
}

function emit(kind, label, fields) {
  try {
    const sinceStart = Math.round(performance.now() - processStart);
    sink(`[trace] ${new Date().toISOString()} +${sinceStart}ms ${kind} ${label}${formatFields(fields)}`);
  } catch {
    // Diagnostics must never affect the run.
  }
}

function innermostOpenLabel() {
  let label = null;
  for (const span of openSpans.values()) label = span.label;
  return label;
}

function beginSpan(label, fields) {
  const id = nextSpanId++;
  emit('BEGIN', label, { in: innermostOpenLabel(), ...fields });
  openSpans.set(id, { label, startedAt: performance.now() });
  return id;
}

function endSpan(id, kind, label, fields) {
  const span = openSpans.get(id);
  openSpans.delete(id);
  const elapsedMs = span ? Math.round(performance.now() - span.startedAt) : undefined;
  emit(kind, label, { elapsedMs, ...fields });
}

function errorFields(err) {
  return { error: err?.name, status: typeof err?.status === 'number' ? err.status : undefined };
}

function safeEndFields(endFields, result) {
  if (typeof endFields !== 'function') return undefined;
  try {
    return endFields(result);
  } catch {
    return undefined;
  }
}

/** Single point marker (no elapsed time). */
export function traceEvent(label, fields) {
  if (!traceEnabled()) return;
  emit('EVENT', label, fields);
}

/**
 * Wraps a synchronous operation. Disabled: returns fn() directly.
 * endFields(result) may return extra safe fields for the END line.
 */
export function traceSync(label, fields, fn, endFields) {
  if (!traceEnabled()) return fn();
  const id = beginSpan(label, fields);
  let result;
  try {
    result = fn();
  } catch (err) {
    endSpan(id, 'FAIL', label, errorFields(err));
    throw err;
  }
  endSpan(id, 'END', label, safeEndFields(endFields, result));
  return result;
}

/**
 * Wraps an async operation. Disabled: returns fn() directly (not a wrapper
 * promise). Enabled: awaits fn(), logs, and returns/re-throws unchanged.
 */
export function traceAsync(label, fields, fn, endFields) {
  if (!traceEnabled()) return fn();
  return runTracedAsync(label, fields, fn, endFields);
}

async function runTracedAsync(label, fields, fn, endFields) {
  const id = beginSpan(label, fields);
  let result;
  try {
    result = await fn();
  } catch (err) {
    endSpan(id, 'FAIL', label, errorFields(err));
    throw err;
  }
  endSpan(id, 'END', label, safeEndFields(endFields, result));
  return result;
}

/**
 * Called once from main(). Disabled: does nothing at all. Enabled: emits a
 * start marker, an exit marker, and a heartbeat listing the open spans.
 */
export function startTrace() {
  if (!traceEnabled() || started) return;
  started = true;
  emit('EVENT', 'trace.start', { pid: process.pid, node: process.version });
  const configured = Number(process.env.DIAGNOSTIC_TRACE_HEARTBEAT_MS);
  const intervalMs = Number.isFinite(configured) && configured > 0 ? configured : 30000;
  const timer = setInterval(() => {
    try {
      const now = performance.now();
      const open = [...openSpans.values()]
        .map((span) => `${span.label}@${Math.round(now - span.startedAt)}ms`)
        .join(';');
      const sinceStart = Math.round(now - processStart);
      sink(`[trace] ${new Date().toISOString()} +${sinceStart}ms HEARTBEAT open=${open || 'none'}`);
    } catch {
      // Diagnostics must never affect the run.
    }
  }, intervalMs);
  timer.unref();
  process.once('exit', (code) => emit('EVENT', 'process.exit', { code }));
}
