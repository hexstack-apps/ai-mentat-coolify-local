'use strict';
//
// Pure Lima/platform resolution logic, extracted from electron-main.js so it
// can be unit tested. electron-main.js cannot be loaded outside Electron
// (require('electron') throws), so none of this had coverage.
//
// Every function takes its inputs explicitly — platform, home, an existence
// probe, a version probe — instead of reading process.* and hitting the real
// filesystem. That is what makes a macOS-only code path verifiable on Linux.

const path = require('path');

/**
 * Candidate limactl locations, in resolution order.
 *
 * Homebrew paths matter specifically because a GUI app launched from Finder
 * inherits a launchd PATH that does NOT include /opt/homebrew/bin. Without
 * these, a perfectly working `brew install lima` still produced "no limactl
 * found" for anyone who had not started the app from a terminal.
 */
function limaFallbackPaths(home) {
  return [
    '/opt/homebrew/bin/limactl',   // Apple silicon Homebrew
    '/usr/local/bin/limactl',      // Intel Homebrew / manual install
    '/usr/bin/limactl',            // distro package
    path.join(home, '.local', 'bin', 'limactl'),
  ];
}

/**
 * Resolve which limactl to use.
 *
 * Order is deliberate: the BUNDLED binary wins over any system copy, so the
 * app's behaviour does not change based on what the user happens to have
 * installed. Only if it is absent do we accept a system limactl.
 *
 * `exists` and `canRun` are injected so this is testable without a real
 * filesystem or spawning processes. `canRun` must return false rather than
 * throw for a binary that is present but not executable — an unrunnable
 * limactl is as useless as a missing one, and must not abort the search.
 */
function resolveLimaBin({ bundledPath, exists, canRun, home }) {
  if (exists(bundledPath)) return bundledPath;

  // A bare 'limactl' resolves through PATH — cheapest check after the bundle.
  if (canRun('limactl')) return 'limactl';

  for (const p of limaFallbackPaths(home)) {
    if (exists(p) && canRun(p)) return p;
  }
  return null;
}

/**
 * Message shown when no Lima can be found anywhere.
 *
 * Deliberately actionable: the previous text stated the problem and stopped,
 * leaving the user with nothing to do. Both remedies are listed because either
 * one genuinely fixes it, and which is appropriate depends on whether they
 * want the app-local copy or a system-wide one.
 */
function limaMissingMessage() {
  return (
    'Lima is not installed: no bundled binary and no limactl on PATH or in the '
    + 'usual Homebrew locations.\n'
    + 'Fix it with either:\n'
    + '  • npm run download:lima   (fetches the bundled copy this app ships with)\n'
    + '  • brew install lima       (system-wide install)'
  );
}

/**
 * PATH for spawned child processes.
 *
 * Same reason as the Lima fallbacks: a GUI-launched app gets a minimal PATH.
 * User tool dirs go FIRST so a user-installed toolchain wins over a stale
 * system copy.
 */
function buildPath(platform, home, envPath) {
  const isWin = platform === 'win32';
  const sep = isWin ? ';' : ':';
  const extra = [path.join(home, '.local', 'bin'), path.join(home, '.bun', 'bin')];
  if (isWin) {
    extra.push(
      path.join(home, 'AppData', 'Roaming', 'npm'),
      path.join(home, 'AppData', 'Local', 'Programs', 'claude-code')
    );
  } else {
    extra.push('/opt/homebrew/bin', '/usr/local/bin');
  }
  // Never produce an empty PATH — that makes even /bin/sh unreachable and
  // turns a missing-tool warning into a crash.
  const base = envPath || (isWin ? '' : '/usr/bin:/bin');
  return extra.join(sep) + sep + base;
}

/**
 * Parse `limactl list --json` output.
 *
 * The format is JSONL — one JSON object PER LINE, not a JSON array. Parsing it
 * with a single JSON.parse fails on any machine with more than one VM, which
 * is exactly the case that never shows up in a clean-machine test.
 *
 * A malformed line is skipped rather than aborting the whole parse: one
 * unparseable entry must not hide every other VM. Skipped lines are returned
 * so the caller can record them instead of losing them silently.
 */
function parseVmList(jsonlOutput) {
  const vms = [];
  const skipped = [];
  for (const line of String(jsonlOutput || '').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      vms.push(JSON.parse(t));
    } catch {
      skipped.push(t.slice(0, 120));
    }
  }
  return { vms, skipped };
}

/**
 * Status of one named VM, or 'Absent'.
 *
 * Returns the raw status string rather than a boolean because "Stopped",
 * "Broken" and absent each need different UI and different remedies.
 */
function vmStatus(vms, vmName) {
  if (!Array.isArray(vms)) return 'Absent';
  const found = vms.find((v) => v && v.name === vmName);
  return found ? (found.status || 'Unknown') : 'Absent';
}

/** Only a Running VM can serve Docker; everything else needs user action. */
function isVmUsable(status) {
  return status === 'Running';
}

module.exports = {
  limaFallbackPaths,
  resolveLimaBin,
  limaMissingMessage,
  buildPath,
  parseVmList,
  vmStatus,
  isVmUsable,
};
