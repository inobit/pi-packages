import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/** 用户确认结果。 */
export type ConfirmChoice =
  | "yes"
  | "session"
  | "no"
  | "terminate"
  | { kind: "reason"; customReason: string };

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
      const baseTitle = `${prefix}${lines.join("\n")}`;
      // 顶层 select 循环：r 进入 input，input Esc 回到 select，select Esc 硬终止
      while (true) {
        const choice = await ctx.ui.select(baseTitle, [
          "y: allow once",
          "s: allow session",
          "n: deny",
          "r: deny with reason",
        ]);
        if (choice === "y: allow once") return "yes";
        if (choice === "s: allow session") return "session";
        if (choice === "n: deny") return "no";
        if (choice === "r: deny with reason") {
          // 第二层 input 循环：空不提交，Esc 回到 select
          while (true) {
            const input = await ctx.ui.input(
              "Deny reason — emacs keys, Enter submit, Esc to go back",
              "e.g. use .env.example instead",
            );
            if (input === undefined) {
              // Esc → 回到上一层 select
              break;
            }
            const trimmed = input.trim();
            if (trimmed === "") {
              ctx.ui.notify("[pi-permission] reason cannot be empty", "warning");
              continue;
            }
            return { kind: "reason", customReason: trimmed };
          }
          // input Esc 后回到 select 循环
          continue;
        }
        if (choice === undefined) {
          // 第一层 Esc → 硬终止（deny + terminate:true）
          return "terminate";
        }
        // 兜底：未知返回按 deny 处理
        return "no";
      }
    },
  };
}