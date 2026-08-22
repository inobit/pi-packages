# @inobit/pi-retry

**中文** | [English](./README.md)

Pi coding agent 手动透明重试：`/retry` + `alt+r` 原样重新发起上一次失败的 turn，不向 LLM 上下文注入任何提示词。

- **零提示词注入**：重试扳机是一条隐藏哨兵消息，会被常驻过滤出每一次 LLM 请求——模型永远看不到它
- **保持原样**：失败的半截响应保留为上下文最后一条，模型按 prefill 方式无缝续写，不丢弃、不重新生成
- **不关心失败原因**：连接错误、断流、被你手动掐断的挂起请求，一个键原样重发

## ⚠️ 已知缺陷（使用前必读）

**本扩展必须常驻安装。** 重试扳机会在会话文件中永久写入一条哨兵记录（custom 消息，内容为一个 `"."`）：

- 插件在位时：这条哨兵被 `context` 过滤器精确剔除，**永远不会到达模型**，transcript 中也不渲染；
- **插件被卸载/禁用后 resume 含哨兵的旧会话**：过滤消失，哨兵经 pi 内置转换变成一条 user 消息发给模型——即对话里多出一条内容为 `"."` 的噪音。无指令危害，但无法避免；
- 会话文件中的哨兵 entry 本身不可删除（pi 无公开 API 删除 entry），属方案固有代价。

## 原理（为什么这样做）

pi 公开 API 的硬约束：**凡能触发 LLM turn 的入口都会写入一条消息，凡不写入的都不触发**。因此"透明重发"只能拆成两半实现：

```
① 扳机：sendMessage({ customType:"pi-retry", triggerTurn:true })
      └─ 发起新 turn（公开 API 唯一的无 user 内容扳机），哨兵落盘
② 过滤：pi.on("context") 常驻处理器
      └─ 在每次 LLM 调用前、消息转 provider 格式之前，
         按 role==="custom" && customType==="pi-retry" 精确剔除哨兵
```

拦截发生在 `AgentMessage[]` 层面（pi 把扩展 `context` 事件注册为全局 `transformContext`，先于 `convertToLlm` 与 HTTP 请求），与具体 provider 无关。过滤后模型收到的上下文**原样结束在断点**——失败的半截 assistant 是最后一条消息，这是标准的 prefill 形态，模型直接接着写：

| | 失败的半截 assistant | 模型行为 |
|---|---|---|
| pi 内置自动重试 | 从上下文删除 | 从头重新生成 |
| 手输"继续" | 保留 + 后跟一条 user 指令 | 续写（带指令歧义） |
| **本扩展** | **保留为最后一条，后面什么都不加** | **续写（零指令）** |

## 安装

```bash
pi install npm:@inobit/pi-retry
```

重启 Pi 或执行 `/reload`。

本地开发（隔离环境，`--no-extensions` 屏蔽已安装旧版）：

```bash
pi -ne -e ./packages/pi-retry
# 失败/中断后：/retry 或 alt+r
```

## 使用

- `/retry` — 透明地重新发起上一个 turn；成功受理后提示 `Retry submitted`。
- `alt+r` — 同 `/retry`。
- **失败守卫**：仅当最近一条 assistant 以 `error`/`aborted` 结束时才触发；否则提示 `Nothing to retry — last turn ended normally`（新会话为 `Nothing to retry yet`）。防止误按产生自由续写并永久写入哨兵。
- 仅 idle 时可用；streaming 中会提示 `Agent is busy — retry is only available when idle`。

## 配置

快捷键可通过 `~/.pi/agent/extensions/pi-retry/config.json` 配置（需 `/reload`）：

```json
{
  "shortcut": "alt+r"
}
```

默认 `alt+r`。受信项目可用 `.pi/extensions/pi-retry/config.json` 覆盖全局。

## 兼容性与限制

- **插件需常驻**（见顶部「已知缺陷」）：卸载后 resume 旧会话会向模型泄漏一句 "."。同族路径：compaction / branch-summary 的摘要输入不经过滤器，哨兵落在被摘要区间时可能以 "." 混入摘要文本。
- **与内置自动重试的交互**：重发的 turn 若再次遇到白名单内可重试错误，pi 核心会接管并删除半截响应从头重新生成（prefill 续写保证只覆盖第一次重发）。
- 尾部 assistant 消息为 Anthropic 原生支持（prefill）；少数 OpenAI 兼容中转行为可能不同，建议在常用 provider 上实测。
- 断流恰好断在整段结束时，模型可能另起一段而非续写——续写语义的固有特性，与手输"继续"一致。

## 开发

```bash
pnpm --filter @inobit/pi-retry check   # tsc --noEmit
pnpm --filter @inobit/pi-retry test    # vitest
pnpm --filter @inobit/pi-retry pack:check
```
