/**
 * @inobit/pi-undo — 撤销：把最近一次发送的输入撤回到输入框并从对话中移除
 * 单次/轮，队列感知，原子 abort，快捷键 alt+u（委托 /undo 命令管道）
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { findLastUserEntry } from "./history.ts";
import { loadConfig, SHORTCUT as DEFAULT_SHORTCUT } from "./config.ts";

type SessionId = string;
const SHORTCUT = DEFAULT_SHORTCUT;

// 硬撤销成功后追加的哨兵条目类型：不进 LLM 上下文、TUI 不渲染，
// 仅用于把分支终点固定到磁盘（resume 按「文件最后一条 entry」重建 leaf）
const UNDO_PIN_ENTRY = "pi-undo-pin";

// abort 后等 idle 的总预算与轮询节拍（原 50*200ms=10s 魔法数收敛）
const WAIT_MS = 3000;
const POLL_MS = 50;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function sessionIdOf(ctx: ExtensionContext): SessionId {
  try {
    return ctx.sessionManager.getSessionId() ?? "__global__";
  } catch {
    return "__global__";
  }
}

/**
 * 等待 agent 回到 idle。
 * - 有 waitForIdle（/undo 命令上下文）：事件驱动 + WAIT_MS 超时兜底
 * - 无 waitForIdle（受限上下文）：deadline 轮询，每 POLL_MS 检一次
 */
async function waitUntilIdle(ctx: ExtensionContext): Promise<void> {
  const maybe = ctx as unknown as { waitForIdle?: () => Promise<void> };
  if (typeof maybe.waitForIdle === "function") {
    await Promise.race([maybe.waitForIdle(), sleep(WAIT_MS)]);
    return;
  }
  const deadline = Date.now() + WAIT_MS;
  while (Date.now() < deadline) {
    const isIdle = typeof (ctx as unknown as { isIdle?: () => boolean }).isIdle === "function"
      ? (ctx as unknown as { isIdle: () => boolean }).isIdle()
      : true;
    if (isIdle) return;
    await sleep(POLL_MS);
  }
}

