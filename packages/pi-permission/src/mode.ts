import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { KeyId } from "@earendil-works/pi-tui";
import { BUILTIN_WRITE_TOOLS } from "./config.ts";
import type { WorkMode } from "./decision.ts";

/** plan 模式系统提示注入文案（FR-8.4）。 */
export const PLAN_SYSTEM_PROMPT =
  "You are in PLAN (read-only) mode. Do not modify files or run any command that changes state; only read, search, and plan.";

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

/** 状态栏文案：Plan 偏绿（success）、Build 偏红（error），跟随当前主题。 */
export function statusText(mode: WorkMode): string {
  const theme = getTheme();
  const label = mode === "plan" ? "Plan" : "Build";
  if (!theme) return label;
  return mode === "plan" ? theme.fg("success", label) : theme.fg("error", label);
}

/** 取会话标识；无 sessionManager 时回退到全局键。 */
export function sessionKey(ctx: ExtensionContext): string {
  try {
    return ctx.sessionManager?.getSessionId?.() ?? "global";
  } catch {
    return "global";
  }
}

/** plan/build 内存状态（FR-8 / D8：会话级、不持久化），subagent 继承宿主模式。 */
export class ModeStore {
  private modes = new Map<string, WorkMode>();
  private savedActiveTools = new Map<string, string[]>();

  getMode(key: string): WorkMode {
    return this.modes.get(key) ?? "build";
  }

  /** 切换模式并同步 TUI 状态栏与活动工具集（FR-8.5/FR-8.6），幂等。 */
  async setMode(key: string, mode: WorkMode, pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
    const prev = this.getMode(key);
    this.modes.set(key, mode);
    if (mode === prev) return;

    try {
      const active = pi.getActiveTools();
      if (mode === "plan") {
        this.savedActiveTools.set(key, active);
        const next = active.filter((t) => !BUILTIN_WRITE_TOOLS.includes(t));
        if (next.length !== active.length) pi.setActiveTools(next);
      } else {
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

/** 注册 /plan、/build 命令（FR-8.2，重复输入幂等）与可配置的切换快捷键。 */
export function registerModeCommands(
  pi: ExtensionAPI,
  store: ModeStore,
  opts: { toggleModeShortcut: string },
): void {
  pi.registerCommand("plan", {
    description: "Switch to read-only planning mode: all writes denied, read-only operations allowed",
    handler: async (args, ctx) => {
      const key = sessionKey(ctx);
      await store.setMode(key, "plan", pi, ctx);
      if (ctx.hasUI) ctx.ui.notify("[pi-permission] switched to plan mode (read-only)", "info");
    },
  });
  pi.registerCommand("build", {
    description: "Switch back to normal mode: sensitive-file / project-boundary / dangerous-operation rules apply",
    handler: async (args, ctx) => {
      const key = sessionKey(ctx);
      await store.setMode(key, "build", pi, ctx);
      if (ctx.hasUI) ctx.ui.notify("[pi-permission] switched to build mode", "info");
    },
  });

  // 快捷键在 plan/build 之间来回切换（如 Alt+P）；配置为空字符串则禁用。
  // 键位格式见 pi keybindings.md（`modifier+key`，如 `alt+p`、`f4`）。
  // 配置为非法键位或与内置受保护键位冲突时，pi 会发警告并跳过，不会影响加载。
  const shortcut = opts.toggleModeShortcut.trim();
  if (shortcut) {
    pi.registerShortcut(shortcut as KeyId, {
      description: "Toggle between plan (read-only) and build mode",
      handler: async (ctx) => {
        const key = sessionKey(ctx);
        const next: WorkMode = store.getMode(key) === "plan" ? "build" : "plan";
        await store.setMode(key, next, pi, ctx);
        if (ctx.hasUI) ctx.ui.notify(`[pi-permission] switched to ${next} mode`, "info");
      },
    });
  }
}