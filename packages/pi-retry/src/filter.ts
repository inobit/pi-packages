/**
 * 哨兵消息识别与过滤（纯函数，不依赖 pi 运行时）。
 *
 * 哨兵是手动重试的触发载体：`sendMessage(triggerTurn: true)` 需要一条消息才能发起 turn，
 * 该消息会以 CustomMessageEntry 落盘、并在 `convertToLlm` 中被转成 user 消息进入请求。
 * 本模块负责在 `context` 事件中把哨兵从发往模型的消息数组里剔除——除此之外的任何消息
 * （包括失败的半截 assistant）一律原样保留。
 */

/** 哨兵 CustomMessage 的 customType，过滤的唯一依据 */
export const RETRY_SENTINEL_TYPE = "pi-retry";

/**
 * 哨兵文本。插件常驻期间它永远不会到达 provider；
 * 仅当用户卸载插件后 resume 含哨兵的旧会话才会泄漏，故取单个安全字符：
 * 空白文本可能被部分 provider 判为非法 text block（4xx），"." 无此风险且无语义。
 */
export const RETRY_SENTINEL_TEXT = ".";

export interface SentinelLikeMessage {
  role: string;
  content?: unknown;
  customType?: string;
}

/** 是否为本扩展写入的重试哨兵消息（仅认 role=custom + customType，不做文本匹配） */
export function isRetrySentinel(message: unknown): boolean {
  const m = message as SentinelLikeMessage | null | undefined;
  return typeof m === "object" && m !== null && m.role === "custom" && m.customType === RETRY_SENTINEL_TYPE;
}

/**
 * 过滤哨兵，返回新数组；输入不满足结构时原样返回同一引用（零拷贝快路径）。
 * O(n) 单次遍历，n 为当前上下文条数，相对 LLM 网络延迟可忽略。
 */
export function stripRetrySentinels<T>(messages: T): T {
  if (!Array.isArray(messages)) return messages;
  let found = false;
  for (const m of messages as unknown[]) {
    if (isRetrySentinel(m)) {
      found = true;
      break;
    }
  }
  if (!found) return messages;
  return (messages as unknown[]).filter((m) => !isRetrySentinel(m)) as T;
}

// ---- 失败守卫：仅当最近一条 assistant 是失败终态时才允许触发 ----

/** 会话分支条目的最小形态（仅用到的字段） */
export interface BranchEntryLike {
  type: string;
  message?: {
    role?: string;
    stopReason?: string;
  };
}

/** 允许重试的 assistant 终态：显式错误 + 被掐断（含挂起后 ctrl+c） */
export const RETRYABLE_STOP_REASONS: ReadonlySet<string> = new Set(["error", "aborted"]);

export function isRetryableStop(stopReason: string | undefined): boolean {
  return stopReason !== undefined && RETRYABLE_STOP_REASONS.has(stopReason);
}

/**
 * 倒序扫描分支，返回最近一条 assistant 消息的 stopReason；
 * 无 assistant（新会话）时返回 undefined。
 */
export function findLastAssistantStop(branch: readonly unknown[]): string | undefined {
  for (let i = branch.length - 1; i >= 0; i--) {
    const e = branch[i] as BranchEntryLike | undefined;
    if (!e || e.type !== "message" || !e.message) continue;
    if (e.message.role !== "assistant") continue;
    return e.message.stopReason;
  }
  return undefined;
}
