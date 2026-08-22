# @inobit/pi-retry

Pi coding agent 的手动透明重试扩展：`/retry` + 快捷键（默认 `alt+r`）原样重新发起上一次失败的 turn，不向 LLM 上下文注入任何提示词。

> 环境要求、catalog、常用命令、版本与发布（含 tag 规范）、文档分工等公共约定见仓库根目录 `AGENTS.md`，本文件只写本包的目标、结构与包特有约束。

## 目标

- `/retry` 与快捷键共用同一条执行路径（仅依赖基础 ctx 的 `isIdle` + `pi.sendMessage`，行为一致性由构造保证）
- 扳机为隐藏哨兵消息（`customType: "pi-retry"`、`display:false`），成功受理后 notify `Retry submitted`
- 常驻 `context` 过滤保证哨兵在任何后续 turn / resume 后都出不去；其余消息（含失败半截 assistant）原样透传——prefill 式续写
- 仅 idle 时可重试；streaming 中显式拒绝并 notify（streaming 中 sendMessage 会变义为 steer/followUp 注入）

## 原理（一句话版）

公开 API 里"触发必写入、写入必进转换管线"，故拆成两半：哨兵落盘触发 turn + `context` 事件（= 全局 `transformContext`，先于 `convertToLlm` 与 HTTP）按类型剔除哨兵。

## 源码结构（src/）

| 文件 | 职责 |
| -- | ---- |
| `index.ts` | 工厂装配：context 常驻过滤、doRetry（idle 守卫 + 失败守卫 + 哨兵扳机 + 受理通知）、注册命令/快捷键 |
| `filter.ts` | 纯函数 `isRetrySentinel` / `stripRetrySentinels` / `findLastAssistantStop` / `isRetryableStop`（类型精确匹配、零拷贝快路径）；不依赖 pi 运行时类型 |
| `config.ts` | 快捷键配置（global / 受信 project 双层，VITEST 下短路返回默认值） |

依赖方向：`index → filter / config`。

## 包特有约束（改动前必读）

- **过滤只认类型**：`role === "custom" && customType === "pi-retry"`，禁止改为文本匹配或扩大过滤范围
- **保持原样是硬约束**：不得在过滤器中顺手剔除 error/aborted assistant 等任何其他消息（半截保留 = prefill 续写语义的根基）
- **哨兵文本必须是安全单字符 `"."`**：仅作为卸载插件后泄漏场景的兜底，空白文本可能被严格 provider 判非法 text block
- **插件需常驻**：卸载后 resume 含哨兵会话会向模型泄漏一句"."（README 已置顶声明）；哨兵 entry 无法删除（pi 无公开 API）
- **快捷键与命令不得分叉**：两者都必须走同一个 `doRetry`，新增能力只改 `doRetry`
- **失败守卫只认终态白名单** `error`/`aborted`：扩充判定时同步更新 filter.ts 的 `RETRYABLE_STOP_REASONS` 及测试；分支不可读时 fail-open
