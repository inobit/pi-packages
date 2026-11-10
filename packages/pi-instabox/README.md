# @inobit/pi-instabox

**English** | [中文](./README.zh-CN.md)

Drive instabox sandboxes from Pi sessions: nine `instabox_desktop_*` computer-use tools whose every call names the box it targets, plus a remote `chrome-devtools-mcp` server bound to one fixed box that is **on by default** and can be switched off (`--no-instabox-devtools`, `devTools: false`, or `/instabox-devtools off`).

- **Every call names its box**: an optional `box` parameter (or the five-level target resolution chain) decides which sandbox runs, and the first line of every successful result is `[box=<name>]`
- **No silent fallback**: a mistyped or ambiguous target is an error listing candidates; only a stale `defaultBox` degrades (with one warning per session)
- **Schemas come from the remote**: tool definitions are generated from the target box's `tools/list` and cached per box, so the load-time declarations need no ssh
- **Never touches your tool selection**: desktop tools are `exposure: "deferred"` — callable from codemode scripts, but neither declared to the model nor listed in codemode's description — and the extension never calls `setActiveTools`

## Requirements

- **`@earendil-works/pi-coding-agent >= 0.99.0`** — a hard floor. `exposure`, `namespace`, `registerMcpServer` and the codemode/MCP support this package builds on landed in 0.99.0; older hosts cannot load it.
- Node.js **>= 24**.
- The `instabox` CLI on `PATH` (`instabox version`, `instabox ls --json`, `instabox ssh`, `instabox wake|start|resume`, `instabox exec`). A missing CLI means the extension registers nothing — no tools, no commands, no MCP server, no runtime files (no template cache) — and shows one warning per session; the only thing written is the single `cli.probe` record in the event log. A first `instabox version` probe that merely times out is retried once at session start with a larger budget before that verdict.
- Sandboxes whose template ships `instabox-computer-use` (the remote MCP server this extension drives over `instabox ssh <box> -- instabox-computer-use mcp`).

## Installation

```bash
pi install npm:@inobit/pi-instabox
```

Restart the Pi session to take effect.

## Usage

