# Changelog

## [0.3.3] - 2026-09-20

- fix: search (`/` plus `n`/`N`) silently did nothing after upgrading to pi 0.86.0
  - Root cause: pi-tui renamed the private `TuiAltScreen.openSearch()` to `toggleSearch()` (`openSearch` no longer exists anywhere in `pi-tui/dist`); the reader probed it via untyped `(tui as any)` duck typing, so the lookup yielded `undefined`, `proxySearchOpen` bailed out and the state machine never left `INACTIVE` — and since the `n`/`N` guards read that same state, the whole search surface died with no error and no effect
  - Fix: all private-TUI probing for search now funnels through one typed compat layer (`NativeTuiSurface` + `nativeTuiSurface()` + `openNativeSearch()`), which prefers `toggleSearch()` and falls back to `openSearch()`; every other member the reader relies on (`closeSearch`, `navigateSearch`, `activeSearch.{component,query,matches,selectedIndex,overlay}`, `getPrimaryScrollView`, `scrollBy`, `scrollToTop`/`scrollToBottom`, `flash`) was verified present in 0.86.0
  - Semantic difference handled: 0.86.0 `toggleSearch()` closes an already-open search whereas 0.84.x `openSearch()` only re-focused it. The reader hides the native overlay right after opening and keeps `activeSearch` alive until Esc, so opening is now skipped when a native search already exists — otherwise a second `/` would have closed the search it just opened
  - Re-opening the search while one is already open (NAV then `/`) no longer shows an empty `Search: ` bar while the transcript still highlights the previous query: the bar is backfilled from the native query/progress, since typing there keeps editing that query instead of starting a fresh one (behaviour itself unchanged — only the display now matches the state)
  - Type hygiene: the search path, the router IO contract and the scroll plumbing no longer use `any` (`tui` handles are `unknown`, narrowed through the structural surface); `pi.on(...)` registrations dropped their `as any` casts so a future event rename fails at compile time instead of silently
  - Tests: +16 (`test/router.test.ts`) — both opener shapes, the `already-open` guard, snapshot/overlay helpers, plus a prototype-chain contract test that fails when `@earendil-works/pi-tui` renames or drops a `TuiAltScreen` method the reader depends on; instance fields (`activeSearch`, `focusedComponent`) and the search component/overlay members are outside its reach and need the manual checklist in the package AGENTS.md on every core upgrade
  - deps: devDependencies for `@earendil-works/pi-{ai,coding-agent,tui}` bumped 0.84.2 → 0.86.0 (the release that exposed the breakage, so `pnpm check` sees the same API the user runs); `peerDependencies` stay `>=0.84.2` because both opener names are now supported

## [0.3.2] - 2026-08-24

- fix: extension dialogs (e.g. a permission ask via `ctx.ui.select`) were frozen while READING was active, and toggling reading mode away made the dialog vanish without resolving its promise — the pending tool call hung forever (agent stuck on "Working...")
  - Root cause A: both TUI-level input listeners consumed Enter/j/k/etc. before the focused extension selector component could receive them; arrow keys in application cursor keys mode (`\x1bO…` SSU sequences) were swallowed too (the passthrough whitelist only covered `\x1b[`)
  - Root cause B: exiting READING rebuilds the editor container (`setCustomEditorComponent` clears it unconditionally), dropping the dialog component without resolving its promise (upstream issue, reported separately; this release avoids triggering it)
  - Fix: focus-based dialog detection — per-key live comparison of `tui.focusedComponent !== reader editor`, exempting the reader's own help overlay and search input components (no reliance on overlay preFocus-restore timing; chained dialogs select→input are handled since detection is not a snapshot)
  - While a foreign component holds focus, the only intercepted key is the reading-toggle key (prevents the container-rebuild hang); every other key is passed through untouched — Enter/j/k/arrows/Esc all operate the dialog as expected
  - `\x1bO` SSU sequences added to the passthrough whitelist of both channels
  - change: `autoExpandTools` now defaults to `false` — tool output state is left untouched across toggles (position naturally lossless); opt in with `autoExpandTools: true`
  - Help overlay + dialog coexistence: the help overlay visually covers the dialog but lost focus to it, so while both are open the reader treats help as logically topmost — it swallows every key except Esc (matching its normal esc-only behavior; nothing leaks to the invisible dialog), and Esc closes the help (overlay hide only restores focus when it holds it, so the dialog keeps focus). Keys start reaching the dialog only after the help is closed
  - Testability seam: dual-channel key routing extracted into injectable factory `createReadingKeyRouter(io, source)` (+25 unit tests incl. dialog-open passthrough/blocking matrix and direct tests of the `isForeignFocus` detection core); dead `patchSearchTitle` helper removed
  - `/reader` command no longer announces a mode flip that was suppressed by the dialog guard
  - docs: README (en/zh) rewritten for the new defaults and dialog-coexistence behavior; package AGENTS.md now records the layering/focus-stack design constraints

