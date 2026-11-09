# @inobit/pi-instabox

把 instabox 沙箱的 X11 桌面交给模型操作：`instabox_desktop_*` 桌面工具（每次调用显式指定 `box`，失败不静默降级），外加一个默认关闭、需 flag 或命令开启的远端 `chrome-devtools-mcp` server。

> 环境要求、catalog、常用命令、版本与发布（含 tag 规范）、文档分工等公共约定见仓库根目录 `AGENTS.md`，本文件只写本包的目标、结构与包特有约束。

## 目标

- 远端 `instabox-computer-use` 的 `tools/list`（当前九个条目）逐条变成一个 `instabox_desktop_<远端名>` 工具，schema 由远端生成、不手写，因此不与远端版本漂移；名字稳定，codemode 脚本写死的工具名跨版本仍可用
- "这次打到哪台箱"必须显式、可回显、失败不静默降级：五级解析链（`box` 参数 → 本轮 user 消息 → 会话目标 → `defaultBox` → `ls` 第一台），参数与会话目标写错是硬错误，每条结果首行 `[box=<name>]`
- 会话目标由 `/instabox-use` 写成一条按分支生效的 entry（不进 LLM 上下文，`/tree` / `--continue` 都能恢复），并在冷启动（无缓存且没有 running 箱）时充当唯一的重试入口：唤醒 → 拉模板 → 注册
- per-box 模板缓存让「加载期零 ssh 声明工具」成立（每次会话启动仍会用一次握手校验版本，见 `src/template.ts` 的 `ensure`）；`session_start` 的后台声明**成功即静默**：有缓存走缓存优先来源，无缓存取第一台 `state === "running"` 的箱，一台 running 都没有时取列表第一台；**连接即唤醒**（后台同步也允许唤醒暂停的箱，不阻塞会话、不显示进度）
- 浏览器能力由一台固定箱的远端 `chrome-devtools-mcp` 提供，与桌面工具的目标互不影响；该能力**默认关闭**，只有 `--instabox-devtools`（或 `/instabox-devtools on [box]`）能开启，`devToolsBox` 只提供默认 box
- 不越权：不调 `setActiveTools`、不写 `settings.json`、不改用户 `defaultTools`；能力不可用时只说清状态与补救命令

## 源码结构（src/）

