# @inobit/pi-instabox

把 instabox 沙箱的 X11 桌面交给模型操作：`instabox_desktop_*` 桌面工具（每次调用显式指定 `box`，失败不静默降级），外加一个按配置注册的远端 `chrome-devtools-mcp` server。

> 环境要求、catalog、常用命令、版本与发布（含 tag 规范）、文档分工等公共约定见仓库根目录 `AGENTS.md`，本文件只写本包的目标、结构与包特有约束。

## 目标

- 远端 `instabox-computer-use` 的 `tools/list`（当前九个条目）逐条变成一个 `instabox_desktop_<远端名>` 工具，schema 由远端生成、不手写，因此不与远端版本漂移；名字稳定，codemode 脚本写死的工具名跨版本仍可用
- "这次打到哪台箱"必须显式、可回显、失败不静默降级：五级解析链（`box` 参数 → 本轮 user 消息 → 会话目标 → `defaultBox` → `ls` 第一台），参数与会话目标写错是硬错误，每条结果首行 `[box=<name>]`
- 会话目标由 `/instabox-use` 写成一条按分支生效的 entry（不进 LLM 上下文，`/tree` / `--continue` 都能恢复），并在冷启动（无缓存且没有 running 箱）时充当唯一的重试入口：唤醒 → 拉模板 → 注册
- per-box 模板缓存让「加载期零 ssh 声明工具」成立（每次会话启动仍会用一次握手校验版本，见 `src/template.ts` 的 `ensure`）；缓存缺失时的后台拉取只连 running 的箱，绝不唤醒
- 浏览器能力由一台固定箱的远端 `chrome-devtools-mcp` 提供，与桌面工具的目标互不影响；`devToolsBox` 为空即该能力整体不存在
- 不越权：不调 `setActiveTools`、不写 `settings.json`、不改用户 `defaultTools`；能力不可用时只说清状态与补救命令

## 源码结构（src/）

| 文件 | 职责 |
| --- | --- |
| `index.ts` | 工厂装配：加载期只探测 CLI（`reason` 为 `missing`/`error` 直接降级；`timeout` 则在第一次 `session_start` 用 5000ms 重试一次）、读配置与四路径、建池/模板存储、注册工具与两个命令与 entry renderer 与 MCP server、`session_start` / `session_tree` 重建、codemode 只读判定与一次性提示 |
| `config.ts` | `InstaboxConfig` + `DEFAULT_CONFIG` + 逐层校验与叠加（全局层、项目层、环境变量）+ `getAgentDir()` + `resolvePaths()`（四处路径单点） |
| `cli.ts` | `instabox` CLI 薄封装：`probeVersion` / `listBoxesJson` / `start` / `wake` / `resume` / `exec`，注入 `ExecFn`；失败归一成 `{ ok: false, error, reason }`，`reason: "missing" | "timeout" | "error"`（`killed` 归 `timeout`），探测预算 3000ms、`ls` 预算 10000ms |
| `boxes.ts` | `ls --json` 解析与校验 + 会话级 5 秒 TTL 缓存（失败不缓存） |
| `resolve.ts` | 解析链纯函数：五级来源、歧义与硬错误判定、`defaultBox` 失效时带 `skippedConfig` 标记 |
| `session-target.ts` | 目标 entry 的形状与读写（`TARGET_ENTRY` / `readTarget(branchEntries)` / `targetEntryData`），只接受 `getBranch()` 的结果 |
| `entry-render.ts` | `createTargetRenderer(TextCtor)`：`theme.fg("dim", …)` 着色后交给 `new Text(text, 0, 0)`，返回 Component |
| `schema.ts` | 远端 `inputSchema` → TypeBox 的保守子集映射（未知节点回落 `Type.Unsafe`）+ 顶层 `box` 注入 |
| `remote.ts` | 远端 stdio MCP 客户端：spawn、双分帧容忍（换行分隔 / `Content-Length` 头）、请求表、四段超时、abort、`dead` 标记；注入 spawn 与 clock |
| `pool.ts` | per-box 客户端池：复用/驱逐，`allowWake: false` 路径零唤醒，其余按 `desiredState` 分流 `start`/`wake`/`resume` 并轮询确认 `running` |
| `template.ts` | per-box 模板缓存（`<agentDir>/pi-instabox/templates.json`）+ `serverInfoVersion`/TTL 比对 + 拉取编排（注入 client/fs/clock，不唤醒） |
| `tools.ts` | 工具定义（名字/label/namespace/exposure/文案）+ `execute` 转发：解析目标、取池、透传 `signal`、首行 `[box=…]`、`isError` 原样保留 |
| `devtools.ts` | helper 脚本内容生成与写盘（`<agentDir>/pi-instabox/bin/devtools-connect.sh`）+ `registerMcpServer` 参数构造 |

