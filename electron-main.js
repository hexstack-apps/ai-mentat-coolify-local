const { app, BrowserWindow, ipcMain, shell } = require('electron');
const { spawn, execSync } = require('child_process');
const path = require('path');
const http = require('http');
const fs = require('fs');
const os = require('os');
const LIMA = require('./lib/lima');
const { quiet, attempt, quietAsync } = require('./lib/failsafe');
const { setupAutoUpdate } = require('./sdk/logic/auto-update');

// ─── Env helpers ──────────────────────────────────────────────────────────

function shellEnv() {
  const home = os.homedir();
  const isWin = process.platform === 'win32';
  const sep = isWin ? ';' : ':';
  const extra = [path.join(home, '.local', 'bin'), path.join(home, '.bun', 'bin')];
  if (isWin) {
    extra.push(
      path.join(home, 'AppData', 'Roaming', 'npm'),
      path.join(home, 'AppData', 'Local', 'Programs', 'claude-code'),
    );
  } else {
    extra.push('/opt/homebrew/bin', '/usr/local/bin');
  }
  return {
    ...process.env,
    PATH: extra.join(sep) + sep + (process.env.PATH || (isWin ? '' : '/usr/bin:/bin')),
  };
}

function execSyncEnv(cmd, opts = {}) {
  return execSync(cmd, { ...opts, env: { ...shellEnv(), ...opts.env } });
}

// ─── Globals ──────────────────────────────────────────────────────────────

let mainWindow;
let tunnelProcess;          // HTTP cloudflared named tunnel (Coolify UI on 8000)
let sshTunnelProcess;       // TCP cloudflared named tunnel for SSH (port 22)
let ptyProcess;
let tunnelUrl = null;
let sshTunnelHost = null;
let cleanupDone = false;

// ─── Persistent storage layout ────────────────────────────────────────────
//
//   <dataDir>/
//     settings.json   — user preferences for this app
//     logs/
//       setup.log     — rolling setup/install log (survives restarts, trimmed)
//
// In packaged builds <dataDir> resolves to the OS-standard userData location:
//   macOS   ~/Library/Application Support/Hexstack Mentat Coolify/.mentat-coolify
//   Linux   ~/.config/Hexstack Mentat Coolify/.mentat-coolify
//   Windows %APPDATA%/Hexstack Mentat Coolify/.mentat-coolify
// In unpacked dev runs it's alongside the source at _mentat-coolify/.mentat-coolify/.
//
// The Lima VM disk image (and therefore all Coolify data — Postgres, configs,
// deployments at /data/coolify) lives in LIMA_DIR, separate from <dataDir>.

// Data lives at <filesystem root>/.hexstack-app/<app-name>/data for every
// build type, dev and packaged alike, so there is one location to inspect.
// resolveDataDir falls back to ~/.hexstack-app/<app>/data when the root is
// not user-writable (see sdk/utils/data-dir.js).
const { resolveDataDir } = require('./sdk/utils/data-dir');
const dataDir = resolveDataDir("ai-mentat-coolify-local");
const logsDir = path.join(dataDir, 'logs');
const SETTINGS_FILE = path.join(dataDir, 'settings.json');
const SETUP_LOG_FILE = path.join(logsDir, 'setup.log');
const SETUP_LOG_MAX_BYTES = 1024 * 1024; // 1 MiB; older lines trimmed from the front

for (const dir of [dataDir, logsDir]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// Ring buffer kept in memory so the renderer can fetch a snapshot without
// re-reading the file on every poll. Seeded from the on-disk log at startup.
const LOG_RING_SIZE = 400;
const logRing = [];
function pushLog(text) {
  for (const line of String(text).split('\n')) {
    if (line.trim()) {
      logRing.push(line);
      if (logRing.length > LOG_RING_SIZE) logRing.shift();
    }
  }
}

let setupLogStream = null;
function openSetupLog() {
  if (setupLogStream) return;
  try {
    // Trim the log if it's gotten too big on a previous run
    try {
      const st = fs.statSync(SETUP_LOG_FILE);
      if (st.size > SETUP_LOG_MAX_BYTES) {
        const kept = fs.readFileSync(SETUP_LOG_FILE, 'utf8').slice(-SETUP_LOG_MAX_BYTES / 2);
        fs.writeFileSync(SETUP_LOG_FILE, kept);
      }
    } catch {}
    setupLogStream = fs.createWriteStream(SETUP_LOG_FILE, { flags: 'a' });
    setupLogStream.write(`\n=== ${new Date().toISOString()} — app started ===\n`);
  } catch (e) { console.warn('[setup-log] open failed:', e.message); }
}
function seedRingFromDisk() {
  try {
    const raw = fs.readFileSync(SETUP_LOG_FILE, 'utf8');
    // Keep only the last LOG_RING_SIZE non-blank lines in memory
    const lines = raw.split('\n').filter(Boolean).slice(-LOG_RING_SIZE);
    for (const l of lines) logRing.push(l);
  } catch {} // file may not exist on first run
}
seedRingFromDisk();
openSetupLog();

function sendSetupLog(t) {
  pushLog(t);
  if (setupLogStream) { try { setupLogStream.write(t); } catch {} }
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('setup:log', t);
}

function loadSettings() {
  try { return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')); }
  catch { return {}; }
}
function saveSettings(s) {
  // Atomic write: tmp file + rename so a crash mid-write can't corrupt settings.
  const tmp = SETTINGS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2));
  fs.renameSync(tmp, SETTINGS_FILE);
}