| 文件 | 职责 |
| --- | --- |
| `index.ts` | 工厂装配：**工厂最前面**先登记两个 flag（`--instabox-devtools` / `--instabox-devtools-box`，晚登记 pi 会当未知选项直接 exit(1)），再读配置与五路径、接上文件日志（早于 CLI 探测，因此 `cli.probe` 失败/超时也落盘），再探测 CLI（`reason` 为 `missing`/`error` 直接降级；`timeout` 则在第一次 `session_start` 用 5000ms 重试一次）+ 缓存命中即静默注册、建池/模板存储、注册工具与三个命令（`/instabox-use` / `/instabox-status` / `/instabox-devtools`）与 entry renderer、`session_start` 后台体（先按 flag 决定 DevTools 注册，再后台声明模板：缓存优先 / `ls` 取第一台 running / 一台都没有则列表第一台，连接即唤醒，成功静默）/ `session_tree` 重建、codemode 只读判定与一次性提示；`/instabox-devtools` 的 box 按「会话绑定 > `--instabox-devtools-box` > `config.devToolsBox`」取，`reset` 只清会话绑定 |
| `config.ts` | `InstaboxConfig` + `DEFAULT_CONFIG` + 逐层校验与叠加（全局层、项目层、环境变量）+ `getAgentDir()` + `resolvePaths()`（五处路径单点：`configFile` / `stateDir` / `templateCacheFile` / `helperScript` / `logDir`） |
| `cli.ts` | `instabox` CLI 薄封装：`probeVersion` / `listBoxesJson` / `start` / `wake` / `resume` / `exec`，注入 `ExecFn`；失败归一成 `{ ok: false, error, reason }`，`reason: "missing" | "timeout" | "error"`（`killed` 归 `timeout`），探测预算 3000ms、`ls` 预算 10000ms |
| `boxes.ts` | `ls --json` 解析与校验 + 会话级 5 秒 TTL 缓存（失败不缓存） |
| `resolve.ts` | 解析链纯函数：五级来源、歧义与硬错误判定、`defaultBox` 失效时带 `skippedConfig` 标记 |
| `session-target.ts` | 目标 entry 的形状与读写（`TARGET_ENTRY` / `readTarget(branchEntries)` / `targetEntryData`），只接受 `getBranch()` 的结果 |
| `entry-render.ts` | `createTargetRenderer(TextCtor)`：`theme.fg("dim", …)` 着色后交给 `new Text(text, 0, 0)`，返回 Component |
| `schema.ts` | 远端 `inputSchema` → TypeBox 的保守子集映射（未知节点回落 `Type.Unsafe`）+ 顶层 `box` 注入 |
| `remote.ts` | 远端 stdio MCP 客户端：spawn、双分帧容忍（换行分隔 / `Content-Length` 头）、请求表、四段超时、abort、`dead` 标记；注入 spawn 与 clock |
| `pool.ts` | per-box 客户端池：复用/驱逐，`allowWake: false` 路径零唤醒，其余按 `desiredState` 分流 `start`/`wake`/`resume` 并轮询确认 `running`；准备阶段共享 `prepareMs`（60s）一个截止时间，每步取 `min(单步上限, 剩余预算)`，超时统一报 `prepare timed out after 60000ms (box "…", step: …)` 并附该步 stderr 尾部 |
| `template.ts` | per-box 模板缓存（`<agentDir>/pi-instabox/templates.json`）+ `serverInfoVersion`/TTL 比对 + 拉取编排（注入 client/fs/clock；`ensure(box, { allowWake })` 原样透传给客户端工厂，自身从不唤醒） |
| `tools.ts` | 工具定义（名字/label/namespace/exposure/文案）+ `execute` 转发：解析目标、取池、透传 `signal`、首行 `[box=…]`、`isError` 原样保留 |
| `devtools.ts` | helper 脚本内容生成与写盘（`<agentDir>/pi-instabox/bin/devtools-connect.sh`）+ `registerMcpServer` 参数构造（每请求超时 180s，脚本先 `wake`/`start` 拉箱、再检查 10s、安装 40s，每条唤醒命令由 `timeout 60` 封顶） |
| `log.ts` | 运行期事件日志：JSONL 追加（`<agentDir>/logs/pi-instabox/pi-instabox.jsonl`）+ 1 MiB × 3 份轮转 + 字段截断 2000 / 敏感键脱敏 + 级别过滤（`off` / `info` / `debug`）+ 模块级单例（`setLogger` / `logEvent`）；目录与路径由装配层给，本模块不推导 |

依赖方向：`index → {config, cli, boxes, pool, template, tools, devtools, session-target, entry-render, log}`；`tools → {schema, resolve, pool, remote}`；`pool → {cli, boxes, remote, config}`；`log` 是模块级单例（`setLogger` 只在 `index` 的装配与收尾里调，其它模块只调 `logEvent`）；`resolve` / `session-target` / `schema` / `entry-render`（除注入的 `Text` 构造器）是不碰宿主运行时的纯逻辑层，单测直接驱动。

文案口径：`tools.ts` 里的工具 label（`instabox desktop <远端名>`）、namespace 描述与用法说明是该文案的唯一来源，其它文件与文档以它为准。

## 包特有约束（改动前必读）

