# @inobit/pi-instabox

[English](./README.md) | **中文**

在 Pi 会话里驱动 instabox 沙箱：九个 `instabox_desktop_*` 桌面工具，每次调用都明说自己打到哪台箱；另可选一个绑定单台箱的远端 `chrome-devtools-mcp` server。

- **每次调用都点名箱**：可选的 `box` 参数（或五级目标解析链）决定哪台沙箱执行，且每条成功结果首行固定为 `[box=<name>]`
- **不静默降级**：箱名写错或有歧义就是错误并列出候选；唯一会降级的是失效的 `defaultBox`（每会话一条 warning）
- **schema 来自远端**：工具定义由目标箱的 `tools/list` 生成并按箱缓存，加载期的工具声明不需要 ssh
- **不碰你的工具选择集**：桌面工具是 `exposure: "codemode"`，扩展从不调用 `setActiveTools`

## 环境要求

- **`@earendil-works/pi-coding-agent >= 0.99.0`**——硬门槛。本包依赖的 `exposure`、`namespace`、`registerMcpServer` 与 codemode/MCP 支持自 0.99.0 起才有，更早的宿主无法加载。
- Node.js **>= 24**。
- `PATH` 上有 `instabox` CLI（`instabox version`、`instabox ls --json`、`instabox ssh`、`instabox wake|start|resume`、`instabox exec`）。没有 CLI 时扩展零注册——无工具、无命令、无 MCP server、不写任何文件——只每会话给一条 warning；若只是首次 `instabox version` 探测超时，会在会话启动时用更大预算重试一次再下这个结论。
- 沙箱模板带 `instabox-computer-use`（本扩展通过 `instabox ssh <box> -- instabox-computer-use mcp` 驱动这个远端 MCP server）。

## 安装

```bash
pi install npm:@inobit/pi-instabox
```

重启 Pi 会话生效。

## 用法

**桌面工具。** 目标箱远端 `tools/list` 的每个条目变成一个 pi 工具，名为 `instabox_desktop_<远端名>`（本包面向的 `instabox-computer-use` 是九个，如 `instabox_desktop_click`），label 为 `instabox desktop <远端名>`，统一挂在 `instabox-desktop` 命名空间（别名 `instabox_desktop`）下，`exposure: "codemode"`。

每个工具都有一个可选 `box` 参数。不传时按下面的顺序解析目标，先命中先停：

1. 本次调用的 `box` 参数；
2. 当前分支里最后一条 user 消息提到的唯一箱名；
3. 会话目标（由 `/instabox-use` 设置）；
4. 配置里的 `defaultBox`；
5. `instabox ls` 返回的第一台。

第 1–3 级都是严格的：写错的名字是硬错误，消息里出现多个箱名是 `ambiguous`——都不猜、也都不退到下一级。只有第 4 级会降级（退到第 5 级，带一条 warning）。每条成功结果首行是 `[box=<name>]`；远端内容（文本与图片）原样透传，远端报错时保留 `isError`，并追加一行说明「未重试、未换箱」及两条补救。

**`/instabox-use [box]`**——设置或查看本会话的目标箱。不带参数时打印当前目标与候选箱；箱名不存在则拒绝，原目标保留。目标以一条自定义会话条目存储（不进 LLM 上下文，按分支生效，因此 `/tree` 切分支与 `--continue` 都能恢复）。若当时还没注册任何桌面工具（冷启动、无缓存），这条命令还会唤醒该箱、拉取 `tools/list` 并注册工具——这就是会话启动时箱子没在跑的重试路径。

**`/instabox-status`**——一次性诊断：配置摘要、会话目标、解析出的目标及其来源、已注册的 `instabox_desktop_*` 工具与 exposure、当前声明来自哪台箱的缓存模板（`tool declarations: from the cached template of box "…"`）、active tools、codemode 状态，以及扩展注册的 MCP server。

