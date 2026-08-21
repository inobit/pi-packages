# Changelog

## [0.2.0] - 2026-08-21

- feat: semantic navigation + anchored scrolling + search state machine
  - Navigation: `[q/]q` prev/next question (OSC133;A prompt), `[a/]a` prev/next answer (first non-empty after prompt), `[t/]t` prev/next tool (heuristic `▌/⎿/●` etc.), `{`/`}` prev/next paragraph (blank-line / `─/—/—/━` separator / `OSC133` zone), `/` search (self-contained: no TUI overlay), `n`/`N` next/prev match
  - Search state machine: `READING --/--> INPUT --enter--> NAV` — `INPUT` captures all keys (incl. `j/k/n`) until `enter` commits to `NAV`, `NAV` only accepts `?` shortcuts, `esc` closes search/cancels highlight staying in `READING` or exits `READING` when no search; single bottom `Search:` bar via `ReadonlyEditor` (native top-right overlay hidden, persists until `esc`, no throttle); robust `isEnterKey/isEscKey` (`\r`/`\n`, Kitty `\x1b[13u`/`\x1b[27u`)
  - Config: remove 2s `TOGGLE_CACHE_TTL` — persistent cache re-read on session_start/reload; default `toggleKey` now `ctrl+o`
  - Navigation: `[q/]q` prev/next question (OSC133;A prompt), `[a/]a` prev/next answer (first non-empty after prompt), `[t/]t` prev/next tool (heuristic `▌/⎿/●` etc.), `{`/`}` prev/next paragraph (blank-line / `─/—/—/━` separator / `OSC133` zone), `/` search (self-contained: no TUI overlay), `n`/`N` next/prev match
  - Anchoring: `questionAnchor` config (`pinTop`=1 default, `third`=floor(vh/3), `center`=floor(vh/2) or number), `visibleBehavior` (`keep` default keeps viewport when target already visible with flash, `reanchor` forces re-anchor), `wrapNavigation` optional; computes `row - offset` clamped to `maxTop` with `disableFollow:true`
  - Count prefix: `1-9` accumulates, `0` only after existing buffer, `800ms` timeout, `5j` / `3]q` / `2}` etc. for line/half/page/paragraph/semantic jumps
  - Paragraph `{`/`}`: `isParagraphBoundary` treats `─/—/—/━` and `OSC133` as boundaries, supports consecutive blanks; force reanchor so holding `}` always advances; `from` anchors to `lastSemanticRow` (5s) for continuous motion
  - Search `/`/`n`/`N`: extension-owned input mode — `/` enters search-typing state where every printable key (incl. `j/k/n`) appends to the query with live `flash` echo and match count/auto-jump (no `TuiAltScreen` overlay, so focus/`Enter` conflicts are impossible); `Backspace` edits, `Enter` commits (read mode `n`/`N` now navigate), `Esc` cancels; `n`/`N` cycle through matches with anchored scroll + flash `Search "pin" 2/20`
  - Reliability: `factory` syncs `latestTui` and `inputListener` uses `curTui = latestTui ?? tt` for `scrollBy/scrollTo`, `getViewportState` traverses `frame.root` to find `scrollContentLines` (fix `No content` for `[q`), `prev` at `maxTop` includes visible last prompt, `next` uses `lastSemanticRow` for continuous `]q` stepping; shared `BracketSequence` (500ms) + `CountBuffer` (800ms) + dedup guard (30ms terminal→input) for dual `inputListener` + `onTerminalInput` channels; try/catch viewport fallback for `regular` mode; flash feedback `Question 2/5` / `No more questions` / `Tool` / `Answer`
  - Help: `?` overlay is a centered bordered box (`╭─╮`) with aligned key/description columns (no truncation, `Esc` to close)

## [0.1.0] - 2026-08-20

- feat: first usable release — Vim-style reading mode (fullscreen)
  - Toggle: `alt+o` (`config.json: toggleKey` configurable) via dual `TUI inputListener` + `onTerminalInput` to enter/exit `READING`, `/reader`/`/scroll` fallback; exit via `esc/i/ctrl+c`, `?` English help closed with `Esc`
  - Scrolling: `ctrl+u/d` half page (`half=floor(vh/2)`), `ctrl+f/b` full page (`page=vh-1`, `OVERLAP=1`) matching `TuiAltScreen`; `j/k`, `ctrl+n/p` line-wise; `g g` (300ms, including batched `gg`) to top, `G` to bottom
  - Read-only: `READING` swallows printable/single-byte keys, mouse wheel passes through; input bar uses `ReadonlyEditor` with left-aligned `◉ Reading` (borderless) overlay, original input preserved and restored on exit; tool outputs expand/collapse asynchronously via `Promise` without blocking first frame
  - Reliability: `listenerInstalled` prevents duplicate install; `currentCtx` refreshed on all `session_*`; `latestTui` stale guard; `gg` 300ms window
  - Compatibility: legacy control sequences and Kitty protocol (`\u001b[111;3u` etc.), `viewportHeight` falls back to `getPrimaryScrollView ?? 20`
