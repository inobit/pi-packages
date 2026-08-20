# Changelog

## [0.1.0] - 2026-08-20

- feat: 首个可用版本 — Vim 风格阅读模式（fullscreen）
  - 切换：`alt+o`（`config.json: toggleKey` 可改）经 `TUI inputListener` + `onTerminalInput` 双通道进/出 `READING`，`/reader`、`/scroll` 兜底；退出 `esc/i/ctrl+c`，`?` 英文帮助 `Esc` 关闭
  - 翻页：`ctrl+u/d` 半页（`half=floor(vh/2)`）、`ctrl+f/b` 整页（`page=vh-1`，`OVERLAP=1`）与 `TuiAltScreen` 一致；`j/k`、`ctrl+n/p` 行级；`g g`（300ms，含同批 `gg`）顶部、`G` 底部
  - 只读：`READING` 态吞可打印/单字节，鼠标滚轮透传；输入栏用 `ReadonlyEditor` 左显 `◉ Reading`（无边框）覆盖，原输入保留，退出恢复；工具输出 `Promise` 异步展开/收起不阻塞首帧
  - 高可靠：`listenerInstalled` 防重；`currentCtx` 在 `session_*` 全量刷新；`latestTui` stale 防御；`gg` 300ms 窗口
  - 兼容：传统控制符与 Kitty 协议（`\u001b[111;3u` 等），`viewportHeight` 降级 `getPrimaryScrollView ?? 20`
