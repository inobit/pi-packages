# Changelog

## [0.2.1] - 2026-09-24

- feat: header left-click toggles collapse via `Component.handleMouse` (duck-typed, same mechanism as pi-subagents: left click on header row `y===0`, modifier clicks ignored); works on hosts with mouse dispatch (verified on pi 0.87.1), harmless no-op on older hosts; `alt+t` shortcut path unchanged

## [0.2.0] - 2026-09-24

- feat: panel budget rendering — hard cap `maxLines` (default 7, `+N more` overflow) + soft cleanup target `targetLines` (default 5, best-effort); unfinished always kept, completed newest-first; both configurable via `config.json` (requires `2 <= targetLines <= maxLines`)
- feat: 3s delayed cleanup of completed items — newly completed stays visible for a confirmation window, then trims to target oldest-first (previous rounds first); under-target lists persist across rounds (no more blanket per-round clear); render-layer only, replay contract untouched
- feat: collapse shortcut `alt+t` (keeps `ctrl+shift+t` as alias); collapsed panel is a single line `▸ Todos (done/total) ✓n ◐n ○n — alt+t to expand`, expanded title carries `▾`
- feat: guideline #2 rewritten to completion timing (123 chars, still within prompt budgets)
- fix: view state isolated per rendered session — switching sessions resets completion order/rounds/suppressed set, so colliding ids are no longer wrongly hidden or misordered across sessions; project-level config.json wired via `isProjectTrusted` (dual-session regression test included)

## [0.1.1] - 2026-08-22

- fix: create with a stray `id` param no longer crashes — `runAction` forwards the `changed` task returned by `applyTodoAction` instead of re-finding by id (regression test included)
- fix: release `tool_execution_start` arg records even when a todo call errors, so failed calls no longer leak Map entries
- fix: clamp snapshot `nextId` to `maxId + 1` on branch replay (hardening against tampered/corrupt session snapshots)
- fix: width-aware truncation in panel rows — CJK titles and activeForm are measured in display columns (subject compressed first, activeForm capped at 40 cols), so rows fold less on narrow terminals
- test: regression cases for all four fixes; prompt budgets unchanged

## [0.1.0] - 2026-08-19

- feat: first usable release — core tools and UI (as reviewed)
  - `todo` tool: create/update/list/get/delete/clear, state machine pending → in_progress → completed, delete via tombstone to prevent id reuse
  - Session isolation: state stored in `Map<sessionId, TaskState>`; slim snapshot (without description) written to tool result `details` on success, restored via replay from `session_start`/`session_compact`/`session_tree`
  - Editor-top panel widget: `Todos (done/total)` + glyph rows + activeForm label (completed grey + strikethrough, no index); collapse shortcut `ctrl+shift+t`; overflow drops completed first then truncates; completed hidden next turn; empty list auto-unmounts
  - `/todos` command: TUI fullscreen grouped list (Pending/In Progress/Completed), summary notification in non-TUI
  - Simplified session render target (review point 4): session_start renders current session, todo tool calls switch to the last calling session
  - Prompt budget met: snippet 47 chars, guidelines 3×≤140 chars, description 444 chars, schema 6 params 229 chars total
- test: 62 cases full coverage (state/replay/schema/overlay/render/index)
- fix: guard `renderCall` for incomplete args (early streaming), collapsed row no longer shows `todo undefined` (regression test)
- fix: hide completed now "reveal by task ids updated to completed in this turn", unrelated calls (create/list etc.) no longer flash finished rows, eliminating cross-turn flicker (`tool_execution_start` records param pairing)
- style: remove `#id` numeric prefix in display; completed rows grey + title strikethrough
