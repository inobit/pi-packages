# Changelog

## [0.4.1] - 2026-08-21

### Fixed

- **Deny 不再终止任务**：`src/index.ts:denyFeedback` 全部改为 `terminate:false`（含 `FR-8 plan 只读` 与 `fallback`，原 `true` 导致 `ask` 拒绝后模型收不到 `reason` 需手动再输入）。`r: deny with reason` 恒为 `false`（完全替换文本后立即回传 `LLM`，仅 `Esc` 硬终止保持 `true`）。修复 `rm -rf` 等 `FR-4` 在 `r` 输入“现在告诉我你的进展”后无响应的 bug。

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