// ─── Lima VM helpers (cross-platform Docker host) ─────────────────────────

const LIMA_DIR = path.join(os.homedir(), '.coolify-lima');
const LIMA_VM_NAME = 'coolify';

// Resolution order: bundled binary (shipped in extraResources) -> a limactl on
// PATH -> the usual Homebrew locations, which are often missing from the PATH a
// GUI app inherits from launchd. Previously only the first two were tried, so a
// perfectly working Homebrew Lima still produced "bundled binary missing and no
// system limactl" for anyone who had not launched the app from a shell.
const LIMA_FALLBACK_PATHS = [
  '/opt/homebrew/bin/limactl',
  '/usr/local/bin/limactl',
  '/usr/bin/limactl',
  path.join(os.homedir(), '.local', 'bin', 'limactl'),
];

function getLimaBin() {
  const bundled = app.isPackaged
    ? path.join(process.resourcesPath, 'lima-bin', 'bin', 'limactl')
    : path.join(__dirname, 'lima-bin', 'bin', 'limactl');
  // Resolution ORDER lives in lib/lima.js and is unit tested; this supplies
  // only the real filesystem/exec probes. `canRun` must return false rather
  // than throw, so a present-but-unrunnable binary does not abort the search.
  return LIMA.resolveLimaBin({
    bundledPath: bundled,
    exists: (p) => quiet('lima.exists', () => fs.existsSync(p), false, { p }),
    canRun: (cmd) => attempt('lima.version', () => {
      if (cmd === 'limactl') execSyncEnv('limactl --version', { timeout: 5000, stdio: 'pipe' });
      else execSync(`"${cmd}" --version`, { timeout: 5000, stdio: 'pipe' });
    }, { cmd }),
    home: os.homedir(),
  });
}

// Actionable message for the "no Lima anywhere" case. The old text stated the
// problem and stopped there, which left the user with nothing to act on.
function limaMissingError() {
  return new Error(
    'Lima is not installed: no bundled binary and no limactl on PATH or in the '
    + 'usual Homebrew locations.\n'
    + 'Fix it with either:\n'
    + '  • npm run download:lima   (fetches the bundled copy this app ships with)\n'
    + '  • brew install lima       (system-wide install)'
  );
}

function getLimaConfigPath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'lima-coolify.yaml')
    : path.join(__dirname, 'lima-coolify.yaml');
}

function limaEnv() { return { ...shellEnv(), LIMA_HOME: LIMA_DIR }; }

function isLimaInstalled() { return !!getLimaBin(); }

// Single `limactl list` shared by both VM probes. Returns null when the call
// itself fails, so callers can tell "no such VM" from "couldn't ask".
function limaListVms() {
  const bin = getLimaBin();
  if (!bin) return [];
  // null means "could not ask" (distinct from "no such VM") — callers rely on
  // that tri-state. The failure is RECORDED rather than swallowed: a silent
  // null here shows up as a VM that mysteriously does not exist.
  const out = quiet('lima.list', () => execSync(`"${bin}" list --json`,
    { timeout: 10000, stdio: 'pipe', env: limaEnv() }).toString(), null);
  if (out === null) return null;
  const { vms, skipped } = LIMA.parseVmList(out);
  // A malformed line must not hide the other VMs, but must not vanish either.
  if (skipped.length) quiet('lima.list.parse', () => { throw new Error(`skipped ${skipped.length} unparseable line(s)`); }, null, { skipped });
  return vms;
}

function triLimaVmRunning() {
  if (!getLimaBin()) return false;
  const vms = limaListVms();
  if (vms === null) return null;
  return vms.find(v => v.name === LIMA_VM_NAME)?.status === 'Running';
}

function triLimaVmExists() {
  if (!getLimaBin()) return false;
  const vms = limaListVms();
  if (vms === null) return null;
  return !!vms.find(v => v.name === LIMA_VM_NAME);
}

function isLimaVmRunning() { return triLimaVmRunning() === true; }
function limaVmExists() { return triLimaVmExists() === true; }

async function limaCreateAndStart(sendLog) {
  const bin = getLimaBin();
  if (!bin) throw limaMissingError();
  if (!fs.existsSync(LIMA_DIR)) fs.mkdirSync(LIMA_DIR, { recursive: true });

  if (isLimaVmRunning()) { sendLog('Lima VM already running.\n'); return; }

  if (limaVmExists()) {
    sendLog('Starting existing Coolify VM...\n');
    await new Promise((resolve, reject) => {
      const proc = spawn(bin, ['start', LIMA_VM_NAME], { stdio: ['pipe', 'pipe', 'pipe'], env: limaEnv() });
      proc.stdout.on('data', d => sendLog(d.toString()));
      proc.stderr.on('data', d => sendLog(d.toString()));
      proc.on('exit', c => c === 0 ? resolve() : reject(new Error(`Lima start failed (code ${c})`)));
    });
    return;
  }

  sendLog('Creating Coolify VM (first run — downloads Ubuntu image, may take several minutes)...\n');
  await new Promise((resolve, reject) => {
    const proc = spawn(bin, ['create', '--name', LIMA_VM_NAME, '--tty=false', getLimaConfigPath()], {
      stdio: ['pipe', 'pipe', 'pipe'], env: limaEnv(),
    });
    proc.stdout.on('data', d => sendLog(d.toString()));
    proc.stderr.on('data', d => sendLog(d.toString()));
    proc.on('exit', code => code === 0 ? resolve() : reject(new Error(`Lima create failed (code ${code})`)));
  });

  sendLog('Starting Coolify VM...\n');
  await new Promise((resolve, reject) => {
    const proc = spawn(bin, ['start', LIMA_VM_NAME], { stdio: ['pipe', 'pipe', 'pipe'], env: limaEnv() });
    proc.stdout.on('data', d => sendLog(d.toString()));
    proc.stderr.on('data', d => sendLog(d.toString()));
    proc.on('exit', c => c === 0 ? resolve() : reject(new Error(`Lima start failed (code ${c})`)));
  });
}

