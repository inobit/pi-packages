# Changelog

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
