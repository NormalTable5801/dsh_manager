<h1 align="center">
  dsh_manager
</h1>

<p align="center">
  <strong>A local web admin console for DeepSeek Harness</strong> &mdash; zero dependencies, no <code>npm install</code>, runs only on your machine.
  One-click pnpm build &amp; hosting of dsh web, update detection &amp; version rollback, <code>~/.dsh</code> backup/restore,
  plus a built-in diagnostic Doctor and a command console &mdash; all in one page.
</p>

<p align="center">
  <code>zero-dep</code> · <code>no npm install</code> · <code>127.0.0.1 only</code> · <code>UTF-8 / GBK</code> · <code>data / source separation</code> · <code>pnpm workspace</code> · <code>ported from dsh-doctor(BSD-3)</code>
</p>

<p align="center">
  <a href="#features">Features</a> ·
  <a href="#runtime-architecture">Runtime architecture</a> ·
  <a href="#pnpm-based-deployment">pnpm deployment</a> ·
  <a href="#diagnostic-doctor">Diagnostic Doctor</a> ·
  <a href="#command-console">Command console</a> ·
  <a href="#quick-start">Quick start</a> ·
  <a href="#security">Security</a> ·
  <a href="#license-credits">License &amp; credits</a>
</p>

`dsh_manager` is a web console scoped to a local DeepSeek Harness installation. It gathers the operations you
usually scatter across several terminals &mdash; start/stop dsh web, pull and switch versions, back up and restore
`~/.dsh`, run an environment diagnostic, and fire arbitrary `dsh` commands &mdash; into a single page. It has no
third-party runtime dependencies and no separate deployment environment: just install Node and run.

> [!CAUTION]
> `dsh_manager` is a **local, personal-use tool**. By default it binds only to `127.0.0.1` &mdash; do not rebind to
> `0.0.0.0` or expose it to the public internet. It may read/back up your real data directory `~/.dsh`
> (conversations, plugin configs and credentials). **Never** add `backups/`, `logs/`, `config.json` or `.env`
> to version control (`.gitignore` already ignores them).

## Features

| Area | Capability |
| --- | --- |
| One-click web hosting | Manages the dsh web subprocess: start / stop / restart, live logs, detected access URL, port probing against duplicate starts |
| Update detection | `git fetch` official tags from the upstream repo, semver-compare against the current position, prompt when an upgrade is available |
| Version rollback | Pulls official git tags and switches to any historical version with one click (`git checkout` + rebuild) |
| Data backup | Backs up `~/.dsh` to `backups/`; restore / delete / overwrite with retention-limit management; safe pre-restore backup by default |
| One-click build | Runs `pnpm install` + `pnpm build` inside the repo to produce the CLI entry and the web frontend |
| Diagnostic Doctor | 17 checks (install-level + harness-level), flutter-doctor style, honest-principle safe repairs |
| Command console | Runs `dsh xxx` from the page with real-time SSE streaming output; whitelist + argv passing, never through a shell |
| Environment check | Detects node / pnpm / git versions and validates that node meets Harness constraints |

## Runtime architecture

`dsh_manager` only manages and orchestrates; it does not participate in dsh's internals. It cooperates with two
other things on your machine:

```text
  You (browser 127.0.0.1:8730)
            │  1) start/stop/restart, live logs, console, diagnostic
            ▼
   ┌─────────────────────────────┐
   │         dsh_manager         │   <─ this repo (standalone git repo)
   │   server.js + doctor.js     │     read-only / controlled ops, never edits Harness source
   └─────────────────────────────┘
        │                │              │
        │ git/pnpm/build │ node↘        │ robocopy backup / restore
        ▼                ▼              ▼
   Harness source repo  dsh web       ~/.dsh data dir
   (apps/cli/lib/bin.js)(subprocess)  (conversations+plugins+creds+settings)
```

- The **Harness source repo** and this project are **two independent git repositories** (source lives in a sibling
  folder, e.g. `D:\dsh\deepseek-harness-dsh-v0.1.1-rc.2`). This project neither enters nor modifies Harness's commit history.
- Upgrade/rollback only changes the source version and rebuilds; it **never touches** `~/.dsh`. All interactive
  data lives in `~/.dsh`, so switching Harness versions does not affect your conversations or config.

## pnpm-based deployment

This project manages DeepSeek Harness &mdash; a **pnpm workspace monorepo**. The whole "install &rarr; build &rarr; run web"
chain relies on pnpm, which is exactly the underlying logic of "one-click deployment":

```bash
cd D:\dsh\deepseek-harness-dsh-v0.1.1-rc.2
pnpm install       # install all workspace dependencies
pnpm build         # produce apps/cli/lib/bin.js and apps/web/dist
pnpm dsh web       # run the dsh script defined in the repo to start the built-in web
```

Mapped to the UI:

- **Build** = runs `pnpm install` + `pnpm run build` inside the repo to generate the CLI entry and the web frontend.
- **Start dsh web** = launches the built artifact `apps/cli/lib/bin.js`; it is equivalent to the command `pnpm dsh web`
  ultimately resolves to (except it calls node directly, skipping the pnpm shim overhead).