async function limaStopVm(sendLog) {
  const bin = getLimaBin();
  if (!bin || !limaVmExists()) return;
  sendLog('Stopping Coolify VM...\n');
  try {
    execSync(`"${bin}" stop ${LIMA_VM_NAME}`, { timeout: 30000, stdio: 'pipe', env: limaEnv() });
  } catch {}
}

function limaShell(cmd, opts = {}) {
  const bin = getLimaBin();
  if (!bin) throw limaMissingError();
  // lima shell <vm> bash -lc "<cmd>" runs the command with a login shell
  return execSync(`"${bin}" shell ${LIMA_VM_NAME} bash -lc ${JSON.stringify(cmd)}`, {
    timeout: opts.timeout || 30000,
    stdio: opts.stdio || 'pipe',
    env: limaEnv(),
  });
}

function limaShellSpawn(cmd, onLog) {
  const bin = getLimaBin();
  if (!bin) throw limaMissingError();
  const proc = spawn(bin, ['shell', LIMA_VM_NAME, 'bash', '-lc', cmd], {
    stdio: ['pipe', 'pipe', 'pipe'], env: limaEnv(),
  });
  proc.stdout.on('data', d => onLog(d.toString()));
  proc.stderr.on('data', d => onLog(d.toString()));
  return proc;
}

// ─── Coolify lifecycle (inside Lima VM) ───────────────────────────────────

// The official install script installs Docker + Coolify's docker-compose stack.
// After install, the compose file lives at /data/coolify/source/docker-compose.yml.
const COOLIFY_COMPOSE = '/data/coolify/source/docker-compose.yml';
const COOLIFY_ENV_FILE = '/data/coolify/source/.env';

// Tri-state probes: true | false | null.
//
// `null` means "the probe itself failed" (VM busy booting, limactl timeout, ssh
// not up yet) as opposed to a definitive "no". Collapsing those two cases into
// `false` is what made the setup indicators show red for a Coolify that was
// installed and running the whole time — a single slow `limactl list` during
// startup turned every downstream flag red.
//
// `test -f` distinguishes cleanly: exit 1 means the file is genuinely absent,
// so only a transport-level failure yields null.
function triCoolifyInstalled() {
  try {
    const out = limaShell(`test -f ${COOLIFY_COMPOSE} && echo yes || echo no`, { timeout: 8000, stdio: 'pipe' })
      .toString().trim();
    return out.endsWith('yes');
  } catch { return null; }
}

function triCoolifyRunning() {
  try {
    const out = limaShell(
      `sudo docker ps --filter name=coolify --format '{{.Names}}' 2>/dev/null | head -n 5`,
      { timeout: 10000, stdio: 'pipe' },
    ).toString().trim();
    return out.split('\n').some(n => /^coolify(-|$)/.test(n));
  } catch { return null; }
}

// Boolean wrappers preserve the original control-flow semantics at call sites
// that gate an action ("don't start what isn't installed"), where treating
// unknown as false is the safe choice.
function isCoolifyInstalled() { return triCoolifyInstalled() === true; }
function isCoolifyRunning() { return triCoolifyRunning() === true; }

async function coolifyInstall(sendLog) {
  // The install script needs to run as root in the VM.
  sendLog('Running Coolify install script inside VM (this will install Docker and bootstrap Coolify)...\n');
  const script = `curl -fsSL https://cdn.coollabs.io/coolify/install.sh | sudo bash`;
  return new Promise((resolve, reject) => {
    const proc = limaShellSpawn(script, sendLog);
    proc.on('exit', code => {
      if (code === 0) { sendLog('Coolify install finished.\n'); resolve(); }
      else reject(new Error(`Coolify install failed (exit ${code}). Check logs above.`));
    });
  });
}

async function coolifyStart(sendLog) {
  if (!isCoolifyInstalled()) throw new Error('Coolify is not installed yet. Run the setup first.');
  sendLog('Starting Coolify stack...\n');
  return new Promise((resolve, reject) => {
    const proc = limaShellSpawn(
      `cd /data/coolify/source && sudo docker compose -f docker-compose.yml --env-file .env up -d`,
      sendLog,
    );
    proc.on('exit', code => code === 0 ? resolve() : reject(new Error(`docker compose up failed (code ${code})`)));
  });
}

