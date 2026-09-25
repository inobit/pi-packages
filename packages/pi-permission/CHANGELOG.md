# Changelog

## [1.1.2] - 2026-09-24

### Added

- **L1 shell-nest gate (fewer popups for read-like commands)**: `$(...)`/backticks/`(...)`/`<(...)` and static `bash -c "..."` are now recursively judged in bash mode — if every inner segment proves read-only with no danger/`cd`/sensitive hits, the fail-closed verdict is cleared and the outer command continues through the normal chain (e.g. `OLD=$(ss -ltnp|cut)`, `(ss -t; ps aux) | head`). Anything else (W/X/danger/parse-error/sensitive/nested syntax/`cd` inside) falls back to the existing FR-7 fail-closed; PowerShell keeps fail-closed. Includes `$(`-preserving top-level split, paren-depth-aware `&&` splitting, and an unbalanced-span guard.
- **Worktree-aware project domain**: new `additionalProjectRoots` config (union merge) plus automatic git-root detection (`findGitRoot`, fs-only, cached) — references under any project root count as in-domain, mirroring OpenCode's startup-dir ∪ worktree semantics. Roots are in-domain, not trusted: plan-mode writes there are still denied.
- **`$HOME`/`${HOME}` expansion** in path handling (same rights as `~`), closing a blind spot in domain and sensitive-file judgments.
- **curl/wget effect classification**: pure GET (and `--spider`) is read-only; send signals (`-d/--data*/-F/--form*/-T/--upload-file`, non-GET `-X/--request`, `-K/--config`) stay X-danger; output options (`-o/--output/-O`, `-D/--dump-header`, `-c/--cookie-jar`, `--trace*`, `--output-dir`, wget `-O/--output-document/-o/-P/-a`) feed enumerated write targets with short-option bundling, unknown-option and missing-value fail-closed; file-valued metadata (`-E/--cert/--key/--cacert`, filename-form `-b/--cookie`) still participates in sensitive scanning.
- **20 more provable readers** in `readonlyBashCommands` (`test`/`[`/`true`/`false`, `basename`/`dirname`/`readlink`/`realpath`, `seq`/`nproc`/`tty`/`logname`/`groups`/`printenv`/`locale`/`getconf`, `tput`/`jobs`/`yes`/`cal`).

### Changed

- **`rm` danger overlay narrowed to recursion/glob**: only `-r`/`-R`/`--recursive` or wildcard targets trigger the overlay (`rm -R` newly covered); `rm -f`/`--force` with literal targets follows the normal bounded-write chain (in-domain allow in build, FR-3 ask outside, deny in plan). `Remove-Item` mirrored: bare `-Force` follows the normal chain, `-Recurse`/glob targets stay danger.
- **`--` is now honored** by write-target collection across all programs (`rm -- -rf` treats `-rf` as a filename).

## [1.1.1] - 2026-08-26

### Fixed

- **Windows host: in-project writes were wrongly gated as external (FR-3)**. `isWithinCwd`'s Windows-absolute early-out did not exclude the case where the cwd itself is a drive-letter path — on a Windows host, any project file written with forward-slash form (`D:/proj/startup.cmd` vs cwd `D:\proj`) was treated as out-of-domain and prompted. Now: when both target and cwd are Windows absolute paths, they are compared with normalized separators, case, and folded `./..` dot-segments; the always-external rule only applies when the host cwd is POSIX-style (WSL/CI). Cross-drive targets stay external. Same separator normalization applied to `isTrustedPath` prefix matching. Mixed pairs (relative target + drive-letter cwd) route through the platform-native resolution instead of the lexical branch.

## [1.1.0] - 2026-08-26

### Added

