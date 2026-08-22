/**
 * @inobit/pi-todo — 工厂装配：注册工具/命令、事件接线、widget 生命周期。
 *
 * 面板渲染目标（评审点 4 简化方案）：session_start → 当前会话；
 * 之后一旦有 todo 工具调用即切到最后成功调用的会话，直到下一次 session_start 重置。
 * 完成项：tool_execution_end 后保留到本轮结束，agent_start（下一轮开始）时移除。
 */

import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { isTodoDetails, replayFromBranch, TodoStore, type BranchEntryLike } from "./store.ts";
import { buildOverlayLines, type OverlayLine } from "./overlay.ts";
import { registerTodoTool, registerTodosCommand, type TodoDeps } from "./todo.ts";

export const WIDGET_ID = "pi-todo";
export const COLLAPSE_SHORTCUT = "ctrl+shift+t";

function sessionIdOf(ctx: { sessionManager: { getSessionId(): string } }): string {
	return ctx.sessionManager.getSessionId() ?? "";
}

function replayFor(store: TodoStore, ctx: ExtensionContext): boolean {
	const sid = sessionIdOf(ctx);
	const branch = ctx.sessionManager.getBranch() as readonly BranchEntryLike[];
	const replayed = replayFromBranch(branch);
	if (replayed) {
		store.set(sid, replayed);
		return true;
	}
	store.delete(sid);
	return false;
}

/** 行段 → 主题化文本（fg 名见 ThemeColor，此处为控制值安全强转） */
function styledText(lines: OverlayLine[], theme: Theme): string {
	return lines
		.map((line) =>
			line
				.map((seg) => {
					let text = seg.text;
					if (seg.bold) text = theme.bold(text);
					if (seg.strikethrough) text = theme.strikethrough(text);
					return seg.fg ? theme.fg(seg.fg as Parameters<typeof theme.fg>[0], text) : text;
				})
				.join(""),
		)
		.join("\n");
}

export default function (pi: ExtensionAPI): void {
	const store = new TodoStore();
	const deps: TodoDeps = { store };
	registerTodoTool(pi, deps);
	registerTodosCommand(pi, deps);

	// 面板视图状态
	let renderSid: string | undefined;
	let collapsed = false;
	/** 本轮内被 update→completed 的任务 id（agent_start 清空） */
	let revealedCompleted = new Set<number>();
	/** tool_execution_start 记录的 todo 参数（id/status），供 tool_execution_end 配对 */
	const todoStartArgs = new Map<string, { id?: number; status?: string }>();
	let currentLines: OverlayLine[] = [];

	const renderWidget = (ctx: ExtensionContext): void => {
		if (!ctx.hasUI) return;
		const state = renderSid !== undefined ? store.get(renderSid) : undefined;
		currentLines = state ? buildOverlayLines(state, { collapsed, revealedCompleted }) : [];
		if (currentLines.length === 0) {
			ctx.ui.setWidget(WIDGET_ID, undefined);
			return;
		}
		ctx.ui.setWidget(WIDGET_ID, (_tui, theme) => new Text(styledText(currentLines, theme), 0, 0));
	};

	// —— 会话生命周期：重放分支重建内存态并刷新面板 ——
	pi.on("session_start", async (_event, ctx) => {
		replayFor(store, ctx);
		renderSid = sessionIdOf(ctx);
		revealedCompleted = new Set();
		renderWidget(ctx);
	});

	pi.on("session_compact", async (_event, ctx) => {
		replayFor(store, ctx);
		renderWidget(ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		replayFor(store, ctx);
		renderSid = sessionIdOf(ctx);
		revealedCompleted = new Set();
		renderWidget(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		store.delete(sessionIdOf(ctx));
	});

	// —— 工具执行：记录 todo 参数，成功后仅揭示本轮真正置完成的任务 ——
	pi.on("tool_execution_start", async (event, _ctx) => {
		if (event.toolName !== "todo") return;
		const args = (event.args ?? {}) as { id?: unknown; status?: unknown };
		todoStartArgs.set(event.toolCallId, {
			id: typeof args.id === "number" ? args.id : undefined,
			status: typeof args.status === "string" ? args.status : undefined,
		});
	});

	pi.on("tool_execution_end", async (event, ctx) => {
		if (event.toolName !== "todo") return;
		// 先清理配对记录再走后续分支（isError / details 非法时也不泄漏条目）
		const args = todoStartArgs.get(event.toolCallId);
		todoStartArgs.delete(event.toolCallId);
		if (event.isError) return;
		const details = (event.result as { details?: unknown } | undefined)?.details;
		if (!isTodoDetails(details)) return;
		// 仅当本次调用把某任务 update 到 completed 时才揭示该 id（避免无关调用点亮已完成行）
		if (args?.status === "completed" && args.id !== undefined) {
			revealedCompleted = new Set(revealedCompleted).add(args.id);
		}
		renderSid = sessionIdOf(ctx);
		renderWidget(ctx);
	});

	// —— 下一轮开始：隐藏上一轮完成项 ——
	pi.on("agent_start", async (_event, ctx) => {
		revealedCompleted = new Set();
		renderWidget(ctx);
	});

	// —— 折叠快捷键 ——
	pi.registerShortcut(COLLAPSE_SHORTCUT, {
		description: "Toggle the todos panel",
		handler: (ctx) => {
			collapsed = !collapsed;
			renderWidget(ctx);
		},
	});
}