async function coolifyStop(sendLog) {
  if (!isCoolifyInstalled()) { sendLog('Coolify not installed; nothing to stop.\n'); return; }
  sendLog('Stopping Coolify stack...\n');
  return new Promise((resolve) => {
    const proc = limaShellSpawn(
      `cd /data/coolify/source && sudo docker compose -f docker-compose.yml --env-file .env down`,
      sendLog,
    );
    proc.on('exit', () => resolve());
  });
}

function checkCoolifyReady() {
  return new Promise((resolve) => {
    const req = http.request({ hostname: 'localhost', port: 8000, path: '/', method: 'GET', timeout: 2500 }, (res) => {
      // Coolify redirects to /login on the root; any 2xx/3xx means it's up
      resolve(res.statusCode >= 200 && res.statusCode < 500);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.end();
  });
}

// ─── Window ───────────────────────────────────────────────────────────────

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200, height: 820, title: 'Coolify Mentat',
    icon: path.join(__dirname, 'icon.png'),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
      webSecurity: false,
      preload: path.join(__dirname, 'preload.js'),
    },
    show: false,
  });

  mainWindow.on('closed', () => cleanup());
  mainWindow.webContents.on('did-fail-load', (_, code, desc) => console.error('Load failed:', desc));

  // Strip X-Frame-Options / CSP so the iframe can render Coolify served from localhost.
  mainWindow.webContents.session.webRequest.onHeadersReceived({ urls: ['<all_urls>'] }, (details, callback) => {
    const headers = { ...details.responseHeaders };
    for (const key of Object.keys(headers)) {
      const lower = key.toLowerCase();
      if (lower === 'x-frame-options' || lower === 'content-security-policy') delete headers[key];
      if (lower === 'set-cookie') {
        headers[key] = headers[key].map(cookie => {
          if (!/samesite/i.test(cookie)) return cookie + '; SameSite=None; Secure';
          return cookie.replace(/samesite=\w+/i, 'SameSite=None');
        });
      }
    }
    callback({ responseHeaders: headers });
  });

  mainWindow.loadFile(path.join(__dirname, 'app.html'));
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    if (!app.isPackaged) mainWindow.webContents.openDevTools();
  });
}

// ─── Cleanup ──────────────────────────────────────────────────────────────

function killProc(proc) {
  if (!proc || proc.killed) return;
  try {
    if (process.platform === 'win32') execSync(`taskkill /pid ${proc.pid} /T /F`, { stdio: 'ignore' });
    else process.kill(-proc.pid, 'SIGTERM');
  } catch {}
  setTimeout(() => { try { if (!proc.killed) proc.kill('SIGKILL'); } catch {} }, 3000);
}

function cleanup() {
  if (cleanupDone) return;
  cleanupDone = true;
  killProc(tunnelProcess); tunnelProcess = null; tunnelUrl = null;
  killProc(sshTunnelProcess); sshTunnelProcess = null; sshTunnelHost = null;
  if (ptyProcess) {
    if (process.platform !== 'win32') try { process.kill(-ptyProcess.pid, 'SIGTERM'); } catch {}
    try { ptyProcess.kill(); } catch {}
    ptyProcess = null;
  }
  if (setupLogStream) { try { setupLogStream.end(`=== ${new Date().toISOString()} — app quit ===\n`); } catch {} setupLogStream = null; }
  // We intentionally do NOT stop the Lima VM on quit — Coolify runs long-lived
  // workloads (deployments, background jobs) that should outlive the UI.
  setTimeout(() => app.quit(), 500);
}

// ─── IPC: Setup / Status ─────────────────────────────────────────────────

// Last-known-good status, persisted so a restart doesn't start from a wall of
// red dots while the VM boots.
function rememberStatus(st) {
  const s = loadSettings();
  s.lastKnownStatus = {
    vmExists: st.vmExists, vmRunning: st.vmRunning,
    coolifyInstalled: st.coolifyInstalled, coolifyRunning: st.coolifyRunning,
    at: Date.now(),
  };
  // Recorded, not swallowed: losing this cache means the next launch shows a
  // wall of "unknown" status instead of the last known good state.
  attempt('settings.saveStatusCache', () => saveSettings(s));
}

function computeStatus() {
  const limaAvailable = isLimaInstalled();
  const vmExists = limaAvailable ? triLimaVmExists() : false;
  const vmRunning = limaAvailable ? triLimaVmRunning() : false;

  // Only skip the Coolify probes when the VM is *definitively* not running.
  // `vmRunning === null` means we could not tell, and must not be read as
  // "stopped" — that was the original bug.
  const coolifyInstalled = vmRunning === false ? false : triCoolifyInstalled();
  const coolifyRunning = coolifyInstalled === false ? false : triCoolifyRunning();

  const fresh = { platform: process.platform, limaAvailable, vmExists, vmRunning, coolifyInstalled, coolifyRunning };

  // Fill unknowns from the last confirmed reading and flag the result as stale
  // so the UI can show "checking" rather than a false negative.
  const last = loadSettings().lastKnownStatus || {};
  let stale = false;
  for (const k of ['vmExists', 'vmRunning', 'coolifyInstalled', 'coolifyRunning']) {
    if (fresh[k] === null) {
      stale = true;
      fresh[k] = typeof last[k] === 'boolean' ? last[k] : null;
    }
  }
  fresh.stale = stale;
  if (!stale) rememberStatus(fresh);
  return fresh;
}

ipcMain.handle('setup:status', () => computeStatus());

