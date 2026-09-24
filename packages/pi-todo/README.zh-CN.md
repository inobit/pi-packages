# @inobit/pi-todo

[English](./README.md) | **中文**

Pi coding agent 的最小侵入任务清单扩展：`todo` 工具 + `/todos` 命令 + 编辑器上方常驻面板。

- **低提示词侵入**：`promptGuidelines` 仅 3 条、`description` 决策树式精简、schema 仅 6 核心参数，每轮提示词开销约 1.1KB
- **状态存会话分支**：每次工具调用把瘦身快照（`id/subject/status/activeForm`）写入 tool result `details`，`/reload`、上下文压缩、分支切换后自动恢复，零磁盘写入
- **会话隔离**：状态按 session id 分区，子会话/并行会话互不污染

## 安装

```bash
pi install npm:@inobit/pi-todo
```

重启 Pi 会话生效。本地开发调试可软链到 `~/.pi/agent/extensions/pi-todo`（pi 读取包内 `pi.extensions` 声明的入口自动加载），改码后 `/reload` 生效。

## 使用

- 直接交代多步骤任务，agent 会调用 `todo` 工具规划并跟踪，面板实时更新：
  - `todo create <subject> [description]` 建任务
  - `todo update <id> <status> [activeForm]` 推进状态（`in_progress` / `completed`，可带进行时标签如 "writing tests"）
  - `todo list [status]` / `todo get <id>` / `todo delete <id>` / `todo clear`
- `/todos`：全屏分组列表（Pending / In Progress / Completed），Escape 关闭
- 面板折叠快捷键：`alt+t`（`ctrl+shift+t` 为兼容别名）；折叠后为带状态计数的单行
- 面板预算：最多显示 `maxLines` 行（默认 7），未完成任务必留；已完成任务在置完成 3s 后按 `targetLines`（默认 5）自动清理，先藏最旧

任务状态 `pending → in_progress → completed`，`completed` 仅由模型显式设置；删除走 tombstone 防 id 重用。

## 配置

可选 `config.json`（全局 `~/.pi/agent/extensions/pi-todo/config.json`，或 trusted 时项目 `<cwd>/.pi/extensions/pi-todo/config.json`）：

```json
{ "maxLines": 7, "targetLines": 5 }
```

要求 `2 <= targetLines <= maxLines`，非法值回退默认；`targetLines` 超过 `maxLines` 时钳制到 `maxLines`。

## 开发

```bash
pnpm --filter @inobit/pi-todo check   # tsc --noEmit
pnpm --filter @inobit/pi-todo test    # vitest
pnpm --filter @inobit/pi-todo pack:check
pi -ne -e ./packages/pi-todo
```
