'use strict';
// Unit tests for lib/failsafe.js — errors must be survivable AND traceable.

const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const F = require('../lib/failsafe');

// Silence console output during tests while still exercising the sink.
let logged = [];
beforeEach(() => {
  F.clearFailures();
  logged = [];
  F.setSink((level, op, message) => logged.push({ level, op, message }));
});

test('quiet returns the value when nothing throws', () => {
  assert.strictEqual(F.quiet('t.ok', () => 7, -1), 7);
  assert.strictEqual(F.recentFailures().length, 0);
});

test('quiet returns the fallback AND records the failure', () => {
  // The whole point: the process continues, the error is not lost.
  assert.strictEqual(F.quiet('t.bad', () => { throw new Error('boom'); }, -1), -1);
  const f = F.recentFailures();
  assert.strictEqual(f.length, 1);
  assert.strictEqual(f[0].op, 't.bad');
  assert.strictEqual(f[0].message, 'boom');
});

test('the failure is LOGGED, not only buffered', () => {
  // A buffer nobody reads is as silent as `catch {}`.
  F.quiet('t.log', () => { throw new Error('x'); }, null);
  assert.ok(logged.some((l) => l.level === 'warn' && l.op === 't.log'));
});

test('non-Error throws are handled', () => {
  // `throw 'string'` is legal JS and used to log "undefined".
  F.quiet('t.str', () => { throw 'plain'; }, null);
  assert.strictEqual(F.recentFailures()[0].message, 'plain');
});

test('context is preserved for debugging', () => {
  F.quiet('t.ctx', () => { throw new Error('e'); }, null, { vm: 'coolify' });
  assert.deepStrictEqual(F.recentFailures()[0].context, { vm: 'coolify' });
});

test('quietAsync returns the fallback on rejection', async () => {
  assert.strictEqual(await F.quietAsync('t.a', async () => { throw new Error('e'); }, 'fb'), 'fb');
  assert.strictEqual(F.recentFailures()[0].op, 't.a');
});

test('quietAsync never rejects, so an unawaited call is safe', async () => {
  // An unhandled rejection in the Electron main process can kill the app.
  await assert.doesNotReject(() => F.quietAsync('t.safe', async () => { throw new Error('e'); }, 0));
});

test('attempt reports success and failure distinctly', () => {
  assert.strictEqual(F.attempt('t.s', () => {}), true);
  assert.strictEqual(F.attempt('t.f', () => { throw new Error('e'); }), false);
});

test('attemptAsync resolves false rather than rejecting', async () => {
  assert.strictEqual(await F.attemptAsync('t.af', async () => { throw new Error('e'); }), false);
});

test('buffer is bounded and keeps the NEWEST entries', () => {
  // Unbounded growth is a leak in a long-running desktop app; dropping the
  // newest would discard the failure being investigated.
  for (let i = 0; i < 260; i++) F.quiet(`t.n`, () => { throw new Error(String(i)); }, 0);
  const f = F.recentFailures();
  assert.ok(f.length <= 200);
  assert.strictEqual(f[f.length - 1].message, '259');
});

test('recentFailures returns a copy', () => {
  F.quiet('t.c', () => { throw new Error('e'); }, 0);
  F.recentFailures().length = 0;
  assert.strictEqual(F.recentFailures().length, 1);
});
