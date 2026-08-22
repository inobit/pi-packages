# @inobit/pi-retry

**English** | [中文](./README.zh-CN.md)

Manual transparent retry for Pi coding agent: `/retry` + `alt+r` re-issues the last failed turn as-is, injecting no prompt into the LLM context.

- **Zero prompt injection**: the retry trigger is a hidden sentinel message that a persistent filter strips from every LLM request — the model never sees it
- **Keep everything as-is**: the failed partial response stays as the last message of the context; the model continues seamlessly (prefill-style), no dropping, no regeneration
- **Failure-agnostic**: connection errors, stream drops, hung requests you aborted — one key re-sends them all

## ⚠️ Known limitation (read before use)

**This extension must stay installed.** The retry trigger permanently writes a sentinel entry into the session file (a custom message containing a single `"."`):

- With the extension installed: the sentinel is stripped by the `context` filter and **never reaches the model**; it is not rendered in the transcript either.
- **If you uninstall/disable the extension and resume an old session containing sentinels**: the filter is gone, and pi's built-in conversion turns each sentinel into a user message sent to the model — i.e. one `"."` noise message appears in the conversation. Harmless, but unavoidable.
- Sentinel entries cannot be deleted from the session file (pi exposes no public API for entry deletion); this is inherent to the design.

## How it works

A hard constraint of pi's public API: **every entry point that can trigger an LLM turn writes a message, and anything that writes nothing does not trigger one**. A "transparent re-send" therefore has to be split in two halves:

```
① Trigger: sendMessage({ customType:"pi-retry", triggerTurn:true })
      └─ starts a new turn (the only no-user-content trigger in the public API); sentinel persisted
② Filter: persistent pi.on("context") handler
      └─ before every LLM call, right before messages are converted to provider format,
         strips exactly role==="custom" && customType==="pi-retry"
```

The interception happens at the `AgentMessage[]` layer (pi registers the extension `context` event as the global `transformContext`, which runs before `convertToLlm` and the HTTP request), so it is provider-independent. After filtering, the model receives the context **ending exactly at the break point** — the failed partial assistant is the last message, which is standard prefill shape; the model simply continues:

| | Failed partial assistant | Model behavior |
|---|---|---|
| pi built-in auto-retry | removed from context | regenerates from scratch |
| typing "continue" | kept + followed by a user instruction | continuation (with instruction ambiguity) |
| **this extension** | **kept as last message, nothing added after it** | **continuation (zero instructions)** |

## Installation

```bash
pi install npm:@inobit/pi-retry
```

Restart Pi or run `/reload`.

Local dev (isolated, `--no-extensions` excludes installed old version):

```bash
pi -ne -e ./packages/pi-retry
# after a failure/abort: /retry or alt+r
```

## Usage

- `/retry` — transparently re-issue the last turn; on success it notifies `Retry submitted`.
- `alt+r` — same as `/retry`.
- **Failure guard**: triggers only when the last assistant message ended with `error`/`aborted`; otherwise notifies `Nothing to retry — last turn ended normally` (or `Nothing to retry yet` on a fresh session). This prevents accidental presses from starting a free-form continuation and permanently writing a sentinel.
- Only available when idle; while streaming it notifies `Agent is busy — retry is only available when idle`.

## Configuration

Shortcut is configurable via `~/.pi/agent/extensions/pi-retry/config.json` (requires `/reload`):

```json
{
  "shortcut": "alt+r"
}
```

Default `alt+r`. When trusted, project config at `.pi/extensions/pi-retry/config.json` overrides global.

## Compatibility & Limitations

- **The extension must stay installed** (see "Known limitation" above): resuming an old session without it leaks one "." to the model. Same family of paths: compaction / branch-summary inputs bypass the filter, so a sentinel inside the summarized range may surface as "." inside the summary text.
- **Interaction with built-in auto-retry**: if the re-issued turn fails again with a whitelisted retryable error, pi core takes over and deletes the partial response, regenerating from scratch (the prefill continuation guarantee only holds for the first re-issue).
- A trailing assistant message is natively supported by Anthropic (prefill); some OpenAI-compatible endpoints may behave differently — test with your providers.
- If the stream happened to end exactly at a complete sentence, the model may start a new paragraph instead of continuing — inherent to continuation semantics, same as typing "continue".

## Development

```bash
pnpm --filter @inobit/pi-retry check   # tsc --noEmit
pnpm --filter @inobit/pi-retry test    # vitest
pnpm --filter @inobit/pi-retry pack:check
```