ipcMain.handle('setup:lima-create', async () => {
  try { await limaCreateAndStart(sendSetupLog); return { success: true }; }
  catch (e) { sendSetupLog(`Error: ${e.message}\n`); return { success: false, error: e.message }; }
});

ipcMain.handle('setup:lima-start', async () => {
  try { await limaCreateAndStart(sendSetupLog); return { success: true }; }
  catch (e) { sendSetupLog(`Error: ${e.message}\n`); return { success: false, error: e.message }; }
});

ipcMain.handle('setup:lima-stop', async () => {
  try { await limaStopVm(sendSetupLog); return { success: true }; }
  catch (e) { return { success: false, error: e.message }; }
});

ipcMain.handle('setup:coolify-install', async () => {
  try {
    if (!isLimaVmRunning()) await limaCreateAndStart(sendSetupLog);
    await coolifyInstall(sendSetupLog);
    return { success: true };
  } catch (e) { sendSetupLog(`Error: ${e.message}\n`); return { success: false, error: e.message }; }
});

ipcMain.handle('setup:coolify-start', async () => {
  try {
    if (!isLimaVmRunning()) await limaCreateAndStart(sendSetupLog);
    await coolifyStart(sendSetupLog);
    return { success: true };
  } catch (e) { sendSetupLog(`Error: ${e.message}\n`); return { success: false, error: e.message }; }
});

ipcMain.handle('setup:coolify-stop', async () => {
  try { await coolifyStop(sendSetupLog); return { success: true }; }
  catch (e) { return { success: false, error: e.message }; }
});

ipcMain.handle('setup:open-vm-shell', () => {
  const bin = getLimaBin();
  if (!bin) return { success: false, error: 'Lima not available' };
  // Open the default terminal with `limactl shell coolify`. On macOS use `open -a Terminal`.
  try {
    if (process.platform === 'darwin') {
      execSync(`osascript -e 'tell app "Terminal" to do script "LIMA_HOME=${LIMA_DIR} \\"${bin}\\" shell ${LIMA_VM_NAME}"'`, { stdio: 'ignore' });
    } else if (process.platform === 'win32') {
      spawn('cmd.exe', ['/k', bin, 'shell', LIMA_VM_NAME], { detached: true, stdio: 'ignore', env: limaEnv() }).unref();
    } else {
      spawn('x-terminal-emulator', ['-e', `${bin} shell ${LIMA_VM_NAME}`], { detached: true, stdio: 'ignore', env: limaEnv() }).unref();
    }
    return { success: true };
  } catch (e) { return { success: false, error: e.message }; }
});

ipcMain.handle('setup:coolify-credentials', () => {
  // Surfaces the auto-generated admin password / url hint from Coolify's .env file.
  try {
    const envText = limaShell(`sudo cat ${COOLIFY_ENV_FILE} 2>/dev/null || true`, { timeout: 10000, stdio: 'pipe' }).toString();
    const get = (k) => { const m = envText.match(new RegExp(`^${k}=(.*)$`, 'm')); return m ? m[1].trim() : null; };
    return {
      ok: true,
      appUrl: get('APP_URL') || 'http://localhost:8000',
      rootUsername: get('ROOT_USERNAME'),
      rootUserEmail: get('ROOT_USER_EMAIL'),
    };
  } catch (e) { return { ok: false, error: e.message }; }
});

// ─── Apply a tunnel hostname to the running Coolify config ────────────────
//
// Design note (Apr 23): "apply exposed via tunnel domain to the running coolify
// config". Coolify builds absolute links (webhooks, OAuth callbacks, magic
// links) from APP_URL in its .env. Left at http://<vm-ip>:8000 those links are
// unreachable through the tunnel, so exposing the UI is only half the job.
//
// Rewrites APP_URL (and the Soketi host used by the realtime websocket) in
// /data/coolify/source/.env inside the VM, keeping a timestamped backup, then
// restarts the stack so the change takes effect.
function applyCoolifyDomain(host, sendLog) {
  const clean = String(host || '').trim().replace(/^https?:\/\//, '').replace(/\/+$/, '');
  if (!clean) throw new Error('No hostname given');
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(clean)) throw new Error(`"${clean}" is not a valid hostname`);
  if (triCoolifyInstalled() !== true) throw new Error('Coolify is not installed yet — run setup first.');

  const url = `https://${clean}`;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');

  sendLog(`Backing up .env -> .env.bak.${stamp}\n`);
  limaShell(`sudo cp ${COOLIFY_ENV_FILE} ${COOLIFY_ENV_FILE}.bak.${stamp}`, { timeout: 15000, stdio: 'pipe' });

  // Upsert each key: replace in place if present, append if not.
  const upsert = (key, value) => {
    const line = `${key}=${value}`;
    limaShell(
      `sudo grep -q '^${key}=' ${COOLIFY_ENV_FILE} `
      + `&& sudo sed -i 's|^${key}=.*|${line}|' ${COOLIFY_ENV_FILE} `
      + `|| echo '${line}' | sudo tee -a ${COOLIFY_ENV_FILE} >/dev/null`,
      { timeout: 15000, stdio: 'pipe' },
    );
  };

  sendLog(`Setting APP_URL=${url}\n`);
  upsert('APP_URL', url);
  upsert('PUSHER_HOST', clean);

  sendLog('Restarting Coolify to apply the new domain...\n');
  limaShell(
    `cd /data/coolify/source && sudo docker compose --env-file ${COOLIFY_ENV_FILE} up -d --force-recreate`,
    { timeout: 180000, stdio: 'pipe' },
  );

  const s = loadSettings();
  s.appliedDomain = { host: clean, url, at: Date.now() };
  // The domain was ALREADY applied inside the VM at this point; if persisting
  // it fails the UI forgets a change that really happened, which is worse than
  // the write failing loudly.
  attempt('settings.saveAppliedDomain', () => saveSettings(s), { host: clean });

  sendLog(`Coolify now advertises itself at ${url}\n`);
  return { url, host: clean, backup: `${COOLIFY_ENV_FILE}.bak.${stamp}` };
}

