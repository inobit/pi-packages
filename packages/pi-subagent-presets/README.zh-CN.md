# @inobit/pi-subagent-presets

[English](./README.md) | **中文**

按**项目**一次性批量配置 [pi-subagents](https://github.com/nicobailon/pi-subagents) 各 agent 的 `model` 与 `thinking`，并把结果导出为可复用的全局 profile 模板。

- **一条命令**：`/subagent-presets` 打开「agent × (model, thinking)」矩阵（另有一行虚拟 `main` 行管主会话自己的默认值），一次保存就写出项目级 `subagents.agentOverrides` 与顶层 `defaultProvider` / `defaultModel` / `defaultThinkingLevel`
- **逐字段合并，而不是覆盖**：全局的 `tools` / `skills` / `acceptanceRole` / `machine` … 会被搬进项目条目，所以新增项目条目**不会**让你在全局配过的字段悄悄消失
- **所见即所得**：`model` / `thinking` 两列显示的是**将会真正生效的值**，不是当前文件里的字面值
- **模板可复用**：保存时可同步导出一份全局 profile 到 `~/.pi/agent/profiles/pi-subagents/`，与官方 `/subagents-profiles`、`/subagents-load-profile` 天然互通
- **不破坏既有配置**：有 provider 作用域配置的、被上游禁用的、以及你根本没碰过的行，都原样保留
- **软依赖**：`pi-subagents` 可选；未安装时命令仍可运行（降级模式，见 [软依赖](#软依赖)）

## 安装

```bash
pi install npm:@inobit/pi-subagent-presets
```

重启 Pi 或 `/reload`。

本地开发：

```bash
# 隔离：只启用 -e 指定的这个扩展
pi -ne -e ./packages/pi-subagent-presets

# 完整：连同其余用户扩展一起加载
pi -e ./packages/pi-subagent-presets
```

> **两种方式的区别**：`-ne`（`--no-extensions`）的特点是**只启用 `-e` 指定的那一个扩展**，其余用户扩展一律不加载。这样能保证测的是工作区里的代码、而不是已安装的旧版本。
>
> 但它同时也会屏蔽**注册模型 provider 的用户扩展**。若你的模型目录里有一部分 provider 来自用户扩展，用 `-ne` 启动时那些模型会变成"不在 registry"，进而无法夹取 thinking 档位、跳过 `maxThinking` 上限校验。要验证涉及模型的完整行为（尤其是 thinking 档位夹取与上限提示），请用**不带 `-ne`** 的那条命令。

## 用法

```text
/subagent-presets                 # 基底 = 仅项目现有条目
/subagent-presets --from work     # 基底 = work 这个 profile，并与全局层合并（--from 整体替换基底）
```

| 键 | 动作 |
| --- | --- |
| `↑` `↓` | 移动选中行 |
| `enter` | 打开模型选择器（搜索框内联在列表上方，光标常驻、输字即过滤） |
| `shift+tab` | 环形切换 thinking 档位（该行没有 model 时用 pi 默认全 7 档） |
| `r` | reset：该 agent 不写项目条目（状态变 `GLOBAL`）；改任一字段后改成“按新内容写”。在 `main` 行上按 `r` 会一次性删掉顶层三个键 |
| `e` | 用 `$EDITOR` 编辑**整条将写入的条目**（含 model / thinking；校验只警告） |
| `S` | 保存 —— **无条件**打开保存屏：导出/改名 profile 不需要先改任何配置；没有待写入内容时项目文件会被静默跳过（不碰、不出现在保存提示里） |
| `esc` | 退出（有未保存改动时二次确认） |

矩阵只有四列（`agent` / `model` / `thinking` / `state`）。`state` 由「将写入对象里字段的来源」实时计算：

| 条件 | `state` | 含义 |
| --- | --- | --- |
| 我们不提供任何字段 | `GLOBAL` | 该 agent **完全不写**进项目 |
| 全局层没有字段留给我们 | `OVERRIDE` | 我们完全接管 |
| 其余 | `MERGE` | 部分覆盖：全局有字段没被我们写入的条目覆盖 |

`state` 列不会展开逐字段清单，字段级细节在 `e` 编辑器与保存屏的 diff 里看。

只要某行落到 `MERGE` / `OVERRIDE`，**合并结果的所有字段都会落盘**（含来自全局层的）——
因为 builtin 是按 agent 整体替换的，没落盘的字段会被**丢弃**而不是继承。
只有仍是 `GLOBAL` 的行才不写入，且它已有的项目条目会被删除。

行级特殊态不进出 `state` 列，而是在 agent 名后就地表达（`DISABLED` /
`⚠UPSTREAM DISABLED` / `⚠MISSING` + 删除线 / `🔒` / `=alias`）。字段没有值就是真正的空白。

模型选择器把一个固定项**常驻置顶**（不随很长的模型列表滚动消失）：

| 选项 | 落盘 | 运行期实际生效的 model |
| --- | --- | --- |
| `Parent session model` | 写字符串 `"inherit"` | 父会话模型，**跳过** `subagents.defaultModel` |

**刻意不提供 `None`（删键）选项**：对 **builtin** agent，pi-subagents 是**按 agent 整体替换**
的（`applyBuiltinOverrides` 里项目条目一旦存在就直接 return，全局条目根本不参与）。
所以项目条目里没有 `model` 键**不会**回落到全局那个 model，而是掉到
定义 → `subagents.defaultModel` → 父会话模型 —— 那不是这里能选的某个具体值。
要「这个 agent 不写进项目」请用 `r` reset 整行；要自己删键就用 `e`。

> 注意：按 agent 整体替换只针对 **builtin** agent。你自己在 `.pi/agents/*.md` 里定义的
> agent 走的是 `applyCustomAgentOverrides`，那条**才是**逐字段合并（user 先、project 后）。

非交互终端会打印各 agent 的解析摘要后正常返回，不写任何文件。

## 注意事项

上游对 `agentOverrides` 有**两条语义相反**的解析路径，取决于 agent 种类。改配置 / 排错前先确认目标 agent 属于哪一类：

| agent 种类 | 上游路径 | 语义 |
| --- | --- | --- |
| **内置**（pi-subagents 自带的 `worker` / `reviewer` / `researcher` / …） | `applyBuiltinOverrides` | **按 agent 整体替换**：项目里只要有该 agent 的条目，全局那条**整条不参与**。项目条目没写的字段回落到 agent 定义 → `subagents.default*` → 父会话模型 |
| **自定义**（你在 `.pi/agents/*.md` 或某个 package 里定义的） | `applyCustomAgentOverrides` | **逐字段**合并：先应用全局、再应用项目（“project wins, without dropping user-only fields”） |

实测对照（项目条目只写 `thinking`，全局配有 `model` / `machine`）：

| | `model` | `machine` | `output` |
| --- | --- | --- | --- |
| 内置 `researcher` | 丢 | 丢 | `research.md`（定义层自带） |
| 自定义 `probe-custom` | `g/GLOBAL-MODEL` | `r1` | `text` |

由此有三个容易踩的地方：

- **在 `e` 里删掉一个字段，两类 agent 结果不同。** 内置：字段真的没了（先回落到定义层，定义层也没有才彻底消失）。自定义：**全局的值又填回来** —— 删键等于「回落到全局」，无法表达「我不要这个字段」。要强制清空得写 `"machine": false`（上游把 `false` 映射为 `delete`）。
- **`MERGE` 在两类 agent 上的含义不同。** 它只表示「我们提供的字段没有覆盖全局的全部字段」。对内置 agent 意味着那些全局字段被**丢弃**；对自定义 agent 意味着它们**回落到全局值**。
- **本扩展「写完整合并」的效果也不同。** 对内置是必须的（否则字段真丢）；对自定义，运行期结果一样，但项目里从此存了一份快照 —— 之后全局改 `model`，这个项目**不会跟着变**。

（判断 agent 属于哪一类，看 pi-subagents discovery 的四桶：`builtin` / `package` / `user` / `project`。）

## 合并语义

对**内置** agent（也就是 pi-subagents 自带的全部 agent），上游解析 `agentOverrides` 的口径是**逐 agent 二选一**，不是逐字段比优先级：项目里只要有 `reviewer` 这条，全局的 `reviewer` 就**整条**不参与。项目条目没写的字段，回落到 agent 自己的 frontmatter → 顶层 `subagents.default*` → 父会话模型。

这正是手写项目条目会丢配置的原因。本扩展的解法是把**合并结果**写进去：

```text
① 基底   = --from 指定的 profile  |  项目现有条目（纯命令不再回落 default profile）
② 全局   = ~/.pi/agent/settings.json（恒参与）
③ frontmatter 的 model + thinking（只用于显示，绝不写盘）

保存 ⇒ 每个改动行：把 ① ∘ ② 逐字段写进项目条目
```

由于写进项目条目的每个字段都会成为最终值，最终解析结果与「跟随全局」**逐字段完全相等**。没动过的行**不写**，所以它们继续跟随全局。

`default` profile 只有在显式 `--from default` 时才会被使用。不带 `--from` 时，没有项目条目的行显示真正的空白（运行期回落到全局层），也不会被写入。

`--from <name>` 会把模板直接铺下去：矩阵显示的是模板与全局层合并后的值，即使一个字不改，直接按 `S` 也会写进项目。底部 `● unsaved changes` 是唯一的生效性提示——它亮着表示显示的值还没落盘；它不出现时，所见即磁盘上的内容。

### 固化的代价

合并结果一旦写进项目文件，就不再跟随全局配置：之后对 `~/.pi/agent/settings.json` 的修改不会再影响该项目。保存屏会逐行列出「正在被钉住的字段」，让你按行决定。

对**自定义** agent 尤其要留意：这类 agent 本来就会逐字段合并、跟着全局走，但写入项目后同样拿到一份快照，从此不再跟随全局。

## `main` 行

矩阵首行 `main` 是**主 agent**（跑你当前会话的那个模型）的虚拟行。它改的是项目 settings 的三个顶层键——`defaultProvider` / `defaultModel` / `defaultThinkingLevel`，绝不进 `subagents.agentOverrides`。

- `defaultModel` 存的是**裸 id**（id 自身可含斜杠，如 `opencode/exo-free`）；同时配了 provider 时矩阵显示 `provider/model`。在 UI 里选模型一定成对写入，两个键天然一致；在 `e` 里手改则不做任何配对校验——写劈了是你自己的行为，插件不干涉。
- 在这一行按 `r` 会一次性删掉项目层的三个键（回落到全局层），没有半删。
- `e` 打开的恰好就是这三个真实键，所见即落盘。
- 两条运行期事实：**未 trust** 的项目会整个忽略项目层 settings，所以这三个默认值在那里不生效；它们只对**下次 pi 启动**生效——用 `pi --session` 恢复旧会话时，沿用那个会话记录的模型。
- pi 会静默忽略用不了的默认值：`defaultModel` 不在模型 registry 里、或 `defaultProvider` 没有配凭证时，静默回落到自动选模型，不报任何错。保存屏会对这两种情况给出警告，但不阻止保存。

profile 把这三个键放在**顶层**（与 `subagents` 并列，绝不在里面——`subagents` 里的 `defaultProvider` 是上游的裸 id 消歧键，同名不同义）。`--from` 会读入它们，保存时会导出它们。

## 软依赖

`pi-subagents` 是**可选 peer 依赖**（`peerDependenciesMeta.pi-subagents.optional`）。单独装本扩展没有实际意义。

| 档位 | 能做什么 | 依赖 |
| --- | --- | --- |
| L0 | 合并、写盘、profile 导出、模型列表、thinking 档位、26 字段校验、两条「不物化」保护 | 仅 pi core + pi-ai |
| L1 | 行分类（正常 / 上游已禁用 / 上游已无 / 别名）、`maxThinking` 上限、定义层回退值、项目根解析、清缓存 | 已安装的 `pi-subagents` 带 `discoverAgentsAll` |
| L2 | 仅黄条提示 —— 绝不阻断写盘 | —— |

「上游不可用」的五种情形一律降级而不崩：没装 / 装了但五类安装根全落空 / 装了但无可加载 JS 入口（git 检出只有 `.ts`）/ 版本太老 / `discoverAgents` 自己抛错（settings 里有非法值 ⇒ **红条** + 降级）。

## 两个有意「不物化」的例外

以下两种情况会让我们自己的写入**破坏用户显式意图**，所以对应行保持现状——**不写、也不删**：

1. **provider 作用域配置**：全局 `agentOverridesByProvider.<任意 provider>.<agent>` 存在时，项目条目会杀死整个 user 侧条目。该行标 🔒，保存屏列出命中的 provider 名。
2. **顶层 `disableThinking` / `disableBuiltins`**（项目或全局任一）：写入会让受影响的 agent 复活。不阻断，但**黄条 + 二次确认**，并列出被带回的字段（`disableBuiltins` 复活的是整条，不只是 `thinking`）。

项目侧的 provider 作用域值也会提示（它会继续覆盖你保存进基础层的对应字段），但不阻止。

## 白名单即托管清单

`<agentDir>/extensions/pi-subagent-presets/config.json` 里的 `agents` 就是**托管清单**：参与矩阵的 agent，也是项目 `agentOverrides` 里允许出现的全部 agent。移出即「我不配置它」——它的项目条目会在该项目下次保存时被删除。

默认值（7 个纯 Pi runner）：

```json
{ "agents": ["worker", "scout", "reviewer", "oracle", "researcher", "delegate", "evidence-auditor"] }
```

`advisor` 是 `oracle` 的别名（键必须是 canonical name——写在 `advisor` 上完全无效，所以本扩展绝不写它）。另 6 个外部 CLI runner（`claude-code*` / `codex-exec*` / `cursor-agent*`）运行期忽略 model/thinking，默认排除。

项目层（`<cwd>/.pi/extensions/pi-subagent-presets/config.json`，仅 trusted）**整体替换**全局列表而不是并集——并集语义会让「删掉一个」永远不生效。

## profile（模板）

profile 位于 `~/.pi/agent/profiles/pi-subagents/<name>.json`，与官方工具同一目录。格式：

```json
{
  "subagents": { "agentOverrides": { "reviewer": { "model": "p/m", "thinking": "high" } } },
  "defaultProvider": "p",
  "defaultModel": "m",
  "defaultThinkingLevel": "high"
}
```

- 名字必须匹配 `^[A-Za-z0-9][A-Za-z0-9._-]*$`；尾部 `.json` 会被剥掉
- **profile 导出的是整张矩阵快照，不是"这次会写的行"**：项目侧只写需要写的（未改动
  的行不进项目文件），profile 侧则导出矩阵里看到的**全部托管 agent**（含一个改动都没有
  的行），因为它是"下个项目 `--from` 铺开用的模板"。两者口径故意不同。
- 模板顶层可带 `main` 行的三个键（`defaultProvider` / `defaultModel` / `defaultThinkingLevel`，都是可选）。它们绝不放在 `subagents` 里面——那里的 `defaultProvider` 是上游的裸 id 消歧键，同名不同义。其余顶层 `subagents` 键（`defaultModel` / `defaultThinking` / `maxThinking` …）**不导出**——新项目里请自行配置
- `--from <name>` 把 agent 条目**和**顶层三个键一起作为新基底（再与全局层合并）；保存时两者都写回（agent 条目进 `subagents.agentOverrides`，三键写 settings 顶层）。`default` profile 只有显式 `--from default` 时才会被使用
- 导出前逐字段校验。`model: false` 在项目 settings 侧合法但**在 profile 侧非法**，所以会被剔除并提示；条目变空则整条不导出
- 读入 profile 时跑同一套校验器；非法即红条并拒绝合并

## `e` JSON 编辑器

`e` 用 `$EDITOR`（或 `settings.externalEditor` / `$VISUAL` / `$EDITOR`）打开该 agent
**整条将写入的条目**——也就是保存时会落到 `subagents.agentOverrides.<agent>` 的那个对象，
`model` / `thinking` 也在里面。注释头是带注释的字段骨架：26 个字段每行一条，附值域提示。

- 矩阵与 `e` 是**同一份草稿的两个视图**：在 `e` 里改 `model` / `thinking` 会同步进矩阵并生效
- **删键**是让字段“未设置”的唯一方式：把那一行从文件里删掉；保存会尊重这个删除，不会从合并基底里把它复活
- 校验**全部只警告，绝不阻止保存、绝不改写你写的值**（包括上游会抱错的非法值）：

| 情形 | 结果 |
| --- | --- |
| 已知字段的非法值 / 非档位 `thinking` | ⚠️ `上游会对以下内容报错（已照原样保存）：reviewer.outputMode="x"` |
| 未知 key | ⚠️ `未知键会被静默丢弃：reviewer.foo` |

这些警告会汇总在保存屏的提示行里。唯一会被拒的还是**顶层不是对象**（那种形状存不进
`agentOverrides`）。

## 其它说明

- `state` 列只有 `GLOBAL` / `MERGE` / `OVERRIDE`：它由**将要写入对象的逐字段来源**实时计算。`项目条存在 + state === GLOBAL` ⇒ 该条对最终结果零贡献 ⇒ **保存时删除它**（`r` 的作用点）
- **两种“禁用”行为不同**：合并结果里有 `disabled: true`（你自己配的）⇒ 可编辑，改成 `false` 即启用；四桶里有但合并结果里没有 ⇒ 行为与“上游已无”完全一致（不可编辑、不写盘），仅标记不同
- 写入**只替换 `subagents.agentOverrides` 与顶层 `main` 三键**（`defaultProvider` / `defaultModel` / `defaultThinkingLevel`）。`settings.json` 的其余内容键集合与值相等；JSON 格式（缩进、键序、行尾）会被规范化
- 写入后**无需 `/reload`**：discovery 缓存指纹包含两个 settings 文件的 `size:mtimeMs`，下次 launch 自动重建；上游可用时我们还会调一次 `clearAgentDiscoveryCache`
- 用上游的 `/subagents-models <agent>` 复核 agent 结果；`main` 的改动请在这个项目里重新启动一次 pi 来验证
- 项目配置目录名不硬编码：由 pi 的 `CONFIG_DIR_NAME` 解析（pi-subagents 也从自己的 `package.json` 解析同名）
- 项目根在上游可用时跟随 pi-subagents 的 `findConfiguredProjectRoot`（含 `.agents` 目录候选、home 截断、`projectRootResolution` 策略）；上游不可用时用 `ctx.cwd`，并提示该文件可能不被上游读取

## 许可

MIT
