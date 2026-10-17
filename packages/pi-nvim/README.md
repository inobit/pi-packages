# @inobit/pi-nvim

**English** | [中文](./README.zh-CN.md)

Reuse your Neovim LSP setup inside [Pi coding agent](https://pi.dev) sessions: `nvim_lsp` (read-only diagnostics) and `nvim_format` (write-back formatting), backed by a per-session headless nvim daemon.

- **Your editor's brain, on call**: diagnostics and formatting come from your own Neovim config (LSP servers, none-ls bridges) — no duplicate language tooling
- **Session-bound daemon**: lazy first-use spawn, zero per-call server churn, whole-session warmth; idle 5min stops clients, parent-death probe exits cleanly
- **Batch-first**: pass ALL touched files in ONE call; per-file five-state format results (`formatted` / `reason`), diagnostics returned in full, error text capped with `…(truncated N chars)` notes

## Requirements

- **Linux only for now.** The daemon relies on POSIX signals and Unix domain sockets (signal-0 liveness probes, `SIGTERM`/`SIGKILL`), and the socket path assumes `XDG_RUNTIME_DIR`. macOS is untested and at risk (no `XDG_RUNTIME_DIR`, so the `os.tmpdir()` fallback can push the socket path past the 104-byte limit); Windows is unsupported.
- A working `nvim` on `PATH` (or set `nvimPath` in config) with your LSP setup loadable headlessly.

## Installation

```bash
pi install npm:@inobit/pi-nvim
```

Restart the Pi session to take effect.

## Usage

The model calls two tools (both `executionMode: "sequential"`):

- `nvim_lsp({ files })` — read-only diagnostics over the given absolute paths. Never modifies files.
- `nvim_format({ files })` — formats with your Neovim formatters, writes back, and returns remaining diagnostics. MODIFIES files on disk.

Per-call timeout overrides:

Per-call timeouts: `nvim_lsp` accepts optional `startupMs` and `diagnosticMs`, `nvim_format` accepts `startupMs`; omitted → the config defaults above. Timeout failures name the knob and a suggested value (e.g. `retry with diagnosticMs=40000`), so a retry can simply pass the larger value — no config edit needed. Overrides are clamped to `maxRequestMs` (default 300s); the daemon request window grows to fit (`startup + diagnostic + 5s`), so a large ask never gets killed by the default 60s window. The bridge clamps the same fields again (120s each) as a defence against malformed requests.

Rules for the model (5 guidelines): nvim_lsp is read-only diagnostics; nvim_format writes back to disk; batch ALL files in ONE call; scope is allowlisted — out-of-scope files come back as per-file skipped.

Call guard: each `execute` pre-checks files (exists → is a file → readable text → per-tool whitelist) before touching the daemon. Missing/directory/unreadable/binary return per-file `error`; off-scope types (unknown included, fail-closed) return per-file `skipped` and are not executed. Fully intercepted batches never start the daemon. Set `whitelist.enabled: false` to disable only the whitelist gate (existence/readability pre-checks still apply).

## Configuration

Optional `config.json` (global `~/.pi/agent/extensions/pi-nvim/config.json`, or project `<cwd>/.pi/extensions/pi-nvim/config.json` when trusted):

```json
{
  "nvimPath": "nvim",
  "timeouts": { "spawnMs": 30000, "startupMs": 10000, "diagnosticMs": 20000, "pushObserveMs": 15000, "requestMs": 60000, "maxRequestMs": 300000, "pollMs": 50 },
  "idleMs": 300000,
  "parentPollMs": 15000,
  "errorCap": 2000,
  "whitelist": {
    "enabled": true,
    "diagnostics": { "extensions": ["ts", "tsx", "js", "lua", "py", "md"], "filenames": ["Dockerfile"] },
    "format": { "extensions": ["ts", "tsx", "js", "lua", "py"], "filenames": [] }
  }
}
```

Invalid entries fall back to defaults. `sockDir` overrides the socket parent dir (default `XDG_RUNTIME_DIR`, falling back to `os.tmpdir()`).

## Development

```bash
pnpm --filter @inobit/pi-nvim check   # tsc --noEmit
pnpm --filter @inobit/pi-nvim test    # vitest
pnpm --filter @inobit/pi-nvim pack:check
pi -ne -e ./packages/pi-nvim
```

Daemon live behavior (spawn/probe/polling) is covered by smoke tests, not unit tests; pure logic (full diagnostics, socket paths, Vim escaping, five-state derivation, error cap, startup health) is unit-tested.

## License

MIT
