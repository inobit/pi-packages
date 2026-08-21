# @inobit/pi-todo

Pi coding agent 的最小侵入任务清单扩展。

> 环境要求、catalog、常用命令、版本与发布（含 tag 规范）、文档分工等公共约定见仓库根目录 `AGENTS.md`，本文件只写本包的目标、结构与包特有约束。

## 目标

- `todo` 工具：模型可 create/update/list/get/delete/clear 任务，`pending → in_progress → completed` 状态机推进
- `/todos` 命令：当前会话全部任务的分组列表（TUI 全屏，Escape 关闭）
- 编辑器上方面板（widget）：`Todos (done/total)` 标题 + glyph 行 + activeForm 标签，折叠（`ctrl+shift+t`）、溢出截断、完成项下轮自动隐藏
- 状态存会话分支：成功快照写入 tool result `details`，`session_start`/`session_compact`/`session_tree` 重放恢复

## 源码结构（src/）

| 文件         | 职责                                                                       |
| ------------ | -------------------------------------------------------------------------- |
| `index.ts`   | 工厂装配：注册工具/命令、事件接线、widget 生命周期                         |
| `todo.ts`    | `registerTodoTool` + `registerTodosCommand`（文案常量集中，评审/调参入口） |
| `schema.ts`  | TypeBox 参数 schema（6 参数，description 即 prompt copy）                  |
| `state.ts`   | Task/TaskState 类型 + 纯函数 reducer（迁移校验、id 分配）；不依赖 pi 类型  |
| `store.ts`   | `Map<sid, TaskState>` 会话隔离 + commit + `replayFromBranch`               |
| `overlay.ts` | 面板行构建（折叠/溢出/完成项隐藏）；纯函数                                 |
| `render.ts`  | renderCall/renderResult + 行格式工具（glyph、截断）                        |

依赖方向：`index → todo → {schema, state, store, overlay, render}`；状态模块不 import pi 运行时类型（结构类型注入，便于单测）。

## 包特有约束（改动前必读）

- **侵入性预算**：`promptSnippet` ≤ 60 chars、`promptGuidelines` ≤ 3 条且每条 ≤ 140 chars、`description` ≤ 600 chars、schema 参数 description 合计 ≤ 270 chars（每轮提示词总开销 ≤ ~1.1KB）；新增提示词文案先核算
- `promptGuidelines` 每条必须点名 `todo`（pi 要求 guideline 点名工具）
- 工具名 `todo` 是分支重放的持久化键（replay 按 `toolName === "todo"` 过滤），**不可改名**
- 状态只进 tool result `details`（分支重放），**不写磁盘**；快照瘦身为 `id/subject/status/activeForm`（description 易失，属方案代价）
- 会话隔离：状态存 `Map<sessionId, TaskState>`，子会话不得读写他人槽位
- `typebox` 与 `@earendil-works/pi-ai` 属 pi 官方捆绑核心包（运行时由 pi 提供），列为 `peerDependencies`（`typebox` 用 `*` 范围，不打包）
- 文案常量集中在 `src/todo.ts`；
