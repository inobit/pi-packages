import fs from "node:fs";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, type Component, type TUI } from "@earendil-works/pi-tui";
import { BUILTIN_READONLY_TOOLS, BUILTIN_WRITE_TOOLS, type PermissionConfig } from "./config.ts";

/** UI 中恒锁定的工具：内置只读 + 内置写 + bash（bash 走独立 bash 判定，勾选无效）。 */
const UI_LOCKED: readonly string[] = [...BUILTIN_READONLY_TOOLS, ...BUILTIN_WRITE_TOOLS, "bash"];

/** /readonly-tools 命令依赖。 */
export interface ToolsDeps {
  /** 取当前生效配置（持久层 ∪ session 层，readonlyTools 并集）。 */
  getConfig: (ctx: ExtensionContext) => PermissionConfig;
  /** 写入 session 层（内存，不持久化）。 */
  setSessionTools: (skey: string, tools: string[]) => void;
  /** 读取 session 层。 */
  getSessionTools: (skey: string) => string[];
  globalConfigPath: () => string;
  readGlobalConfig: () => Record<string, unknown>;
  projectConfigPath: (cwd: string) => string;
  readProjectConfig: (cwd: string) => Record<string, unknown>;
  isTrusted: (ctx: ExtensionContext) => boolean;
  /** 清除持久层配置缓存（写文件后调用）。 */
  invalidateConfig: (cwd: string, trusted: boolean) => void;
}

type PickerResult = { selected: string[]; done: boolean };
type EditTarget = "session" | "project" | "global";

const TARGET_SESSION = "session: current session only (memory)";
const TARGET_PROJECT = "project: this project (.pi/extensions/pi-permission/config.json)";
const TARGET_GLOBAL = "global: user-wide config.json";

/**
 * 注册 `/readonly-tools` 命令：
 * 1. 选择编辑目标（session / project / global），Esc 取消；
 *    每层只改自己：目标层之外的配置（含内置/其他层）锁定不可动。
 * 2. 空格选中/取消选中（锁定项灰色不可操作），↑/↓/j/k 移动、Enter 完成、Esc 取消
 * 3. 有变更时按目标保存（session 内存 / project / global 写 config.json）
 */
export function registerToolsCommand(pi: ExtensionAPI, deps: ToolsDeps): void {
  pi.registerCommand("readonly-tools", {
    description: "Manage read-only tools (plan mode): session/project/global levels, space to toggle",
    handler: async (args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("[pi-permission] /readonly-tools requires the TUI", "warning");
        return;
      }

      const target = await ctx.ui.select("Manage read-only tools for", [
        TARGET_SESSION,
        TARGET_PROJECT,
        TARGET_GLOBAL,
      ]);
      if (!target) {
        ctx.ui.notify("[pi-permission] cancelled", "info");
        return;
      }
      const editTarget: EditTarget =
        target === TARGET_GLOBAL ? "global" : target === TARGET_PROJECT ? "project" : "session";

      // 项目级配置要求项目被信任
      if (editTarget === "project" && !deps.isTrusted(ctx)) {
        ctx.ui.notify("[pi-permission] project is not trusted; cannot write project config", "warning");
        return;
      }

      const allTools = [...new Set(pi.getAllTools().map((t) => t.name))].sort();
      if (allTools.length === 0) {
        ctx.ui.notify("[pi-permission] no tools available", "info");
        return;
      }

      // 各层已有工具
      const globalTools = (deps.readGlobalConfig()?.["readonlyTools"] as string[] | undefined) ?? [];
      const projectTools = (deps.readProjectConfig(ctx.cwd)?.["readonlyTools"] as string[] | undefined) ?? [];
      const skey = sessionKeyFor(ctx);
      const sessionTools = deps.getSessionTools(skey);

      // 锁定集合：目标层之外的所有层（含内置 + 其他层），目标层只能改自己
      const locked = new Set<string>([
        ...UI_LOCKED,
        ...(editTarget === "global" ? [...projectTools, ...sessionTools] : []),
        ...(editTarget === "project" ? [...globalTools, ...sessionTools] : []),
        ...(editTarget === "session" ? [...globalTools, ...projectTools] : []),
      ]);

      const current = deps.getConfig(ctx).readonlyTools;
      const result = await ctx.ui.custom<PickerResult>(
        (tui, theme, _keybindings, done) => createToolPicker(allTools, current, locked, theme, tui, done),
        { overlay: true },
      );

      if (!result || !result.done) {
        ctx.ui.notify("[pi-permission] cancelled", "info");
        return;
      }
      const selected = result.selected;
      const unchanged =
        selected.length === current.length && selected.every((t) => current.includes(t));
      if (unchanged) {
        ctx.ui.notify("[pi-permission] no changes", "info");
        return;
      }

      // 该层增量 = 勾选 - 锁定（其他层/内置保持原状）
      const ownPart = selected.filter((t) => !locked.has(t));

      if (editTarget === "session") {
        deps.setSessionTools(skey, ownPart);
        ctx.ui.notify("[pi-permission] read-only tools updated for this session", "info");
        return;
      }

      // project / global：写入 config.json
      const configPath =
        editTarget === "global" ? deps.globalConfigPath() : deps.projectConfigPath(ctx.cwd);
      try {
        const existing = editTarget === "global" ? deps.readGlobalConfig() : deps.readProjectConfig(ctx.cwd);
        if (ownPart.length > 0) existing["readonlyTools"] = ownPart;
        else delete existing["readonlyTools"];
        fs.mkdirSync(path.dirname(configPath), { recursive: true });
        fs.writeFileSync(configPath, `${JSON.stringify(existing, null, 2)}\n`);
        deps.invalidateConfig(ctx.cwd, ctx.isProjectTrusted());
        ctx.ui.notify(
          `[pi-permission] read-only tools saved to ${editTarget} config`,
          "info",
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        ctx.ui.notify(`[pi-permission] failed to write ${editTarget} config: ${message}`, "error");
      }
    },
  });
}

