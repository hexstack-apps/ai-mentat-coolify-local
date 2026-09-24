# ai-mentat-coolify-local

## Quick start

```sh
git clone --recurse-submodules https://github.com/hexstack-apps/ai-mentat-coolify-local.git
cd ai-mentat-coolify-local
npm run setup     # install all npm and non-npm dependencies
npm run run       # launch in dev mode
npm run build     # build for this system
npm run check     # build, then start the built app
```

Already cloned without `--recurse-submodules`? Run `npm run setup` — it
initialises the [ai-mentat-sdk](https://github.com/hexstack-apps/ai-mentat-sdk)
submodule for you.

| script | what it does |
|---|---|
| `setup` | git submodules, npm dependencies, non-npm/system dependency check, creates the data dir |
| `run` | runs `setup` first, then launches the Electron app in dev mode |
| `build` | builds for the current OS into `/.hexstack-app/ai-mentat-coolify-local/ai-mentat-coolify-local.<ext>` |
| `check` | runs `build`, then starts the built executable |

`<ext>` is `dmg` on macOS, `exe` on Windows, `AppImage` on Linux.

## Where data is stored

```
/.hexstack-app/ai-mentat-coolify-local/data
```

The filesystem root is not writable by an unprivileged user on most systems, so
`npm run setup` creates the directory and tells you what to run if it cannot:

```sh
sudo mkdir -p /.hexstack-app && sudo chown -R "$(whoami)" /.hexstack-app
```

Until then the app falls back to `~/.hexstack-app/ai-mentat-coolify-local/data` rather than
failing to start.

## Shared code

Common logic, UI and utilities live in
[ai-mentat-sdk](https://github.com/hexstack-apps/ai-mentat-sdk), mounted here as
a git submodule at `sdk/`.

---

Desktop wrapper that runs [Coolify](https://coolify.io) (self-hosted Heroku/Vercel alternative) locally. Coolify ships as a docker-compose stack — this app:

- Boots a bundled Lima VM on macOS (Apple Virtualization.framework, no Docker Desktop required)
- Runs Coolify's official `install.sh` inside the VM
- Embeds the Coolify web UI in a native window
- Exposes everything (HTTP + optional SSH) over a Cloudflare named tunnel

## Tabs

1. **Coolify Localhost** — iframe to `http://localhost:8000`
2. **Setup** — Lima VM + Coolify install/start/stop, live install log
3. **Cloudflare Tunnel** — 4-step wizard (install → auth → hostnames → run), HTTP + SSH routes
4. **FAQ** — first-launch walkthrough, tunneling, data location

## Architecture

Mirrors the sibling apps `ai-mentat-n8n` (iframe wrapper) + `ai-mentat-minecraft` (Lima-based Docker orchestration).
Extracted from the `hexstack` monorepo; the pieces it used to share live in `shared/` here.

| Concern | Reuses |
|---|---|
| Electron bundling (esbuild) | `sdk/utils/bundle-electron.js` |
| Auto-update | `sdk/logic/auto-update.js` |
| Publish pipeline | `sdk/logic/publish.js` |
| Lima VM boot/shell pattern | inspired by `ai-mentat-minecraft` |
| Tunnel wizard (IPC + UI) | ported from `ai-mentat-n8n` |

## Ports

- `8000` — Coolify web UI (iframe target)
- `6001` — realtime websocket
- `6002` — terminal
- `8080` — docker proxy dashboard
- `2222` — SSH to the Lima VM (`guestPort: 22 -> hostPort: 2222`)

## Build

```bash
npm install
npm run download:lima         # fetch Lima binaries (~50MB, required for packaging)

npm run gui                   # bundle + launch
npm run build:mac             # unsigned universal DMG
npm run build:mac:signed      # signed + notarized DMG
npm run publish               # full pipeline (bump, bundle, build, itch, updates feed)
```

## Dev notes

- `lima-bin/` is not committed (~50MB). Run `npm run download:lima` once before packaging. In the old monorepo this was a symlink into `_mentat-mcbes/`; standalone it is downloaded.
- Lima VM lives at `~/.coolify-lima/` (separate from the Minecraft app's `~/.mc-lima/`).
- Coolify data persists at `/data/coolify` inside the VM.