- **PowerShell tool support (fine-grained)**: the optional `powershell` tool added in pi 0.84.3 (Windows-only, opt-in via `defaultTools`/SDK) is now covered by the same R/W/X + danger-overlay decision pipeline as bash, instead of falling through to the tool-level path check where its `command`-only input silently hit FR-5 allow in build mode. Includes: alias normalization (`gci`/`rm`/`curl` → canonical cmdlets), read/write/dangerous cmdlet registries with named-parameter path extraction (`-Path`/`-LiteralPath`/`-Destination`…), fixed danger forms (`iex`, `icm`, `Set-ExecutionPolicy`, nested `pwsh`/`powershell`, call operator `&`, dot-sourcing, script blocks, `Remove-Item -Recurse/-Force`, `irm | iex` pipe-to-shell), `$()` subexpression / bare grouping / splatting / here-string fail-closed, and native exe fallback to the bash registries (git subcommand logic reused). New config keys `readonlyPowerShellCommands` and `dangerousPowerShellCommands` (same union merge semantics as the bash arrays).
- **Windows-style absolute paths are always outside the project domain** (`isWithinCwd`): drive-letter (`C:\...`) and UNC (`\\server\...`) paths no longer rely on platform path resolution — POSIX resolve used to treat them as relative and wrongly grant in-domain access when running off-Windows.

### Hardened (post-review)

- **C1**: `Push-Location`/`Pop-Location` are now tracked by segment cwd resolution — `Push-Location <dir>` switches the tracked cwd, no-arg push keeps it (stack-only), and `Pop-Location` marks subsequent relative paths as untrackable (conservatively treated as out-of-domain). Previously `Push-Location D:\outside; New-Item x` silently allowed an out-of-domain write in build mode.
- **M1**: single-letter short flags `-r`/`-f` on `Remove-Item` (incl. aliases `rm`/`ri`/`del`) now hit the fixed danger overlay, matching bash's `rm -r/-f` handling.
- **M2**: a standalone `&` after a completed statement splits segments (background-job marker), so `Get-Date & Remove-Item x` no longer hides the second statement inside the first segment's args; a leading `&` is still recognized as the call operator.
- **P2**: FR-10 session approval keys are tool-name-scoped (a powershell executor approval no longer pre-approves bash, and vice versa); braces inside quotes no longer trigger the script-block danger; `Rename-Item -NewName` participates in write-target collection; malformed non-string powershell input fails closed (ask) instead of falling through to allow; `expandHome` accepts `~\` form and sensitive-path matching gains backslash-normalized candidates.

## [1.0.2] - 2026-08-24

### Fixed

- Tests no longer leak temp dirs into the real home directory: the `outside` fixture in `test/path.test.ts` (symlink-escape regression case) was never cleaned up, leaving one `~/pi-permission-outside-*` dir behind on every test run; it is now removed together with `root` in a single `finally`. The `~/`-prefixed logDir case in `test/config-audit.test.ts` now wraps its write and assertions in `try/finally` so `~/pi-permission-test-tilde-*` is cleaned up even when assertions fail.

## [1.0.1] - 2026-08-22

Hardening patch after the issue #1 security review (all 6 flaws closed, see commits 00b2d50 / 57cc985).

### Fixed

- `find` write flags with an omitted start path now default to `.` (GNU find semantics, `find -name "*.tmp" -delete` is no longer missed as a pure read); start-path detection skips values of value-taking options (-name/-path/-newer etc.)
- `chmod/chown/chgrp --recursive` long form now hits the danger overlay (previously only short flags containing `R` matched)
- `sort --output=` / `--output FILE` long forms now produce write targets (same as `-o`)

### Hardened

- Launcher strip list extended with `exec`/`time`/`builtin` — `exec bash -c 'x'` hits the danger overlay, `time -p ls` resolves back to `ls`, `builtin eval ls` no longer borrows the read-only tier
- Options of `command`/`builtin` (e.g. `command -v`) are consumed and no longer pollute the real program name
- FR-10 approval keys are mode-scoped: an executor approved via `s` under build no longer leaks into the plan read-only contract

## [1.0.0] - 2026-08-22

### BREAKING (default behavior changes, read before upgrading)

- **Decision model reworked**: commands are classified by effect provability into R pure reader / W bounded writer / X opaque tiers plus a danger overlay, replacing the old read/unknown two-tier scheme; trust domains are formalized as T_plan = trustedExternalPaths and T_build = cwd ∪ trustedExternalPaths
- **Build no longer silently allows unknown commands**: commands with X segments (interpreters/build tools/unrecognized programs) and cross-domain references now ask (FR-10); everything inside the trust domain is still allowed
- **Plan mode**: writes to sensitive files inside the trusted zone changed from silent deny to ask (e.g. `echo x > /tmp/.env`); X segments always ask (silent deny under strictPlanMode) — no executor exemptions remain
- **tar reclassified from W to X**: extraction targets are determined by archive contents and cannot be enumerated (the old implementation wrongly enumerated command-line arguments); plan now asks instead of allowing
- **Unrecognized git subcommands reclassified from pseudo-read-only to X**
- `find -delete/-fls/-fprint*` merged into write-action detection (no separate toggle; roll back by checking out an older version)

### Added

- Launcher prefix stripping (env/nice/timeout N/nohup/setsid/stdbuf/command/VAR=x): `env rm -rf x` is classified as `rm` (root-cures the whitelist bypass); sudo is not stripped and is intercepted directly
- Fine-grained session approval memory: danger/X by program, sensitive by path, cross-domain writes by target parent directory (the old FR-4 key ignored the specific command — approving one dangerous command with `s` exempted every FR-4 for the whole session)
- Dialog hints shown once per rule per session; deny feedback is scenario-specific (token -29%) and passes through the self-contained decision reason
- Dialog command display: middle-ellipsis replaces the 120-char hard cut (cap ~400, head+tail preserved), chained commands rendered per segment (≤8 lines), home compressed to `~`
- `sensitivePatterns` adds `~/.config/gh/hosts.yml` (gh CLI credentials); reader registry adds sed/jq

### Changed

- Table order: plan ④ provable allow comes first with ⑤ X fallback last (symmetric with the build table); yolo branch semantics unchanged (sensitive still denied)
- Tool-side write/edit allows trusted-zone scratch writes under plan (same rights as bash `tee`), silently denies cross-domain writes

### Fixed

- Unrecognized git subcommands no longer treated as read-only (the old "not in list = read-only" was a pseudo-read-only hole)
- `sed` corrected from "all arguments are write targets" to writing only with `-i`


## [0.4.1] - 2026-08-21

### Fixed

- **Deny no longer terminates the task**: `denyFeedback` in `src/index.ts` now always uses `terminate:false` (including `FR-8 plan read-only` and the fallback, which were `true` and caused the model to miss the `reason` after an ask was rejected, requiring manual re-input). `r: deny with reason` is always `false` (text is fully replaced and returned to the LLM immediately; only `Esc` hard-terminate stays `true`). Fixes the bug where `FR-4` (`rm -rf` etc.) became unresponsive after typing progress info on `r`.

## [0.4.0] - 2026-08-21

### Added

- **Ask dialog (4 options)**: `y: allow once / s: allow session / n: deny / r: deny with reason` (`src/ui.ts: `ctx.ui.select` loop). `r` opens `ctx.ui.input` (emacs, title `Deny reason — emacs keys, Enter submit, Esc to go back`, placeholder `e.g. use .env.example instead`) with full replacement (`[pi-permission] User denied: <custom>`), empty input stays and notifies, `Esc` returns to select; `select Esc` hard-terminates (`deny + terminate:true`, `reason="[pi-permission] Denied by user — stopping."`, audit `terminatedByEsc`).
- **Hard terminate**: `select Esc` hard terminate (`audit.ts: ReviewEntry.terminatedByEsc`, `index.ts: terminate:true` regardless of rule, vs `FR-1/FR-7` default `false`).
- **Audit**: `ReviewEntry.customReason` with `capFieldWidths` truncation and redact awareness (152 tests passing, +7).

