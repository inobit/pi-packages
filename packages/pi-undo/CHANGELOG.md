# Changelog

## [0.1.1] - 2026-08-22

- fix: undo 后 UI 未移除消息、进程内 LLM 上下文未移除（静默正确性缺陷）、resume 后被撤消息复活三个问题
  - 根因：`branch()/resetLeaf()` 仅移动内存 leaf 指针不落盘；进程内 context/UI 重建仅发生在宿主 `navigateTree` 内部；快捷键上下文缺少 `navigateTree` 等能力导致静默降级
  - 统一走 `navigateTree(userEntryId, { summarize: false })`：宿主对 user 目标自动特判 leaf=parentId（root 自动 resetLeaf），一条路径覆盖首条/非首条并自带 UI/context 重建；不再扩展侧特判首条
  - 撤销成功后追加哨兵条目 `pi-undo-pin`（`pi.appendEntry`）：把生效分支终点固定到磁盘，resume 按「文件末条」重建 leaf 时不再复活被撤消息；哨兵不进 LLM 上下文、TUI 不渲染
  - 显式处理导航结果：目标恰为当前 leaf 的 no-op 早退、`session_before_tree` 取消、leaf 未实际移动均视同失败——notify 提示、不回填编辑器、不消耗单次/轮、绝不落哨兵
- feat(breaking-ish): alt+u 改为委托 `/undo` 命令管道（`pi.sendUserMessage("/undo", { expandPromptTemplates: true })`），与手敲 /undo 同一执行路径，行为一致性由构造保证；原直接调 doUndo 的方式因宿主快捷键上下文缺少 session-control 能力而只能拿到精简 ctx
- fix: 无 `navigateTree` 能力的受限上下文下显式失败提示改用 /undo，删除静默降级到 `sessionManager.branch()` 的分支（旧降级只动内存指针，UI/context/磁盘三者均不更新）
- test: 重写 parentId→entryId、首条 resetLeaf 相关用例；新增端到端委托一致性、no-op 陷阱、导航取消/未移动、哨兵参数与失败不落哨兵、首条即 leaf 特例等用例
## [0.1.0] - 2026-08-21

- feat: first release — hard branch revert with single-per-turn guard, queue-aware, abort-then-undo
  - Command `/undo` + shortcut `alt+u` share `doUndo` (hard revert via `navigateTree(parentId)`/`branch(parentId)`/`resetLeaf` for first message, recoverable via `/tree`); file side-effects not reverted; only errors notified in English
  - Queue-aware: `a sent + b,c queued` → `undo` pops `c` to editor once (mirror `steer|followUp`, cap 20); next undo goes to history; draft check atomic before abort
  - Abort-then-undo: `!isIdle` → `abort()` → `waitUntilIdle` (event + 3s timeout / poll) before revert; draft re-checked after wait
  - Single per turn: `canUndo` per `sessionId`, reset on `before_agent_start`, set false after undo, `session_start` clears mirror; pending mutex prevents concurrent double-undo
  - Shortcut configurable via `~/.pi/agent/extensions/pi-undo/config.json` (`{"shortcut":"alt+u"}`), default `alt+u` (project override when trusted); no redo; editor has draft → "Editor has draft, clear it first" and do not overwrite
- test: history/config/undo state machine (extractText, findLastUserEntry, canUndo, mirror) + integration tests for `doUndo` (hasUI/draft/mirror/abort/hard revert/concurrency)
