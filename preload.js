const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // Setup / status
  setupStatus: () => ipcRenderer.invoke('setup:status'),
  setupLimaCreate: () => ipcRenderer.invoke('setup:lima-create'),
  setupLimaStart: () => ipcRenderer.invoke('setup:lima-start'),
  setupLimaStop: () => ipcRenderer.invoke('setup:lima-stop'),
  setupCoolifyInstall: () => ipcRenderer.invoke('setup:coolify-install'),
  setupCoolifyStart: () => ipcRenderer.invoke('setup:coolify-start'),
  setupCoolifyStop: () => ipcRenderer.invoke('setup:coolify-stop'),
  setupOpenVmShell: () => ipcRenderer.invoke('setup:open-vm-shell'),
  setupCredentials: () => ipcRenderer.invoke('setup:coolify-credentials'),
  setupProbeReady: () => ipcRenderer.invoke('setup:probe-ready'),
  setupLogSnapshot: () => ipcRenderer.invoke('setup:get-log-snapshot'),
  setupPaths: () => ipcRenderer.invoke('setup:paths'),
  onSetupLog: (cb) => ipcRenderer.on('setup:log', (_, t) => cb(t)),
  onAutoStart: (cb) => ipcRenderer.on('setup:auto-start', (_, s) => cb(s)),

  // Settings
  settingsGet: () => ipcRenderer.invoke('settings:get'),
  settingsSet: (patch) => ipcRenderer.invoke('settings:set', patch),

  // Cloudflare tunnel
  cloudflaredCheck: () => ipcRenderer.invoke('cloudflared:check'),
  cloudflaredInstall: () => ipcRenderer.invoke('cloudflared:install'),
  cloudflaredAuthStatus: () => ipcRenderer.invoke('cloudflared:auth-status'),
  cloudflaredLogin: () => ipcRenderer.invoke('cloudflared:login'),
  cloudflaredTunnelStatus: () => ipcRenderer.invoke('cloudflared:tunnel-status'),
  cloudflaredSetupTunnel: (payload) => ipcRenderer.invoke('cloudflared:setup-tunnel', payload),
  coolifyApplyDomain: (host) => ipcRenderer.invoke('coolify:apply-domain', host),
  coolifyAppliedDomain: () => ipcRenderer.invoke('coolify:applied-domain'),
  tunnelStart: () => ipcRenderer.invoke('tunnel:start'),
  tunnelStop: () => ipcRenderer.invoke('tunnel:stop'),
  tunnelStatus: () => ipcRenderer.invoke('tunnel:status'),
  onTunnelUrl: (cb) => ipcRenderer.on('tunnel:url-update', (_, data) => cb(data)),
  onTunnelLog: (cb) => ipcRenderer.on('tunnel:log', (_, t) => cb(t)),

  // PTY
  ptySpawn: (cols, rows) => ipcRenderer.invoke('pty:spawn', cols, rows),
  ptyWrite: (data) => ipcRenderer.send('pty:write', data),
  ptyResize: (cols, rows) => ipcRenderer.send('pty:resize', cols, rows),
  ptyKill: () => ipcRenderer.send('pty:kill'),
  onPtyData: (cb) => { ipcRenderer.removeAllListeners('pty:data'); ipcRenderer.on('pty:data', (_, d) => cb(d)); },
  onPtyExit: (cb) => { ipcRenderer.removeAllListeners('pty:exit'); ipcRenderer.on('pty:exit', () => cb()); },

  // Shell
  openExternal: (url) => ipcRenderer.invoke('shell:open-external', url),
  openDataDir: () => ipcRenderer.invoke('shell:open-data-dir'),
  openLogsDir: () => ipcRenderer.invoke('shell:open-logs-dir'),
  openLimaDir: () => ipcRenderer.invoke('shell:open-lima-dir'),


  // Auto-update
  onUpdateAvailable: (cb) => ipcRenderer.on('update:available', (_, info) => cb(info)),
  onUpdateDownloaded: (cb) => ipcRenderer.on('update:downloaded', (_, info) => cb(info)),
  installUpdate: () => ipcRenderer.invoke('update:install'),
});