## [0.3.1] - 2026-08-20

### Fixed

- Sync `AGENTS.md` for `yolo` priority/module/status bar and deny routing docs; reuse `resolveSegmentCwds` cache in `decision.ts` yolo branch to avoid per-turn recomputation (145 tests passing).

## [0.3.0] - 2026-08-20

### Added

- **Yolo mode**: new `/yolo` command (`yolo` = fully permissive except sensitive files still blocked). Requires second confirmation `y: confirm yolo` in UI, no shortcut, session-scoped and non-persistent.
  - Decision: under `yolo`, sensitive files `FR-1` still `deny` (`terminate:false`, reuses `Sensitive file blocked` guidance from 0.2.7 without terminating the task), all other `FR-3/FR-4/FR-5/FR-7/FR-8/FR-9` and `fail-closed` are `allow rule:"yolo"` (including `$(...)`/subshell/`curl|sh` etc.).
  - Injection (Option B): `plan` injects `PLAN_SYSTEM_PROMPT` every turn; `yolo` injects `YOLO_SWITCH_NOTICE` (`Yolo on: prompts bypassed, sensitive files still blocked...`) only on entry, zero injection while resident; `build` has zero injection on first turn, both `plan->build` and `yolo->build` unify to `BUILD_SWITCH_NOTICE` (trimmed to `Plan mode off. Normal permission checks restored.`).
  - Status bar: `Yolo` orange `warning` (`Build` red / `Plan` green), key `pi-permission-mode`.
  - `ModeStore` treats `yolo` as same group as `build`, auto save/restore write tools on `plan<->yolo`.
