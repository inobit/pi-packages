# Changelog

## [0.1.0] - 2026-08-19

- feat: 首个可用版本——核心工具与 UI（按评审结论落地）
  - `todo` 工具：create/update/list/get/delete/clear，状态机 pending → in_progress → completed，delete 置 tombstone 防 id 重用
  - 会话隔离：状态存 `Map<sessionId, TaskState>`；成功快照（瘦身，不含 description）写入 tool result `details`，`session_start`/`session_compact`/`session_tree` 从分支重放恢复
  - 编辑器上方面板 widget：`Todos (done/total)` + glyph 行 + activeForm 标签（completed 灰 + 删除线、不显示序号）；折叠快捷键 `ctrl+shift+t`；溢出优先丢 completed 再截断；完成项下轮自动隐藏；空列表自动卸载
  - `/todos` 命令：TUI 全屏分组列表（Pending/In Progress/Completed），非 TUI 环境给概要通知
  - 会话渲染目标简化方案（评审点 4）：session_start 渲染当前会话，todo 工具调用后切到最后调用会话
  - 提示词预算达标：snippet 47 chars、guidelines 3×≤140 chars、description 444 chars、schema 6 参数描述合计 229 chars
- test: 62 用例全覆盖（state/replay/schema/overlay/render/index）
- fix: `renderCall` 对 args 未完整（streaming 早期）做防御，折叠行不再出现 `todo undefined`（回归测试）
- fix: 完成项隐藏改为「按本轮 update→completed 的任务 id 揭示」，无关调用（create/list 等）不再点亮已完成行，消除跨轮假闪烁（`tool_execution_start` 记录参数配对）
- style: 展示层去掉 `#id` 数字序号；completed 行整行灰 + 标题删除线
