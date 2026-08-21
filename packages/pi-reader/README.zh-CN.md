# @inobit/pi-reader

[English](./README.md) | **中文**

Pi `fullscreen` 的 Vim 风格阅读模式：按 `alt+o` 进入只读并把 `transcript` 工具输出自动展开，`ctrl-u/d/f/b`、`gg/G`、`j/k` 翻页，新增 `[q/a/t` 语义跳、`{}` 段落、`/·n/N` 搜索，退出后恢复 `emacs` 编辑与折叠。

- **单键切换 + 自动展开**：`alt+o`（`TUI inputListener` 拦截，可在 `extensions/pi-reader/config.json` 中改 `toggleKey`）→ `READING` 并自动展开工具输出；退出恢复折叠
- **零侵入编辑**：`INSERT` 态完全透传，`READING` 态才拦截；默认 `ctrl+u = deleteToLineStart` 零回归
- **精准复刻 Pi 滚动**：`half = viewportHeight/2`、`page = viewportHeight-1`（`OVERLAP=1`），与 `TuiAltScreen` 一致
- **语义导航**：`[q/]q` 问题、`[a/]a` 回答、`[t/]t` 工具、`{`/`}` 段落、`/·n/N` 搜索（`Enter` 后 `vim` 式 `n/N`）
- **高可靠事件路由**：按键走 `TUI inputListener` 拦截，阅读态吞键、`INSERT` 透传；`ctx` 在多会话事件中刷新，确保 `resume` 旧会话可用

## 安装

```bash
pi install npm:@inobit/pi-reader
```

本地调试（隔离，--no-extensions 屏蔽已安装旧版）：

```bash
pi -ne -e ./packages/pi-reader --tui-mode fullscreen
```

> 仅 `fullscreen` 可滚动；`regular` 下 `scrollBy` 无视口，扩展静默忽略。

## 按键表

| 作用                   | 按键                                        | 说明                                                                               |
| ---------------------- | ------------------------------------------- | ---------------------------------------------------------------------------------- |
| **进入/退出阅读**      | `alt+o` / `/reader` / `/scroll`（复按即退） | 默认 `alt+o`，`config.json` 中 `toggleKey` 可改（如 `ctrl+o`），`?` 弹窗显示生效键 |
| **退出**               | `esc` / `i` / `ctrl+c`                      | 阅读态 `esc`/`i`/`ctrl+c` 退（`ctrl+c` 不清屏），`i` 不落入输入                    |
| **帮助**               | `?`                                         | 仅 READING 可用，弹出英文快捷键说明，`esc` 关闭                                    |
| **半页上 / 下**        | `ctrl+u` / `ctrl+d`                         | `scrollBy(∓half)`；编辑态 `ctrl+u` 仍删行；支持 `count` 如 `3 ctrl+u`              |
| **整页下 / 上**        | `ctrl+f` / `ctrl+b`                         | `scrollBy(±page)`；支持 `count`                                                    |
| **行下 / 行上**        | `j` / `k` + `ctrl+n` / `ctrl+p`             | `scrollBy(±1)`；支持 `count` 如 `5j`                                               |
| **顶部**               | `g g`                                       | 300ms 内双 `g`（含同批连发的 `gg`）→ `scrollToTop()`                               |
| **底部**               | `G` (`shift+g`)                             | `scrollToBottom()`，跟随输出                                                       |
| **上/下个问题**        | `[q` / `]q`                                 | `OSC133;A` prompt 行；支持 `count` 如 `3]q`；`flash Question 2/5`；可见时 `keep` 不动 |
| **上/下个回答**        | `[a` / `]a`                                 | prompt 后首个非空行；支持 `count`                                                  |
| **上/下个工具**        | `[t` / `]t`                                 | 启发式 `▌/⎿/●` 等；支持 `count`                                                     |
| **上/下个段落**        | `{` / `}`                                   | 空行分隔；支持 `count` 如 `2}`                                                     |
| **搜索**               | `/` 然后 `n` / `N`                          | `/` 进入搜索输入（扩展自研：`flash` 实时回显查询词与 `n/m` 匹配进度）；输入期间所有可打印键（含 `j/k/n`）都是查询词，`Enter` 提交后 `n` 下一个、`N` 上一个循环匹配 |
| **count 前缀**         | `1-9`（`0` 仅已有 buffer 时）               | 最多 4 位，`800ms` 超时，作用于 `j/k`、半页/整页、`[q/a/t`、`{}`                    |
| **手动展开（编辑态）** | `alt+o`（`keybindings.json` 可改）          | 因 `ctrl+o` 被阅读占用，`app.tools.expand` 重绑到 `alt+o`                          |

## 配置

- 阅读切换：`extensions/pi-reader/config.json`（`config.json` 已 `gitignore`）
  ```json
  { "toggleKey": "alt+o", "questionAnchor": "pinTop", "visibleBehavior": "keep", "wrapNavigation": false }
  ```
  `questionAnchor`：`pinTop`（=1，默认）| `third`（=floor(vh/3)）| `center`（=floor(vh/2)）| 数字；`visibleBehavior`：`keep`（默认，目标已可见则不动视口仅 flash）| `reanchor`；`wrapNavigation`：首尾回绕。`?` 弹窗显示生效键
- 工具展开：`~/.pi/agent/keybindings.json`
  ```json
  { "app.tools.expand": "alt+o" }
  ```

## 行为

- **只读**：阅读态吞掉可打印键（`INSERT` 透传），输入栏隐藏为居左 `◉ Reading`（无边框，完全覆盖原位置），原输入保留，退出恢复
- **锚定**：语义跳按 `row - offset`（`questionAnchor` 决定）`clamp` 到 `maxTop` 且 `disableFollow:true`；可见且 `keep` 时不动视口仅 `flash Question 2/5`
- **指示**：`?` 在 READING 弹出英文帮助（`Esc` 关闭）：居中带边框（`╭─╮`）盒子，key/描述双列对齐
- **count**：`1-9` 累积（`0` 仅已有 buffer 时追加），`800ms` 自动清空；`[`/`]` 500ms 为 leader 窗口；`/` 搜索完全在扩展内自研（不碰 TUI overlay），`Enter`/`n`/`N` 不与输入焦点冲突
- **恢复**：退出清理 `gg`/count/bracket 缓冲，恢复输入与工具折叠（工具展开/收起 异步，不阻塞首帧）

## 兼容与限制

- **键协议**：兼容传统控制符与 `Kitty` 协议
- 鼠标滚轮/触板、手选复制、`ctrl+shift+f` 搜索在 fullscreen 下仍透传
- `regular` 下无 `ScrollView`，导航静默无操作

## 开发

```bash
pnpm --filter @inobit/pi-reader check
pnpm --filter @inobit/pi-reader test   # parseReadingKey/halfPage/pageStep/GgSequence + 新增导航单测
pnpm --filter @inobit/pi-reader pack:check
pi -ne -e ./packages/pi-reader --tui-mode fullscreen
```

## License

MIT
