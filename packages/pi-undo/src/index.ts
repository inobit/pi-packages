/**
 * @inobit/pi-undo — 撤销：把最近一次发送的输入撤回到输入框并从对话中移除
 * 单次/轮，队列感知，原子 abort，快捷键 alt+u
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { findLastUserEntry } from "./history.ts";
import { loadConfig, SHORTCUT as DEFAULT_SHORTCUT } from "./config.ts";

type SessionId = string;
const SHORTCUT = DEFAULT_SHORTCUT;

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
 * - 无 waitForIdle（alt+u 快捷键上下文）：deadline 轮询，每 POLL_MS 检一次
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
      try {
        // 首条消息优先 resetLeaf，再回退到 parentId
        if (found.parentId === null || found.parentId === undefined) {
          if (typeof sm.resetLeaf === "function") {
            (sm.resetLeaf as () => void)();
          } else {
            throw new Error("No hard revert capability");
          }
        } else if (typeof anyCtx.navigateTree === "function") {
          await (anyCtx.navigateTree as (id: string, opts: unknown) => Promise<unknown>)(found.parentId, { summarize: false });
        } else if (typeof sm.branch === "function") {
          (sm.branch as (id: string) => void)(found.parentId);
        } else {
          throw new Error("No hard revert capability");
        }
        // navigateTree 已在内部 setEditorText（当编辑器空时），再补一次确保
        try { ctx.ui.setEditorText(found.text); } catch {}
        try { ctx.ui.setStatus("pi-undo", " "); ctx.ui.setStatus("pi-undo", undefined); } catch {}
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
      description: "Undo last prompt to editor (hard)",
      handler: async (ctx) => { await doUndo(ctx); },
    });
  } catch (e) {
    try { console.warn(`[pi-undo] shortcut ${shortcut} failed: ${String(e)}`); } catch {}
  }
}
