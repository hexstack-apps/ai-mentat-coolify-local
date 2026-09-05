'use strict';
//
// Fail-safe execution helpers.
//
// WHY THIS EXISTS
// ---------------
// electron-main.js had 21 bare `catch {}` blocks. Continuing after a failure is
// usually correct here — a missing optional binary or an unreachable VM must
// not take down the window — but a failure that leaves NO trace is
// undiagnosable. "The VM would not start" with an empty log is a support case
// with nothing to work from.
//
// These helpers keep the resilience and add the record: a stable operation
// label, the error message, optional context, and a bounded in-memory buffer
// that a debug panel or bug report can read back.
//
// Pure: no electron import, so it is unit testable under plain node.

/** Errors suppressed this session, oldest first. Bounded — this is a long-running app. */
const recent = [];
const MAX_RECENT = 200;

// Injectable sink so tests can capture output and the app can route it to a
// file logger later without touching every call site.
let sink = (level, op, message, context) => {
  const line = `[failsafe] ${op}: ${message}`;
  if (level === 'warn') console.warn(line, context ?? '');
  else console.debug(line, context ?? '');
};

/** Replace the log sink. Returns the previous one so callers can restore it. */
function setSink(fn) {
  const prev = sink;
  sink = fn;
  return prev;
}

function record(op, err, context) {
  const message = err instanceof Error ? err.message : String(err);
  recent.push({ at: Date.now(), op, message, context });
  // Trim from the FRONT: the oldest entries are least useful, and clearing
  // wholesale would drop evidence in the middle of an investigation.
  if (recent.length > MAX_RECENT) recent.splice(0, recent.length - MAX_RECENT);
  sink('warn', op, message, context);
  if (err instanceof Error && err.stack) sink('debug', op, err.stack, undefined);
}

/** Copy of the suppressed-error buffer. A copy, so callers cannot corrupt it. */
function recentFailures() {
  return recent.slice();
}

function clearFailures() {
  recent.length = 0;
}

/**
 * Run a sync operation, returning `fallback` if it throws.
 *
 * `op` must be a STABLE literal ("lima.version", "settings.read"), not a
 * template string containing variable data — it is what you grep for later.
 */
function quiet(op, fn, fallback, context) {
  try {
    return fn();
  } catch (err) {
    record(op, err, context);
    return fallback;
  }
}

/** Async form. A rejected promise is recorded, never rethrown. */
async function quietAsync(op, fn, fallback, context) {
  try {
    return await fn();
  } catch (err) {
    record(op, err, context);
    return fallback;
  }
}

/**
 * Fire-and-forget side effect. Returns true on success so a caller CAN branch.
 * Replaces the `try { doThing(); } catch {}` shape where there is no value.
 */
function attempt(op, fn, context) {
  try {
    fn();
    return true;
  } catch (err) {
    record(op, err, context);
    return false;
  }
}

/** Async fire-and-forget. Never rejects — safe to leave unawaited. */
async function attemptAsync(op, fn, context) {
  try {
    await fn();
    return true;
  } catch (err) {
    record(op, err, context);
    return false;
  }
}

module.exports = { quiet, quietAsync, attempt, attemptAsync, recentFailures, clearFailures, setSink };
