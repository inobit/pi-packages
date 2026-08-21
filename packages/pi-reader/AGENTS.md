# @inobit/pi-reader

> 环境要求、catalog、常用命令、版本与发布（含 tag 规范）、文档分工等公共约定见仓库根 `AGENTS.md`，本文件只写本包目标、结构与包特有约束。

## 目标

- 阅读模式：`alt+o`（`config.json: toggleKey` 可改）经 `TUI inputListener` 拦截进/出 `READING`，`Promise` 异步展开工具输出；`/reader`、`/scroll` 兜底
- Vim 翻页：`ctrl+u/d` 半页、`ctrl+f/b` 整页、`j/k`/`ctrl+n/p` 行、`g g` 顶部（300ms，含同批 `gg`）、`G` 底部
- 指示：`ReadonlyEditor` 左显 `◉ Reading` 覆盖原输入（无边框），原输入保留；`?` 弹窗英文帮助 `Esc` 关闭

## 架构（改动前必读）

按键主通道 `TUI inputListener` + `ctx.ui.onTerminalInput` 双通道（后者确保 `reload`/`resume` 后仍生效），`INSERT` 透传：

- **事件**：`listenerInstalled` 防重；`currentCtx` 在全量会话事件刷新；`latestTui` 缓存用于滚动
- **禁抢 `tui.altScreen.*`**：`TUI` 层摘要先 consume
- **stale ctx**：仅 `.ui` 访问异常置 `ctxBroken`；输入保留 `savedInput`；工具展开 `Promise` 异步
- `ScrollReaderEditor` 必须传**真实 theme/keybindings** 构造（空对象会让 `Editor.render` 的 `borderColor()` 崩）

## 源码结构（src/）

| 文件           | 职责                                                                                                                                                                                                                                                                                                |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/index.ts` | 纯逻辑导出 `parseReadingKey`/`halfPage`/`pageStep`/`GgSequence`；`ScrollReaderEditor`/`ReadonlyEditor`（左显 `◉ Reading`）；`factory` + `onTerminalInput` 双通道；`applyReaderUI` 隐藏输入（保留原输入）+ `Promise` 异步工具；`?` 帮助（`custom` overlay）；`getActiveToggleLabel` 读 `config.json` |

依赖方向：`index.ts → {CustomEditor, ExtensionAPI, ExtensionContext} from pi-coding-agent` + `{Key, matchesKey, truncateToWidth, type TUI} from pi-tui`；无本地子模块。

## 包特有约束（改动前必读）

- **不注册 `pi.registerShortcut`**：阅读切换走 `inputListener`/`onTerminalInput`，避免与 `app.tools.expand` 冲突报 warning
- **切换键**：默认 `alt+o`，`config.json: {"toggleKey":"alt+o"}` 可改；仅生效配置的那个，`?` 弹窗显示生效键
- `parseReadingKey` 兼容传统控制符与 Kitty 协议
- `gg` 用 `GgSequence(300)`（含 `gg` 同批 `gg` 合并处理）
- 阅读态吞掉可打印/单字节；退出键 `esc`/`i`/`ctrl+c`（`i` 仅退阅读，不落入输入），`?` 仅 READING 且 `Esc` 关闭
- `viewportHeight` 取 `getPrimaryScrollView?.().viewportHeight ?? 20`，`try/catch`；`scrollBy` 已 `clamp`
- 状态放闭包 `isReading`/`savedInput`，不写 `appendEntry`