ipcMain.handle('coolify:apply-domain', async (_, host) => {
  try { return { success: true, ...applyCoolifyDomain(host, sendSetupLog) }; }
  catch (e) {
    sendSetupLog(`Error applying domain: ${e.message}\n`);
    return { success: false, error: e.message };
  }
});

ipcMain.handle('coolify:applied-domain', () => loadSettings().appliedDomain || null);

ipcMain.handle('setup:probe-ready', async () => ({ ready: await checkCoolifyReady() }));

ipcMain.handle('setup:get-log-snapshot', () => ({ lines: logRing.slice(-200) }));

ipcMain.handle('setup:paths', () => ({
  dataDir,
  settingsFile: SETTINGS_FILE,
  logsDir,
  setupLog: SETUP_LOG_FILE,
  limaDir: LIMA_DIR,
  limaConfig: getLimaConfigPath(),
  cloudflaredDir: path.join(os.homedir(), '.cloudflared'),
  coolifyDataInVm: '/data/coolify',
}));

ipcMain.handle('settings:get', () => loadSettings());
ipcMain.handle('settings:set', (_, patch) => {
  const merged = { ...loadSettings(), ...(patch || {}) };
  saveSettings(merged);
  return { success: true, settings: merged };
});

ipcMain.handle('shell:open-logs-dir', () => shell.openPath(logsDir));
ipcMain.handle('shell:open-lima-dir', () => shell.openPath(LIMA_DIR));

// ─── IPC: Cloudflare Tunnel (HTTP — ported from n8n-mentat) ───────────────

ipcMain.handle('cloudflared:check', () => {
  try { execSyncEnv('cloudflared --version', { timeout: 5000, stdio: 'pipe' }); return { installed: true }; }
  catch {
    try { execSyncEnv('npx cloudflared --version', { timeout: 15000, stdio: 'pipe' }); return { installed: true }; }
    catch { return { installed: false }; }
  }
});

ipcMain.handle('cloudflared:install', () => {
  try { execSyncEnv('npx bun add -g cloudflared', { timeout: 60000 }); return { success: true }; }
  catch (e) { return { success: false, error: e.stderr?.toString().trim() || e.message }; }
});

ipcMain.handle('cloudflared:auth-status', () => {
  const certPath = path.join(os.homedir(), '.cloudflared', 'cert.pem');
  return { authenticated: fs.existsSync(certPath) };
});

ipcMain.handle('cloudflared:login', async () => {
  try {
    const proc = spawn('cloudflared', ['tunnel', 'login'], { stdio: 'pipe', detached: true, env: shellEnv() });
    return new Promise((resolve) => {
      let output = '';
      proc.stdout.on('data', (d) => { output += d.toString(); });
      proc.stderr.on('data', (d) => { output += d.toString(); });
      proc.on('exit', (code) => {
        if (code === 0) resolve({ success: true });
        else resolve({ success: false, error: output.trim() || `Exit code ${code}` });
      });
      setTimeout(() => { try { proc.kill(); } catch {} resolve({ success: false, error: 'Login timed out' }); }, 300000);
    });
  } catch (e) { return { success: false, error: e.message }; }
});

