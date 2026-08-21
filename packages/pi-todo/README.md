# @inobit/pi-todo

**English** | [中文](./README.zh-CN.md)

Minimal-intrusion task list extension for [Pi coding agent](https://pi.dev): `todo` tool + `/todos` command + persistent panel above the editor.

- **Low prompt intrusion**: 3 `promptGuidelines`, decision-tree style `description`, only 6 core schema params — ~1.1 KB prompt overhead per turn
- **State on the session branch**: each tool call writes a slim snapshot (`id/subject/status/activeForm`) into the tool result `details`; automatically restored after `/reload`, context compaction, and branch switches — zero disk writes
- **Session isolation**: state is partitioned by session id, child/parallel sessions never pollute each other

## Installation

```bash
pi install npm:@inobit/pi-todo
```

Restart the Pi session to take effect. For local development, symlink to `~/.pi/agent/extensions/pi-todo` (Pi auto-loads the entry declared in `pi.extensions`); run `/reload` after code changes.

## Usage

- Describe a multi-step task and the agent will call the `todo` tool to plan and track it, with live panel updates:
  - `todo create <subject> [description]` — create a task
  - `todo update <id> <status> [activeForm]` — advance status (`in_progress` / `completed`, optional running label like "writing tests")
  - `todo list [status]` / `todo get <id>` / `todo delete <id>` / `todo clear`
- `/todos`: fullscreen grouped list (Pending / In Progress / Completed), `Escape` to close
- Panel collapse shortcut: `ctrl+shift+t`

Task states `pending → in_progress → completed`; `completed` is only set explicitly by the model. Deletes use a tombstone to prevent id reuse. No config file in v1.

## Development

```bash
pnpm --filter @inobit/pi-todo check   # tsc --noEmit
pnpm --filter @inobit/pi-todo test    # vitest
```

## License

MIT
