import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { KeyId } from "@earendil-works/pi-tui";
import { BUILTIN_WRITE_TOOLS } from "./config.ts";
import type { WorkMode } from "./decision.ts";

/** plan 模式系统提示注入文案（FR-8.4）。 */
export const PLAN_SYSTEM_PROMPT =
  "You are in PLAN mode — read-only. Do not edit files or run state-changing commands. Use read, search, and planning only.";

/** 只读纠正公告（FR-8.4b）：plan→build、plan→chill 后首个 turn 注入一次，显式撤销只读约束，两处复用同一文案。 */
export const BUILD_SWITCH_NOTICE =
  "Plan mode off. Normal permission checks restored.";

/** yolo 模式切入公告：仅从非 yolo 切到 yolo 的首轮注入一次。 */
export const YOLO_SWITCH_NOTICE =
  "Yolo on: prompts bypassed, sensitive files still blocked. Stay cautious — avoid destructive commands unless the user explicitly asks.";


/** pi 全局主题实例键（与 pi 内部 getMarkdownTheme 同机制）。 */
const THEME_KEY = Symbol.for("@earendil-works/pi-coding-agent:theme");

/** 取当前主题实例；未初始化时返回 undefined（状态栏降级为纯文本）。 */
function getTheme(): Theme | undefined {
  try {
    return (globalThis as Record<symbol, unknown>)[THEME_KEY] as Theme | undefined;
  } catch {
    return undefined;
  }
}

/** 状态栏文案：风险单调上色——Plan 绿（success）、Build accent、Chill 橙（warning）、Yolo 红（error），跟随当前主题。 */
export function statusText(mode: WorkMode): string {
  const theme = getTheme();
  const label = mode === "plan" ? "Plan" : mode === "yolo" ? "Yolo" : mode === "chill" ? "Chill" : "Build";
  if (!theme) return label;
  if (mode === "plan") return theme.fg("success", label);
  if (mode === "chill") return theme.fg("warning", label);
  if (mode === "yolo") return theme.fg("error", label);
  return theme.fg("accent", label);
}

/** 取会话标识；无 sessionManager 时回退到全局键。 */
export function sessionKey(ctx: ExtensionContext): string {
  try {
    return ctx.sessionManager?.getSessionId?.() ?? "global";
  } catch {
    return "global";
  }
}

/** plan/build/yolo 内存状态（FR-8 / D8：会话级、不持久化），subagent 继承宿主模式。 */
export class ModeStore {
  private modes = new Map<string, WorkMode>();
  private savedActiveTools = new Map<string, string[]>();

  /**
   * 取会话模式；`fallback` 为新会话默认值（配置 `defaultMode` 归一结果，默认 `build`）。
   */
  getMode(key: string, fallback: WorkMode = "build"): WorkMode {
    return this.modes.get(key) ?? fallback;
  }

  /** 切换模式并同步 TUI 状态栏与活动工具集（FR-8.5/FR-8.6），幂等。
   * `fallback` 同 getMode：用于 prev 判定，避免 `defaultMode: "chill"` 下 /build 早退导致状态栏失真。 */
  async setMode(key: string, mode: WorkMode, pi: ExtensionAPI, ctx: ExtensionContext, fallback: WorkMode = "build"): Promise<void> {
    const prev = this.getMode(key, fallback);
    this.modes.set(key, mode);
    if (mode === prev) return;

    try {
      const active = pi.getActiveTools();
      // plan 为只读需隐藏写工具，yolo/build 均为非 plan 需恢复
      if (mode === "plan" && prev !== "plan") {
        this.savedActiveTools.set(key, active);
        const next = active.filter((t) => !BUILTIN_WRITE_TOOLS.includes(t));
        if (next.length !== active.length) pi.setActiveTools(next);
      } else if (prev === "plan" && mode !== "plan") {
        const saved = this.savedActiveTools.get(key);
        if (saved) pi.setActiveTools(saved);
        this.savedActiveTools.delete(key);
      }
    } catch {
      // 工具集调整失败不影响模式切换，tool_call 拦截兜底
    }

    try {
      ctx.ui.setStatus("pi-permission-mode", statusText(mode));
    } catch {
      // 无 UI 时忽略状态栏更新
    }
  }
}