// Parses ~/.cloudflared/config.yml to find the hostname we wired up for Coolify
// (HTTP → localhost:8000) and for SSH (TCP → localhost:2222).
function readTunnelConfig() {
  const configPath = path.join(os.homedir(), '.cloudflared', 'config.yml');
  if (!fs.existsSync(configPath)) return { hasConfig: false };
  let tunnelName = null, httpHost = null, sshHost = null;
  try {
    const cfg = fs.readFileSync(configPath, 'utf8');
    const m = cfg.match(/^tunnel:\s*(.+)$/m);
    if (m) tunnelName = m[1].trim();
    const lines = cfg.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const svc = lines[i].match(/service:\s*(.+)$/);
      if (!svc) continue;
      const value = svc[1].trim();
      const hostMatch = lines[i - 1]?.match(/hostname:\s*(.+)/);
      if (!hostMatch) continue;
      const host = hostMatch[1].trim().replace(/['"]/g, '');
      if (/http:\/\/localhost:8000/.test(value)) httpHost = host;
      if (/ssh:\/\/localhost:2222/.test(value)) sshHost = host;
    }
  } catch (err) {
    // A parse failure here previously reported "no hostnames configured" for a
    // perfectly good tunnel — the config exists, we just could not read it.
    quiet('cloudflared.parseConfig', () => { throw err; }, null, { tunnelName });
  }
  return { hasConfig: true, tunnelName, httpHost, sshHost };
}

function writeTunnelConfig(tunnelId, httpHost, sshHost) {
  const configPath = path.join(os.homedir(), '.cloudflared', 'config.yml');
  const credsPath = path.join(os.homedir(), '.cloudflared', `${tunnelId}.json`);
  const ingress = ['ingress:'];
  if (httpHost) ingress.push(`  - hostname: ${httpHost}`, '    service: http://localhost:8000');
  if (sshHost)  ingress.push(`  - hostname: ${sshHost}`,  '    service: ssh://localhost:2222');
  ingress.push('  - service: http_status:404');
  const yaml = [
    `tunnel: ${tunnelId}`,
    `credentials-file: ${credsPath}`,
    '',
    ...ingress,
    '',
    'metrics: 127.0.0.1:0',
    '',
  ].join('\n');
  fs.writeFileSync(configPath, yaml);
}

ipcMain.handle('cloudflared:tunnel-status', () => {
  const info = readTunnelConfig();
  return { configured: info.hasConfig && !!info.tunnelName && (!!info.httpHost || !!info.sshHost), ...info };
});

async function ensureTunnelId(tunnelName, sendLog) {
  let tunnelId = null;
  try {
    const list = execSyncEnv('cloudflared tunnel list -o json', { timeout: 15000, stdio: 'pipe' }).toString();
    const tunnels = JSON.parse(list);
    const existing = tunnels.find(t => t.name === tunnelName);
    if (existing) {
      const existingCreds = path.join(os.homedir(), '.cloudflared', `${existing.id}.json`);
      if (fs.existsSync(existingCreds)) tunnelId = existing.id;
      else {
        if (sendLog) sendLog('Tunnel exists but credentials missing locally, recreating...\n');
        try { execSyncEnv(`cloudflared tunnel delete -f ${tunnelName}`, { timeout: 15000, stdio: 'pipe' }); } catch {}
      }
    }
  } catch {}
  if (!tunnelId) {
    const out = execSyncEnv(`cloudflared tunnel create ${tunnelName}`, { timeout: 15000, stdio: 'pipe' }).toString();
    const match = out.match(/([0-9a-f-]{36})/);
    if (!match) throw new Error('Failed to parse tunnel ID from: ' + out);
    tunnelId = match[1];
  }
  return tunnelId;
}

ipcMain.handle('cloudflared:setup-tunnel', async (_, payload) => {
  try {
    const { httpHost, sshHost } = payload || {};
    if (!httpHost && !sshHost) return { success: false, error: 'At least one hostname is required' };

    const tunnelName = 'coolify';
    const tunnelId = await ensureTunnelId(tunnelName);
    writeTunnelConfig(tunnelId, httpHost?.trim() || null, sshHost?.trim() || null);

    for (const host of [httpHost, sshHost].filter(Boolean)) {
      try {
        execSyncEnv(`cloudflared tunnel route dns --overwrite-dns "${tunnelId}" "${host}"`, { timeout: 15000, stdio: 'pipe' });
      } catch (e) {
        const err = e.stderr?.toString() || '';
        if (!err.includes('already exists')) return { success: false, error: `DNS route failed for ${host}: ` + err.trim() };
      }
    }

    return { success: true, tunnelId, httpHost: httpHost || null, sshHost: sshHost || null };
  } catch (e) {
    return { success: false, error: e.stderr?.toString().trim() || e.message };
  }
});

ipcMain.handle('tunnel:start', async () => {
  if (tunnelProcess && !tunnelProcess.killed) return { success: true, url: tunnelUrl };
  try {
    const info = readTunnelConfig();
    if (!info.hasConfig || (!info.httpHost && !info.sshHost)) {
      return { success: false, error: 'No tunnel configured — complete setup first' };
    }

    tunnelProcess = spawn('cloudflared', ['tunnel', 'run'], { stdio: 'pipe', detached: true, env: shellEnv() });
    tunnelUrl = null;
    sshTunnelHost = info.sshHost || null;

    const sendLog = (t) => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('tunnel:log', t); };
    let connected = false;
    const handler = (data) => {
      const text = data.toString();
      sendLog(text);
      if (!connected && text.includes('Registered tunnel connection')) {
        connected = true;
        if (info.httpHost) tunnelUrl = `https://${info.httpHost}`;
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('tunnel:url-update', { httpUrl: tunnelUrl, sshHost: info.sshHost });
        }
      }
    };
    tunnelProcess.stdout.on('data', handler);
    tunnelProcess.stderr.on('data', handler);
    tunnelProcess.on('exit', (code) => {
      sendLog(`\n[cloudflared exited with code ${code}]\n`);
      tunnelProcess = null; tunnelUrl = null; sshTunnelHost = null;
    });

    for (let i = 0; i < 20 && !connected; i++) await new Promise(r => setTimeout(r, 1000));
    if (!connected) return { success: false, error: 'Tunnel failed to connect' };
    return { success: true, httpUrl: tunnelUrl, sshHost: info.sshHost };
  } catch (e) { return { success: false, error: e.message }; }
});

ipcMain.handle('tunnel:stop', () => {
  killProc(tunnelProcess); tunnelProcess = null; tunnelUrl = null; sshTunnelHost = null;
  return { success: true };
});

ipcMain.handle('tunnel:status', () => ({
  running: !!(tunnelProcess && !tunnelProcess.killed),
  httpUrl: tunnelUrl,
  sshHost: sshTunnelHost,
}));

