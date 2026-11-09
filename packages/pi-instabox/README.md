# @inobit/pi-instabox

**English** | [中文](./README.zh-CN.md)

Drive instabox sandboxes from Pi sessions: nine `instabox_desktop_*` computer-use tools whose every call names the box it targets, plus an optional remote `chrome-devtools-mcp` server bound to one fixed box.

- **Every call names its box**: an optional `box` parameter (or the five-level target resolution chain) decides which sandbox runs, and the first line of every successful result is `[box=<name>]`
- **No silent fallback**: a mistyped or ambiguous target is an error listing candidates; only a stale `defaultBox` degrades (with one warning per session)
- **Schemas come from the remote**: tool definitions are generated from the target box's `tools/list` and cached per box, so the load-time declarations need no ssh
- **Never touches your tool selection**: desktop tools are `exposure: "codemode"` and the extension never calls `setActiveTools`

## Requirements

- **`@earendil-works/pi-coding-agent >= 0.99.0`** — a hard floor. `exposure`, `namespace`, `registerMcpServer` and the codemode/MCP support this package builds on landed in 0.99.0; older hosts cannot load it.
- Node.js **>= 24**.
- The `instabox` CLI on `PATH` (`instabox version`, `instabox ls --json`, `instabox ssh`, `instabox wake|start|resume`, `instabox exec`). A missing CLI means the extension registers nothing — no tools, no commands, no MCP server, no files on disk — and shows one warning per session; a first `instabox version` probe that merely times out is retried once at session start with a larger budget before that verdict.
- Sandboxes whose template ships `instabox-computer-use` (the remote MCP server this extension drives over `instabox ssh <box> -- instabox-computer-use mcp`).

## Installation

```bash
pi install npm:@inobit/pi-instabox
```

Restart the Pi session to take effect.

## Usage

**Desktop tools.** Each entry of the target box's remote `tools/list` becomes one Pi tool named `instabox_desktop_<remote_name>` (nine for the `instabox-computer-use` build this package targets, e.g. `instabox_desktop_click`), labelled `instabox desktop <remote_name>`, grouped in the `instabox-desktop` namespace (alias `instabox_desktop`) with `exposure: "codemode"`.

Every tool takes an optional `box` parameter. When it is omitted, the target is resolved in this order, first match wins:

1. the `box` parameter of this call;
2. the only box name mentioned in the last user message of the current branch;
3. the session target (set with `/instabox-use`);
4. `defaultBox` from config;
5. the first box returned by `instabox ls`.

Levels 1–3 are strict: an unknown name is an error and a message naming several boxes is `ambiguous` — none of them guesses, and none falls through to the next level. Only level 4 degrades (to level 5, with one warning). Every successful result starts with `[box=<name>]`; remote content (text and images) is passed through unchanged, and a remote error keeps its `isError` flag plus one line stating that nothing was retried and no other box was used (with two remedies).

**`/instabox-use [box]`** — set or show this session's target box. Without arguments it prints the current target and the candidate boxes. An unknown name is refused and the previous target is kept. The target is stored as a custom session entry (never injected into the LLM context, scoped to the current branch, so `/tree` switches and `--continue` restore it). If no desktop tool is registered yet (cold start, no cache), the command also wakes the box, fetches `tools/list` and registers the tools — this is the retry path when the box was not running at session start.

**`/instabox-status`** — one-shot diagnostics: config summary, session target, resolved target and how it was resolved, registered `instabox_desktop_*` tools with their exposure, which box's cached template the declarations came from (`tool declarations: from the cached template of box "…"`), active tools, codemode state, and the MCP servers registered by extensions.

**codemode prerequisite.** `codemode` exposure means the tools are registered and callable, but they are not declared to the model directly — the model reaches them from codemode scripts (`describeTool`, `searchTools`, `describeNamespace`). The extension never activates codemode for you, and it only judges the state once desktop tools are registered (at session start, and on every `/instabox-status`). If codemode is inactive and no `codemode`-exposure MCP server exists, you get one warning per session with the fix: start with `pi --tools +codemode`, or set `"defaultTools": ["+codemode"]` in settings. If the session has no `codemode` tool at all (filtered out by `--tools` / `--exclude-tools`, or a built-in extension replaced), a different one-time warning says the desktop tools are not callable in this session. With `devToolsBox` set, Pi activates codemode by itself (see below), so neither warning appears. `/instabox-use` and `/instabox-status` keep working either way.

## Configuration

Optional `config.json` (global `<agentDir>/extensions/pi-instabox/config.json`, or project `<cwd>/.pi/extensions/pi-instabox/config.json` when the project is trusted):

```json
{
  "defaultBox": "",
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
    "wakeMs": 50000,
    "startMs": 120000,
    "connectMs": 15000,
    "initializeMs": 20000,
    "listToolsMs": 20000,
    "callMs": 120000
  }
}
```

