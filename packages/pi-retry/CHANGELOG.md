# Changelog

## [0.1.0] - 2026-08-22

- feat: first release — manual transparent retry via `/retry` + `alt+r` (configurable)
  - Trigger: hidden sentinel message (`customType: "pi-retry"`) sent through `sendMessage({ triggerTurn: true })`; idle-only, explicit refusal while streaming
  - Persistent `context` filter strips the sentinel by exact type (never by text) on every LLM call; all other messages — including failed partial assistants — pass through untouched
  - Semantics: keep-as-is continuation (prefill-style), no prompt injected into LLM context
  - Shortcut configurable via `~/.pi/agent/extensions/pi-retry/config.json` (`{"shortcut":"alt+r"}`); trusted project override supported
