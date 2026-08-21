# @inobit/pi-undo

Pi 撤销扩展：把最近一次发送的输入撤回到输入框并从对话中移除，单次/轮，队列感知。

> 环境要求、catalog、常用命令、版本与发布（含 tag 规范）、文档分工等公共约定见仓库根 `AGENTS.md`，本文件只写本包目标、结构与包特有约束。

## 目标

- `/undo` + 快捷键 `alt+u` 同走 `doUndo`，有草稿时提示 `Editor has draft, clear it first` 且不覆盖
- 撤销效果：从对话中移除最近一次 `user` 轮并回填到输入框，`/tree` 可找回，文件副作用不回滚
- 队列感知：`a已发 + b,c队列` 时 `undo` 撤 `c`（镜像 tail 单次），第 2 次转历史
- 执行中原子：先判草稿再 `abort→waitForIdle→再判草稿→移除`

## 源码结构（src/）

| 文件 | 职责 |
|---|---|
| `src/index.ts` | 工厂装配：事件接线、canUndo 轮级锁、镜像队列、doUndo、注册命令/快捷键 |
| `src/history.ts` | 纯函数 `extractText` / `findLastUserEntry`（分支倒序找最近非空 user） |

依赖方向：`index → history`；`history` 不依赖 pi 运行时类型。

## 常用命令

```bash
pnpm --filter @inobit/pi-undo check   # tsc --noEmit
pnpm --filter @inobit/pi-undo test    # vitest（history/config/undo）
pnpm --filter @inobit/pi-undo pack:check
pi -e ./packages/pi-undo/src/index.ts # 冒烟：发一句后 /undo 回填，队列时 undo 撤尾，执行中先 abort
```

## 包特有约束（改动前必读）

- **单次/轮**：每轮仅可撤销一次，队列撤销也计一次，下次发送后重置
- **可找回**：仅回退对话分支，文件副作用不回滚，可经 `/tree` 找回
- **队列感知**：排队消息优先撤销队尾
- **使用约束**：无界面模式静默，有草稿不覆盖，执行中先中断再撤销