/** 会话标识（与 index.ts 的 sessionKey 一致）。 */
function sessionKeyFor(ctx: ExtensionContext): string {
  try {
    return ctx.sessionManager?.getSessionId?.() ?? "global";
  } catch {
    return "global";
  }
}

const BORDER_TL = "┌";
const BORDER_TR = "┐";
const BORDER_BL = "└";
const BORDER_BR = "┘";
const BORDER_H = "─";
const BORDER_V = "│";

/**
 * 空格多选组件：↑/↓/j/k 移动（自动滚动）、space 切换、enter 完成、esc/q 取消。
 * 锁定项（灰色）保持选中且不可切换；光标行加背景色；弹窗带边框。
 */
function createToolPicker(
  allTools: string[],
  initial: readonly string[],
  locked: ReadonlySet<string>,
  theme: Theme,
  tui: TUI,
  done: (r: PickerResult) => void,
): Component {
  let cursor = 0;
  let viewportOffset = 0;
  const selected = new Set(initial);
  // 可见高度：终端行数减去 首边框+标题+末边框+余量
  const rows = tui.terminal?.rows ?? 24;
  const visibleHeight = Math.max(3, Math.min(allTools.length, rows - 4));

  const clampViewport = () => {
    if (cursor < viewportOffset) viewportOffset = cursor;
    else if (cursor >= viewportOffset + visibleHeight) {
      viewportOffset = cursor - visibleHeight + 1;
    }
  };

  return {
    invalidate() {
      // 无缓存状态
    },
    handleInput(data: string) {
      if (matchesKey(data, "up") || matchesKey(data, "k")) {
        cursor = cursor > 0 ? cursor - 1 : allTools.length - 1;
        clampViewport();
        tui.requestRender();
      } else if (matchesKey(data, "down") || matchesKey(data, "j")) {
        cursor = (cursor + 1) % allTools.length;
        clampViewport();
        tui.requestRender();
      } else if (matchesKey(data, "space")) {
        const tool = allTools[cursor];
        if (tool && !locked.has(tool)) {
          if (selected.has(tool)) selected.delete(tool);
          else selected.add(tool);
          tui.requestRender();
        }
      } else if (matchesKey(data, "return")) {
        done({ selected: [...selected].sort(), done: true });
      } else if (matchesKey(data, "escape") || matchesKey(data, "q")) {
        done({ selected: [], done: false });
      }
    },
    render(width: number): string[] {
      const innerW = Math.max(20, Math.min(width - 2, 64));
      // 先对纯文本截断/补全（保证边框对齐），再套 ANSI 颜色（颜色序列不占可视宽度）
      const fmt = (text: string, isLocked: boolean, isCursor: boolean): string => {
        let line = truncateToWidth(text, innerW, "…").padEnd(innerW);
        if (isLocked) line = theme.fg("dim", line);
        if (isCursor) line = theme.bg("selectedBg", line);
        return `${BORDER_V} ${line} ${BORDER_V}`;
      };

      const lines: string[] = [];
      lines.push(`${BORDER_TL}${BORDER_H.repeat(innerW + 2)}${BORDER_TR}`);
      const title = "Read-only tools (plan mode) — space toggle · ↑↓/jk move · enter done · esc cancel · dim=locked";
      lines.push(fmt(title, false, false));

      for (let i = viewportOffset; i < viewportOffset + visibleHeight; i++) {
        const tool = allTools[i];
        if (!tool) break;
        const isLocked = locked.has(tool);
        const isCursor = i === cursor;
        const mark = selected.has(tool) ? "[x]" : "[ ]";
        const lockLabel = isLocked ? " (locked)" : "";
        const prefix = isCursor ? "> " : "  ";
        const content = `${prefix}${mark} ${tool}${lockLabel}`;
        lines.push(fmt(content, isLocked, isCursor));
      }

      lines.push(`${BORDER_BL}${BORDER_H.repeat(innerW + 2)}${BORDER_BR}`);
      return lines;
    },
  };
}