# Changelog

## [0.1.0] - 2026-08-21

- feat: first release — hard branch revert with single-per-turn guard, queue-aware, abort-then-undo
  - Command `/undo` + shortcut `alt+u` share `doUndo` (hard revert via `navigateTree(parentId)`/`branch(parentId)`/`resetLeaf` for first message, recoverable via `/tree`); file side-effects not reverted; only errors notified in English
  - Queue-aware: `a sent + b,c queued` → `undo` pops `c` to editor once (mirror `steer|followUp`, cap 20); next undo goes to history; draft check atomic before abort
  - Abort-then-undo: `!isIdle` → `abort()` → `waitUntilIdle` (event + 3s timeout / poll) before revert; draft re-checked after wait
  - Single per turn: `canUndo` per `sessionId`, reset on `before_agent_start`, set false after undo, `session_start` clears mirror; pending mutex prevents concurrent double-undo
  - No config file, shortcut fixed to `alt+u`; no redo; editor has draft → "Editor has draft, clear it first" and do not overwrite
- test: history/config/undo state machine (extractText, findLastUserEntry, canUndo, mirror) + integration tests for `doUndo` (hasUI/draft/mirror/abort/hard revert/concurrency)
