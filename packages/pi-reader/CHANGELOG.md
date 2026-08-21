# Changelog

## [0.1.0] - 2026-08-20

- feat: first usable release — Vim-style reading mode (fullscreen)
  - Toggle: `alt+o` (`config.json: toggleKey` configurable) via dual `TUI inputListener` + `onTerminalInput` to enter/exit `READING`, `/reader`/`/scroll` fallback; exit via `esc/i/ctrl+c`, `?` English help closed with `Esc`
  - Scrolling: `ctrl+u/d` half page (`half=floor(vh/2)`), `ctrl+f/b` full page (`page=vh-1`, `OVERLAP=1`) matching `TuiAltScreen`; `j/k`, `ctrl+n/p` line-wise; `g g` (300ms, including batched `gg`) to top, `G` to bottom
  - Read-only: `READING` swallows printable/single-byte keys, mouse wheel passes through; input bar uses `ReadonlyEditor` with left-aligned `◉ Reading` (borderless) overlay, original input preserved and restored on exit; tool outputs expand/collapse asynchronously via `Promise` without blocking first frame
  - Reliability: `listenerInstalled` prevents duplicate install; `currentCtx` refreshed on all `session_*`; `latestTui` stale guard; `gg` 300ms window
  - Compatibility: legacy control sequences and Kitty protocol (`\u001b[111;3u` etc.), `viewportHeight` falls back to `getPrimaryScrollView ?? 20`
