# @inobit/pi-permission

**English** | [中文](./README.zh-CN.md)

Lightweight permission control for [Pi coding agent](https://pi.dev). Does only four things, everything else stays out of your way:

1. **Sensitive file protection**: `.env`, `.ssh/*`, `*.pem` etc. — any read or write (tool or bash) triggers a confirmation prompt.
2. **Project boundary**: reads outside the project (outside cwd) go through a read allowlist (allow if matched, otherwise ask); writes require confirmation.
3. **Dangerous operation confirmation**: `git push` / `git reset --hard`, `rm -rf`, `sudo`, `curl | sh` and similar always require confirmation.
4. **Plan / Build modes**: `/plan` is read-only (writes denied), `/build` returns to normal.

## Features

- Zero third-party dependencies (besides Pi core packages), purely local deterministic decisions, fail-closed — never silently allows
- Precise read/write distinction down to path granularity; symlinks and relative paths cannot bypass, relative paths after `cd` are resolved correctly
- Sensitive file rules apply uniformly across all tools + bash
- Trusted temp directory (`/tmp`) exemption: reads/writes under `/tmp` are auto-allowed in plan/build (friendly for validating computations with temp files during planning), dangerous/sensitive checks still take precedence
- Zero friction for high-frequency essentials (`cat` / `grep` / `ls` / `git status` / `sleep` etc.)

## Installation

```bash
pi install npm:@inobit/pi-permission
```

## Commands

```
/plan   enter read-only planning mode (writes denied, status bar shows Plan)
/build  return to normal mode (Build)
/yolo   enter yolo mode (allows everything except sensitive files, requires second confirmation, status bar shows Yolo)
/readonly-tools   manage read-only tools for plan mode (multi-select with Space, session/project/global scopes)
```

- Defaults to build mode, session-scoped and non-persistent (resets to build on restart). `yolo` requires a second confirmation `y: confirm yolo` with no shortcut.
- **Toggle shortcut**: `Alt+P` cycles between plan/build (remappable via `toggleModeShortcut`, empty string to disable; key format follows Pi [keybindings](https://pi.dev/docs/keybindings))
- Status bar: `Plan` green / `Build` red (theme-aware), status key `pi-permission-mode`

## Decision Priority (highest to lowest)

**Yolo mode**: sensitive file → deny (`terminate:false`, `Sensitive file blocked` — suggests using `.example`/placeholders); everything else → allow (`rule:"yolo"`, including `fail-closed` / `curl|sh` / dangerous operations)

**Plan mode** (regardless of cwd): dangerous operation → deny; non-exempt writes (target not under trusted, including sensitive file writes) → deny; sensitive file → ask; trusted paths (e.g. `/tmp`) read/write → allow; read allowlist → allow; everything else → ask (deny when `strictPlanMode` is on)

**Build mode**: dangerous operation ask → sensitive file ask → (inside cwd or all external refs under trusted → allow; outside-cwd read allowlist allow → otherwise ask)

## Configuration

Merged by layer (array fields are **union**-deduplicated across layers, non-array fields are overridden by higher layers):

| Layer | Location |
| -- | --- |
| Global | `~/.pi/agent/extensions/pi-permission/config.json` |
| Project | `.pi/extensions/pi-permission/config.json` (project must be trusted) |
| Session | In-memory (via `/readonly-tools` with session scope, lost on restart) |

| Field | Description | Default |
| -- | --- | --- |
| `sensitivePatterns` | Sensitive file glob list | `*.env` `*.env.*` `~/.ssh/*` `*.pem` `*.key` `id_rsa*` `credentials.json` `secrets*.yaml` `~/.aws/*` `.npmrc` |
| `envExampleReadAllowed` | Allow reading `.env.example` without prompt | `true` |
| `readonlyBashCommands` | Bash read allowlist | High-frequency read-only commands (cat/grep/ls/..., ~70 entries) |
| `dangerousBashCommands` | Unified dangerous operation list (`sudo` or `git commit`) | Git write subcommands + dangerous shell |
| `trustedExternalPaths` | Trusted external path prefixes — reads/writes under these prefixes are auto-allowed (e.g. `/tmp` for temp files; `os.tmpdir()` is merged at runtime) | `["/tmp"]` |
| `readonlyTools` | Tool read allowlist (union across layers) | `read grep find ls` |
| `strictPlanMode` | In plan mode, turn non-allowlist ask into deny | `false` |
| `toggleModeShortcut` | Plan/build toggle shortcut (empty string to disable) | `alt+p` |
| `reviewLog` | Review log toggle (FR-6) | `true` |
| `debugLog` | Debug log toggle (separate from review log, verbose events) | `false` |
| `logDir` | Log directory (relative to `~/.pi/agent`, respects `PI_CODING_AGENT_DIR`; supports absolute path and `~/`, 0600; extension dir holds only config) | `logs/pi-permission` |

> Fixed rules (not configurable): built-in write tools `write`/`edit`, `rm -r/-f`, `chmod -R`, `chown -R`,
> `curl/wget | sh/bash`, `bash -c`/`eval`/`sudo`/`xargs`/`find -exec` are always treated as dangerous;
> redirect targets `>`/`>>` are always checked; git subcommands not in `dangerousBashCommands` are treated as read-only.
> Prompt reasons carry a `[bash]` / `[tool:<name>]` source prefix and include configuration hints.
>
> **Log location**: defaults to `~/.pi/agent/logs/pi-permission/<project>/pi-permission-{review,debug}.jsonl` (co-located with `pi-debug.log`), isolated per project, files `0600`, dirs `0700`, with size-based rotation. The extension directory `~/.pi/agent/extensions/pi-permission` holds only `config.json`. Custom paths support absolute and `~/` forms, e.g. `"logDir": "~/my-logs/pi-permission"` or `"/var/log/pi-permission"`.
>
> **Trusted exemption boundary**: only the "directory boundary" is exempted, always after dangerous/sensitive checks — even inside a trusted directory,
> writes matching a sensitive filename (e.g. `/tmp/.env`, or writing `.env` while cwd is `/tmp`) are still deny in plan and ask in build;
> dangerous commands (`sudo rm -rf /tmp` etc.) are path-independent and always intercepted before trusted checks; dual-form realpath guards against symlink escapes.

## Ask Dialog

`ask` (= confirmation required) shows a 4-option selector + optional emacs input. All denies are `terminate:false` so the model immediately sees the `reason` and continues; only `Esc` hard terminate forces `true`.

| Key | Action | terminate | Audit |
| --- | --- | --- | --- |
| `y` | allow once | — | `allow-after-ask` |
| `s` | allow session (remembered as `<session>:<approvalKey>`) | — | `allow-after-ask` + `sessionApprovals` |
| `n` | deny (default) | `false` (model continues) | `deny` |
| `r` | deny with reason → emacs input | `false` (fully replaces `denyFeedback` text, model continues) | `deny` + `customReason` (truncated, redacted) |
| `Esc` (on select) | hard terminate — deny and stop | `true` (force) | `deny` + `terminatedByEsc` (`reason="[pi-permission] Denied by user — stopping."`) |

**`r` second layer** (`ctx.ui.input`, inherits `tui.input.*` emacs keys `C-a/e/k/u/f/b`): title `Deny reason — emacs keys, Enter submit, Esc to go back`, placeholder `e.g. use .env.example instead`. Empty (`trim()===""`) notifies `reason cannot be empty` and stays; `Esc` (`input===undefined`) returns to the 4-option select; `Enter` non-empty returns `{kind:"reason", customReason}` fully replacing the default reason as `[pi-permission] User denied: <custom>`. No UI (`rpc`/`print`) degrades to `notify` + `deny` with default.

```
ask → select [y/s/n/r]
  ├─ y/s → allow (+ s remembered)
  ├─ n   → deny (default, terminate:false → model continues)
  ├─ r   → input (emacs)
  │        ├─ non-empty Enter → deny with reason (fully replaces, terminate:false)
  │        ├─ empty Enter     → stay (notify)
  │        └─ Esc             → back to select
  └─ Esc  → deny + hard terminate (force true)
```

## /readonly-tools Interaction

`Space` to select/deselect, `↑`/`↓`/`j`/`k` to move, `Enter` to confirm, `Esc`/`q` to cancel. Pick the edit target first (**each layer edits only itself, other layers are locked**):

- **session** (in-memory, session-scoped): built-in + global + project-configured tools are locked
- **project** (writes to `.pi/extensions/pi-permission/config.json`): built-in + global-configured are locked, project must be trusted
- **global** (writes to global config.json): only built-in tools are locked

Built-in tools (`read`/`grep`/`find`/`ls`), `bash`, and `write`/`edit` are always locked.

## Status Bar Integration

- **Pi built-in statusline**: `Plan`/`Build` appears in the footer extension status row, no configuration needed.
- **pi-powerline-footer**: status value without `[` prefix, goes into the `extension_statuses` aggregated segment; to place it at the leftmost of the main bar:

```json
{
  "powerline": {
    "preset": "default",
    "placement": "below",
    "customItems": [
      { "id": "pi-mode", "statusKey": "pi-permission-mode", "position": "left", "excludeFromExtensionStatuses": true }
    ],
    "layout": { "left": ["custom:pi-mode", "model", "thinking", "shell_mode", "path", "git", "queue", "context_pct", "cache_read", "cost"] }
  }
}
```

## Development

```bash
pnpm --filter @inobit/pi-permission check   # tsc --noEmit
pnpm --filter @inobit/pi-permission test    # vitest
pnpm --filter @inobit/pi-permission pack:check
pi -ne -e ./packages/pi-permission
```

## License

MIT