**Desktop tools.** Each entry of the target box's remote `tools/list` becomes one Pi tool named `instabox_desktop_<remote_name>` (nine for the `instabox-computer-use` build this package targets, e.g. `instabox_desktop_click`), labelled `instabox desktop <remote_name>`, grouped in the `instabox-desktop` namespace (alias `instabox_desktop`) with `exposure: "deferred"`: registered and callable from a codemode script, but not declared to the model and not listed in codemode's description, so they take nothing out of its 3000-token budget. A script finds them through the namespace — `describeNamespace("instabox-desktop")` for the whole group, `searchTools("instabox")` for a BM25 search over the same text (the namespace description and instructions are part of the indexed text, so a search for the namespace name surfaces the group's tools) — and then calls them by name (`tools.instabox_desktop_click({ … })`).

Every tool takes an optional `box` parameter. When it is omitted, the target is resolved in this order, first match wins:

1. the `box` parameter of this call;
2. the only box name mentioned in the last user message of the current branch;
3. the session target (set with `/instabox-use`);
4. `defaultBox` from config;
5. the first box returned by `instabox ls`.

Levels 1–3 are strict: an unknown name is an error and a message naming several boxes is `ambiguous` — none of them guesses, and none falls through to the next level. Only level 4 degrades (to level 5, with one warning). Every successful result starts with `[box=<name>]`; remote content (text and images) is passed through unchanged, and a remote error keeps its `isError` flag plus one line stating that nothing was retried and no other box was used (with two remedies).

**`/instabox-use [box]`** — set or show this session's target box. Without arguments it prints the current target and the candidate boxes. An unknown name is refused and the previous target is kept. The target is stored as a custom session entry (never injected into the LLM context, scoped to the current branch, so `/tree` switches and `--continue` restore it). If no desktop tool is registered yet (cold start, no cache), the command also wakes the box, fetches `tools/list` and registers the tools — this is the retry path when the box was not running at session start.

**`/instabox-status`** — one-shot diagnostics: config summary (`defaultBox`, `devTools`, `devToolsBox`, `autoInstallDevTools`, `remotePath` — `devToolsBox` there is only the DevTools default box, not the switch), the DevTools switch together with where it comes from (`instabox-devtools: on (config)` / `on (--instabox-devtools)` / `off (--no-instabox-devtools)` / `off (/instabox-devtools)`), session target, resolved target and how it was resolved, registered `instabox_desktop_*` tools with their exposure (`deferred`), which box's cached template the declarations came from (`tool declarations: from the cached template of box "…"`), active tools, codemode state, and the MCP servers registered by extensions — `instabox-devtools` appears in that last list while the DevTools server is registered (see [DevTools MCP](#devtools-mcp)).

**`/instabox-devtools [status|on [box]|off|reset]`** — the runtime toggle for the remote DevTools MCP server: bare (or `status`) shows the switch together with its source (`on (config)` / `on (--instabox-devtools)` / `off (--no-instabox-devtools)` / `on (INSTABOX_MCP_DEVTOOLS)` / `off (/instabox-devtools)`), the name of the server registered in this session, the box bound to this session and the box the next `on` would use with where that box comes from (`session` / `flag` / `config`); `on [box]` switches the capability on for this session, registers or replaces the server and, when a box is given, binds it to this session; `off` switches it off and unregisters it for the rest of the session without clearing that binding; `reset` clears the session binding only. Details in [DevTools MCP](#devtools-mcp).

**Where the tools come from.** On load, a cache hit registers the desktop tools silently — no ssh, no notification. Otherwise the session start decides in the background: with a cache it re-validates the box the declarations came from (session target → `defaultBox` → most recently fetched box, each only if that box has a cache entry); with no cache it lists boxes and takes the first box in `state === "running"`, or — when nothing is running — the first box in the list. **Connecting wakes the box:** every connection, desktop tool calls and this background sync alike, first makes sure the box is running (`instabox wake`, then `instabox start`, then `instabox resume`), so a paused box is woken in the background — no progress UI, the session is not blocked — instead of being skipped. Success is silent: the tools simply appear. You only see a warning when there is no usable sandbox at all (`instabox ls` empty or failing) or when the sync itself fails; both are once per session and the latter names `/instabox-use <box>`.

**codemode prerequisite.** `deferred` exposure means the tools are registered and callable from a codemode script, but never declared to the model and never listed in codemode's description: deferred tools are left out of that description entirely, so they do not touch its shared 3000-token budget and the description does not change while tools register. The model still has to know that they exist, so the extension writes one system-prompt section at `before_agent_start` (tag `instabox-desktop`, only while desktop tools are registered): one intro line plus a `- instabox-desktop (codemode): <description>` line, the same shape Pi uses for MCP servers. That description is **not** a constant: it is generated from remote data — the first line of the remote `initialize` `instructions`, truncated to 250 characters, falling back to the packaged namespace description when the remote sends none. A remote upgrade (or any refetch, such as the 168-hour TTL) therefore carries the new text over to the next registration (load-time cache hit, the `session_start` background sync, `/instabox-use`) with no code change. It only changes when the remote data changes, so no per-turn system-prompt patching happens and the prompt prefix cache stays valid. In a script, `describeNamespace("instabox-desktop")` returns the namespace and the names of its tools, `describeTool(name)` returns one tool's full declaration (the `ALL_TOOLS` entries carry declarations too), and `searchTools("instabox")` ranks the same tools by BM25. codemode itself still has to be active — only a script can run these tools — and the extension never activates it for you, and it only judges the state once desktop tools are registered (at session start, and on every `/instabox-status`). If codemode is inactive and no `codemode`-exposure MCP server exists, you get one warning per session with the fix: start with `pi --tools +codemode`, or set `"defaultTools": ["+codemode"]` in settings. If the session has no `codemode` tool at all (filtered out by `--tools` / `--exclude-tools`, or a built-in extension replaced), a different one-time warning says the desktop tools are not callable in this session. With the DevTools server on (the default — see [DevTools MCP](#devtools-mcp)), Pi activates codemode by itself, so neither warning appears. `/instabox-use` and `/instabox-status` keep working either way.

## Configuration

Optional `config.json` (global `<agentDir>/extensions/pi-instabox/config.json`, or project `<cwd>/.pi/extensions/pi-instabox/config.json` when the project is trusted):

```json
{
  "defaultBox": "",
  "devTools": true,
  "devToolsBox": "",
  "autoInstallDevTools": true,
  "remotePath": "/opt/npm/bin:/usr/local/bin:/usr/bin:/bin",
  "devToolsArgs": [
    "--headless",
    "--userDataDir=/data/home/.agent-chrome",
    "--executablePath=/usr/bin/chromium",
    "--viewport=1280x800",
    "--no-usage-statistics"
  ],
  "timeouts": {
    "prepareMs": 60000,
    "wakeMs": 20000,
    "startMs": 30000,
    "connectMs": 15000,
    "initializeMs": 15000,
    "listToolsMs": 15000,
    "callMs": 120000
  }
}
```

| Key | Default | Meaning |
| --- | --- | --- |
| `defaultBox` | `""` | Late fallback target; empty means unset (falls back to the first `instabox ls` box) |
| `devTools` | `true` | Switch for the remote DevTools MCP server. `false` keeps it off unless `--instabox-devtools` or `/instabox-devtools on` overrides it. Precedence: `--instabox-devtools` / `--no-instabox-devtools` → `INSTABOX_MCP_DEVTOOLS` → this key |
| `devToolsBox` | `""` | Default box for `chrome-devtools-mcp`; it never enables the server by itself, and both `--instabox-devtools-box` and the session binding (`/instabox-devtools on <box>`) override it |
| `autoInstallDevTools` | `true` | Try `sudo -n env "PATH=<remotePath>" npm i -g chrome-devtools-mcp` on the box once when it is missing |
| `remotePath` | `/opt/npm/bin:/usr/local/bin:/usr/bin:/bin` | PATH used inside the box; the defaults cover the npm prefixes seen so far on box templates |
| `devToolsArgs` | see above | Passed verbatim to `chrome-devtools-mcp` |
| `timeouts.prepareMs` | `60000` | Deadline for the whole prepare phase of one tool call: state check → wake chain → confirm `running` → connect |
| `timeouts.wakeMs` | `20000` | Per-step cap for `instabox wake` (self-paused boxes) |
| `timeouts.startMs` | `30000` | Per-step cap for `instabox start` / `instabox resume` |
| `timeouts.connectMs` | `15000` | Per-step cap from spawn until the first byte from the remote MCP server |
| `timeouts.initializeMs` | `15000` | `initialize` request |
| `timeouts.listToolsMs` | `15000` | `tools/list` request |
| `timeouts.callMs` | `120000` | `tools/call` request (desktop actions, screenshots included); not part of the prepare budget |

`prepareMs` is a deadline, the other fields are single-step caps: every step's timeout is `min(step cap, remaining budget)`, and polling/backoff waits shrink the same way, so a step that hangs cannot stretch the total into the sum of the caps. When the budget runs out the call fails with `prepare timed out after 60000ms (box "<name>", step: wake|start|resume|confirm|connect)` plus that step's `stderr` tail; nothing is retried on another box. `timeouts.callMs` starts after the prepare phase, so it is not contained in `prepareMs`.

Layers are applied in order, later wins: built-in defaults → the global `config.json` → the project `config.json` (trusted projects only) → environment variables. Invalid values are ignored, so that layer simply keeps the value below it; `timeouts` merges field by field, and an explicit `"devToolsArgs": []` clears the list.

Environment variables (empty means unset): `INSTABOX_MCP_DEFAULT_BOX`, `INSTABOX_MCP_DEVTOOLS` (`0` or `1` — switches the DevTools server off/on), `INSTABOX_MCP_DEVTOOLS_BOX`, `INSTABOX_MCP_AUTO_INSTALL` (`0` or `1`), `INSTABOX_MCP_PATH` (the remote PATH).

## Paths

`<agentDir>` is Pi's agent directory: `~/.pi/agent` by default, or the value of `PI_CODING_AGENT_DIR` (`~` is expanded).

| Path | What |
| --- | --- |
| `<agentDir>/extensions/pi-instabox/config.json` | Configuration (the global layer above) |
| `<agentDir>/pi-instabox/templates.json` | Per-box template cache: each box's `tools/list` plus the remote `serverInfo.version` and `fetchedAt`. Load-time declarations come from this file alone (no ssh, no notification), and the box they come from is picked cache-first: the session target (only if that box has a cache entry) → `defaultBox` (same condition) → the most recently fetched box in the cache. With an empty cache the session start does not use the resolution chain: it takes the first box in `state === "running"` or, when no box is running, the first box in the list; a running box needs no wake, a paused one is woken in the background first (no progress UI). Each session start then validates the chosen box with one handshake (waking it first if it is paused): the same `serverInfo.version` reuses the cache untouched, a different version refetches `tools/list` and rewrites that box's entry, a 168-hour TTL refetches regardless of version, and a failed validation silently falls back to the cached tools. The version compared is whatever that handshake returns — there is nothing to configure |
| `<agentDir>/logs/pi-instabox/pi-instabox.jsonl` | Event log (`0700` directory, `0600` file): one JSON record per event, rotated at 1 MiB into `.1` … `.3`. Logging starts at extension load (config and paths resolved, before the CLI probe), so a failed probe is on record too; safe to delete. See [Logs](#logs) |

## Logs

Every session appends structured events to `<agentDir>/logs/pi-instabox/pi-instabox.jsonl` (directory `0700`, file `0600`) from the moment the extension loads — config and paths are resolved first, then logging is wired, and only then does the `instabox version` probe run. A probe that fails or times out is therefore on record too; a session with no CLI writes exactly one `cli.probe` record and nothing else. Assembly failures also write log records only: no template cache, no other runtime files.

- **Format:** one JSON record per line — `{"ts":"2026-11-09T12:00:00.000Z","level":"info","event":"session.start","fields":{…}}`. Event data lives under `fields` rather than being flattened into the record: `undefined` values are dropped, string values are truncated at 2000 characters, and a field whose key matches `token|secret|password|api[-_]?key` is written as `"[redacted]"`. Messages and payloads are never logged — events carry names, states, counts and timings (`box`, `source`, `mentions`, `candidates`, `ms`, …), never prompt text or tool arguments.
- **Levels:** `info` by default (lifecycle plus one `resolve` record per tool call, so box selection can be audited after the fact without any switch). `PI_INSTABOX_DEBUG=1` switches the file to `debug`, which additionally records pool state samples, spawn argv, template cache hits and per-tree target changes. `warn`/`error` records are written at both levels, so failures never disappear because you left debug off. `off` exists only in code (`createFileLogger({ level: "off" })`); there is no switch for it.
- **Rotation:** at 1 MiB the file is rolled into `pi-instabox.jsonl.1` … `pi-instabox.jsonl.3` (`.1` is the newest). The size check runs after the write, so a freshly rolled main file is empty and reappears on the next event.
- **Write failures never reach the session:** a directory or append failure is reported once through the internal debug channel and swallowed; logging is never a precondition for the tools working.

| Event | Level | Fields |
| --- | --- | --- |
| `cli.probe` | info / warn | `ok`, `reason` (`missing` / `timeout` / `error`), `version`, `ms` |
| `cli.ls` | info | `ok`, `count`, `reason`, `ms` |
| `cli.lifecycle` | info | `command` (`start` / `wake` / `resume`), `box`, `ok`, `reason`, `ms` |
| `cli.exec` | info | `box`, `timeoutSec`, `ok`, `ms` |
| `load.assembled` | info | `cacheHit`, `box`, `tools` (declared at load time) |
| `session.start` | info | `target`, `source` (session start reason), `mode` |
| `session.tree` | debug | `target` |
| `session.shutdown` | info | `open` (connections disposed) |
| `resolve` | info | `param`, `source` (`param` / `message` / `session` / `config` / `first`), `box`, `mentions`, `candidates` (first 10), `degraded` (a missing `defaultBox` was skipped) |
| `resolve.fail` | warn | `kind` (`no-boxes` / `invalid-param` / `invalid-session` / `ambiguous` / `invalid-config`), `message`, `candidates` (first 10) |
| `pool.connect` | info | `box`, `ok`, `ms`, `error` |
| `pool.prepare` | info / warn | `box`, `ok`, `ms` (the whole prepare phase), `step` (`wake` / `start` / `resume` / `confirm` / `connect`; only when the budget ran out), `timeoutMs` (the budget that step got) |
| `pool.wake` | info / warn | `box`, `step` (`wake` / `start` / `resume`), `ok`, `ms`, `timeoutMs` (that step's budget) |
| `pool.state` | debug | `box`, `state`, `desiredState` |
| `pool.reuse` | debug | `box` |
| `pool.dispose` | debug | `box` |
| `remote.spawn` | debug | `command`, `args` |
| `remote.initialize` | info | `ok`, `ms`, `protocolVersion`, `serverInfoVersion` |
| `remote.listTools` | info | `ok`, `count`, `ms` |
| `remote.call` | info | `tool`, `ok`, `ms`, `isError` |
| `template.hit` | debug | `box`, `serverInfoVersion`, `stale` (TTL expired) |
| `template.refetch` | info | `box`, `reason`, `ms`, `tools` |
| `template.fail` | warn | `box`, `error`, `stale` (a cached template was kept) |
| `tool.call` | info | `tool`, `box`, `ok`, `ms`, `isError` |
| `codemode` | debug | `state` (`active` / `inactive` / `missing`), `server` (a codemode-exposure MCP server exists) |
| `devtools.register` | info | `box`, `ok` |
| `devtools.enabled` | info | `box`, `source` (`session` / `flag` / `config` / `command`) |
| `devtools.disabled` | info | — (no fields) |
| `devtools.reset` | info | — (no fields) |
| `devtools.prepare` | info / warn | `box`, `ok`, `ms`, `error` (registration is skipped when `ok` is false) |
| `devtools.install` | info / warn | `box`, `ok`, `skipped` (`autoInstallDevTools` off) |
| `error` | warn | `where`, `message` (a swallowed failure: session branch, `session_start` background task, `ui.notify`) |

**Diagnosing a wrong box.** The successful `resolve` records are `info`-level, so they are on disk at the default level — no switch needed, just filter:

```bash
grep '"event":"resolve"' ~/.pi/agent/logs/pi-instabox/pi-instabox.jsonl
```

Each record says which of the five levels won (`source`), which box that produced (`box`), every box name found in the last user message (`mentions` — recorded even when it is empty, and empty is exactly what sends the call to the next level), the names that were in play (`candidates`) and whether a stale `defaultBox` was skipped (`degraded`). Hard failures land right next to them as `resolve.fail` with `kind` and `candidates`: an unknown `box` parameter, an unknown session target, a message naming two boxes, or an empty box list. `PI_INSTABOX_DEBUG=1` adds the detail around the decision (pool state samples, spawn argv, template hits), not the decision itself.

## DevTools MCP

The remote `chrome-devtools-mcp` server is **on by default** (`devTools: true`). These inputs decide the switch and the box; for the switch the first one that is set wins:

| Input | Meaning |
| --- | --- |
| `--instabox-devtools` | Force the capability on (boolean, default `false`) |
| `--no-instabox-devtools` | Force it off (boolean, default `false`); wins over the config default |
| `INSTABOX_MCP_DEVTOOLS` | `0` / `1`, sits between the flags and the config |
| `devTools` (config) | The switch itself (boolean, default `true`) |
| `--instabox-devtools-box <name>` | The box that hosts the server; beats `devToolsBox`, loses to the session binding (string, default `""`) |
| `/instabox-devtools [status\|on [box]\|off\|reset]` | The runtime override for this session plus the session binding (see below) |

To turn it off: `--no-instabox-devtools`, `"devTools": false` in `config.json`, `INSTABOX_MCP_DEVTOOLS=0`, or `/instabox-devtools off` for the current session. All of them speak the same vocabulary: the switch is `devTools`, its state is `on` / `off`.

The box is resolved in this order: the **session binding** written by `/instabox-devtools on <box>` (a branch-scoped session entry, so it survives `--continue` and follows `/tree`), then `--instabox-devtools-box`, then `config.devToolsBox`. With none of the three — and the switch on — **no server is registered**. Because the switch is on by default that is background behaviour and **stays silent** (one `[pi-instabox] …` debug line, visible with `PI_INSTABOX_DEBUG=1`); a box that `instabox ls` does not list is treated the same way — no registration, never silently swapped for another box, no warning unless you asked for the server explicitly. Passing only `--instabox-devtools-box` while the switch is explicitly off warns once and enables nothing; `config.devToolsBox` alone is silent, because the config only supplies a default box.

With the switch on, the extension first prepares the box and then registers **one plain stdio MCP server** named `instabox-devtools`:

```json
{ "command": "instabox", "args": ["ssh", "<box>", "--", "env", "PATH=<remotePath>", "chrome-devtools-mcp", "...devToolsArgs"] }
```

That is exactly the entry you could write into `mcp.json` yourself — the only difference is that the extension registers (and unregisters) it on demand. No script is generated, nothing is written to disk, and no extra process wraps the connection.

The preparation step is an ordinary function call made **before** `registerMcpServer`, because the MCP client never wakes a box itself and Pi does not reconnect a failed server:

1. **Make the box ready**, with the very same `pool.ensureReady()` the desktop tools use (one implementation, one set of semantics: an unknown box fails with the candidate list, a `running` box returns immediately, otherwise `wake` → `start` → `resume` with a `running` poll after each step, all inside the shared `timeouts.prepareMs` deadline). A box that cannot be made ready means **no registration** — plus one warning only when the server was requested explicitly (`--instabox-devtools` or `/instabox-devtools on`); on the default-on background path the failure is silent (debug log only).
2. **Binary check**: `instabox exec <box> --env PATH=<remotePath> --timeout 20 -- sh -c 'command -v chrome-devtools-mcp'`. If the binary is missing and `autoInstallDevTools` is on, one `sudo -n env "PATH=<remotePath>" npm i -g chrome-devtools-mcp` runs (60 s; sudo rewrites PATH from `secure_path`, so the remote PATH is passed through explicitly). A failed check or install only warns — the server is still registered, and the real `command not found` surfaces on the first MCP call.

`devToolsArgs` are appended verbatim after `chrome-devtools-mcp`; `remotePath` becomes the `PATH` of both the `instabox ssh` payload and the `instabox exec` calls above. The registration itself carries `exposure: "codemode"` and a 180-second per-request timeout (it only bounds MCP requests now — the preparation above happens before the server exists).

**`/instabox-devtools`** with no argument is `status`, and it prints five lines: the switch together with its source (`instabox-devtools: on (config)` / `on (--instabox-devtools)` / `off (--no-instabox-devtools)` / `on (INSTABOX_MCP_DEVTOOLS)` / `off (/instabox-devtools)`), the server registered in this session (`registration: <name> (via <source>)`, or `registration: (none)` when nothing is registered; `<source>` is `command` for a server registered by this command, otherwise the level that supplied the box — `session` / `flag` / `config`), the box bound to this session (`session binding: <name>` / `session binding: (unset)`), the box the next `on` or session start would use together with its source (`effective box: <name> (<source>)` / `effective box: (unset)`; the levels resolve `session` → `flag` → `config`), and the candidate boxes (`candidates: …`). The three middle lines stay separate on purpose: `reset` clears the session binding only, so `registration` keeps naming the server that is still running while `effective box` already shows where the next `on` would land. `on [box]` switches the capability on for this session and registers the server for that box (argument first, then the session binding, `--instabox-devtools-box`, `devToolsBox`) and, when a box argument is given, stores it as the session binding; re-running `on` unregisters the old registration first, so the connection is new instead of reused. An unknown box name is refused and the current state is kept. `off` switches it off for the rest of the session and unregisters the server: its tools become `exposure: "hidden"` (Pi cannot unregister a tool) and therefore disappear from codemode's `ALL_TOOLS` and `searchTools`, calls that are already in flight fail, earlier transcript messages do not change, and a later `on` opens a fresh connection. `off` does **not** clear the session binding. `reset` clears the session binding only: the next `on` (and the next session start with the switch on) falls back to `--instabox-devtools-box` → `config.devToolsBox`, the switch keeps its state, and an already registered server stays registered.

Its tools — DOM/accessibility snapshots, element screenshots, CSS cascade, network, console, traces — are not declared to the model. The model discovers them from a codemode script:

```js
const ns = describeNamespace("mcp__instabox_devtools"); // { name, tools }
// or: searchTools("devtools")
```

Because this server has `codemode` exposure, Pi activates codemode automatically while it is registered, which is also why desktop tools become reachable in the same session.

**If the first connection fails, Pi does not retry it.** The MCP server stays dead for the rest of the session, so the namespace yields nothing until you reconnect it with `/mcp`, run `/instabox-devtools on <box>` again (that registration is fresh), or restart the session. That is why the extension wakes the box and checks the binary *before* registering: by the time the stdio command runs, the box is up and the binary is in place. A box that cannot be woken is not registered at all; when you asked for the server explicitly (`--instabox-devtools`, `/instabox-devtools on`) one warning names the reason, so enable time gives a clear message instead of a dead namespace. On the default-on background path the same failure is silent (debug log only).

## Compatibility & Limitations

- **Host floor:** `pi-coding-agent >= 0.99.0` (see Requirements). The package pins the types it is compiled against, so an upgrade shows up as a `check` failure rather than a runtime surprise.
- **Your tool selection is yours:** the extension never calls `setActiveTools`, never writes `settings.json` and never edits `defaultTools`. It only reports the codemode state and the command that fixes it.
- **codemode inactive means uncallable:** the tools are registered but unreachable while codemode is off. Nothing lists them either: the model learns their names by searching (`describeNamespace("instabox-desktop")` / `searchTools("instabox")`). See the prerequisite in Usage.
- **Tool sets follow the template, not the extension:** definitions come from the cached `tools/list` of the box they came from. Different boxes may run different `instabox-computer-use` versions, so the set and the schemas can differ per box. Validation is one handshake per session start: the same remote version keeps the cached tools as they are, a different version refetches `tools/list` and rewrites the entry, and a 168-hour TTL refetches on its own. Names are stable (`instabox_desktop_<remote_name>`), so a codemode script that names a tool keeps working across versions.
- **Quiet by design:** a successful background sync says nothing at all — the tools simply show up, and the transcript carries no notification about the declaration. The only session-start warnings are "no usable sandbox" (`ls` empty or failing) and a failed sync naming `/instabox-use <box>`. DevTools stays silent unless you asked for it explicitly: with the default-on switch, a missing box, a box that `ls` does not list, a box that cannot be woken, or a failed `chrome-devtools-mcp` install only produce debug lines (`PI_INSTABOX_DEBUG=1`) and a `warn` record in the JSONL log; `--instabox-devtools` turns the same situations into one warning per session, and `--instabox-devtools-box` while the switch is explicitly off warns because that is a direct request that cannot be honoured. Internal `[pi-instabox] …` stderr output and the `debug`-level half of the JSONL log (see [Logs](#logs)) are off by default; set `PI_INSTABOX_DEBUG=1` to see wakes, spawn argv and handshake internals. Box selection needs no switch: each tool call writes its `resolve` record at `info`.
- **A fully paused fleet is still woken:** when no box is running, the first box from `instabox ls` is woken in the background and its template fetched — the wake happens on connect, so a cached box that is paused gets woken for the version check too; a wake failure degrades to that one warning, and the session is never blocked or held up.
- **Desktop screenshots are expensive:** for browser work prefer the DevTools server (on by default); switch it off with `--no-instabox-devtools` or `"devTools": false` when you do not need it. The namespace instructions tell the model the same.
- **`box` covers desktop tools only:** it selects the sandbox for `instabox_desktop_*` calls. The DevTools server is bound to one box — session binding first, then `--instabox-devtools-box`, then `devToolsBox`; switch the box at runtime with `/instabox-devtools on <box>` (which also updates the session binding), no reload needed, and `/instabox-devtools reset` drops the binding again. The capability itself follows `devTools` (default `true`) until a flag or `/instabox-devtools off` says otherwise.
- **`off` leaves names behind:** `/instabox-devtools off` only hides the server's tools. Tool names that already appear in the transcript can still be tried by the model and then fail, because the connection is gone and Pi does not reload history.

## Development

```bash
pnpm --filter @inobit/pi-instabox check      # tsc --noEmit
pnpm --filter @inobit/pi-instabox test       # vitest
pnpm --filter @inobit/pi-instabox pack:check # tarball contents
pi -ne -e builtin:codemode -e builtin:mcp -e ./packages/pi-instabox
```

The smoke command has to bring the built-ins back: `-ne` / `--no-extensions` disables `codemode` and `mcp` along with every installed extension, and without them the desktop tools cannot be called and `registerMcpServer` fails. Unit tests stay offline — every external edge (`exec`, `spawn`, filesystem, clock, `Text`) is injectable, so no test spawns `instabox`, connects to a box or touches the network.

## License

MIT