// ─── IPC: PTY (optional terminal — mirrors n8na/mcbes for parity) ─────────

ipcMain.handle('pty:spawn', async (_, cols, rows) => {
  try {
    if (ptyProcess) { try { ptyProcess.kill(); } catch {} ptyProcess = null; }
    const home = os.homedir();
    const env = { ...shellEnv(), TERM: 'xterm-256color', COLUMNS: String(cols || 80), LINES: String(rows || 24) };
    const bin = getLimaBin();
    // When Lima is available, drop the user directly into the Coolify VM shell
    // so they can run `docker`, `docker compose logs`, etc. without the app UI.
    if (process.platform === 'win32') {
      const args = bin ? ['/k', bin, 'shell', LIMA_VM_NAME] : ['/k'];
      ptyProcess = spawn('cmd.exe', args, { stdio: ['pipe', 'pipe', 'pipe'], cwd: home, env });
    } else {
      let helperPath = path.join(__dirname, 'pty-helper.py');
      if (app.isPackaged) helperPath = helperPath.replace('app.asar', 'app.asar.unpacked');
      const shellArgs = bin
        ? [bin, 'shell', LIMA_VM_NAME]
        : [process.env.SHELL || '/bin/zsh', '-l'];
      ptyProcess = spawn('python3', [helperPath, ...shellArgs], { stdio: ['pipe', 'pipe', 'pipe'], cwd: home, env: { ...env, LIMA_HOME: LIMA_DIR } });
    }
    ptyProcess.stdout.on('data', (d) => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('pty:data', d.toString()); });
    ptyProcess.stderr.on('data', (d) => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('pty:data', d.toString()); });
    ptyProcess.on('exit', () => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('pty:exit'); ptyProcess = null; });
    return { success: true };
  } catch (e) { return { success: false, error: e.message }; }
});
ipcMain.on('pty:write', (_, data) => { if (ptyProcess && !ptyProcess.killed) ptyProcess.stdin.write(data); });
ipcMain.on('pty:resize', () => { if (ptyProcess?.pid && process.platform !== 'win32') try { process.kill(ptyProcess.pid, 'SIGWINCH'); } catch {} });
ipcMain.on('pty:kill', () => {
  if (ptyProcess) {
    if (process.platform !== 'win32') try { process.kill(-ptyProcess.pid, 'SIGTERM'); } catch {}
    try { ptyProcess.kill(); } catch {}
    ptyProcess = null;
  }
});

// ─── IPC: Shell ───────────────────────────────────────────────────────────

ipcMain.handle('shell:open-external', (_, url) => {
  if (typeof url === 'string' && /^https?:\/\//.test(url)) shell.openExternal(url);
});
ipcMain.handle('shell:open-data-dir', () => shell.openPath(dataDir));

// ─── Lifecycle ────────────────────────────────────────────────────────────

app.setName('Coolify Mentat');

app.whenReady().then(async () => {
  if (process.platform === 'darwin' && fs.existsSync(path.join(__dirname, 'icon.png'))) {
    app.dock.setIcon(path.join(__dirname, 'icon.png'));
  }
  createWindow();
  setupAutoUpdate(mainWindow);

  // If Coolify is already running from a previous session, the iframe will load it
  // directly and the user skips setup. Otherwise the Setup tab guides them.
  autoStartIfReady();
});

// Design note (Apr 23): "step 3 to be additionally run on start automatically if
// all setup steps checks pass, to start with ui initially if ready (for ux)".
//
// A user who finished setup once should not have to walk the Setup tab again
// just because the VM stopped when they shut down. If the VM exists and Coolify
// is installed, bring both up in the background and drop the user straight on
// the Coolify tab. Runs detached so it never blocks window creation, and stays
// strictly opt-out via the autoStart setting.
async function autoStartIfReady() {
  if (loadSettings().autoStart === false) return;

  const notify = (phase, detail) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('setup:auto-start', { phase, detail });
    }
  };

  try {
    if (!isLimaInstalled()) return;
    if (triLimaVmExists() !== true) return;      // never auto-create a VM: that is a
                                                 // multi-minute first-run download
    if (triLimaVmRunning() !== true) {
      notify('vm', 'Starting the Coolify VM…');
      sendSetupLog('[auto-start] VM is not running — starting it.\n');
      await limaCreateAndStart(sendSetupLog);
    }

    if (triCoolifyInstalled() !== true) return;  // setup was never completed

    if (triCoolifyRunning() !== true) {
      notify('coolify', 'Starting Coolify…');
      sendSetupLog('[auto-start] Coolify is installed but not running — starting it.\n');
      await coolifyStart(sendSetupLog);
    }

    notify('ready', 'Coolify is up.');
    sendSetupLog('[auto-start] Ready.\n');
  } catch (e) {
    // Auto-start is a convenience; a failure must leave the user on the Setup
    // tab with a usable log rather than blocking the app.
    sendSetupLog(`[auto-start] Skipped: ${e.message}\n`);
    notify('failed', e.message);
  }
}

app.on('window-all-closed', () => cleanup());
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
app.on('before-quit', () => cleanup());
process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);
process.on('uncaughtException', (e) => {
  if (e.code === 'EPIPE' || e.code === 'ERR_STREAM_DESTROYED') { return; }
  console.error('Uncaught:', e); cleanup();
});