/** 注册 /plan、/build、/chill、/yolo 命令（FR-8.2，重复输入幂等）与可配置的切换快捷键。 */
export function registerModeCommands(
  pi: ExtensionAPI,
  store: ModeStore,
  opts: { toggleModeShortcut: string; defaultMode: WorkMode },
): void {
  /** 会话默认模式（配置 defaultMode 归一结果）：getMode/setMode 的回退值，
   * 保证 `defaultMode: "chill"` 下 /build 不会被「当前即目标」早退吞掉状态栏更新。 */
  const fallback = opts.defaultMode;
  pi.registerCommand("plan", {
    description: "Switch to read-only planning mode: all writes denied, read-only operations allowed",
    handler: async (args, ctx) => {
      const key = sessionKey(ctx);
      await store.setMode(key, "plan", pi, ctx, fallback);
      if (ctx.hasUI) ctx.ui.notify("[pi-permission] switched to plan mode (read-only)", "info");
    },
  });
  pi.registerCommand("build", {
    description: "Switch back to normal mode: sensitive-file / project-boundary / dangerous-operation rules apply",
    handler: async (args, ctx) => {
      const key = sessionKey(ctx);
      await store.setMode(key, "build", pi, ctx, fallback);
      if (ctx.hasUI) ctx.ui.notify("[pi-permission] switched to build mode", "info");
    },
  });
  pi.registerCommand("chill", {
    description: "Switch to chill mode: relaxed checks, only critical list asks",
    handler: async (args, ctx) => {
      const key = sessionKey(ctx);
      await store.setMode(key, "chill", pi, ctx, fallback);
      if (ctx.hasUI) ctx.ui.notify("[pi-permission] switched to chill mode (relaxed; critical list still asks)", "info");
    },
  });
  pi.registerCommand("yolo", {
    description: "Switch to yolo mode: bypass all checks except sensitive files (requires confirmation)",
    handler: async (args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("[pi-permission] yolo requires UI confirmation", "warning");
        return;
      }
      const choice = await ctx.ui.select("Enable yolo mode? Prompts bypassed, sensitive files still blocked.", [
        "y: confirm yolo",
        "n: cancel",
      ]);
      if (choice !== "y: confirm yolo") {
        ctx.ui.notify("[pi-permission] yolo cancelled", "info");
        return;
      }
      const key = sessionKey(ctx);
      await store.setMode(key, "yolo", pi, ctx, fallback);
      if (ctx.hasUI) ctx.ui.notify("[pi-permission] switched to yolo mode — prompts bypassed (sensitive files still blocked)", "warning");
    },
  });

  // 快捷键按 plan → build → chill → plan 顺序循环（如 Alt+P）；配置为空字符串则禁用。
  // 键位格式见 pi keybindings.md（`modifier+key`，如 `alt+p`、`f4`）。
  // 配置为非法键位或与内置受保护键位冲突时，pi 会发警告并跳过，不会影响加载。
  const shortcut = opts.toggleModeShortcut.trim();
  if (shortcut) {
    pi.registerShortcut(shortcut as KeyId, {
      description: "Cycle plan (read-only) → build → chill mode",
      handler: async (ctx) => {
        const key = sessionKey(ctx);
        const current = store.getMode(key, fallback);
        const next: WorkMode = current === "plan" ? "build" : current === "build" ? "chill" : "plan";
        await store.setMode(key, next, pi, ctx, fallback);
        if (ctx.hasUI) ctx.ui.notify(`[pi-permission] switched to ${next} mode`, "info");
      },
    });
  }
}