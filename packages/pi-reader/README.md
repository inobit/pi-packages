# @inobit/pi-reader

**English** | [中文](./README.zh-CN.md)

Vim-style reading mode for Pi `fullscreen`: press `alt+o` to enter read-only and auto-expand `transcript` tool outputs, `ctrl-u/d/f/b`, `gg/G`, `j/k` to scroll, exit to restore `emacs` editing and collapsed tools.

- **Single-key toggle + auto-expand**: `alt+o` (intercepted via `TUI inputListener`, remappable via `toggleKey` in `extensions/pi-reader/config.json`) → `READING` with auto-expanded tool outputs; collapsed state is restored on exit
- **Zero-intrusion editing**: fully passthrough in `INSERT`, keys intercepted only in `READING`; `ctrl+u = deleteToLineStart` by default with zero regressions
- **Pixel-perfect Pi scrolling**: `half = viewportHeight/2`, `page = viewportHeight-1` (`OVERLAP=1`), matching `TuiAltScreen`
- **Robust event routing**: keys go through `TUI inputListener` — reading mode swallows keys, `INSERT` passes through; `ctx` is refreshed across multi-session events so `resume` on old sessions works

## Installation

```bash
pi install npm:@inobit/pi-reader
```

Local dev:

```bash
pi --tui-mode fullscreen -e ./packages/pi-reader/src/index.ts
```

> Only `fullscreen` is scrollable; in `regular` mode `scrollBy` has no viewport and the extension silently ignores it.

## Key Bindings

| Action | Key | Notes |
| --- | --- | --- |
| **Toggle reading** | `alt+o` / `/reader` / `/scroll` (toggle) | Default `alt+o`, remappable via `toggleKey` in `config.json` (e.g. `ctrl+o`); effective key is shown in the `?` popup |
| **Exit** | `esc` / `i` / `ctrl+c` | `esc`/`i`/`ctrl+c` in reading mode (`ctrl+c` does not clear screen), `i` does not leak into input |
| **Help** | `?` | Only in READING — shows English shortcut reference, `esc` to close |
| **Half page up / down** | `ctrl+u` / `ctrl+d` | `scrollBy(∓half)`; `ctrl+u` still deletes to line start in edit mode |
| **Page down / up** | `ctrl+f` / `ctrl+b` | `scrollBy(±page)` |
| **Line down / up** | `j` / `k` + `ctrl+n` / `ctrl+p` | `scrollBy(±1)` |
| **Top** | `g g` | Double `g` within 300ms (including batched `gg`) → `scrollToTop()` |
| **Bottom** | `G` (`shift+g`) | `scrollToBottom()`, follows output |
| **Manual expand (edit mode)** | `alt+o` (remappable in `keybindings.json`) | Since `ctrl+o` is taken by reading mode, `app.tools.expand` is rebound to `alt+o` |

## Configuration

- Reading toggle: `extensions/pi-reader/config.json` (`config.json` is `gitignore`d)
  ```json
  { "toggleKey": "alt+o" }
  ```
  Default `alt+o`, kept separate from `app.tools.expand`; `?` popup shows the effective key.
- Tool expand: `~/.pi/agent/keybindings.json`
  ```json
  { "app.tools.expand": "alt+o" }
  ```

## Behavior

- **Read-only**: printable keys are swallowed in reading mode (`INSERT` passes through), the input bar is hidden behind a left-aligned `◉ Reading` overlay (borderless, fully covers the original position), original input is preserved and restored on exit
- **Indicator**: `?` in READING shows the English help overlay (`Esc` to close, title not uppercased, themed character border, centered)
- **Restore**: clears the `gg` buffer on exit, restores input and tool collapse state (tool expand/collapse is async and does not block the first frame)

## Compatibility & Limitations

- **Key protocol**: compatible with legacy control sequences and `Kitty` keyboard protocol
- Mouse wheel / trackpad, text selection + copy, and `ctrl+shift+f` search still pass through in fullscreen

## Development

```bash
pnpm --filter @inobit/pi-reader check
pnpm --filter @inobit/pi-reader test   # parseReadingKey/halfPage/pageStep/GgSequence
pnpm --filter @inobit/pi-reader pack:check
pi --tui-mode fullscreen -e ./packages/pi-reader/src/index.ts
```

## License

MIT
