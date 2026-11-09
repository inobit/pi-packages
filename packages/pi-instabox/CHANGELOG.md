# Changelog

## [0.1.0] - 2026-11-09

- feat: nine `instabox_desktop_*` tools generated from the target box's remote `tools/list`, each taking an optional `box` parameter and returning `[box=<name>]` as the first line of every result
- feat: five-level target resolution (call parameter → box name in the last user message → session target → `defaultBox` → first `instabox ls` box) with hard errors instead of silent fallbacks, and an explicit "no fallback, nothing retried" note on remote errors
- feat: `/instabox-use` and `/instabox-status` commands; the session target is a branch-scoped custom entry rendered in the transcript and never injected into the LLM context; `/instabox-use` also retries registration (wake → fetch → register) after a cold start
- feat: per-box template cache at `<agentDir>/pi-instabox/templates.json` (remote `serverInfo.version` + 7-day TTL) so the load-time declarations need no ssh; a background fetch that never wakes a paused box re-validates the version once per session start and refetches only when it changed or the TTL expired
- feat: silent session-start tool declaration (supersedes the earlier “never wakes a paused box” wording) — cache hit: silent registration, then one handshake to re-validate the version (a failed check falls back to the cached tools without a word); no cache: the first box in `state === "running"` and never woken; nothing running: the first listed box is woken in the background (no progress UI, non-blocking) and its template fetched. Success never notifies; only “no usable sandbox” (`ls` empty or failing) and a failed sync warn once. Internal `[pi-instabox] …` logs are silent unless `PI_INSTABOX_DEBUG=1`
- feat: per-box stdio MCP pool with a `desiredState`-aware wake chain (`start` / `wake` / `resume`), abort propagation and failure eviction, driven by a JSON-RPC client that tolerates both newline-delimited and `Content-Length` framing
- feat: optional remote `chrome-devtools-mcp` — when `devToolsBox` is set, a generated `bin/devtools-connect.sh` helper plus an `instabox-devtools` MCP server with `codemode` exposure; config comes from `<agentDir>/extensions/pi-instabox/config.json` layered over defaults and `INSTABOX_MCP_*` environment variables, and the extension never calls `setActiveTools`
- feat: gate devtools MCP behind --instabox-devtools with a runtime toggle
- feat: write structured JSONL logs under `<agentDir>/logs/pi-instabox` (one record per event, `info` by default and `debug` with `PI_INSTABOX_DEBUG=1`, 1 MiB × 3 rotation, sensitive field names redacted, write failures swallowed)
- feat: bind devtools box to the session and add /instabox-devtools reset
- fix: cap the prepare phase at 60s
