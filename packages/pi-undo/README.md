# @inobit/pi-undo

**English** | [中文](./README.zh-CN.md)

Undo for Pi coding agent: restore the last sent prompt to the editor and remove it from the conversation, single-per-turn, queue-aware, abort-then-undo.

- **Undo**: removes the last `user` turn and restores it to the editor, recoverable via `/tree`; file side-effects are NOT reverted
- **Queue-aware, single per turn**: `a sent + b,c queued` → `undo` pops `c` to editor once; the next `undo` goes to history. One undo per turn, reset on next `before_agent_start`; draft checked atomically before abort
- **Abort-then-undo**: if streaming, `abort()` then `waitForIdle()` before revert, re-checks draft

## Installation

```bash
pi install npm:@inobit/pi-undo
```

Restart Pi or run `/reload`.

Local dev:

```bash
pi -e ./packages/pi-undo/src/index.ts
# send a message, then /undo or alt+u
```

## Usage

- `/undo` — undo last sent prompt to editor. Only notifies on error (English).
- `alt+u` — same as `/undo`.

Behavior:
- If editor has draft, notifies `Editor has draft, clear it first` and does not overwrite (atomic, no abort).
- If `a` sent and `b,c` queued, `undo` restores `c` once; the remaining `b` stays queued in the mirror (true queue may still contain `c`; use `Esc` if needed — see Limitations).
- If streaming, directly aborts then reverts, re-checks draft after wait.
- No redo: recover via `/tree`.

## Configuration

Shortcut is configurable via `~/.pi/agent/extensions/pi-undo/config.json` (requires `/reload`):

```json
{
  "shortcut": "alt+u"
}
```

Default `alt+u`. When trusted, project config at `.pi/extensions/pi-undo/config.json` overrides global.

## Compatibility & Limitations

- Reverts page immediately and persists across `--session`; first message via `resetLeaf`.
- File side-effects NOT reverted (edits/writes/bash); undo only reverts conversation branch.
- Queue undo is mirror-based (captures `input` with `streamingBehavior=steer|followUp`, capped at 20). True queue pop requires kernel `getPendingMessages` — queued `c` may still be pending; use `Esc` to clear if needed.

## Development

```bash
pnpm --filter @inobit/pi-undo check   # tsc --noEmit
pnpm --filter @inobit/pi-undo test    # vitest
pnpm --filter @inobit/pi-undo pack:check
```

## License

MIT
