# @inobit/pi-reader

[English](./README.md) | **中文**

Pi `fullscreen` 的 Vim 风格阅读模式：按 `alt+o` 进入只读并把 `transcript` 工具输出自动展开，`ctrl-u/d/f/b`、`gg/G`、`j/k` 翻页，退出后恢复 `emacs` 编辑与折叠。

- **单键切换 + 自动展开**：`alt+o`（`TUI inputListener` 拦截，可在 `extensions/pi-reader/config.json` 中改 `toggleKey`）→ `READING` 并自动展开工具输出；退出恢复折叠
- **零侵入编辑**：`INSERT` 态完全透传，`READING` 态才拦截；默认 `ctrl+u = deleteToLineStart` 零回归
- **精准复刻 Pi 滚动**：`half = viewportHeight/2`、`page = viewportHeight-1`（`OVERLAP=1`），与 `TuiAltScreen` 一致
- **高可靠事件路由**：按键走 `TUI inputListener` 拦截，阅读态吞键、`INSERT` 透传；`ctx` 在多会话事件中刷新，确保 `resume` 旧会话可用

## 安装

```bash
pi install npm:@inobit/pi-reader
```

本地调试：

```bash
pi --tui-mode fullscreen -e ./packages/pi-reader/src/index.ts
```

> 仅 `fullscreen` 可滚动；`regular` 下 `scrollBy` 无视口，扩展静默忽略。

## 按键表

| 作用                   | 按键                                        | 说明                                                                               |
| ---------------------- | ------------------------------------------- | ---------------------------------------------------------------------------------- |
| **进入/退出阅读**      | `alt+o` / `/reader` / `/scroll`（复按即退） | 默认 `alt+o`，`config.json` 中 `toggleKey` 可改（如 `ctrl+o`），`?` 弹窗显示生效键 |
| **退出**               | `esc` / `i` / `ctrl+c`                      | 阅读态 `esc`/`i`/`ctrl+c` 退（`ctrl+c` 不清屏），`i` 不落入输入                    |
| **帮助**               | `?`                                         | 仅 READING 可用，弹出英文快捷键说明，`esc` 关闭                                    |
| **半页上 / 下**        | `ctrl+u` / `ctrl+d`                         | `scrollBy(∓half)`；编辑态 `ctrl+u` 仍删行                                          |
| **整页下 / 上**        | `ctrl+f` / `ctrl+b`                         | `scrollBy(±page)`                                                                  |
| **行下 / 行上**        | `j` / `k` + `ctrl+n` / `ctrl+p`             | `scrollBy(±1)`                                                                     |
| **顶部**               | `g g`                                       | 300ms 内双 `g`（含同批连发的 `gg`）→ `scrollToTop()`                               |
| **底部**               | `G` (`shift+g`)                             | `scrollToBottom()`，跟随输出                                                       |
| **手动展开（编辑态）** | `alt+o`（`keybindings.json` 可改）          | 因 `ctrl+o` 被阅读占用，`app.tools.expand` 重绑到 `alt+o`                          |

## 配置

- 阅读切换：`extensions/pi-reader/config.json`（`config.json` 已 `gitignore`）
  ```json
  { "toggleKey": "alt+o" }
  ```
  默认 `alt+o`，与 `app.tools.expand` 错开；`?` 弹窗显示生效键
- 工具展开：`~/.pi/agent/keybindings.json`
  ```json
  { "app.tools.expand": "alt+o" }
  ```

## 行为

- **只读**：阅读态吞掉可打印键（`INSERT` 透传），输入栏隐藏为居左 `◉ Reading`（无边框，完全覆盖原位置），原输入保留，退出恢复
- **指示**：`?` 在 READING 弹出英文帮助（`Esc` 关闭，标题非全大写、主题字符边框居中）
- **恢复**：退出清理 `gg` 缓冲，恢复输入与工具折叠（工具展开/收起 异步，不阻塞首帧）

## 兼容与限制

- **键协议**：兼容传统控制符与 `Kitty` 协议
- 鼠标滚轮/触板、手选复制、`ctrl+shift+f` 搜索在 fullscreen 下仍透传

## 开发

```bash
pnpm --filter @inobit/pi-reader check
pnpm --filter @inobit/pi-reader test   # parseReadingKey/halfPage/pageStep/GgSequence
pnpm --filter @inobit/pi-reader pack:check
pi --tui-mode fullscreen -e ./packages/pi-reader/src/index.ts
```

## License

MIT