- **依赖版本是全仓唯一例外**：`@earendil-works/pi-coding-agent` / `pi-tui` 显式钉 `1.5.0`、`typebox` 钉 `1.3.27`，**不走 `catalog:`**——本包需要 codemode / `exposure` / `namespace` / `registerMcpServer` 这些类型，而 catalog 里的 pi 版本只服务其余包；改回 `catalog:` 会让 `check` 因缺类型直接失败，改版本号就等于做一次兼容性探针（先只改这一行，再跑 `check`）。依赖升级时 `pnpm-lock.yaml` 必须一起提交（CI 是 `--frozen-lockfile`）。
- **peer 写 `"*"`，真实下限写在文档**：`peerDependencies` 三项（pi-coding-agent / pi-tui / typebox）按 pi 官方包约定写 `"*"`，不得挪进 `dependencies`；真实下限 `@earendil-works/pi-coding-agent >= 0.99.0` 只写在 README（环境要求与兼容小节）与本文件，不要在 `peerDependencies` 里写范围。
- **本包从不调用 `setActiveTools`**：桌面工具一律 `exposure: "codemode"`，扩展只读 `getAllTools()` / `getActiveTools()` / `getMcpServers()` 判定状态并在必要时提示一次补救命令。"顺手帮你启用 codemode" 等于替用户改显式偏好，不属本包职责；同理不得写 `settings.json` / `defaultTools`。加载期不判定 codemode（此时注册/自动激活尚未完成），只在 `session_start` 与 `/instabox-status` 实时读。
- **路径职责分离**：配置进 `<agentDir>/extensions/pi-instabox/config.json`（沿用本仓库配置惯例）；运行期状态与 helper 进 `<agentDir>/pi-instabox/`（`templates.json`、`bin/devtools-connect.sh`）；事件日志进 `<agentDir>/logs/pi-instabox/`。五处路径只在 `config.ts` 的 `resolvePaths()` 定义，其它模块只消费；新增路径先改这里，再同步 README 的「路径」与「日志」小节。
- **helper 必须自己把箱拉起来**：MCP 客户端不会唤醒箱，pi 也不会重连失败的 server——首次连接失败后整场会话拿不到任何 DevTools 工具（只能 `/mcp` 手动 reconnect 或重启会话）。所以脚本在 `instabox exec` 检查与 `instabox ssh` 之前先 `instabox wake "$box"`（失败再 `instabox start "$box"`），失败不阻断（`|| true`）、输出全丢 `/dev/null`，并把唤醒 + 检查 + 安装三段都算进注册的每请求超时（180s）；改预算时这两处必须同步。
- **准备阶段总预算 60s，单步只是上限**：一次工具调用的准备阶段（查状态 → `wake`/`start`/`resume` → 确认 `running` → 建连）共享 `timeouts.prepareMs`（`60000`）一个截止时间，每步实际超时取 `min(该步上限（`wakeMs` 20000 / `startMs` 30000 / `connectMs` 15000）, 剩余预算)`，轮询与退避的等待也按剩余收窄——**不要把各步上限相加当总预算**（那曾是最多 8 分钟的由来）。预算耗尽报 `prepare timed out after 60000ms (box "<box>", step: wake|start|resume|confirm|connect)` 并带上该步 stderr 尾部，不换箱、不重试；`callMs`（120000）是工具调用本身的超时，**不**在 `prepareMs` 内。改值时 README 配置表与 `docs/instabox-mcp-extension-plan.md` §7.3 三处同步（文档里的超时数字必须与 `DEFAULT_CONFIG.timeouts` 逐字一致）。
- **DevTools 默认关，只有开关能开**：`--instabox-devtools`（或 `/instabox-devtools on [box]`）是唯一开关，`--instabox-devtools-box` / `config.devToolsBox` 只提供箱名。箱名优先级固定为**会话绑定 > `--instabox-devtools-box` > `config.devToolsBox`**。箱名缺失、箱不在 `instabox ls` 里、只给 box 不给开关，都只给一条 warning 且**不注册**——绝不静默换机或静默启用。两个 flag 必须在工厂最前面 `registerFlag`（pi 在加载期判定合法性，未登记就 exit(1)），而加载期 `getFlag()` 读到的只有注册默认值（命令行值在扩展加载完成后才写入），所以判定只能放在 `session_start` 之后与命令里。
- **DevTools box 会话绑定优先**：`/instabox-devtools on <box>` 把箱名写成按分支生效的 entry（`DEVTOOLS_TARGET_ENTRY`，`readDevtoolsTarget` 从 `getBranch()` 末尾向前扫），因此恢复会话后仍打到同一台、`/tree` 切分支会跟着变；解析顺序是**会话绑定 > `--instabox-devtools-box` > `config.devToolsBox`**，`devtools.enabled` 的 `source`（`session` / `flag` / `config` / `command`）与 `status` 的三段——`registration: <箱> (via <来源>)` / `registration: (none)`、`session binding: <箱>` / `(unset)`、`effective box: <箱> (<来源>)` / `(unset)`——是这条优先级唯一的外部证据。`off` 只注销 server、**不清**绑定；`reset` 只写一条清除标记（不改开关、不注销 server），`registration` 保持不变、`effective box` 回退到 `--instabox-devtools-box` / `config.devToolsBox`，两者别混。
- **运行期 `off` 是 hidden，不是删除**：pi 没有 `unregisterTool`，`/instabox-devtools off` 走 `pi.unregisterMcpServer()`，内置 MCP 扩展会把该 server 的工具重注为 `exposure: "hidden"`——它们从 codemode 的 `ALL_TOOLS` / `searchTools` 消失、已发出的调用报错，但转录里已有的消息不改。重新 `on` 必须先把旧注册 `unregisterMcpServer` 掉再 `registerMcpServer`，否则复用旧连接、换箱不生效。
- **永不 throw 到会话层**：CLI / spawn / 远端握手 / 读写盘的任何失败都归一成工具结果 `isError: true`、`{ ok: false, error }` 或一条 `notify`，事件与命令处理器统一走兜底 `safely`。工具 `execute` 必须把 `signal` 一路透传（abort 立即返回，不被 120 秒超时拖住），并在 abort/断流后标记连接失效。
- **后台声明成功即静默，`debug` 默认静音**：`session_start` 的后台声明只要成功就**不发任何 `notify`**（工具出现就是唯一信号），只有「没有可用沙箱」（`ls` 空或失败）与「同步失败且无旧缓存」才各提示一次；不要把成功路径改回 `notify`。排查输出有两条渠道：`debug()`（stderr，`[pi-instabox] …` 前缀，默认完全静音）与 `log.ts` 的 JSONL 事件日志（默认 `info`）——两者都由 `PI_INSTABOX_DEBUG=1` 打开，排查箱选择、唤醒、握手失败优先看后者。
- **日志默认 `info`，写盘失败不得影响会话**：事件经 `logEvent` 落 `<agentDir>/logs/pi-instabox/pi-instabox.jsonl`（`resolvePaths().logDir`，目录 `0700`、文件 `0600`），级别由 `PI_INSTABOX_DEBUG` 定（`1` → `debug`，否则 `info`）；`off` 只存在于代码层，不对外加开关。`createFileLogger` 的 IO 失败一律吐掉、同一错误只回调一次 `onError`，**绝不 throw 到会话层**，也不得成为工具可用的前提。**不得记录消息全文、工具参数或凭据**：事件只写名字 / 状态 / 计数 / 耗时，敏感键（`token|secret|password|api[-_]?key`）由 `log.ts` 自动替换成 `[redacted]`，但不要靠脱敏兜底——新增字段先问「这条能不能落盘」。`VITEST` 下不建文件 logger（`attachLogger` 只在注入 `loggerFactory` 时才建；单测用 `createMemoryLogger` + `setLogger`），`session_shutdown` 复位单例。**接线位置是加载期第 0 步**（`loadConfig` + `resolvePaths` 之后、`probeVersion` 之前）：`cli.probe`（含失败/超时）与装配失败的证据都靠它落盘，不要挪回 `assemble()` 末尾；那时还没装配，因此这条路径**只**写日志，不建 `templates.json` / `bin/` 等运行期目录（`createFileLogger` 只在写入时建自己的目录）。
- **测试必须离线**：单测不 spawn 真进程、不连远端、不读真实配置与缓存、不等真实时间——`exec` / `spawn` / 文件系统 / 时钟 / `Text` 构造器全部走注入面，远端协议用内存假流验证；真机行为（唤醒、截图、DevTools 连接）靠冒烟，不进单测。
- **冒烟命令不是仓库通用的那一条**：`pi -ne -e builtin:codemode -e builtin:mcp -e ./packages/pi-instabox`。`-ne` 会连内置扩展一起禁用，少了 `builtin:codemode` 桌面工具不可调用、少了 `builtin:mcp` 会报 extension error。
- 配置读取的 `VITEST` 短路（未注入 `env` 时只返回默认值＋环境变量层）是测试确定性的前提，不要在 `loadConfig` 里移除。
