# @inobit/pi-permission

**English** | [中文](./README.zh-CN.md)

Lightweight permission control for [Pi coding agent](https://pi.dev). Decisions are tiered by "effect provability" — only block what needs blocking:

1. **Sensitive file protection**: `.env`, `~/.ssh/*`, `*.pem`, `.npmrc`, `~/.config/gh/hosts.yml` etc. — any read or write (tool or bash) triggers a confirmation prompt.
2. **Trust domain boundary**: plan is read-only (out-of-domain writes silently denied); build trust domain = project dir ∪ trusted paths — everything inside is allowed, crossings are gated.
3. **Dangerous operation confirmation**: `git push` / `rm -rf`, `sudo`, `curl | sh` and the danger overlay always require confirmation; unverifiable execution (interpreters/unknown programs) asks in plan and is allowed inside the build domain.
4. **Plan / Build modes**: `/plan` is read-only (out-of-domain writes silently denied), `/build` returns to normal.

## Effect Classification Model (R/W/X)

Commands are classified by "can side effects be fully derived from the arguments" into three tiers, plus a danger overlay:

| Tier | Criterion | Examples |
| ---- | --------- | -------- |
| **R pure reader** | No file side effects | cat/grep/jq/git status/sort (no -o) |
| **W bounded writer** | Write targets fully enumerable from arguments | touch/mkdir/cp/mv/sed -i/redirects/find -delete |
| **X opaque** | Effects not derivable — interpreters, build tools, every unrecognized program, parse-failure downgrades | python3/npm/make/bash -c/tar extraction/patch |

The danger overlay (rm recursion/glob targets, chmod/chown -R, git write subcommands, curl\|sh, sudo, bash -c, xargs, find -exec) sits above the tiers and keeps the existing product contract.

## Features

- Zero third-party dependencies (besides Pi core packages), purely local deterministic decisions, fail-closed — never silently allows
- Precise read/write distinction down to path granularity; symlinks and relative paths cannot bypass, relative paths after `cd` are resolved correctly
- Sensitive file rules apply uniformly across all tools + bash
- Trust domain model: plan domain = trusted paths (e.g. `/tmp`, free scratch reads/writes); build domain = project ∪ trusted — everything inside is allowed including executors; dangerous/sensitive checks always take precedence
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

## Core Decision Paths

### Plan mode (read-only contract)

```
danger overlay hit (rm -rf / git push / sudo / curl|sh ...)   -> silent deny
enumerable write target outside trust domain T_plan           -> silent deny
(includes project files; plain args of X segments are refs only)
sensitive file involved (read or write)                        -> ask
all segments are R or W (W targets proven inside T_plan)       -> allow
fallback: any X segment (unverifiable effects)                 -> strict ? silent deny : ask
```

### Build mode

```
danger overlay hit                                             -> ask
sensitive file involved (read or write)                        -> ask
all refs & write targets of every segment inside T_build       -> allow (R/W/X alike)
   (T_build = cwd + trusted paths; python3 /tmp/x.py and npm test both allowed)
pure R (refs anywhere)                                         -> allow
otherwise (W/X with cross-domain refs)                         -> ask
```

Pre-layer: unparseable syntax / `$()` / subshell / process substitution -> fail-closed before the tables (build=ask, plan=deny). Yolo mode skips all checks except sensitive files (still denied). Ask dialogs pick `s` to approve per program/path/parent-dir for the session; hints show once per rule per session.

## Threat Model & Residual Risks (must read)

- Allowing executors inside the build trust domain = accepting the full capability of arbitrary code execution there. Script content can silently cross trust domains (write `~/.ssh`, network) — the permission system sees the command surface, not code behavior. **This extension is an in-process rule layer, not a sandbox**; use containers/disposable environments for real isolation
- W-tier safety equals target-enumeration correctness; unparseable syntax conservatively downgrades to X, but enumeration bugs themselves become mis-allows
- TOCTOU/symlink races are mitigated, not eliminated; `/tmp` is world-writable on multi-user machines
- Plan mode has no executor exemption mechanism: X segments always ask (silent deny under strict), keeping the read-only contract intact

## Configuration

Merged by layer (array fields are **union**-deduplicated across layers, non-array fields are overridden by higher layers):

| Layer | Location |
| -- | --- |
| Global | `~/.pi/agent/extensions/pi-permission/config.json` |
| Project | `.pi/extensions/pi-permission/config.json` (project must be trusted) |
| Session | In-memory (via `/readonly-tools` with session scope, lost on restart) |

| Field | Description | Default |
| -- | --- | --- |
| `sensitivePatterns` | Sensitive file glob list | `*.env` `*.env.*` `~/.ssh/*` `*.pem` `*.key` `id_rsa*` `credentials.json` `secrets*.yaml` `~/.aws/*` `.npmrc` `~/.config/gh/hosts.yml` |
| `envExampleReadAllowed` | Allow reading `.env.example` without prompt | `true` |
| `readonlyBashCommands` | Bash read allowlist | High-frequency read-only commands (cat/grep/ls/..., 92 entries) |
| `dangerousBashCommands` | Unified dangerous operation list (`sudo` or `git commit`) | Git write subcommands + dangerous shell |
| `readonlyPowerShellCommands` | PowerShell read allowlist (canonical cmdlet names, aliases normalized before matching) | Read-only cmdlets (`get-childitem`/`get-content`/`select-string`/...) |
| `dangerousPowerShellCommands` | PowerShell dangerous operation list | `start-process` / `add-type` / `register-scheduledtask` / ... |
| `trustedExternalPaths` | Trusted external path prefixes — reads/writes under these prefixes are auto-allowed (e.g. `/tmp` for temp files; `os.tmpdir()` is merged at runtime) | `["/tmp"]` |
| `additionalProjectRoots` | Extra project roots treated as in-domain (like OpenCode's startup dir ∪ worktree root); in-domain ≠ trusted — plan-mode writes here are still denied; auto-detected git root is always included | `[]` |
| `readonlyTools` | Tool read allowlist (union across layers) | `read grep find ls` |
| `strictPlanMode` | Plan mode: unverifiable execution (X segments) tightened from ask to silent deny | `false` |
| `toggleModeShortcut` | Plan/build toggle shortcut (empty string to disable) | `alt+p` |
| `reviewLog` | Review log toggle (FR-6) | `true` |
| `debugLog` | Debug log toggle (separate from review log, verbose events) | `false` |
| `logDir` | Log directory (relative to `~/.pi/agent`, respects `PI_CODING_AGENT_DIR`; supports absolute path and `~/`, 0600; extension dir holds only config) | `logs/pi-permission` |

> Fixed rules (not configurable): built-in write tools `write`/`edit`, `rm` recursion/glob targets, `chmod -R`, `chown -R`,
> `curl/wget | sh/bash`, `bash -c`/`eval`/`sudo`/`xargs`/`find -exec` are always treated as dangerous;
> redirect targets `>`/`>>` are always checked; git subcommands not in `dangerousBashCommands` are treated as read-only.
> Prompt reasons carry a `[bash]` / `[tool:<name>]` source prefix and include configuration hints.
>
> **PowerShell tool** (pi 0.84.3+, Windows, opt-in via `defaultTools: [... "powershell"]`): same R/W/X pipeline as bash.
> Aliases are normalized first (`gci`→`get-childitem`, `rm`→`remove-item`, `cat`→`get-content`, ...); native exes (git/node/npm)
> reuse the bash registries. Fixed PowerShell dangers (not configurable): `iex`/`Invoke-Expression`, `icm`/`Invoke-Command`,
> `Set-ExecutionPolicy`, nested `pwsh`/`powershell` invocations (incl. `-EncodedCommand`), call operator `&`, dot-sourcing,
> script blocks `{...}`, `Remove-Item -Recurse/-Force`, and pipe-to-shell (`irm|iex`). `$()` subexpressions, bare grouping,
> splatting and here-strings are fail-closed. Ambiguous names stay conservative: `curl`/`wget` are X (PS 5.1 alias vs PS 7 exe),
> `sc` is always treated as the service controller.
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
