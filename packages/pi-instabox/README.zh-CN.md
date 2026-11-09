# @inobit/pi-instabox

[English](./README.md) | **中文**

在 Pi 会话里驱动 instabox 沙箱：九个 `instabox_desktop_*` 桌面工具，每次调用都明说自己打到哪台箱；另有一个绑定单台箱的远端 `chrome-devtools-mcp` server，**默认关闭**，需 `--instabox-devtools` 才开启。

- **每次调用都点名箱**：可选的 `box` 参数（或五级目标解析链）决定哪台沙箱执行，且每条成功结果首行固定为 `[box=<name>]`
- **不静默降级**：箱名写错或有歧义就是错误并列出候选；唯一会降级的是失效的 `defaultBox`（每会话一条 warning）
- **schema 来自远端**：工具定义由目标箱的 `tools/list` 生成并按箱缓存，加载期的工具声明不需要 ssh
- **不碰你的工具选择集**：桌面工具是 `exposure: "codemode"`，扩展从不调用 `setActiveTools`

## 环境要求

- **`@earendil-works/pi-coding-agent >= 0.99.0`**——硬门槛。本包依赖的 `exposure`、`namespace`、`registerMcpServer` 与 codemode/MCP 支持自 0.99.0 起才有，更早的宿主无法加载。
- Node.js **>= 24**。
- `PATH` 上有 `instabox` CLI（`instabox version`、`instabox ls --json`、`instabox ssh`、`instabox wake|start|resume`、`instabox exec`）。没有 CLI 时扩展零注册——无工具、无命令、无 MCP server、不写运行期文件（无模板缓存、无 helper）——只每会话给一条 warning；唯一的落盘产物是事件日志里那一条 `cli.probe`。若只是首次 `instabox version` 探测超时，会在会话启动时用更大预算重试一次再下这个结论。
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