- **Prompt trimming**: `PLAN_SYSTEM_PROMPT` trimmed to `You are in PLAN mode — read-only...`, `BUILD_SWITCH_NOTICE` trimmed to `Plan mode off...`, deny routing completed in 0.2.7.

## [0.2.7] - 2026-08-20

### Improved

- **Deny feedback routing**: `src/index.ts` `denyFeedback` changed from unified `Permission was/by user denied. Do not retry this operation.` (`terminate:true`) to rule-based routing, correctness first, brevity second:
  - `FR-1` sensitive file → `terminate:false`, `Sensitive file blocked: "${p}". Do not retry this file. Use .example, placeholders, or ask the user, and continue the task.` (guides to alternative path without terminating the task, reusable for yolo)
  - `FR-7` fail-closed (`rule===FR-7` or `reason` contains `fail-closed`) → `terminate:false`, `Command too complex to verify. Do not retry as-is. Split into single steps, avoid $(...), `( )`, and rewrite with simpler tool calls.` (guides to split complex reads)
  - `FR-8` plan read-only (`mode===plan` and `reason` contains `plan mode`) → `terminate:true`, `Plan is read-only — writes blocked. Gather info with read-only tools or ask to run /build.`
  - Fallback → `terminate:true`, `Permission denied (${rule}). Do not retry the same operation; try a simpler approach.`
- Update corresponding assertions in `test/index.test.ts` (`Do not retry` → `Plan is read-only` / `Permission denied` + `try a simpler approach`), all 137 tests passing.

## [0.2.6] - 2026-08-20

### Changed

- **More conventional log directory**: default log directory changed from `~/.pi/agent/extensions/pi-permission/logs/<project>/` to `~/.pi/agent/logs/pi-permission/<project>/` (more conventional, co-located with `pi-debug.log`, extension dir holds only `config.json`), `logDir` default changed from `"logs"` to `"logs/pi-permission"` (relative to `~/.pi/agent`), supports absolute paths and `~/` prefix.
- `config.ts` now exports `getAgentDir()` (aligned with pi core), global config and log root in `index.ts`/`loadConfig` both follow `PI_CODING_AGENT_DIR`; `audit.ts` adds `~/` expansion, absolute `logDir` overrides `base`.
- Update `config/default.json`, `README.md`, `AGENTS.md` and tests.

## [0.2.4] - 2026-08-19

### Fixed

- Fix off-by-one paren depth for `$()` command substitution: `splitTopLevel` `$` branch did `parenDepth++` then `(` branch did another `++`, while matching `)` only did `-1`, so any properly closed `$(...)` ended with depth 1 → false `parseError` → fail-closed always reported as "unparseable command syntax". Now `$(` skips both chars at once (depth +1 only), balanced `$(...)` returns to 0 and hits the "command substitution / subshell / complex syntax" branch (decision unchanged, still fail-closed: build=ask, plan=deny).
- Add regression tests: `$(...)` and nested `$(...)` no longer falsely report parseError; decision-layer reason assertions hit the complex syntax branch.

## [0.2.3] - 2026-08-19

### Added

- Trusted external path exemption (FR-9): new config `trustedExternalPaths` (default `["/tmp"]`, merged with `os.tmpdir()` at runtime); reads/writes under the prefix are auto-allowed (for temporary computation validation; normal users cannot delete entire /tmp: sticky 1777), merged via ARRAY_FIELDS as default ∪ global ∪ project union.
  - Plan mode: dangerous deny → non-exempt write deny (including sensitive file writes like /tmp/.env / .env) → sensitive file read ask → trusted read/write allow (FR-9) → read whitelist → other ask/deny
  - Build mode: sensitive ask → trusted exemption (allow if filtered externalRefs/externalTargets empty) → remaining external write ask → remaining external read whitelist/ask
  - Realpath dual-form + segment cwd resolution prevents symlink escapes; sensitive/dangerous checks always precede trusted exemption.

