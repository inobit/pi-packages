# @inobit/pi-reader

> 环境要求、catalog、常用命令、版本与发布（含 tag 规范）、文档分工等公共约定见仓库根 `AGENTS.md`，本文件只写本包目标、结构与包特有约束。

## 目标

- 阅读模式：切换键（`config.json: toggleKey`，默认 `alt+o`）经 `TUI inputListener` 拦截进/出 `READING`；`/reader`、`/scroll` 兜底
- Vim 翻页：`ctrl+u/d` 半页、`ctrl+f/b` 整页、`j/k`/`ctrl+n/p` 行、`g g` 顶部（300ms，含同批 `gg`）、`G` 底部
- 指示：`ReadonlyEditor` 左显 `◉ Reading` 覆盖原输入（无边框），原输入保留；`?` 弹窗英文帮助 `Esc` 关闭
- 位置保位：进出阅读与手动展开/收拢时视口钉在原问答附近；锚点为 OSC133 prompt 序号坐标系 `{k,d,count}`，恢复用统一 clamp 模型
- 配置：默认不动工具状态（位置天然无损）；`autoExpandTools: true` 进出阅读时自动展开/收拢（走锚点补偿）；`app.tools.expand` 在 READING 态也可用（走同一锚点包装）

## 架构（改动前必读）

按键主通道 `TUI inputListener` + `ctx.ui.onTerminalInput` 双通道（后者确保 `reload`/`resume` 后仍生效），`INSERT` 透传：

- **事件**：`listenerInstalled` 防重；`currentCtx` 在全量会话事件刷新；`latestTui` 缓存用于滚动
- **禁抢 `tui.altScreen.*`**：`TUI` 层摘要先 consume
- **stale ctx**：仅 `.ui` 访问异常置 `ctxBroken`；输入保留 `savedInput`；工具展开 `Promise` 异步
- `ScrollReaderEditor` 必须传**真实 theme/keybindings** 构造（空对象会让 `Editor.render` 的 `borderColor()` 崩）

## 源码结构（src/）