export default function (pi: ExtensionAPI) {
  const canUndoBySid = new Map<SessionId, boolean>();
  const mirrorBySid = new Map<SessionId, string[]>();
  const pendingBySid = new Set<SessionId>();

  const getCanUndo = (sid: SessionId): boolean => (canUndoBySid.has(sid) ? canUndoBySid.get(sid)! : true);
  const setCanUndo = (sid: SessionId, v: boolean): void => { canUndoBySid.set(sid, v); };
  const getMirror = (sid: SessionId): string[] => {
    let a = mirrorBySid.get(sid);
    if (!a) { a = []; mirrorBySid.set(sid, a); }
    return a;
  };

  const doUndo = async (ctx: ExtensionContext): Promise<void> => {
    if (!ctx.hasUI) return;
    const sid = sessionIdOf(ctx);

    const safeNotify = (msg: string, level: "info" | "warning" | "error" = "warning"): void => {
      try { ctx.ui.notify(msg, level); } catch {}
    };

    if (pendingBySid.has(sid)) {
      safeNotify("Undo already in progress, try again", "warning");
      return;
    }
    if (!getCanUndo(sid)) {
      safeNotify("Already undone for this turn. Send a new message to undo again.", "warning");
      return;
    }
    let draft = "";
    try { draft = ctx.ui.getEditorText() ?? ""; } catch {}
    if (draft.trim() !== "") {
      safeNotify("Editor has draft, clear it first", "warning");
      return;
    }

    const mirror = getMirror(sid);
    if (mirror.length > 0) {
      // 单次/轮预占，避免并发二次 pop
      setCanUndo(sid, false);
      const popped = mirror.pop();
      if (popped === undefined) return;
      try { ctx.ui.setEditorText(popped); } catch {}
      // 强刷一次，确保 TUI 立即刷新
      try { ctx.ui.setStatus("pi-undo", " "); ctx.ui.setStatus("pi-undo", undefined); } catch {}
      return;
    }

    // 历史撤销路径：加互斥，防止并发绕过单次/轮
    pendingBySid.add(sid);
    try {
      const isIdleFn = typeof (ctx as unknown as { isIdle?: () => boolean }).isIdle === "function"
        ? () => (ctx as unknown as { isIdle: () => boolean }).isIdle()
        : () => true;
      const abortFn = typeof (ctx as unknown as { abort?: () => void }).abort === "function"
        ? () => (ctx as unknown as { abort: () => void }).abort()
        : () => {};

      if (!isIdleFn()) {
        try { abortFn(); } catch {}
        await waitUntilIdle(ctx);
        if (!isIdleFn()) {
          safeNotify("Abort did not settle, try again", "warning");
          return;
        }
        let d2 = "";
        try { d2 = ctx.ui.getEditorText() ?? ""; } catch {}
        if (d2.trim() !== "") {
          safeNotify("Editor has draft, clear it first", "warning");
          return;
        }
      }

      let branch: readonly unknown[] = [];
      try { branch = ctx.sessionManager.getBranch() as readonly unknown[]; } catch { branch = []; }
      const found = findLastUserEntry(branch as never);
      if (!found) {
        safeNotify("No message to undo", "warning");
        return;
      }

      const anyCtx = ctx as unknown as Record<string, unknown>;
      const sm = ctx.sessionManager as unknown as Record<string, unknown>;

      // 读取当前 leaf 指针；能力缺失或异常时返回 undefined（无法观测移动，退化为仅信任结果标志）
      const getLeafIdSafe = (): string | null | undefined => {
        try {
          const fn = (ctx.sessionManager as unknown as { getLeafId?: () => string | null }).getLeafId;
          return typeof fn === "function" ? fn.call(ctx.sessionManager) : undefined;
        } catch {
          return undefined;
        }
      };

      // 哨兵落盘：把生效分支的终点写进文件末尾，否则 resume 会按旧末条重建 leaf 导致复活
      const appendPinSafely = (): void => {
        try {
          pi.appendEntry(UNDO_PIN_ENTRY, { v: 1, at: found.parentId ?? null });
        } catch {}
      };

      try {
        if (typeof anyCtx.navigateTree !== "function") {
          // 受限上下文（如部分宿主版本的快捷键环境）没有导航能力：
          // 显式失败优于静默降级——sm.branch() 只动内存指针，UI/context/磁盘三者都不会更新
          safeNotify("Hard undo unavailable here — use /undo instead", "warning");
          return;
        }

        const leafBefore = getLeafIdSafe();
        let target = found.entryId;
        if (leafBefore !== undefined && leafBefore === found.entryId) {
          // no-op 陷阱：目标恰为当前 leaf 时 navigateTree 会静默早退（返回 cancelled:false 但什么都不做）。
          // 典型场景：崩溃 resume 后文件末条恰为该 user 消息。改以 parent 为目标触发真实导航。
          if (found.parentId != null) {
            target = found.parentId;
          } else {
            // 特例：首条消息本身是 leaf，没有任何 entry 可作导航目标。
            // 语义：resetLeaf + 根级哨兵保证磁盘正确；进程内视图无法在此重建，显式告知用户。
            if (typeof sm.resetLeaf !== "function") throw new Error("No hard revert capability");
            (sm.resetLeaf as () => void)();
            appendPinSafely();
            try { ctx.ui.setEditorText(found.text); } catch {}
            try { ctx.ui.setStatus("pi-undo", " "); ctx.ui.setStatus("pi-undo", undefined); } catch {}
            setCanUndo(sid, false);
            safeNotify("Undone on disk. In-memory view not refreshed — restart or /new to apply.", "warning");
            return;
          }
        }

        const result = await (anyCtx.navigateTree as (id: string, opts: unknown) => Promise<unknown>)(
          target,
          { summarize: false },
        );
        // 结果字段不可信（no-op 早退同样返回 cancelled:false），以 leaf 是否实际移动为准；
        // getLeafId 不可用时退化为仅信任 cancelled 标志
        const cancelled = (result as { cancelled?: boolean } | undefined)?.cancelled === true;
        const moved = leafBefore === undefined
          ? !cancelled
          : getLeafIdSafe() !== leafBefore;
        if (cancelled || !moved) {
          // 导航未生效：会话保持原状。不回填编辑器、不消耗单次/轮、绝不落哨兵
          // （此时落哨兵会把待撤销消息钉回生效路径，主动制造 resume 复活）
          safeNotify("Undo did not take effect, try again", "warning");
          return;
        }

        // navigateTree 已在内部 setEditorText（当编辑器空时），再补一次确保
        try { ctx.ui.setEditorText(found.text); } catch {}
        try { ctx.ui.setStatus("pi-undo", " "); ctx.ui.setStatus("pi-undo", undefined); } catch {}
        appendPinSafely();
        setCanUndo(sid, false);
        return;
      } catch (e) {
        try { ctx.ui.setEditorText(found.text); } catch {}
        setCanUndo(sid, false);
        safeNotify(`Hard undo failed: ${e instanceof Error ? e.message : String(e)}`, "warning");
        return;
      }
    } finally {
      pendingBySid.delete(sid);
    }
  };

  pi.on("input", async (event, ctx) => {
    const sid = sessionIdOf(ctx);
    const beh = (event as unknown as { streamingBehavior?: string }).streamingBehavior;
    if (beh === "steer" || beh === "followUp") {
      const t = event.text?.trim() ?? "";
      if (t !== "" && !(t === "/undo" || t.startsWith("/undo ") || t.startsWith("/undo\t"))) {
        const m = getMirror(sid);
        m.push(t);
        if (m.length > 20) m.shift();
      }
    }
    return { action: "continue" as const };
  });

  pi.on("before_agent_start", async (event, ctx) => {
    const sid = sessionIdOf(ctx);
    setCanUndo(sid, true);
    const m = getMirror(sid);
    if (m.length > 0 && event.prompt !== undefined) {
      const promptTrim = typeof event.prompt === "string" ? event.prompt.trim() : String(event.prompt).trim();
      if (promptTrim !== "") {
        if (m[0] === promptTrim) m.shift();
        else {
          const idx = m.indexOf(promptTrim);
          if (idx !== -1) m.splice(idx, 1);
        }
      }
    }
  });

  pi.on("session_start", async (_e, ctx) => {
    const sid = sessionIdOf(ctx);
    setCanUndo(sid, true);
    mirrorBySid.set(sid, []);
    pendingBySid.delete(sid);
  });
  pi.on("session_shutdown", async (_e, ctx) => {
    const sid = sessionIdOf(ctx);
    mirrorBySid.delete(sid);
    canUndoBySid.delete(sid);
    pendingBySid.delete(sid);
  });

  // 快捷键可配：~/.pi/agent/extensions/pi-undo/config.json {"shortcut":"alt+u"}，需 /reload
  let shortcut: string = SHORTCUT;
  try {
    const cfg = loadConfig(process.cwd());
    if (cfg.shortcut) shortcut = cfg.shortcut;
  } catch {}

  pi.registerCommand("undo", {
    description: `Undo last prompt to editor (hard revert, single per turn, queue-aware). Shortcut: ${shortcut}`,
    handler: async (_a, ctx) => { await doUndo(ctx); },
  });

  try {
    pi.registerShortcut(shortcut as unknown as import("@earendil-works/pi-tui").KeyId, {
      description: "Undo last prompt to editor (delegates to /undo)",
      handler: async () => {
        // 宿主给快捷键注入的上下文缺少 navigateTree 等 session-control 能力（类型层却同为
        // ExtensionContext），直接跑 doUndo 只能拿到精简 ctx。委托 /undo 走命令派发管道后
        // 与手敲 /undo 字面上同一条执行路径，行为一致性由构造保证。
        // expandPromptTemplates 必须显式 true（宿主默认 false）：命中扩展命令后立即返回，不触发 LLM turn。
        pi.sendUserMessage("/undo", { expandPromptTemplates: true });
      },
    });
  } catch (e) {
    try { console.warn(`[pi-undo] shortcut ${shortcut} failed: ${String(e)}`); } catch {}
  }
}