**codemode 前提。** `codemode` exposure 的含义是：工具已注册、可调用，但不直接声明给模型——模型要在 codemode 脚本里通过 `describeTool`、`searchTools`、`describeNamespace` 找到它们。扩展不会替你激活 codemode，且只在**已注册桌面工具**时才判定状态（会话启动一次，`/instabox-status` 每次实时读）。若 codemode 未激活、且会话里没有 `codemode` exposure 的 MCP server，你会收到每会话一条 warning 并附带补救命令：用 `pi --tools +codemode` 启动，或在 settings 里设 `"defaultTools": ["+codemode"]`。若本会话根本没有 `codemode` 工具条目（被 `--tools` / `--exclude-tools` 剔除，或内置扩展被替换），则用另一条一次性文案明说桌面工具在本会话不可调用。配了 `devToolsBox` 时 pi 会自动激活 codemode（见下文），因此两条提示都不会出现。两种情况下 `/instabox-use` 与 `/instabox-status` 都可用。

## 配置

可选 `config.json`（全局 `<agentDir>/extensions/pi-instabox/config.json`，或 trusted 时项目 `<cwd>/.pi/extensions/pi-instabox/config.json`）：

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

| 键 | 默认值 | 含义 |
| --- | --- | --- |
| `defaultBox` | `""` | 解析链靠后的兜底目标；空串＝未配置（退到 `instabox ls` 第一台） |
| `devToolsBox` | `""` | 承载 `chrome-devtools-mcp` 的唯一箱；空串＝该能力整体不存在 |
| `autoInstallDevTools` | `true` | 远端缺 `chrome-devtools-mcp` 时尝试一次 `sudo -n env "PATH=<remotePath>" npm i -g chrome-devtools-mcp` |
| `remotePath` | `/opt/npm/bin:/usr/local/bin:/usr/bin:/bin` | 箱内使用的 PATH；默认值覆盖目前已在箱模板上见到的 npm 前缀 |
| `devToolsArgs` | 见上 | 原样透传给 `chrome-devtools-mcp` |
| `timeouts.wakeMs` | `50000` | `instabox wake` 上界（自动暂停的箱） |
| `timeouts.startMs` | `120000` | `instabox start` / `instabox resume` 上界 |
| `timeouts.connectMs` | `15000` | 从 spawn 到远端 MCP server 吐出第一个字节 |
| `timeouts.initializeMs` | `20000` | `initialize` 请求 |
| `timeouts.listToolsMs` | `20000` | `tools/list` 请求 |
| `timeouts.callMs` | `120000` | `tools/call` 请求（含截图的桌面操作） |

叠加顺序后者覆盖前者：内置默认值 → 全局 `config.json` → 项目 `config.json`（仅 trusted 项目）→ 环境变量。非法值被忽略，即该层保留下一层的值；`timeouts` 逐字段合并，显式写 `"devToolsArgs": []` 表示清空。

环境变量（空串＝未设置）：`INSTABOX_MCP_DEFAULT_BOX`、`INSTABOX_MCP_DEVTOOLS_BOX`、`INSTABOX_MCP_AUTO_INSTALL`（`0` / `1`）、`INSTABOX_MCP_PATH`（远端 PATH）。

## 路径

`<agentDir>` 是 pi 的 agent 目录：默认 `~/.pi/agent`，可用 `PI_CODING_AGENT_DIR` 覆盖（`~` 会展开）。

| 路径 | 内容 |
| --- | --- |
| `<agentDir>/extensions/pi-instabox/config.json` | 配置文件（即上文的全局层） |
| `<agentDir>/pi-instabox/templates.json` | per-box 模板缓存：每台箱的 `tools/list` 加远端 `serverInfo.version` 与 `fetchedAt`。加载期的工具声明只读这个文件（零 ssh），声明来自哪台箱是**缓存优先**的：会话目标（该箱有缓存条目才算）→ `config.defaultBox`（同上）→ 缓存里最近拉取的那台；只有缓存为空时才走解析链（本轮 user 消息 → 会话目标 → `defaultBox` → `ls` 第一台）。随后每次会话启动用一次握手校验该箱：`serverInfo.version` 相同就复用缓存、不动磁盘，不同则重拉 `tools/list` 并重写该箱条目；另有 168 小时 TTL 兜底（超期无论版本是否相同都会重拉）。比对用的就是这次握手返回的 `serverInfo.version`，无需额外配置 |
| `<agentDir>/pi-instabox/bin/devtools-connect.sh` | 生成的 helper（权限 `0755`），用于连接远端 `chrome-devtools-mcp`。只在设置了 `devToolsBox` 时写入；可以删，下次加载会重新生成并 `chmod 0755` |

