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
/chill  enter chill mode (relaxed tier: only critical operations ask, sensitive files still denied, status bar shows Chill)
/yolo   enter yolo mode (allows everything except sensitive files, requires second confirmation, status bar shows Yolo)
/readonly-tools   manage read-only tools for plan mode (multi-select with Space, session/project/global scopes)
```

- Defaults to build mode, session-scoped and non-persistent (resets to `defaultMode` on restart). `yolo` requires a second confirmation `y: confirm yolo` with no shortcut; `/chill` needs no second confirmation.
- **Toggle shortcut**: `Alt+P` cycles plan → build → chill → plan (remappable via `toggleModeShortcut`, empty string to disable; key format follows Pi [keybindings](https://pi.dev/docs/keybindings))
- Status bar: `Plan` green / `Build` accent / `Chill` warning / `Yolo` error (theme-aware), status key `pi-permission-mode`

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

### Chill mode

Chill (*relaxed*) sits between `build` and `yolo`: it drops the trust-domain and unverifiable-execution checks but keeps two gates — the **critical** operation list (always `ask`) and **sensitive files** (deny by default). Unparseable syntax, missing variables and over-nested wrapping are allowed. Chill allows are recorded to the debug log only.

```
sensitive file involved                                          -> deny (FR-1; ask when chillSensitiveAction=ask)
critical hit (list, fixed rule, or static literal payload)       -> ask  (FR-4)
everything else (danger overlay, cross-domain refs, wrappers,    -> allow (FR-5)
  X programs, unparseable, unknown)
```

The critical set is the host-level, hard-to-reverse slice of the dangerous predicate set (`critical ⟹ dangerous`), so **every critical command asks in `build` and `deny`s in `plan` too**. Chill's ask scope is a narrowed subset of that set — `rm`/`Remove-Item` only ask when recursion (`-r`/`-R`/`--recursive`) targets one of the blacklisted paths enumerated below or a wildcard target, and `chmod` only on the numeric `0?777` token. Full default contents of what chill asks for:

```
Bash   rm -r/-R/--recursive on a blacklisted path or with a wildcard target, chmod 777/0777/7777,
       dd, mkfs*, fdisk, gdisk, parted, wipefs, shutdown, reboot, halt, poweroff, init, pipe-to-shell
PS     Format-Volume, diskpart, Remove-Computer, Restart-Computer, Stop-Computer, Clear-Eventlog,
       Remove-Item -Recurse on a blacklisted path or with a wildcard target,
       iex/Invoke-Expression, icm/Invoke-Command, nested pwsh/powershell