依赖方向：`index → {config, cli, boxes, pool, template, tools, devtools, session-target, entry-render}`；`tools → {schema, resolve, pool, remote}`；`pool → {cli, boxes, remote, config}`；`resolve` / `session-target` / `schema` / `entry-render`（除注入的 `Text` 构造器）是不碰宿主运行时的纯逻辑层，单测直接驱动。

文案口径：`tools.ts` 里的工具 label（`instabox desktop <远端名>`）、namespace 描述与用法说明是该文案的唯一来源，其它文件与文档以它为准。

## 包特有约束（改动前必读）

- **依赖版本是全仓唯一例外**：`@earendil-works/pi-coding-agent` / `pi-tui` 显式钉 `1.5.0`、`typebox` 钉 `1.3.27`，**不走 `catalog:`**——本包需要 codemode / `exposure` / `namespace` / `registerMcpServer` 这些类型，而 catalog 里的 pi 版本只服务其余包；改回 `catalog:` 会让 `check` 因缺类型直接失败，改版本号就等于做一次兼容性探针（先只改这一行，再跑 `check`）。依赖升级时 `pnpm-lock.yaml` 必须一起提交（CI 是 `--frozen-lockfile`）。
- **peer 写 `"*"`，真实下限写在文档**：`peerDependencies` 三项（pi-coding-agent / pi-tui / typebox）按 pi 官方包约定写 `"*"`，不得挪进 `dependencies`；真实下限 `@earendil-works/pi-coding-agent >= 0.99.0` 只写在 README（环境要求与兼容小节）与本文件，不要在 `peerDependencies` 里写范围。
- **本包从不调用 `setActiveTools`**：桌面工具一律 `exposure: "codemode"`，扩展只读 `getAllTools()` / `getActiveTools()` / `getMcpServers()` 判定状态并在必要时提示一次补救命令。"顺手帮你启用 codemode" 等于替用户改显式偏好，不属本包职责；同理不得写 `settings.json` / `defaultTools`。加载期不判定 codemode（此时注册/自动激活尚未完成），只在 `session_start` 与 `/instabox-status` 实时读。
- **路径职责分离**：配置进 `<agentDir>/extensions/pi-instabox/config.json`（沿用本仓库配置惯例）；运行期状态与 helper 进 `<agentDir>/pi-instabox/`（`templates.json`、`bin/devtools-connect.sh`）。四处路径只在 `config.ts` 的 `resolvePaths()` 定义，其它模块只消费；新增路径先改这里，再同步 README 的「路径」小节。
- **永不 throw 到会话层**：CLI / spawn / 远端握手 / 读写盘的任何失败都归一成工具结果 `isError: true`、`{ ok: false, error }` 或一条 `notify`，事件与命令处理器统一走兜底 `safely`。工具 `execute` 必须把 `signal` 一路透传（abort 立即返回，不被 120 秒超时拖住），并在 abort/断流后标记连接失效。
- **测试必须离线**：单测不 spawn 真进程、不连远端、不读真实配置与缓存、不等真实时间——`exec` / `spawn` / 文件系统 / 时钟 / `Text` 构造器全部走注入面，远端协议用内存假流验证；真机行为（唤醒、截图、DevTools 连接）靠冒烟，不进单测。
- **冒烟命令不是仓库通用的那一条**：`pi -ne -e builtin:codemode -e builtin:mcp -e ./packages/pi-instabox`。`-ne` 会连内置扩展一起禁用，少了 `builtin:codemode` 桌面工具不可调用、少了 `builtin:mcp` 会报 extension error。
- 配置读取的 `VITEST` 短路（未注入 `env` 时只返回默认值＋环境变量层）是测试确定性的前提，不要在 `loadConfig` 里移除。
