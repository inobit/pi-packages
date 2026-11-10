# @inobit/pi-instabox

把 instabox 沙箱的 X11 桌面交给模型操作：`instabox_desktop_*` 桌面工具（每次调用显式指定 `box`，失败不静默降级），外加一个默认关闭、需显式开启的远端 `chrome-devtools-mcp` server。

> 环境要求、catalog、常用命令、版本与发布（含 tag 规范）、文档分工等公共约定见仓库根目录 `AGENTS.md`，本文件只写本包的目标、结构与包特有约束。

## 目标

- **把远端桌面工具映射成 pi 工具**：远端 `instabox-computer-use` 暴露的每个桌面动作在 pi 侧都有一个稳定名字的工具，schema 与名字来自远端而非手写，因此不随远端版本漂移
- **按调用选箱，且不静默降级**：这次打到哪台沙箱必须显式、可回显；选不出唯一目标时宁可报错并列出候选，也不换一台继续跑
- **目标可以是默认值，但不是隐藏状态**：会话绑定记住的箱按分支生效、可恢复，单次指定可临时覆盖；两者都不改用户配置
- **浏览器能力默认关闭**：远端 `chrome-devtools-mcp` 只在显式开启时注册，且与桌面工具的目标互不影响（可以指向不同箱）
- **不替用户改工具选择集**：能力不可用时只说清状态与补救命令，不自动启用、不写设置、不改用户默认工具
- **不占描述预算，靠命名空间发现**：桌面工具以 `deferred` 暴露，既不直接声明给模型也不进 codemode 描述，发现走命名空间（`describeNamespace` / `searchTools`）；`before_agent_start` 那段发现提示的描述**不写死**，按远端 `instructions` 生成

## 源码结构（src/）

| 文件 | 职责 |
| --- | --- |
| `index.ts` | 扩展装配：读配置、接日志、探测 CLI，注册工具/命令与全部事件接线（`before_agent_start` 写 `instabox-desktop` 发现段） |
| `config.ts` | 配置类型、默认值与分层叠加，并集中定义本包涉及的三类路径 |
| `cli.ts` | `instabox` CLI 的薄封装：把每次调用的输出归一成成功或带原因的失败 |
| `boxes.ts` | 解析 `instabox ls --json` 并做会话级短缓存，供选箱与状态展示使用 |
| `resolve.ts` | 选箱解析链：按来源优先级定出目标箱，判定歧义与硬错误（纯函数） |
| `session-target.ts` | 会话绑定的箱名在分支上的读写形状（桌面工具与 DevTools 各一条） |
| `entry-render.ts` | 把会话绑定条目渲染成转录里的一行提示 |
| `schema.ts` | 远端 `inputSchema` 到 TypeBox 的保守转换，并为每次调用注入 `box` 参数 |
| `remote.ts` | 远端 stdio MCP 客户端：建连、请求路由、分帧、超时与中断 |
| `pool.ts` | 按箱复用远端连接，并把唤醒收进连接过程 |
| `template.ts` | 按箱缓存远端工具清单与 `initialize` 的 `instructions`，让会话启动不必每次重新握手 |
| `tools.ts` | 工具定义与文案（`deferred` 暴露 + 命名空间）、发现提示文本，以及每次调用的转发与结果透传 |
| `devtools.ts` | 注册远端 `chrome-devtools-mcp`：注册前准备（唤醒箱 + 确保远端可执行）与 `registerMcpServer` 参数（一条普通的 `instabox ssh …` 配置，不生成脚本） |
| `log.ts` | 运行期事件日志：轮转写盘、字段脱敏与级别过滤 |

依赖方向：`index` 是唯一的装配层，向下接其余模块；`tools → {schema, resolve, pool, remote}`；`pool → {cli, boxes, remote}`；`resolve` / `session-target` / `schema` / `entry-render` 是不碰宿主运行时的纯逻辑层，注入依赖后单测直接驱动。

## 核心约束（改动前必读）

- **依赖版本不走 catalog**：本包用到 pi 的新 API，故 pi 与 typebox 显式钉版本；`peerDependencies` 三项一律写 `"*"`，真实下限只写在 README，不写进 peer 范围
- **从不调用 `setActiveTools`、不写用户设置**：桌面工具一律以 `deferred` 形式暴露（不进 codemode 描述，靠命名空间搜索发现），启用与否是用户的决定
- **发现提示的描述来自远端，不写死**：`instabox-desktop` 段那行描述由远端 `initialize` 的 `instructions` 生成（首行、截断 250 字符），缺失才回退到命名空间描述；跟随每次注册重算，远端升版后自动更新，不要把它换回常量
- **路径职责分离**：配置进 `extensions/pi-instabox/`，运行期状态（模板缓存）进 `pi-instabox/`，事件日志进 `logs/pi-instabox/`，三处互不混用（`resolvePaths()` 只有这四条）
- **永不 throw 到会话层**：CLI、远端握手、读写盘的任何失败都归一成 `isError` 工具结果、结构化失败或一条 `notify`
- **所有远端操作只经 `instabox` CLI**：不自建 ssh/远程协议，也不绕过 CLI 直接碰沙箱
- **「准备一个可用 box」只有一套实现**：`pool.ensureReady(box, opts)`（查状态 → `wake`/`start`/`resume` → 确认 `running`，共享 `prepareMs` 截止时间）是唯一入口；`pool.get` 先 `await` 它再建连，DevTools 注册前的准备也从装配层注入同一个方法——不要在别处再写一遍唤醒链
- **DevTools 默认关闭，只能显式开启**：箱名优先级固定为会话绑定 > flag > 配置，缺箱或缺开关都不注册；开启时先 `prepareDevTools`（`ensureReady` 准备箱 + 检查/安装 `chrome-devtools-mcp`）再 `registerMcpServer({ command: "instabox", args: ["ssh", …] })`，不生成 helper、不额外包进程
- **测试必须离线**：exec / spawn / 文件系统 / 时钟全部走注入面，单测不连远端、不读真实配置；真机行为靠冒烟

## 常用命令

```bash
pnpm --filter @inobit/pi-instabox check       # 类型检查
pnpm --filter @inobit/pi-instabox test        # 单测（离线）
pnpm --filter @inobit/pi-instabox pack:check  # 检查发布 tarball
pi -ne -e builtin:codemode -e builtin:mcp -e ./packages/pi-instabox  # 本地冒烟
```

冒烟必须带上 `builtin:codemode` 与 `builtin:mcp`（`-ne` 会连内置扩展一起禁用）。安装、全仓检查与版本发布等公共命令见根 `AGENTS.md`。