Shared interpreter -c/-e literal payload hitting a critical predicate (rm -rf /, dd, shutdown, ...)
```

Both `rm`/`Remove-Item` blacklists in full — nothing outside them is blacklisted:

- **Bash, POSIX (15 entries + the `~`/`$HOME` literal forms)**: Linux `/` `/bin` `/sbin` `/lib` `/lib64` `/usr` `/etc` `/boot` `/opt` `/root` `/home`, plus the macOS counterparts `/Users` `/System` `/Library` `/Applications`, plus `~`, `~user`, `$HOME`, `${HOME}` (`~`/`$HOME` expand into `/home/<user>`, `/root` or — on macOS — `/Users/<user>` via `os.homedir()`; `~user` cannot be expanded, so every `~` prefix is blocked). `/usr/local` and `/opt/homebrew` need no separate entry (already covered by the `/usr` and `/opt` prefixes). `/var` `/srv` `/dev` `/proc` `/sys` `/tmp` `/mnt` are deliberately not listed, and neither is `/private` (the symlink host of `/etc` `/tmp` `/var`, so listing it would block `/private/tmp`) or `/Volumes` (mounted volumes, same stance as `/mnt`). Matching is case-sensitive (POSIX semantics) after normalization (`~`/`$HOME` expanded, `//` collapsed, trailing `/` dropped): a hit is equality with an entry or the `<entry>/` prefix; `/` matches the exact root only.
- **Bash, Windows-shaped targets (git-bash: drive letter, backslash or `$env:` form)**: the drive root of any drive (`X:\` exact root only — `X:\Users` does not count), the Windows directory (`$env:SystemRoot` expanded, `System32` included, `SystemRoot` preferred over the `C:\Windows` fallback), the user home (`os.homedir()`, `$env:USERPROFILE` / `$env:HOMEPATH`, `~` expansion). Matching is case-insensitive with `\` and `/` unified, `//` collapsed and trailing separators dropped.
- **PowerShell (`Remove-Item`)**: the same three Windows counterparts — drive root of any drive, `$env:SystemRoot` (default `C:\Windows`), the current user home (`~`/`$HOME`/`$env:USERPROFILE`/`$env:HOMEPATH`, falling back to `os.homedir()`).

Known trade-off: **chill does not stop recursive `chmod`/`chown` on system paths** — `chown -R alice /home`, `chmod -R 755 /etc` and `Remove-Item -Recurse C:\tmp` are allowed (they stay `danger`, so they still ask in `build` and are denied in `plan`). `chmod 644 report777.md` is also unaffected: the numeric rule matches whole `0?777` tokens only.

`dangerousBashCommands`/`dangerousPowerShellCommands` remain fully configurable (union across layers). `criticalBashCommands`/`criticalPowerShellCommands` are likewise configurable additions; their defaults are subsets of the dangerous defaults, so on a default install this release changes `chill` behavior only (plus the two shared fixed rules below) — existing `plan`/`build`/`yolo` semantics are untouched. Static payload expansion for chill stops at 2 levels and never unwraps script files, encoded payloads or dynamic values.

### Behavior change in build (shared fixed rules)

Two predicates are now critical in **all** modes, so `build` asks (and `plan` denies) where it previously allowed:

- bare `chmod 777 <file>` / `chmod 0777` — numeric `0?777` only; symbolic forms (`a+rwx`, `u=rwx,go=rwx`) and `chmod 644` are unaffected
- interpreter literal payload hitting a critical command: `python3 -c "os.system('rm -rf /')"`, `node -e "require('child_process').exec('dd if=/dev/zero of=/dev/sda')"` — obfuscated, base64-encoded, concatenated and script-file forms keep the previous X handling


## Threat Model & Residual Risks (must read)

- Allowing executors inside the build trust domain = accepting the full capability of arbitrary code execution there. Script content can silently cross trust domains (write `~/.ssh`, network) — the permission system sees the command surface, not code behavior. **This extension is an in-process rule layer, not a sandbox**; use containers/disposable environments for real isolation
- W-tier safety equals target-enumeration correctness; unparseable syntax conservatively downgrades to X, but enumeration bugs themselves become mis-allows
- TOCTOU/symlink races are mitigated, not eliminated; `/tmp` is world-writable on multi-user machines
- Plan mode has no executor exemption mechanism: X segments always ask (silent deny under strict), keeping the read-only contract intact
- **Chill is a convenience tier, not a safety tier**: it allows arbitrary code execution (interpreters, build tools) and unparseable commands inside the session, exactly like build's trust domain — the only difference is it stops asking. Chill approvals are mode-scoped (`dangerous:<mode>:...`), so a chill approval never waives the same program in build
- Under the PowerShell tool the POSIX-shaped `rm -rf /` (and `& "rm -rf /"`) normalizes to `remove-item` with the POSIX `/` path, which is not a drive-letter root, so it misses the remove-item blacklist and chill allows it; the bash tool is unaffected (`rm -rf /` still asks)
- Interpreter literal payloads are matched with the **wide** critical predicate (the same one build/plan use), not the narrowed chill blacklist: `python3 -c "os.system('rm -rf ./dist')"` still asks in chill while the equivalent top-level `rm -rf ./dist` is allowed — interpreter literals stay conservative (one extra prompt over a hole)
- `cmd /c "…"` payloads are not unwrapped as interpreter literals: `cmd /c "rm -rf /"` is allowed in chill (build still asks via wrapper danger FR-10). Under the PowerShell tool `bash -c "…"` is not treated as a wrapper either, so chill **and** build both allow it; the bash tool's `bash -c` keeps its wrapper marking and is unaffected
- `mkfs*` is matched by a fixed **prefix rule** (any `mkfs.<fs>` form), so it cannot be removed by editing `criticalBashCommands`; conversely, entries you *add* to `criticalBashCommands` participate in the union but are not covered by that fixed rule
- The `chmod` numeric rule matches the literal numeric token `777`/`0777`/`7777` only, in any argument position — it does not inspect effective permission bits (`chmod 40777`, `chmod a+rwx` and equivalent umask games are not critical)
- Interpreter literal payload detection is a regex over the `-c`/`-e` string; obfuscated, base64-encoded, hex-escaped or concatenated payloads are out of scope (chill allows them), and an argument list form such as `python3 -c "subprocess.run(['rm','-rf','/'])"` is not matched either. A dangerous command merely **mentioned inside a string literal** also matches (`python3 -c "print('rm -rf /')"` asks) — it is a shallow net, not a static analyzer

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
| `criticalBashCommands` | **Critical** severity list — one level above dangerous; used by chill (always ask) and by the effective dangerous union in all modes | `dd` `mkfs` `fdisk` `gdisk` `parted` `wipefs` `shutdown` `reboot` `halt` `poweroff` `init` |
| `readonlyPowerShellCommands` | PowerShell read allowlist (canonical cmdlet names, aliases normalized before matching) | Read-only cmdlets (`get-childitem`/`get-content`/`select-string`/...) |
| `dangerousPowerShellCommands` | PowerShell dangerous operation list | `start-process` / `add-type` / `register-scheduledtask` / ... |
| `criticalPowerShellCommands` | PowerShell **critical** severity list | `format-volume` `diskpart` `remove-computer` `restart-computer` `stop-computer` `clear-eventlog` |
| `chillSensitiveAction` | Chill mode: sensitive files `deny` (default) or `ask` | `deny` |
| `defaultMode` | Mode on session start (`build`/`chill`; `plan`, `yolo` and invalid values fall back to `build`) | `build` |
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
> `chmod` numeric `0?777` and interpreter literal payloads hitting a critical command are always critical;
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