## [0.2.2] - 2026-08-19

### Added

- Fix model awareness after plan→build switch: `before_agent_start` records the mode at last agent start, and injects a one-time build notice on the first turn after plan→build (`Plan mode is now disabled. Full tool access is restored; you may modify files and run state-changing commands.`), explicitly lifting the plan read-only constraint to prevent the model from staying read-only; build mode has zero injection and no context accumulation (pattern follows @narumiruna/pi-plan-mode handoff notice).

## [0.2.1] - 2026-08-19

### Fixed

- Fix FR-3/FR-5 external path messaging ambiguity: original "not in read whitelist" was mistaken for a path whitelist (actual whitelist is only at command/tool level); now "`external path referenced by a non-whitelisted command/tool`", FR-5 clarified as "`read-only command/tool whitelist, external path allowed`".
- Unify trigger line for all ask dialogs: bash layer appends `bash:<command>` (single-line normalized + 120-char truncation, replaces `command: …` format) to the end of details for all asks (FR-1 sensitive / FR-3 external read-write / FR-4 dangerous / FR-7 fail-closed / FR-8.3 plan unknown), tool layer appends `tool:<tool_name>`; path details stay first, `s` session approval still remembered at path granularity.

## [0.2.0] - 2026-08-19

### Added

- Plan/build toggle shortcut: default `Alt+P` to cycle between read-only planning and normal mode (`registerShortcut`, does not occupy TUI input keys).
- New config `toggleModeShortcut` (global `config.json`): customizable shortcut or empty string to disable, format follows pi's built-in key bindings.

## [0.1.2] - 2026-08-19

### Fixed

- Side-effect-free redirects no longer misjudged as external writes: `2>/dev/null`, `&>/dev/null`, `2>&1`, `>&2`, `> /dev/null` and `tee /dev/null` etc. no longer trigger "writing outside project" confirmation (pure reads like `ls ... 2>/dev/null` previously showed a false popup listing `/dev/null`).
- Positional arg / input redirect `/dev/null` no longer treated as external read refs (`cat < /dev/null`, `tee /dev/null`).
- Real external writes (e.g. `> /tmp/x`, `2>~/err.log`) still intercepted via FR-3, behavior unchanged.
- Add redirect exemption unit tests and bash decision integration regression cases (all 117 tests passing).

## [0.1.1] - 2026-08-19

### Fixed

- Review log no longer written to project directory, moved to global extension directory `~/.pi/agent/extensions/pi-permission/logs/<project>/`, isolated per project.
- Align with pi ecosystem logging: debug/review dual streams, field width caps, size rotation, `extension`/`stream`/`sessionId` context.
- Add `debugLog` config (off by default), review log toggle remains `reviewLog`.

## [0.1.0] - 2026-08-18

### Added

- Lightweight permission control extension (`@inobit/pi-permission`), pi 0.84.2+, loaded via jiti without build.
- Sensitive file protection (FR-1): `.env`/`.ssh/*`/`*.pem` etc. ask on any channel read/write, realpath dual-form prevents symlink bypass, `.env.example` read exempted.
- Project boundary (FR-3): reads outside cwd go through read whitelist (allow if matched, otherwise ask), external writes ask.
- Dangerous operation confirmation (FR-4): unified `dangerousBashCommands` list (`git <subcommand>` + dangerous shell), wrappers/pipes always sensitive.
- Plan/build modes (FR-8): `/plan` `/build` commands, status bar (`Plan` green / `Build` red, theme-aware), system prompt injection, write tool hiding.
- `/readonly-tools` command: multi-select readonly tools with Space, session/global levels, locks built-ins and bash/write/edit.
- Custom simplified bash parser (quote-aware, redirects, git subcommands, wrappers, cd tracking, fail-closed).
- Review log (FR-6): JSONL 0600, sensitive key redaction.
- 106 vitest cases.

### Config

- `sensitivePatterns` / `envExampleReadAllowed` / `readonlyBashCommands` / `dangerousBashCommands` / `readonlyTools` / `strictPlanMode` / `reviewLog` / `logDir`
- Merge global `~/.pi/agent/extensions/pi-permission/config.json` and project `.pi/extensions/pi-permission/config.json`.
