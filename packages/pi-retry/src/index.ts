/**
 * @inobit/pi-retry — 手动透明重试：/retry + 快捷键（默认 alt+r）
 *
 * 语义：把上一次失败的 turn 原样重新发起——失败的半截 assistant 消息保留在上下文末尾，
 * 不注入任何有语义的提示词，模型按 prefill 方式无缝续写。
 *
 * 实现要点：
 * - 扳机：`sendMessage({ customType, triggerTurn: true })` 是公开 API 里唯一能零参数发起
 *   turn 的入口；哨兵消息会落盘并经 convertToLlm 转成 user 消息，因此必须配合过滤。
 * - 过滤：`context` 事件在每次 LLM 调用前、convertToLlm 之前触发，返回 { messages } 即整体
 *   替换（runner.emitContext）。常驻过滤保证哨兵在任何后续 turn / resume 后都出不去。
 * - 其余一切消息（含 error/aborted 的半截 assistant）原样透传，不做任何改写。
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { KeyId } from "@earendil-works/pi-tui";
import { loadConfig, SHORTCUT as DEFAULT_SHORTCUT } from "./config.ts";
import {
  RETRY_SENTINEL_TEXT,
  RETRY_SENTINEL_TYPE,
  findLastAssistantStop,
  isRetryableStop,
  stripRetrySentinels,
} from "./filter.ts";

export default function (pi: ExtensionAPI) {
  // 快捷键可配：~/.pi/agent/extensions/pi-retry/config.json {"shortcut":"alt+r"}，需 /reload
  let shortcut: string = DEFAULT_SHORTCUT;
  try {
    const cfg = loadConfig(process.cwd());
    if (cfg.shortcut) shortcut = cfg.shortcut;
  } catch {}

  // 常驻过滤：哨兵永不进入任何 LLM 请求。O(n) 且无哨兵时零拷贝快路径。
  pi.on("context", async (event) => {
    return { messages: stripRetrySentinels(event.messages) };
  });

  const doRetry = async (ctx: ExtensionContext): Promise<void> => {
    // 仅 idle 时允许：streaming 中 sendMessage 会转成 steer/followUp 队列注入，
    // 与「重发失败 turn」的语义不符且会打断当前流，显式拒绝优于静默变义。
    let idle = true;
    try {
      idle = typeof ctx.isIdle === "function" ? ctx.isIdle() : true;
    } catch {
      idle = true;
    }
    if (!idle) {
      try {
        ctx.ui.notify("Agent is busy — retry is only available when idle", "warning");
      } catch {}
      return;
    }

    // 失败守卫：仅当最近一条 assistant 是 error/aborted 时才触发。
    // 每次触发都会永久写入哨兵 entry，误按的代价不可逆，故正常结束/新会话均显式拒绝。
    // 分支不可读（异常）时 fail-open：尊重用户的显式按键意图。
    let stop: string | undefined;
    let readable = true;
    try {
      const branch = ctx.sessionManager.getBranch() as readonly unknown[];
      stop = findLastAssistantStop(branch);
    } catch {
      readable = false;
    }
    if (readable && !isRetryableStop(stop)) {
      try {
        ctx.ui.notify(
          stop === undefined ? "Nothing to retry yet" : `Nothing to retry — last turn ended normally (${stop})`,
          "warning",
        );
      } catch {}
      return;
    }
    try {
      pi.sendMessage(
        {
          customType: RETRY_SENTINEL_TYPE,
          content: [{ type: "text", text: RETRY_SENTINEL_TEXT }],
          // display:false → transcript 不渲染，哨兵在 UI 层也不可见
          display: false,
        },
        { triggerTurn: true },
      );
      // 扳机已提交；注意 sendMessage 返回 void，异步拒绝只会进 runner.emitError
      // （如 compaction 进行中会 throw），此处通知仅代表“已受理”而非“turn 已启动”
      try {
        ctx.ui.notify("Retry submitted", "info");
      } catch {}
    } catch (e) {
      try {
        ctx.ui.notify(`Retry failed to start: ${e instanceof Error ? e.message : String(e)}`, "error");
      } catch {}
    }
  };

  pi.registerCommand("retry", {
    description: `Retry the last failed turn transparently (no prompt injected). Shortcut: ${shortcut}`,
    handler: async (_args: unknown, ctx: ExtensionContext) => {
      await doRetry(ctx);
    },
  });

  try {
    pi.registerShortcut(shortcut as unknown as KeyId, {
      description: "Retry last failed turn (delegates to same path as /retry)",
      handler: async (ctx: ExtensionContext) => {
        // 快捷键与命令共用 doRetry：两者都只依赖基础 ctx 的 isIdle 与 pi.sendMessage，
        // 行为一致性由构造保证，无需像 pi-undo 那样委托命令派发管道。
        await doRetry(ctx);
      },
    });
  } catch (e) {
    try {
      console.warn(`[pi-retry] shortcut ${shortcut} failed: ${String(e)}`);
    } catch {}
  }
}
