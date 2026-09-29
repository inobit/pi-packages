# @inobit/pi-subagent-presets

按项目批量配置 pi-subagents 各 agent 的 `model` / `thinking`，写入项目 `.pi/settings.json`，并可导出为全局 profile 模板。

> 环境要求、catalog、常用命令、版本与发布（含 tag 规范）、文档分工等公共约定见仓库根 `AGENTS.md`，本文件只写本包目标、结构与包特有约束。

## 目标

- `/subagent-presets [--from <profile>]`：交互式矩阵（`agent` / `model` / `thinking` / `state` 四列）批量设置，写入项目 `.pi/settings.json`；保存时可同步导出全局 profile
- 键位：`enter` 选 model · `shift+tab` 循环 thinking · `r` reset 该行（不写项目）· `e` 用 `$EDITOR` 编辑整条将写入的条目 · `S` 保存 · `esc` 退出
- **合并而非覆盖**：把「项目 / 模板 / 全局」逐字段合并后落盘，避免项目条目让全局同名条目整级出局而丢字段
- **所见即所得**：矩阵显示的是**将真正生效的值**；基准值直读上游 discovery，不手算回落链
- **白名单即托管清单**：`agents` 配置项既是矩阵行集，也是项目 `agentOverrides` 里允许出现的全部 agent
- **不破坏用户显式意图**：provider 条件层行不物化（不写也不删）

## 源码结构（src/）

| 文件 | 职责 |
|---|---|
| `index.ts` | 工厂装配：命令注册、参数解析与 `--from` 补全、headless 摘要、`e` 的注释头 |
| `session.ts` | 会话装配：discovery 探测、四桶归一、`state` 实时计算、显示值（model / thinking 档位与上限） |
| `merge.ts` | 逐字段合并、草稿三态（`touched`）、`applyDraft` 删键语义、`state` 三值、reset 基底（纯函数） |
| `writer.ts` | 保存计划与原子写：只整体替换 `subagents.agentOverrides`，保留其余键 |
| `rowstate.ts` | 行分类（正常 / 上游已禁用 / 上游已无 / 别名 / 不可合并）+ 行内标记 |
| `validate.ts` | 26 字段值域知识；`e` 只警告不阻止，profile 载入才拒绝非法条目 |
| `context.ts` | 项目根解析（`.pi` → git 根 → cwd）与配置目录名 |
| `settings-io.ts` | user / project 层与 profile 的读取、profile 名规范化与安全校验 |
| `models.ts` `thinking.ts` | 模型定位与档位集合，直接复用 pi / pi-ai 的官方逻辑 |
| `upstream.ts` | pi-subagents 软依赖探测与三档降级，不内置任何上游数据 |
| `tui/matrix.ts` | 主屏矩阵：四列渲染、键位、列宽、草稿写回 |
| `tui/model-picker.ts` | 模型选择器：常驻搜索框 + fuzzy 过滤 + 固定项置顶 |
| `tui/save-dialog.ts` | 保存屏：写入目标、profile 名输入、只展示 diff |
| `external-editor.ts` | `$EDITOR` 一轮编辑（异步 spawn，临时文件 `entry.jsonc`） |
| `completions.ts` | `--from` 的补全项（`value` 必须带 `--from` 前缀） |

依赖方向：`index → {session, tui/*, writer, upstream, config}`；`session → {merge, rowstate, settings-io, models, thinking, upstream}`；`merge` / `rowstate` / `writer` / `validate` / `thinking`（除 pi-ai 的 clamp/档位）是不 import pi 的纯逻辑层，单测直接驱动。

## 包特有约束（改动前必读）

- **只生成配置，不解释配置**：不建模上游解析行为；唯一例外是两条「不物化」保护，它们防的是**我们自己的写入**破坏用户显式意图
- **⚠️ 上游有两条语义相反的合并路径**（本项目最容易错的地方）：**builtin** agent（包内 `agents/*.md`）走 `applyBuiltinOverrides`，是**按 agent 整体替换**，项目条目少写的字段会被**丢弃**而非由全局兜底；**custom** agent（`.pi/agents/*.md`、package）与 runtime agent 走 `applyCustomAgentOverrides`，才是逐字段合并。判据在 discovery 四桶里
- **写就写完整合并**：改动任一字段（矩阵两列或 `e` 里的任意字段）后 `state` 即为 `MERGE`/`OVERRIDE`，此时**合并结果的所有字段都必须落盘**（含全局来源的），否则 builtin 的整体替换会让没落盘的字段**直接丢失**；只有**纯 `GLOBAL`** 不写入，且已有条目要**删除**
- **`state` 三值**只看「将写入对象里字段的来源」：`GLOBAL`（不写）/ `OVERRIDE`（全局键全被接管）/ `MERGE`（其余）；判定是「将写入对象 + 全局条目」的纯函数，与操作顺序无关
- **model 选择器不提供「删键」项**：builtin 是整体替换，不写 `model` 键不会回落到全局值，而是掉到 定义 → `subagents.defaultModel` → 父会话模型；唯一固定项是 `inherit`（写哨兵字符串）
- **提示类归 pi，状态类归行本身**：提示一律走 `ctx.ui.notify`，不渲染进自定义 UI；状态走行内紧凑标记 + `state` 列；底部固定「1 空行 + 1 行 `unsaved changes`（整份配置口径）+ footer」
- **UI 文案统一英文**（含保存屏的移除原因），与表头、footer 一致
- **pi 的 custom UI 不会因 `handleInput` 自动重绘**：矩阵须用 `try/finally` 显式 `tui.requestRender(true)`；改草稿的每个入口都要调 `onNeedRefresh()`，否则 `state` 变了但单元格（视图缓存）不更新
- **列宽 = 内容宽，右边距由 `pad()` 单独追加 1 空格**：CJK 占 2 列，不能用 `String.padEnd`
- **`rebuilt` 从空对象构建** ⇒ 任何 `continue` 都等于**删除**：`unmerged` 与 `!dirty` 两行必须走 `keepExisting`，不能裸 `continue`
- **项目条存在 + 该行 `state === GLOBAL` ⇒ 必须删该条**（`r` 的全部意义就靠这一条）
- **写入只替换 `subagents.agentOverrides` 一个键**，且自实现原子写（临时文件 + `rename`）：上游的拷贝是 allowlist，会剥掉未知键
- **settings.json 语法错误 ⇒ 报错并拒绝写入**，绝不覆盖用户数据
