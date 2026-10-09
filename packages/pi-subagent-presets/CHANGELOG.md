# Changelog

## [0.2.0] - 2026-10-09

### Added

- `main` virtual row: the first matrix row edits the project settings' top-level `defaultProvider` / `defaultModel` / `defaultThinkingLevel` (the main agent defaults). It never enters `subagents.agentOverrides` or the whitelist; `defaultModel` is stored as a bare id; `r` removes all three keys at once; the save dialog warns when the model is not in the registry or the provider has no credentials
- `--from <profile>` now lays its template down directly: pressing `S` writes the template values to the project even with no edits; the bottom `● unsaved changes` line is the only "not yet written" signal
- `main` participates in profile import/export: profiles carry the three keys at the top level (next to `subagents`, never inside it) and `--from` reads them back as the new base

### Fixed

- `--from` + no edits + `S` wrote nothing (the template base made every row look clean, so the old entries were kept as-is)
- save dialog `--from` section said `not applied (--from blueprint, project entry wins)` — the semantics were backwards; it now says the blueprint is the base and the project entry does not contribute

### Changed

- **a profile now exports the whole matrix snapshot, not just the rows being written**: the project side still writes only what has to be written, while the profile gets every managed agent visible in the matrix — including rows you never touched — because a profile is the blueprint a future project lays down with `--from`. The two sides deliberately differ, and the save screen now says so whenever the profile target is checked
- `r` no longer leaves the `main` row showing (or writing) a cross-layer mix of the pre-reset project `defaultProvider` and the frozen global `defaultModel`. Provider resolution is now one function (`resolveMainEntry`) shared by the matrix cell, the write path and the `e` editor
- the plain command no longer falls back to the default profile (values shown were never written); use `--from default` explicitly
- English README completed (a whole section and the `e` warning table were still Chinese)

## [0.1.1] - 2026-10-07

- Fix the matrix model cell staying on the previous value after choosing a new model; it now displays the selected draft value before saving.

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
