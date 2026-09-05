'use strict';
// Unit tests for lib/lima.js — pure Lima/platform resolution.
// Run: npm test   (node --test 'test/*.js')

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const L = require('../lib/lima');

// ── resolveLimaBin ─────────────────────────────────────────────────────────

test('bundled binary wins over any system copy', () => {
  // The app must behave the same regardless of what the user has installed.
  const bin = L.resolveLimaBin({
    bundledPath: '/app/lima-bin/bin/limactl',
    exists: (p) => p === '/app/lima-bin/bin/limactl' || p === '/opt/homebrew/bin/limactl',
    canRun: () => true,
    home: '/Users/x',
  });
  assert.strictEqual(bin, '/app/lima-bin/bin/limactl');
});

test('falls back to limactl on PATH when there is no bundle', () => {
  const bin = L.resolveLimaBin({
    bundledPath: '/app/missing',
    exists: () => false,
    canRun: (c) => c === 'limactl',
    home: '/Users/x',
  });
  assert.strictEqual(bin, 'limactl');
});

test('finds Homebrew limactl when PATH lacks it', () => {
  // THE bug this ordering exists for: a GUI app launched from Finder inherits
  // a launchd PATH without /opt/homebrew/bin, so a working brew install was
  // reported as "not installed".
  const bin = L.resolveLimaBin({
    bundledPath: '/app/missing',
    exists: (p) => p === '/opt/homebrew/bin/limactl',
    canRun: (c) => c !== 'limactl',
    home: '/Users/x',
  });
  assert.strictEqual(bin, '/opt/homebrew/bin/limactl');
});

test('a present but UNRUNNABLE binary does not abort the search', () => {
  // An unrunnable limactl is as useless as a missing one; it must not stop us
  // finding a working one further down the list.
  const bin = L.resolveLimaBin({
    bundledPath: '/app/missing',
    // Every fallback exists on disk, but only /usr/bin/limactl actually runs.
    // The bundled path must NOT exist or it wins first (that ordering is
    // asserted separately).
    exists: (p) => p !== '/app/missing',
    canRun: (p) => p === '/usr/bin/limactl',
    home: '/Users/x',
  });
  assert.strictEqual(bin, '/usr/bin/limactl');
});

test('returns null when Lima is nowhere', () => {
  assert.strictEqual(
    L.resolveLimaBin({ bundledPath: '/none', exists: () => false, canRun: () => false, home: '/Users/x' }),
    null
  );
});

test('fallback list covers both Homebrew prefixes and ~/.local/bin', () => {
  const paths = L.limaFallbackPaths('/Users/x');
  assert.ok(paths.includes('/opt/homebrew/bin/limactl'), 'apple silicon brew');
  assert.ok(paths.includes('/usr/local/bin/limactl'), 'intel brew');
  assert.ok(paths.includes(path.join('/Users/x', '.local', 'bin', 'limactl')));
});

// ── error message ──────────────────────────────────────────────────────────

test('missing-Lima message is ACTIONABLE, not just descriptive', () => {
  // The old text stated the problem and stopped, leaving nothing to do.
  const m = L.limaMissingMessage();
  assert.ok(m.includes('download:lima'), 'must offer the bundled route');
  assert.ok(m.includes('brew install lima'), 'must offer the system route');
});

// ── buildPath ──────────────────────────────────────────────────────────────

test('buildPath prepends user tool dirs', () => {
  const out = L.buildPath('darwin', '/Users/x', '/usr/bin:/bin');
  assert.ok(out.indexOf('/opt/homebrew/bin') < out.indexOf('/usr/bin'));
});

test('buildPath never yields an empty PATH', () => {
  // An empty PATH makes /bin/sh unreachable — a crash, not a warning.
  assert.ok(L.buildPath('darwin', '/Users/x', '').endsWith('/usr/bin:/bin'));
});

test('buildPath uses ; on win32', () => {
  assert.ok(L.buildPath('win32', 'C:\\U', 'C:\\W').includes(';'));
});

// ── parseVmList / vmStatus ─────────────────────────────────────────────────

test('parses JSONL — one object PER LINE, not a JSON array', () => {
  // `limactl list --json` emits JSONL. A single JSON.parse works on a
  // one-VM machine and fails on every multi-VM one — the case a clean-machine
  // test never reaches.
  const out = '{"name":"coolify","status":"Running"}\n{"name":"other","status":"Stopped"}';
  const { vms, skipped } = L.parseVmList(out);
  assert.strictEqual(vms.length, 2);
  assert.strictEqual(skipped.length, 0);
  assert.strictEqual(L.vmStatus(vms, 'coolify'), 'Running');
  assert.strictEqual(L.vmStatus(vms, 'other'), 'Stopped');
});

test('one malformed line does not hide the other VMs', () => {
  const { vms, skipped } = L.parseVmList('{"name":"a","status":"Running"}\nNOT JSON\n{"name":"b","status":"Stopped"}');
  assert.strictEqual(vms.length, 2, 'good lines must survive');
  assert.strictEqual(skipped.length, 1, 'bad line must be reported, not lost');
});

test('empty output yields no VMs, not a crash', () => {
  assert.deepStrictEqual(L.parseVmList('').vms, []);
  assert.deepStrictEqual(L.parseVmList(null).vms, []);
});

test('vmStatus distinguishes Absent from Stopped', () => {
  // These need different UI: one offers "create", the other offers "start".
  const { vms } = L.parseVmList('{"name":"coolify","status":"Stopped"}');
  assert.strictEqual(L.vmStatus(vms, 'coolify'), 'Stopped');
  assert.strictEqual(L.vmStatus(vms, 'nope'), 'Absent');
});

test('a VM entry with no status reports Unknown, not Running', () => {
  // Defaulting to Running would make the app try to use a VM that may be dead.
  const { vms } = L.parseVmList('{"name":"coolify"}');
  assert.strictEqual(L.vmStatus(vms, 'coolify'), 'Unknown');
});

test('only Running is usable', () => {
  assert.strictEqual(L.isVmUsable('Running'), true);
  for (const s of ['Stopped', 'Broken', 'Absent', 'Unknown', '']) {
    assert.strictEqual(L.isVmUsable(s), false, `${s} must not be usable`);
  }
});