| 文件           | 职责                                                                                                                                                                                                                                                                                                |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/index.ts` | 纯逻辑导出 `parseReadingKey`/`halfPage`/`pageStep`/`GgSequence`；原生私有面兼容层 `NativeTuiSurface`/`nativeTuiSurface`/`openNativeSearch`/`readNativeSearchSnapshot`/`hideNativeSearchOverlay`；`ScrollReaderEditor`/`ReadonlyEditor`（左显 `◉ Reading`）；`factory` + `onTerminalInput` 双通道；`applyReaderUI` 隐藏输入（保留原输入）+ `Promise` 异步工具；`?` 帮助（`custom` overlay）；`getActiveToggleLabel` 读 `config.json` |

依赖方向：`index.ts → {CustomEditor, ExtensionAPI, ExtensionContext} from pi-coding-agent` + `{Key, matchesKey, truncateToWidth, type TUI} from pi-tui`；无本地子模块。

## 包特有约束（设计层面，改动前必读）

**核心私有面（跨版本风险最高）**

- 搜索/滚动/提示系列成员（`activeSearch`、`closeSearch`、`navigateSearch`、`getPrimaryScrollView`、`scrollBy`、`scrollToTop/Bottom`、`flash`）**都不在 pi-tui 公开 `TUI` 接口里**，是 `TuiAltScreen` 的类私有字段，`tsc` 看不见——0.86.0 把 `openSearch` 改名 `toggleSearch` 时无任何编译错误，搜索功能直接静默失效（`/` 无响应、`n`/`N` 一并失效）
- 一律经 `NativeTuiSurface` + `nativeTuiSurface()` + `openNativeSearch()` 收窄，禁止新增 `(tui as any)?.xxx` 式探测；探测项必须保持可选（全部可选才能让真实 `TUI` 仍可赋值）
- 开启搜索是**跨版本唯一分叉点**：0.86.0 `toggleSearch()` 是开关（已开则关），0.84.x `openSearch()` 幂等；因 reader 开启后立即隐藏 overlay 且 `activeSearch` 存续到 esc，已存在搜索态时必须跳过调用
- `test/router.test.ts` 有原型链契约测试，但**只覆盖 `TuiAltScreen` 原型链上的方法**。下列不在覆盖内，每次升级核心必须人工核对（证据源：核心 dist 的 `tui-alt-screen.js` / `alt-screen-search.js`）：
  - 实例字段 `activeSearch`——改名会让 `openNativeSearch` 恒返回 `opened`（toggle 反噬：第二次 `/` 关掉刚开的搜索）且快照恒 `null`（enter 即关搜索）；`focusedComponent`——改名会让 `dialogOpen()` 恒 `false`，复活弹窗悬挂 Bug B
  - `activeSearch.component.handleInput`、`component.input.getValue`、`activeSearch.overlay.hide`（属 `AltScreenSearchComponent` / `OverlayHandle`）
  - viewport 内省仍是裸 `any` 直探（`currentLayout.primaryScrollView` / `scrollContentLines` / `isFollowingEnd` / `scrollTo`），与搜索面同属私有面风险，尚未收敛
- 升级核心后先跑 `pnpm check` + `pnpm test` 再动逻辑；契约测试变红时先查读者侧探测是否仍可用，再同步名单（核心把方法改成实例箭头函数字段属合法重构，会假阳性）

**分层模型：焦点栈即按键归属**

- pi-tui 的 `focusedComponent` 就是逻辑栈顶：弹窗/输入框/help overlay 出现即入栈、关闭即出栈；reader 的双通道 listener 位于焦点组件上游的分发必经之路，「哪个层接键」由路由按每键实时焦点比对判定（非快照，链式弹窗 select→input 换组件也能感知）
- **UI 与逻辑必须统一**：用户看见什么就在操作什么。帮助 overlay 视觉在上层时逻辑上也置顶——吞掉除 esc 外所有键，不下漏给视觉被覆盖的弹窗；esc 关帮助不得抢回焦点（overlay hide 仅自持焦点时才恢复）；禁止任何按键作用于视觉上被覆盖的组件
- **外部弹窗让路是规避而非治愈**：弹窗夺焦期只屏蔽 toggle——它是唯一直接操作「层」本身的键，放行会触发核心容器重建、弹窗 promise 永久悬挂且无任何恢复手段（扩展拿不到弹窗句柄）；其余全量透传。根治在上游核心（清容器前闭合存量 promise），本包只能规避触发路径
- 方向键透传白名单必须同时覆盖 CSI（`\x1b[`）与 SSU（`\x1bO`，application cursor keys）两类前缀，漏掉 SSU 会让方向键在常见终端下被吞

**键位优先级**

- 阅读切换不注册 `pi.registerShortcut`，走双通道拦截：TUI inputListener 主通道 + `onTerminalInput` 兜底（保证 `reload`/`resume` 后仍生效），`INSERT` 透传；禁抢 `tui.altScreen.*`（TUI 层摘要先 consume）
- READING 内优先级：SEARCH_INPUT > toggle > help > exit(esc/i/ctrl+c) > expand > 语义导航 > 滚动；显式绑定键（expand）优先级低于固定白名单语义键——与 `toggleKey` 同绑的键在 READING 不可达，文档已写明勿同键
- 改路由行为先改路由本体并补 `test/router.test.ts` 注入式用例；fake tui 不许带 `extensionSelector` 字段——真实运行时该私有字段不可达，测了也是假阳性

**配置定位**

- jiti 把扩展编译为 base64 data:URL 模块，`import.meta.url` 无文件路径；定位包目录必须用 CJS 包装注入的 `__dirname`
- 若改回基于 URL 的解析不会报错，只会静默回退到用户级旧配置（字段分歧时新配置项失效，极难排查）

**保位不变量**（三者缺一恢复会静默失效，无报错）

- 一切改变 transcript 高度的动作（自动或手动的 `setToolsExpanded`）都必须过锚点包装：先同步捕获、变更后挂恢复监视器
- 恢复 `scrollTo` 必带 `disableFollow:true`，否则目标落底会重新武装 follow-end，前功尽弃
- 监视器的稳定性判据依赖帧代际推进，而 pi-tui 按需渲染（空闲零帧），故每 tick 必须主动 `requestRender`

**锚点坐标系**

- 选 OSC133 prompt 序号是因为它跨展开/收拢严格稳定（盒树/行号/文本签名均被否决）；核心升级后若保位异常，先验证 `findPromptRows` 前提再查别处

**已知限制**

- 工具展开状态靠本地镜像维护（核心无 getter）：编辑态经核心路径切换会漂移，进入 READING 自动对齐
- `regular` 模式无视口，滚动/保位静默降级
- 「命令打开的系统弹窗 × 阅读模式」组合结构性不存在：READING 下编辑器被替换无法输入命令，弹窗下又被让路守卫禁入阅读——只有扩展主动弹出的对话框会在 READING 期间出现
- `parseReadingKey` 兼容传统控制符与 Kitty 协议；`gg` 用 `GgSequence(300)` 双击判定