| Key | Default | Meaning |
| --- | --- | --- |
| `defaultBox` | `""` | Late fallback target; empty means unset (falls back to the first `instabox ls` box) |
| `devToolsBox` | `""` | The single box hosting `chrome-devtools-mcp`; empty means the DevTools capability does not exist at all |
| `autoInstallDevTools` | `true` | Try `sudo -n env "PATH=<remotePath>" npm i -g chrome-devtools-mcp` on the box once when it is missing |
| `remotePath` | `/opt/npm/bin:/usr/local/bin:/usr/bin:/bin` | PATH used inside the box; the defaults cover the npm prefixes seen so far on box templates |
| `devToolsArgs` | see above | Passed verbatim to `chrome-devtools-mcp` |
| `timeouts.wakeMs` | `50000` | Upper bound for `instabox wake` (self-paused boxes) |
| `timeouts.startMs` | `120000` | Upper bound for `instabox start` / `instabox resume` |
| `timeouts.connectMs` | `15000` | Spawn until the first byte from the remote MCP server |
| `timeouts.initializeMs` | `20000` | `initialize` request |
| `timeouts.listToolsMs` | `20000` | `tools/list` request |
| `timeouts.callMs` | `120000` | `tools/call` request (desktop actions, screenshots included) |

Layers are applied in order, later wins: built-in defaults → the global `config.json` → the project `config.json` (trusted projects only) → environment variables. Invalid values are ignored, so that layer simply keeps the value below it; `timeouts` merges field by field, and an explicit `"devToolsArgs": []` clears the list.

Environment variables (empty means unset): `INSTABOX_MCP_DEFAULT_BOX`, `INSTABOX_MCP_DEVTOOLS_BOX`, `INSTABOX_MCP_AUTO_INSTALL` (`0` or `1`), `INSTABOX_MCP_PATH` (the remote PATH).

## Paths

`<agentDir>` is Pi's agent directory: `~/.pi/agent` by default, or the value of `PI_CODING_AGENT_DIR` (`~` is expanded).

| Path | What |
| --- | --- |
| `<agentDir>/extensions/pi-instabox/config.json` | Configuration (the global layer above) |
| `<agentDir>/pi-instabox/templates.json` | Per-box template cache: each box's `tools/list` plus the remote `serverInfo.version` and `fetchedAt`. Load-time declarations come from this file alone (no ssh), and the box they come from is picked cache-first: the session target (only if that box has a cache entry) → `defaultBox` (same condition) → the most recently fetched box in the cache; the resolution chain (last user message → session target → `defaultBox` → first `instabox ls` box) only runs when the cache is empty. Each session start then validates that box with one handshake: the same `serverInfo.version` reuses the cache untouched, a different version refetches `tools/list` and rewrites that box's entry, and a 168-hour TTL refetches regardless of version. The version compared is whatever that handshake returns — there is nothing to configure |
| `<agentDir>/pi-instabox/bin/devtools-connect.sh` | Generated (mode `0755`) helper that connects the remote `chrome-devtools-mcp`. Only written when `devToolsBox` is set; safe to delete, it comes back with `chmod 0755` on the next load |

## DevTools MCP

`devToolsBox` empty → the capability is absent: no helper script, no MCP server, no directory created. `devToolsBox` set → the extension writes the helper and registers one MCP server named `instabox-devtools` whose `command` is that helper, so the remote `chrome-devtools-mcp` runs inside that fixed box over `instabox ssh`. Its `exposure` is `codemode` with a 120-second per-request timeout; if the binary is missing on the box and `autoInstallDevTools` is on, the helper tries one `sudo -n env "PATH=<remotePath>" npm i -g chrome-devtools-mcp` (sudo rewrites PATH from `secure_path`, so the remote PATH is passed through explicitly), and all of its diagnostics go to stderr so the JSON-RPC framing on stdout stays clean.

Its tools — DOM/accessibility snapshots, element screenshots, CSS cascade, network, console, traces — are not declared to the model. The model discovers them from a codemode script:

```js
const ns = describeNamespace("mcp__instabox_devtools"); // { name, tools }
// or: searchTools("devtools")
```

Because this server has `codemode` exposure, Pi activates codemode automatically, which is also why desktop tools become reachable in the same session.

## Compatibility & Limitations

- **Host floor:** `pi-coding-agent >= 0.99.0` (see Requirements). The package pins the types it is compiled against, so an upgrade shows up as a `check` failure rather than a runtime surprise.
- **Your tool selection is yours:** the extension never calls `setActiveTools`, never writes `settings.json` and never edits `defaultTools`. It only reports the codemode state and the command that fixes it.
- **codemode inactive means uncallable:** the tools are registered but unreachable while codemode is off, and the model cannot see their names outside codemode. See the prerequisite in Usage.
- **Tool sets follow the template, not the extension:** definitions come from the cached `tools/list` of the box they came from. Different boxes may run different `instabox-computer-use` versions, so the set and the schemas can differ per box. Validation is one handshake per session start: the same remote version keeps the cached tools as they are, a different version refetches `tools/list` and rewrites the entry, and a 168-hour TTL refetches on its own. Names are stable (`instabox_desktop_<remote_name>`), so a codemode script that names a tool keeps working across versions.
- **Desktop screenshots are expensive:** for browser work prefer the DevTools server when one is configured; the namespace instructions tell the model the same.
- **`box` covers desktop tools only:** it selects the sandbox for `instabox_desktop_*` calls. The DevTools server is bound to `devToolsBox` and changing it requires reloading the extension.

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