## [0.3.1] - 2026-08-23

- docs: README cleanup (en + zh-CN synced) — drop the redundant `app.tools.expand` keybinding section and the `config.json` gitignore note; remove the internal planning doc `plan.md` from the repo, no runtime changes

## [0.3.0] - 2026-08-23

- feat: scroll position preservation across mode toggle (prompt-ordinal anchor)
  - Root cause: `setToolsExpanded` on toggle changes transcript height drastically; ScrollView follow-end re-arms once clamped to bottom, so exiting READING almost always snapped to the very bottom
  - Anchor: `{k, d, count}` in the OSC133 prompt-ordinal coordinate system — expansion/collapse never adds/removes prompt boundaries so `k` is invariant; restore = `scrollTo(clamp(base + d), { disableFollow: true })` after layout stabilizes
  - Flow: sync capture at the top of `applyReaderUI` branches → apply UI → `ScrollRestoreMonitor` polls (16ms × ≤20) until generation unchanged + `currentLayout` frame advanced + `contentHeight` stable across two frames, then restores; guards skip when following-end (natural follow takes over)
  - Stability fix: pi-tui renders on demand (zero frames while idle) — the monitor now calls `requestRender` each tick so the two-new-frame criterion is deterministic; without it restores silently timed out
  - Unified clamp model: exact restore when possible, clamp into segment when the anchored block collapsed away, pin to last page when content below is shorter than one viewport (anchored line always stays on screen); no fake blank padding (keeps `[q/{}/search` line coordinates clean)
- feat: `autoExpandTools` config (`false` disables auto expand/collapse of tool output on toggle)
  - Default `true` (previous behavior); `false` keeps tool output state untouched — position is then naturally lossless; anchor runs anyway as an idempotent no-op
  - Config resolved from the package dir first, user-level fallback kept
- feat: `app.tools.expand` now works inside READING mode
  - Resolves the user keybinding via `kb.matches`/`kb.getKeys` (factory third arg); toggling goes through the same anchor wrapper so manual expand/collapse also preserves position
  - Priority fixed: SEARCH_INPUT > toggle > exit > help > expand > semantic nav > scrolling; keys bound to pre-empted actions (`?`, esc, i, ctrl+c) stay unreachable by design
  - `?` help dynamically lists the effective expand key(s) with edit/reading attribution
- fix: package `config.json` was never read at runtime
  - jiti compiles extensions into base64 `data:` URL modules where `import.meta.url` carries no file path, so module-dir resolution silently fell back to the user-level config; now uses the CJS wrapper-injected `__dirname` (probes both `<pkg>/src/..` and `<pkg>/src`) before falling back
- test: +12 unit tests (anchor capture/restore round-trip, d clamping, followingEnd skip, count-mismatch abort, generation invalidation, monitor stability, config default fallback)

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