## DevTools MCP

`devToolsBox` 为空 → 该能力整体不存在：不写 helper、不注册 MCP server、不建目录。`devToolsBox` 有值 → 扩展写 helper，并注册一个名为 `instabox-devtools` 的 MCP server，其 `command` 就是该 helper，于是远端 `chrome-devtools-mcp` 在这台固定箱里经 `instabox ssh` 运行。它的 `exposure` 是 `codemode`，每请求超时 120 秒；箱上缺该二进制且 `autoInstallDevTools` 开启时，helper 会尝试一次 `sudo -n env "PATH=<remotePath>" npm i -g chrome-devtools-mcp`（sudo 会按 `secure_path` 重写 PATH，所以远端 PATH 显式再传一遍），其全部诊断信息只写 stderr，避免污染 stdout 上的 JSON-RPC 帧。

它的工具——DOM/无障碍快照、元素截图、CSS 级联、网络、console、性能 trace——不会声明给模型。模型在 codemode 脚本里发现它们：

```js
const ns = describeNamespace("mcp__instabox_devtools"); // { name, tools }
// 或: searchTools("devtools")
```

正因为这个 server 是 `codemode` exposure，pi 会自动激活 codemode，这也是同一会话里桌面工具变得可调用的原因。

## 兼容与限制

- **宿主门槛：**`pi-coding-agent >= 0.99.0`（见环境要求）。本包钉死编译所用类型，升级只会体现为 `check` 失败，而不是运行期意外。
- **工具选择集归你：**扩展从不调用 `setActiveTools`，不写 `settings.json`，也不改 `defaultTools`；它只报告 codemode 状态与补救命令。
- **codemode 未激活＝不可调用：**工具已注册，但 codemode 关掉时模型够不到它们，在 codemode 之外也看不到工具名。见「用法」里的前提说明。
- **工具集跟随模板而非扩展：**定义来自该箱缓存的 `tools/list`。不同箱可能跑不同版本的 `instabox-computer-use`，因此工具集与 schema 可能逐箱不同。校验口径是每次会话启动一次握手：远端版本相同则沿用缓存的工具、不动磁盘，不同则重拉并重写该箱条目，另有 168 小时 TTL 单独触发重拉。工具名稳定（`instabox_desktop_<远端名>`），所以写死了名字的 codemode 脚本跨版本仍可用。
- **桌面截图成本高：**配置了 DevTools server 时，浏览器相关工作优先走它；命名空间说明里也对模型传达了同一条。
- **`box` 只作用于桌面工具：**它为 `instabox_desktop_*` 调用选择沙箱。DevTools server 固定绑定 `devToolsBox`，改它需要重新加载扩展。

## 开发

```bash
pnpm --filter @inobit/pi-instabox check      # tsc --noEmit
pnpm --filter @inobit/pi-instabox test       # vitest
pnpm --filter @inobit/pi-instabox pack:check # tarball 内容
pi -ne -e builtin:codemode -e builtin:mcp -e ./packages/pi-instabox
```

冒烟命令必须把内置扩展带回来：`-ne` / `--no-extensions` 会连同已安装的扩展一起禁用 `codemode` 与 `mcp`，缺了它们桌面工具无法调用、`registerMcpServer` 也会失败。单测全程离线——每处外部边界（`exec`、`spawn`、文件系统、时钟、`Text`）都可注入，因此没有测试会 spawn `instabox`、连箱子或访问网络。

## 许可证

MIT
