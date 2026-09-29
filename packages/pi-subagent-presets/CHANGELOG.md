# Changelog

## [0.1.0] - 2026-09-28

First release — `/subagent-presets [--from <profile>]`.

- matrix TUI (`tui/matrix.ts`): four columns (`agent` / `model` / `thinking` / `state`). `state` is `GLOBAL` / `MERGE` / `OVERRIDE`, computed live from where the fields of the entry to be written come from. Per-row special states are shown in place after the agent name (`DISABLED` / `⚠UPSTREAM DISABLED` / `⚠MISSING` + strikethrough / `🔒` / `=alias`). Keys: `enter` model picker, `shift+tab` cycle thinking, `r` reset row, `e` external editor, `S` save, `esc` quit
- model picker (`tui/model-picker.ts`): always-focused inline search box (fuzzy), one pinned fixed row (`inherit`) plus the full model list with complete ids
- save dialog (`tui/save-dialog.ts`): project / profile targets, profile-name input, diff-only view, removals grouped by reason
- field-level merge (`merge.ts`): base = `--from` profile | project entry ?? default profile, always merged with the global entry (the definition layer is never materialized); three-state drafts (`touched`), key-deletion semantics, per-field `origin` driving the `state` column. A row that stays `GLOBAL` is not written, and an existing project entry is **deleted** (it would otherwise keep shadowing the global layer)
- writer (`writer.ts`): whenever a row is written, the **complete merged entry** is materialized — including fields that came from the global layer. This matters because pi-subagents replaces a **built-in** agent's entry per agent (`applyBuiltinOverrides`): any field we don't write is *dropped*, not inherited
- 26-field validator (`validate.ts`): the `e` editor only warns with it (even for values upstream would throw on); profile loading still rejects illegal entries
- atomic writer: replaces only `subagents.agentOverrides` via temp file + `rename`; keeps unknown keys; never overwrites a syntactically broken settings file
- soft-dependency probe (`upstream.ts`): L0/L1/L2 degradation, injectable loader, never throws
- UI layering: every **notice** goes to pi (`ctx.ui.notify`) and never into the custom UI, which would make the layout jump during navigation; **state** is carried by in-place markers plus the `state` column. The bottom area is fixed at one blank line + `unsaved changes` (scoped to the whole configuration) + footer
- external editor: opens `entry.jsonc` so editors apply JSON tooling while the field guide stays comment-based
