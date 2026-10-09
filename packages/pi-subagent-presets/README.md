# @inobit/pi-subagent-presets

**English** | [中文](./README.zh-CN.md)

Batch-configure the `model` and `thinking` level of every [pi-subagents](https://github.com/nicobailon/pi-subagents) agent **per project**, and export the result as a reusable global profile template.

- **One command**: `/subagent-presets` opens a matrix of agents × (model, thinking) — plus a virtual `main` row for the session's own defaults — and writes project-level `subagents.agentOverrides` and the top-level `defaultProvider` / `defaultModel` / `defaultThinkingLevel` in one save
- **Field-level merge, not overwrite**: global values for `tools` / `skills` / `acceptanceRole` / `machine` / … are copied into the project entry, so a project entry never silently drops what you configured globally
- **What you see is what runs**: the `model` and `thinking` columns show the value that will actually take effect, not the current file contents
- **Reusable template**: every save can also export a global profile under `~/.pi/agent/profiles/pi-subagents/`, interoperable with the official `/subagents-profiles` and `/subagents-load-profile`
- **Never breaks your config**: rows with a provider-scoped config, rows disabled upstream, and rows you did not touch are left exactly as they are
- **Soft dependency**: `pi-subagents` is optional. Without it the command still runs in a degraded mode (see [Soft dependency](#soft-dependency))

## Installation

```bash
pi install npm:@inobit/pi-subagent-presets
```

Restart Pi or run `/reload`.

Local dev:

```bash
# isolated: only the extension given to -e is enabled
pi -ne -e ./packages/pi-subagent-presets

# full: your other user extensions are loaded too
pi -e ./packages/pi-subagent-presets
```

> **What differs**: `-ne` (`--no-extensions`) enables **only** the one extension passed to `-e` and skips every other user extension. That guarantees you exercise the working-tree code instead of an installed copy.
>
> It also hides user extensions that **register model providers**. If some of your model catalogue comes from such an extension, those models become "not in registry" under `-ne`, which in turn disables thinking-level clamping and the `maxThinking` ceiling check. Use the **command without `-ne`** whenever you need to verify model-dependent behaviour.

## Usage

```text
/subagent-presets                 # base = project entries only
/subagent-presets --from work     # base = the "work" profile, merged over the global layer (--from replaces the whole base)
```

| Key | Action |
| --- | --- |
| `↑` `↓` | Move the selected row |
| `enter` | Open the model picker (inline search box above the list, always focused — just type) |
| `shift+tab` | Cycle the thinking level (pi's default levels when the row has no model) |
| `r` | Reset: do not write a project entry (state becomes `GLOBAL`); editing any field turns it into "write this instead". On the `main` row, `r` removes all three top-level keys at once |
| `e` | Edit the **whole entry that will be written** in `$EDITOR` (model / thinking included; validation only warns) |
| `S` | Save |
| `esc` | Quit (asks twice when there are unsaved changes) |

The matrix has four columns (`agent` / `model` / `thinking` / `state`). `state` is
computed live from where the fields of the entry to be written come from:

| Condition | `state` | Meaning |
| --- | --- | --- |
| we provide no fields | `GLOBAL` | this agent is **not written** to the project at all |
| the global layer has no field left for us | `OVERRIDE` | we take it over completely |
| otherwise | `MERGE` | partial: some global fields are not covered by the entry we write |

The `state` column never expands into a per-field breakdown; see the `e` editor and the
save dialog's diff for that.

Whenever a row ends up in `MERGE` / `OVERRIDE`, the **complete merged entry** is written —
including fields that came from the global layer — because a built-in agent's entry is
replaced per agent, so anything we don't write is dropped rather than inherited. Only a row
that stays `GLOBAL` is not written, and an existing project entry for it is deleted.

Per-row special states never enter the `state` column — they are shown in place after the
agent name (`DISABLED` / `⚠UPSTREAM DISABLED` / `⚠MISSING` + strikethrough / `🔒` / `=alias`).
A field without a value renders as genuinely blank.

The model picker pins one fixed row above the (possibly very long) model list:

| Option | Written | Effective model at runtime |
| --- | --- | --- |
| `Parent session model` | the string `"inherit"` | the parent session model, **skipping** `subagents.defaultModel` |

There is deliberately **no "None" / delete-the-key option**: for **built-in** agents
pi-subagents replaces the whole entry per agent (`applyBuiltinOverrides` returns as soon
as a project entry exists, so the global entry is never consulted). A project entry
without a `model` key therefore does *not* fall back to the global model — it falls through
to definition → `subagents.defaultModel` → parent session model, which is not a value you
can pick here. Use `r` to reset the row, or delete the key yourself in `e`.

> Note: this per-agent replacement applies to **built-in** agents. Agents you define
> yourself in `.pi/agents/*.md` go through `applyCustomAgentOverrides`, which *is* a
> field-by-field merge (user then project).

Non-interactive sessions print a summary of every agent and return without writing anything.

## Two opposite upstream resolution paths

Upstream resolves `agentOverrides` through **two paths with opposite semantics**, depending on the agent kind. Before writing code or debugging, confirm which kind your target agent belongs to:

| Agent kind | Upstream path | Semantics |
| --- | --- | --- |
| **Built-in** (`worker` / `reviewer` / `researcher` / … shipped with pi-subagents) | `applyBuiltinOverrides` | **Whole-entry replacement per agent**: once the project has an entry for that agent, the global entry is **entirely skipped**. Fields the project entry does not write fall back to the agent definition → `subagents.default*` → parent session model |
| **Custom** (defined by you in `.pi/agents/*.md` or in some package) | `applyCustomAgentOverrides` | **Field-by-field** merge: global first, then project ("project wins, without dropping user-only fields") |

Measured comparison (project entry writes only `thinking`, global config has `model` / `machine`):

| | `model` | `machine` | `output` |
| --- | --- | --- | --- |
| Built-in `researcher` | dropped | dropped | `research.md` (from the definition layer) |
| Custom `probe-custom` | `g/GLOBAL-MODEL` | `r1` | `text` |

Three easy traps follow from this:

- **Deleting a field in `e` behaves differently per kind.** Built-in: the field is really gone (falls back to the definition layer first, and disappears entirely only if the definition layer has neither). Custom: **the global value fills back in** — deleting a key means "fall back to global" and cannot express "I don't want this field". To force a blank, write `"machine": false` (upstream maps `false` to `delete`).
- **`MERGE` means different things per kind.** It only says "the fields we provide do not cover every global field". For built-in agents those uncovered global fields are **dropped**; for custom agents they **fall back to the global values**.
- **This extension's "write the complete merge" lands differently too.** For built-in agents it is required (otherwise fields are really lost); for custom agents the runtime result is the same, but the project now holds a snapshot of its own — later edits to the global `model` **will not follow** into this project.

(To tell which kind an agent is, look at pi-subagents discovery's four buckets: `builtin` / `package` / `user` / `project`.)

## Merge semantics

For **built-in** agents — which is every agent pi-subagents ships with — `agentOverrides` is resolved upstream **per agent, not per field**: if the project has an entry for `reviewer`, the global entry for `reviewer` is skipped *entirely*. Fields the project entry does not write fall back to the agent's own frontmatter, then to the top-level `subagents.default*`, then to the parent session model.

That is why hand-writing a project entry is lossy. This extension fixes it by writing the **merge**:

```text
① base     = --from profile | project entry (a plain command never falls back to the default profile)
② global   = ~/.pi/agent/settings.json  (always)
③ frontmatter model + thinking  (display only, never written)

save ⇒ for each changed row: write ① ∘ ②, field by field
```

Because every field written into the project entry becomes the final value, the resolved result is identical to "follow global" — field for field. Untouched rows are **not** written, so they keep following the global config.

The `default` profile is only ever used when you ask for it explicitly via `--from default`. Without `--from`, rows with no project entry show genuinely blank cells (they follow the global layer at runtime) and are not written.

`--from <name>` lays its template down directly: the matrix shows the template merged over the global layer, and pressing `S` writes it to the project **even if you changed nothing**. The bottom line `● unsaved changes` is the only signal that the displayed values have not been written yet — when it is absent, what you see is what is on disk.

### The cost of pinning

Once the merged result is written into the project file, it no longer follows the global config: later edits to `~/.pi/agent/settings.json` will not reach that project. The save dialog lists exactly which fields are being pinned so you can decide per row.

Worth keeping in mind for **custom** agents in particular: those follow the global config field by field, but after the merge is written they hold a snapshot just the same and stop following it.

## The `main` row

The first matrix row, `main`, is a virtual row for the **main agent** (the model running your session itself). It edits the three top-level keys of the project settings — `defaultProvider` / `defaultModel` / `defaultThinkingLevel` — and never touches `subagents.agentOverrides`.

- `defaultModel` is stored as a **bare id** (the id itself may contain a slash, e.g. `opencode/exo-free`); the matrix displays `provider/model` when a provider is set. Picking a model in the UI always writes the pair together, so the two keys stay consistent. Hand-editing them in `e` is never validated — an unpaired combination is your own doing and the extension does not interfere.
- `r` on this row removes all three keys from the project at once (falling back to the global layer). There is no partial removal.
- `e` opens exactly the three real keys — what you see is what lands in the file.
- Two runtime facts worth knowing: an **untrusted** project ignores its project settings entirely, so these defaults do nothing there; and they only take effect on the **next pi start** in this project — resuming an old session with `pi --session` keeps that session's model.
- Pi silently ignores defaults it cannot use: a `defaultModel` that is not in the model registry, or a `defaultProvider` with no configured credentials, falls back to automatic model selection with no error. The save dialog warns about both cases without blocking the save.

Profiles carry these three keys at the **top level** (next to `subagents`, never inside it — the `defaultProvider` inside `subagents` is upstream's bare-id disambiguation key, same name but a different meaning). `--from` reads them in and `S` exports them back out.

## Soft dependency

`pi-subagents` is an **optional peer dependency** (`peerDependenciesMeta.pi-subagents.optional`). Installing this package alone is not useful.

| Level | What you get | Requires |
| --- | --- | --- |
| L0 | Merge, save, profile export, model list, thinking levels, the 26-field validator, both "do not materialize" guards | pi core + pi-ai only |
| L1 | Row classification (normal / upstream-disabled / upstream-missing / alias), `maxThinking` ceiling, definition-layer fallbacks, project-root resolution, cache clear | `discoverAgentsAll` present in the installed `pi-subagents` |
| L2 | Yellow banner only — never blocks writing | — |

The five "upstream unavailable" cases all degrade instead of failing: not installed, install root not found, no loadable JS entry (git checkouts ship `.ts` only), version too old, or `discoverAgents` itself throws because a settings file contains an illegal value (red banner, degraded mode, never a crash).

## Exceptions we deliberately do not materialize

Two situations would let our own write destroy an explicit user intent, so the affected row is left alone (neither written **nor** deleted):

1. **Provider-scoped config**: if `agentOverridesByProvider.<any provider>.<agent>` exists in the **global** settings, the project entry would kill that whole user-side entry. The row is marked 🔒 and the save dialog names the providers.
2. **Top-level `disableThinking` / `disableBuiltins`** (project or global): writing would resurrect the affected agents. We do not block, but we show a yellow banner and ask for a second confirmation, and we list the fields that come back (`disableBuiltins` resurrects whole entries, not just `thinking`).

A project-side provider layer is reported too (it keeps overriding the fields you save in the base layer) but does not block.

## Whitelist = managed set

`agents` in `<agentDir>/extensions/pi-subagent-presets/config.json` is the **managed set**: the agents that appear in the matrix, and the only ones allowed to appear in the project `agentOverrides`. Removing one means "stop managing it" — its project entry is dropped on the next save in that project.

Default (7 pure-Pi runners):

```json
{ "agents": ["worker", "scout", "reviewer", "oracle", "researcher", "delegate", "evidence-auditor"] }
```

`advisor` is an alias of `oracle` (keys must be the canonical name — an override written on `advisor` does nothing, so it is never written). The six external CLI runners (`claude-code*` / `codex-exec*` / `cursor-agent*`) are excluded because they ignore `model` / `thinking` at run time.

The project layer (`<cwd>/.pi/extensions/pi-subagent-presets/config.json`, trusted projects only) **replaces** the global list rather than merging with it — otherwise removing an agent would never take effect.

## Profiles

Profiles live in `~/.pi/agent/profiles/pi-subagents/<name>.json`, the same directory the official tooling uses. Format:

```json
{
  "subagents": { "agentOverrides": { "reviewer": { "model": "p/m", "thinking": "high" } } },
  "defaultProvider": "p",
  "defaultModel": "m",
  "defaultThinkingLevel": "high"
}
```

- Names must match `^[A-Za-z0-9][A-Za-z0-9._-]*$`; a trailing `.json` is stripped.
- **A profile exports the whole matrix snapshot, not just the rows being written**: the
  project side writes only what has to be written (untouched rows never enter the project
  file), while the profile gets **every managed agent visible in the matrix** — including
  rows you never touched — because a profile is the blueprint a future project lays down
  with `--from`. The two sides deliberately differ, and the save screen says so whenever the
  profile target is checked.
- A profile carries the `main` row's three keys at the **top level** (`defaultProvider` / `defaultModel` / `defaultThinkingLevel`, each optional). They never live inside `subagents` — the `defaultProvider` inside `subagents` is upstream's bare-id disambiguation key, same name but a different meaning. The remaining top-level `subagents` keys (`defaultModel`, `defaultThinking`, `maxThinking`, …) are **not** exported — configure them separately in a new project.
- `--from <name>` reads the agent entries *and* the top-level three keys as the new base, merged over the global layer; saving writes both back (agent entries to `subagents.agentOverrides`, the three keys to the settings top level). The `default` profile is only used when named explicitly via `--from default`.
- Every field is validated before export. `model: false` is legal in project settings but **not** in a profile, so it is stripped with a notice; an entry that becomes empty is dropped entirely.
- Reading a profile runs the same validator. An illegal value is a red banner and the merge is refused.

## The `e` JSON editor

`e` opens `$EDITOR` (or `settings.externalEditor` / `$VISUAL` / `$EDITOR`) on the **whole
entry that will be written** — the exact object that lands in
`subagents.agentOverrides.<agent>`, `model` and `thinking` included. The comment header is a
commented field skeleton: one line per one of the 26 fields, with its value domain.

- The matrix and `e` are **two views of one draft**: editing `model` / `thinking` here syncs into the matrix and takes effect.
- **Deleting a key** is the only way to make a field "unset": remove the line. The save honours the deletion and never resurrects it from the merge base.
- Validation **only warns — it never blocks the save and never rewrites what you typed** (illegal values included):

| Case | Result |
| --- | --- |
| Known field with an illegal value / non-level `thinking` | ⚠️ a red notice naming the field and the value you typed (saved as-is, upstream will complain) |
| Unknown key | ⚠️ a red notice naming the key (silently dropped upstream) |

Those warnings are summarised on the save screen. The only thing still rejected is a
top-level non-object (that shape cannot be stored in `agentOverrides` at all).

## Notes

- The `state` column only shows `GLOBAL` / `MERGE` / `OVERRIDE`, computed live from where each field of the entry to be written comes from. `project entry exists + state === GLOBAL` means the entry contributes nothing to the final result, so the save **deletes it** (that is what `r` acts on).
- **The two kinds of "disabled" behave differently**: `disabled: true` inside the merge result (your own config) stays editable — set it to `false` to re-enable; disabled in the four buckets but not in the merge result behaves exactly like "upstream no longer has this agent" (not editable, never written), only the marker differs.
- Writing only replaces `subagents.agentOverrides` plus the three top-level `main` keys (`defaultProvider` / `defaultModel` / `defaultThinkingLevel`). Everything else in `settings.json` keeps its key set and values; the JSON formatting (indent, key order, trailing newline) is normalized.
- No `/reload` is needed: the discovery cache fingerprint includes `size:mtimeMs` of both settings files, so the next launch picks the values up. We also call `clearAgentDiscoveryCache` when available.
- Verify an agent result with pi-subagents' own `/subagents-models <agent>`; verify a `main` change by starting pi again in this project.
- The project config directory name is not hardcoded — it is resolved from pi's `CONFIG_DIR_NAME` (and pi-subagents resolves the same name from its own `package.json`).
- The project root follows pi-subagents' `findConfiguredProjectRoot` when available (including its `.agents`-directory candidates, home cutoff, and `projectRootResolution` policy). Without the upstream, the root is `ctx.cwd`, and a banner tells you the file may not be picked up.

## License

MIT
