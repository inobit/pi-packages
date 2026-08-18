import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/** 用户确认结果。 */
export type ConfirmChoice = "yes" | "session" | "no";

export interface ConfirmOptions {
  title: string;
  /** 风险等级：danger 用于 FR-4 危险操作（不可逆/高风险标注）。 */
  dangerLevel?: "info" | "warning" | "danger";
  details?: string[];
}

export interface Confirmer {
  confirm(ctx: ExtensionContext, options: ConfirmOptions): Promise<ConfirmChoice>;
}

/**
 * ask 决策的用户交互封装（NFR-5）。
 *
 * 交互约定：`y` 允许本次 / `s` 允许本会话 / `n` 拒绝；
 * 无 UI 环境（rpc/json/print）降级为拒绝 + 提示（DEVELOPMENT.md §4.3）。
 */
export function createConfirmer(): Confirmer {
  return {
    async confirm(ctx, options) {
      if (!ctx.hasUI) {
        ctx.ui.notify(`[pi-permission] ${options.title} (no UI available, defaulting to deny)`, "error");
        return "no";
      }
      const prefix = options.dangerLevel === "danger" ? "⚠ " : "";
      const lines = [options.title, ...(options.details ?? []).map((d) => `  • ${d}`)];
      const choice = await ctx.ui.select(`${prefix}${lines.join("\n")}`, [
        "y: allow once",
        "s: allow session",
        "n: deny",
      ]);
      if (choice === "y: allow once") return "yes";
      if (choice === "s: allow session") return "session";
      return "no";
    },
  };
}