- You can also switch to `source` mode in **Settings** and run `node --import tsx/esm apps/cli/src/bin.ts` straight
  from the TS source, handy for development/debugging.
- `apps/cli` (CLI) and `apps/web` (built-in web) live in the same workspace: shared dependencies, unified commands,
  no extra install &mdash; another "zero extra deployment" on top of the zero-dep `dsh_manager` itself.

## Diagnostic Doctor

The built-in **Diagnostic Doctor** is ported from the community [`coppynight/dsh-doctor`](https://github.com/coppynight/dsh-doctor)
(BSD-3-Clause) and **adapted for Windows**, using a flutter-doctor style report (`✓ ok / ! warn / ✗ error`).

- **Install-level checks:** node / git / pnpm versions, credentials, repo git state, ports and executables.
- **Harness-level checks:** `settings.yaml`, sessions, credential source chain, web.log, repository plugins and mount state.
- **Honest repair principle:** `--fix` runs only actions declared safe and rollback-able &mdash;
  when `settings` is missing/corrupt it backsup then writes a minimal valid config; credentials are written to
  `~/.dsh/.env` (`chmod 600`) only after you type them in; everything else emits precise, copy-pasteable commands
  and does **not** modify your environment without permission.
- Checks that depend on a Unix install layout (privilege / ownership / layout / staging / path / hooks / lefthook)
  are explicitly reported as "skipped (not applicable here)" on Windows rather than silently misreported.

## Command console

An embedded **Command Console** page for running `dsh` commands with real-time streaming output:

- Only accepts commands starting with `dsh`, e.g. `dsh doctor`, `dsh --help`, `dsh web`.
- Arguments are passed **directly as argv** (never through a shell), so non-`dsh` commands such as `rm -rf /` are
  rejected outright &mdash; no injection risk.
- Only one command runs at a time; you can **stop** it any time (taskkill the whole process tree on Windows).
- Completed output stays in the terminal box for easy review.

## Quick start

1. Make sure local `node` satisfies `^22.19.x` or `24.x`, and that `pnpm` and `git` are installed (see **Environment check**).
2. Double-click `start.bat` (or run `node server.js`); the window will open `http://127.0.0.1:8730` automatically.
3. In **Environment check**, configure the official remote for the Harness repo (or just hit **Fetch version list**); then **Build** once
   to ensure `apps/cli/lib/bin.js` and the web frontend artifacts exist.
4. Back in **Web**, click **Start dsh web** to open the dsh UI (the browser opens automatically).

> If clicking `start.bat` makes the window flash and disappear (instead of staying in the running state), startup
> failed &mdash; usually a port conflict or an unsatisfied node version. Press Ctrl+C / read the window error; the
> frontend and backend are unbuilt source, so editing `public/` takes effect on a page refresh.

## Security

- The server binds only to `127.0.0.1`; all commands are assembled from fixed internal commands plus strictly
  validated arguments to avoid injection.
- Console commands are restricted to the `dsh` prefix and passed as argv, never through a shell.
- `.gitignore` ignores `backups/` (real `~/.dsh` data), `logs/`, `config.json` (machine-specific paths), `.env`,
  keys and editor temp files; **do not `git add -f`** them.
- This is a local personal tool &mdash; be careful with restore / rollback / delete-backup actions; they all ask for
  confirmation by default.

## Development

This project is itself zero-dependency; changes take effect immediately:

```bash
cd d:\dsh\dsh_manager
node server.js       # start the admin UI, browser opens http://127.0.0.1:8730
```

- Backend: `server.js` (HTTP + REST + SSE + subprocess management + console exec), `doctor.js` (diagnostics & repair).
- Frontend: `public/index.html`, `public/app.js`, `public/style.css` (no build step; changes apply directly).
- This directory is an initialized git repository; commit as needed and keep `.gitignore` effective.

## FAQ

| Symptom | Handling |
| --- | --- |
| Port already in use | The manager auto-switches to the next port; dsh web port is `webPort` in **Settings** (0 = auto) |
| node version warning | Harness requires `node ^22.19.x` or `24.x`; lower versions cause build failures |
| Cannot fetch versions | Check GitHub connectivity and that the repo has the official remote configured |
| `start.bat` flashes out | Usually a port conflict or node version mismatch; check Ctrl+C / window error |
| "uncommitted changes" on upgrade/rollback | Harness working tree is dirty; it aborts and asks you to commit or restore first |
| Want to fully clear data | Manage `~/.dsh` via **Backup / Restore**; do not delete the source directory by hand |

## License &amp; credits

- This project is released under the **BSD-3-Clause** license (&copy; `NormalTable5801`, 2026);
  see the root [`LICENSE`](LICENSE) for the full terms.
- Its **Diagnostic Doctor** is ported from
  [`coppynight/dsh-doctor`](https://github.com/coppynight/dsh-doctor) (BSD-3-Clause, &copy; `dsh-external`).
  To satisfy clause 1 of BSD-3 for source redistribution, `doctor.js` names the source at the top and retains the
  **full original copyright notice, terms and disclaimer** at the end.
- Manages [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness.git).