**`/instabox-status`**——一次性诊断：配置摘要（`defaultBox`、`devToolsBox`、`autoInstallDevTools`、`remotePath`——那里出现的 `devToolsBox` 只是 DevTools 的默认箱，不是开关）、会话目标、解析出的目标及其来源、已注册的 `instabox_desktop_*` 工具与 exposure、当前声明来自哪台箱的缓存模板（`tool declarations: from the cached template of box "…"`）、active tools、codemode 状态，以及扩展注册的 MCP server——`instabox-devtools` 只在 DevTools server 开着时出现在最后这一段；开关本身由 `/instabox-devtools status` 报告（见 [DevTools MCP](#devtools-mcp)）。

**`/instabox-devtools [status|on [box]|off]`**——远端 DevTools MCP server 的运行期开关：不带参数（或 `status`）显示开关、将使用的箱与是否已注册；`on [box]` 注册或替换；`off` 在本会话内注销它。细节见 [DevTools MCP](#devtools-mcp)。

**工具声明的来源。**加载期命中缓存就静默注册桌面工具——零 ssh、零提示。否则会话启动在后台替你决定：有缓存时对「声明来源」那台箱做一次版本校验（会话目标 → `defaultBox` → 缓存里最近拉取的那台，均要求该箱有缓存条目）；没有缓存时先 `ls`，取**第一台 `state === "running"`** 的箱，一台 running 都没有时取列表第一台。**连接即唤醒**：无论桌面工具调用还是这个后台同步，建连前都先确保箱子在跑（`instabox wake`、再 `instabox start`、再 `instabox resume`），因此暂停的箱会在后台被唤醒——不显示进度、不阻塞会话——而不是被跳过。成功一律静默：工具出现就是唯一的成功信号。只有真的同步不了才提示：`instabox ls` 为空或失败 → 一条「没有可用沙箱」；同步本身失败 → 一条带 `/instabox-use <box>` 的提示，都是每会话一次。

**codemode 前提。** `codemode` exposure 的含义是：工具已注册、可调用，但不直接声明给模型——模型要在 codemode 脚本里通过 `describeTool`、`searchTools`、`describeNamespace` 找到它们。扩展不会替你激活 codemode，且只在**已注册桌面工具**时才判定状态（会话启动一次，`/instabox-status` 每次实时读）。若 codemode 未激活、且会话里没有 `codemode` exposure 的 MCP server，你会收到每会话一条 warning 并附带补救命令：用 `pi --tools +codemode` 启动，或在 settings 里设 `"defaultTools": ["+codemode"]`。若本会话根本没有 `codemode` 工具条目（被 `--tools` / `--exclude-tools` 剔除，或内置扩展被替换），则用另一条一次性文案明说桌面工具在本会话不可调用。配置了 DevTools server 时（`--instabox-devtools` 或 `/instabox-devtools on`），pi 会自动激活 codemode（见下文），因此两条提示都不会出现。两种情况下 `/instabox-use` 与 `/instabox-status` 都可用。

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
| `devToolsBox` | `""` | DevTools server 开启后 `chrome-devtools-mcp` 的默认箱；它本身不开启该能力，且 `--instabox-devtools-box` 可覆盖它 |
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
| `<agentDir>/pi-instabox/templates.json` | per-box 模板缓存：每台箱的 `tools/list` 加远端 `serverInfo.version` 与 `fetchedAt`。加载期的工具声明只读这个文件（零 ssh、零提示），声明来自哪台箱是**缓存优先**的：会话目标（该箱有缓存条目才算）→ `config.defaultBox`（同上）→ 缓存里最近拉取的那台。**缓存为空时后台不走解析链**：取第一台 `state === "running"` 的箱，一台 running 都没有时取列表第一台；running 的箱不需要唤醒，暂停的箱会先在后台被唤醒（不显示进度）。随后每次会话启动用一次握手校验该箱（暂停时会先唤醒它）：`serverInfo.version` 相同就复用缓存、不动磁盘，不同则重拉 `tools/list` 并重写该箱条目；另有 168 小时 TTL 兜底（超期无论版本是否相同都会重拉），校验失败则静默沿用缓存。比对用的就是这次握手返回的 `serverInfo.version`，无需额外配置 |
| `<agentDir>/pi-instabox/bin/devtools-connect.sh` | 生成的 helper（权限 `0755`），用于连接远端 `chrome-devtools-mcp`。只在 DevTools server 真的开启时（`--instabox-devtools` 或 `/instabox-devtools on`）写入；可以删，下次加载或下次 `on` 会重新生成并 `chmod 0755` |
| `<agentDir>/logs/pi-instabox/pi-instabox.jsonl` | 事件日志（目录 `0700`、文件 `0600`）：一行一事件，超 1 MiB 轮转为 `.1` … `.3`。**扩展加载时**（配置与路径解析完、CLI 探测前）就开始记，因此探测失败也有记录；可以删。见[日志](#日志) |

## 日志

每个会话从**扩展加载时**起就往 `<agentDir>/logs/pi-instabox/pi-instabox.jsonl` 追加结构化事件（目录 `0700`、文件 `0600`）：先解析配置与路径，随即接上日志，然后才跑 `instabox version` 探测——所以探测失败/超时也有记录；没有 CLI 的会话只有 `cli.probe` 那一条，别的不写。装配失败同样只写日志，不建模板缓存、不写 helper、不建 `bin/`。

- **格式：**一行一条 JSON —— `{"ts":"2026-11-09T12:00:00.000Z","level":"info","event":"session.start","fields":{…}}`。事件数据在 `fields` 子对象里，不摊平到顶层：`undefined` 字段被丢掉，字符串截断到 2000 字符，键名命中 `token|secret|password|api[-_]?key` 的字段整体写成 `"[redacted]"`。**消息正文与调用参数从不写盘**——事件只带名字、状态、计数与耗时（`box`、`source`、`mentions`、`candidates`、`ms` 等）。
- **级别：**默认 `info`（生命周期 + 每一次工具调用一条 `resolve`，选箱可事后复盘，不需要任何开关）。`PI_INSTABOX_DEBUG=1` 把文件切到 `debug`，额外记池状态采样、spawn 参数、模板缓存命中与 `session_tree` 的目标切换。`warn` / `error` 记录在两个级别下都写，所以「忘了开 debug」不会让失败消失。`off` 只存在于代码层（`createFileLogger({ level: "off" })`），没有对外开关。
- **轮转：**到 1 MiB 就滚动成 `pi-instabox.jsonl.1` … `pi-instabox.jsonl.3`（`.1` 最新）。大小判定在**写入之后**，所以刚滚动完的主文件是空的，下一条事件写入时重新出现。
- **写盘失败不进会话：**建目录或追加失败只经内部 debug 渠道报一次然后吞掉；日志永远不是工具可用的前提。

| 事件 | 级别 | 字段 |
| --- | --- | --- |
| `cli.probe` | info / warn | `ok`、`reason`（`missing` / `timeout` / `error`）、`version`、`ms` |
| `cli.ls` | info | `ok`、`count`、`reason`、`ms` |
| `cli.lifecycle` | info | `command`（`start` / `wake` / `resume`）、`box`、`ok`、`reason`、`ms` |
| `cli.exec` | info | `box`、`timeoutSec`、`ok`、`ms` |
| `load.assembled` | info | `cacheHit`、`box`、`tools`（加载期声明的工具数） |
| `session.start` | info | `target`、`source`（会话启动原因）、`mode` |
| `session.tree` | debug | `target` |
| `session.shutdown` | info | `open`（收掉的连接数） |
| `resolve` | info | `param`、`source`（`param` / `message` / `session` / `config` / `first`）、`box`、`mentions`、`candidates`（前 10 个）、`degraded`（跳过了失效的 `defaultBox`） |
| `resolve.fail` | warn | `kind`（`no-boxes` / `invalid-param` / `invalid-session` / `ambiguous` / `invalid-config`）、`message`、`candidates`（前 10 个） |
| `pool.connect` | info | `box`、`ok`、`ms`、`error` |
| `pool.wake` | info / warn | `box`、`step`（`wake` / `start` / `resume`）、`ok`、`ms` |
| `pool.state` | debug | `box`、`state`、`desiredState` |
| `pool.reuse` | debug | `box` |
| `pool.dispose` | debug | `box` |
| `remote.spawn` | debug | `command`、`args` |
| `remote.initialize` | info | `ok`、`ms`、`protocolVersion`、`serverInfoVersion` |
| `remote.listTools` | info | `ok`、`count`、`ms` |
| `remote.call` | info | `tool`、`ok`、`ms`、`isError` |
| `template.hit` | debug | `box`、`serverInfoVersion`、`stale`（TTL 已过） |
| `template.refetch` | info | `box`、`reason`、`ms`、`tools` |
| `template.fail` | warn | `box`、`error`、`stale`（沿用了缓存模板） |
| `tool.call` | info | `tool`、`box`、`ok`、`ms`、`isError` |
| `codemode` | debug | `state`（`active` / `inactive` / `missing`）、`server`（存在 codemode exposure 的 MCP server） |
| `devtools.register` | info | `box`、`ok` |
| `devtools.enabled` | info | `box`、`via`（`flag` / `command`） |
| `devtools.disabled` | info | ——（无字段） |
| `devtools.helper` | info | `ok`、`path`、`error` |
| `error` | warn | `where`、`message`（被吞掉的失败：会话分支、`session_start` 后台任务、`ui.notify`） |

**排查一次选错箱。**成功的 `resolve` 是 `info` 级，默认级别下就已经落盘——不用切级别，直接过滤：

```bash
grep '"event":"resolve"' ~/.pi/agent/logs/pi-instabox/pi-instabox.jsonl
```

每条记录说明：五级里哪一级命中（`source`）、命中的是哪台箱（`box`）、本轮 user 消息里出现了哪些箱名（`mentions`——**零命中也记**，而零命中正是「落到下一级」的原因）、当时备选的名字（`candidates`）、是否跳过了失效的 `defaultBox`（`degraded`）。硬失败就在旁边，以 `resolve.fail` 落盘，带 `kind` 与 `candidates`：`box` 参数不存在、会话目标不存在、消息里提到两台箱、或箱列表为空。`PI_INSTABOX_DEBUG=1` 打开的是决策周边的细节（池状态采样、spawn 参数、模板命中），不是决策本身。

## DevTools MCP

远端 `chrome-devtools-mcp` server **默认关闭**。三个入口决定它在一次会话里存不存在：

| 入口 | 含义 |
| --- | --- |
| `--instabox-devtools` | 打开该能力（boolean，默认 `false`） |
| `--instabox-devtools-box <name>` | 承载该 server 的箱；覆盖 `devToolsBox`（string，默认 `""`） |
| `/instabox-devtools [status\|on [box]\|off]` | 运行期开关（见下文） |

箱子按 `--instabox-devtools-box` → `config.devToolsBox` 的顺序取；两者都没配时（且开关开着）给一条 warning 说箱名缺失，**不注册**。箱不在 `instabox ls` 里也是 warning + 不注册并列出候选——绝不静默换一台。只给 `--instabox-devtools-box` 而不给开关，会有一条 warning 提示加开关、什么都不启用；只配 `config.devToolsBox` 则完全静默，因为配置只负责提供默认箱。

开关打开后，扩展写 helper，并注册一个名为 `instabox-devtools` 的 MCP server，其 `command` 就是该 helper，于是远端 `chrome-devtools-mcp` 在这台固定箱里经 `instabox ssh` 运行。它的 `exposure` 是 `codemode`，每请求超时 180 秒；连接前 helper 会先把目标箱拉起来（`instabox wake`，失败再 `instabox start`）——MCP 客户端自己从不唤醒箱，一台暂停的箱否则会赔上整场会话。箱上缺该二进制且 `autoInstallDevTools` 开启时，helper 接着尝试一次 `sudo -n env "PATH=<remotePath>" npm i -g chrome-devtools-mcp`（sudo 会按 `secure_path` 重写 PATH，所以远端 PATH 显式再传一遍），其全部诊断信息只写 stderr，避免污染 stdout 上的 JSON-RPC 帧。预算都在那个超时之内：检查 10 秒、安装 40 秒，输出一律丢进 `/dev/null`。

**`/instabox-devtools`** 不带参数就是 `status`，打印三行：开关（`instabox-devtools: on (--instabox-devtools)` / `instabox-devtools: off (--instabox-devtools)`）、要用的箱以及是否已注册（`box: <名称> (registered)` / `(not registered)`）、候选箱（`candidates: …`）。`on [box]` 为该箱注册 server（箱名依次取参数、`--instabox-devtools-box`、`devToolsBox`）；重复执行 `on` 会先注销旧注册再重注，所以拿到的是新连接而不是复用旧连接。箱名不存在则拒绝且保持现状。`off` 在本会话内注销该 server：它的工具变成 `exposure: "hidden"`（pi 不支持反注册工具），因此从 codemode 的 `ALL_TOOLS` 与 `searchTools` 里消失，已经发出的调用会报错，但转录里已有的消息不变；之后再 `on` 会建立新连接。

它的工具——DOM/无障碍快照、元素截图、CSS 级联、网络、console、性能 trace——不会声明给模型。模型在 codemode 脚本里发现它们：

```js
const ns = describeNamespace("mcp__instabox_devtools"); // { name, tools }
// 或: searchTools("devtools")
```

正因为这个 server 是 `codemode` exposure，它在注册期间会让 pi 自动激活 codemode，这也是同一会话里桌面工具变得可调用的原因。

**首次连接失败时 pi 不会自己重试。**该 MCP server 会一直处于失败状态直到你用 `/mcp` 重连、再执行一次 `/instabox-devtools on <box>`（这是一次全新注册）或重启会话，期间命名空间里拿不到任何工具。所以 helper 在交给 `instabox ssh` 之前先自己补救一次：先 `wake`，失败再 `start`；这一步也失败不阻断，真正的原因由后续步骤原样报到 stderr。

## 兼容与限制

- **宿主门槛：**`pi-coding-agent >= 0.99.0`（见环境要求）。本包钉死编译所用类型，升级只会体现为 `check` 失败，而不是运行期意外。
- **工具选择集归你：**扩展从不调用 `setActiveTools`，不写 `settings.json`，也不改 `defaultTools`；它只报告 codemode 状态与补救命令。
- **codemode 未激活＝不可调用：**工具已注册，但 codemode 关掉时模型够不到它们，在 codemode 之外也看不到工具名。见「用法」里的前提说明。
- **工具集跟随模板而非扩展：**定义来自该箱缓存的 `tools/list`。不同箱可能跑不同版本的 `instabox-computer-use`，因此工具集与 schema 可能逐箱不同。校验口径是每次会话启动一次握手：远端版本相同则沿用缓存的工具、不动磁盘，不同则重拉并重写该箱条目，另有 168 小时 TTL 单独触发重拉。工具名稳定（`instabox_desktop_<远端名>`），所以写死了名字的 codemode 脚本跨版本仍可用。
- **默认安静：**后台声明成功不提示——成功路径没有任何通知，工具直接出现。会话启动只有三种提示：`ls` 空/失败的「没有可用沙箱」、同步失败并给出 `/instabox-use <box>`，以及 DevTools 开关配置有误（箱名缺失、箱不在 `ls` 里、或只给了 `--instabox-devtools-box` 没给 `--instabox-devtools`，见 [DevTools MCP](#devtools-mcp)）。内部 `[pi-instabox] …` 的 stderr 输出与 JSONL 日志的 `debug` 级记录（见[日志](#日志)）默认关闭，设 `PI_INSTABOX_DEBUG=1` 才能看到唤醒、spawn 参数与握手内部细节；**选箱不需要开关**：每次工具调用都会以 `info` 落一条 `resolve`。
- **全部暂停也会被拉起：**没有 running 的箱时，取 `instabox ls` 第一台在后台唤醒并拉模板——唤醒发生在建连这一步，所以缓存命中但箱已暂停时也会为版本校验把它唤醒；唤醒失败降级为那一条提示，会话不会被阻塞或拖住。
- **桌面截图成本高：**DevTools server 开启时，浏览器相关工作优先走它；命名空间说明里也对模型传达了同一条。
- **`box` 只作用于桌面工具：**它为 `instabox_desktop_*` 调用选择沙箱。DevTools server 固定绑定一台箱（先 `--instabox-devtools-box`、后 `devToolsBox`）；换箱用 `/instabox-devtools on <box>`，不需要重新加载扩展。
- **`off` 会留下旧工具名：**`/instabox-devtools off` 只是把它们隐藏。转录里已经出现过的工具名仍可能被模型尝试，然后以报错告终——连接已关，而 pi 不会因为隐藏而改写历史消息。

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
