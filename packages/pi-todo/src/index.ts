/**
 * @inobit/pi-todo — 工厂装配：注册工具/命令、事件接线、widget 生命周期。
 *
 * 面板渲染目标：session_start → 当前会话；之后一旦有 todo 工具调用即切到
 * 最后成功调用的会话，直到下一次 session_start 重置。
 *
 * 完成项可见性（隐藏≠删除，状态层不动）：
 * - 跨轮完成序 completedOrder（旧→新）+ 轮次 completionRound + 清理集合 suppressed；
 * - tool_execution_end 成功且 update→completed 后立即渲染（3s 确认窗口），并重设 3s 单 timer；
 * - timer 到达 / agent_start（下一轮开始）时按软目标 targetLines 修剪：先藏上一轮及更早
 *   的已完成，再藏本轮最旧，直到总行数 <= target 或已完成藏完；未完成必留；
 * - 总量在目标内时跨轮保留（agent_start 不再 blanket 清空）。
 * - 视图状态按渲染会话隔离：renderSid 切换时重置完成序/轮次/清理集合（id 按会话独立编号）。
 */

import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { isTodoDetails, replayFromBranch, TodoStore, type BranchEntryLike } from "./store.ts";
import { buildOverlayLines, planVisibility, type OverlayLine } from "./overlay.ts";
import { loadConfig } from "./config.ts";
import { registerTodoTool, registerTodosCommand, type TodoDeps } from "./todo.ts";

export const WIDGET_ID = "pi-todo";
/** 主快捷键；旧 `ctrl+shift+t` 保留为别名（部分终端截留 ctrl+shift 组合） */
export const COLLAPSE_SHORTCUT = "alt+t";
export const COLLAPSE_SHORTCUT_ALIAS = "ctrl+shift+t";
/** 完成确认窗口：刚完成的项至少可见这么久再参与清理（测试可调） */
export const CLEANUP = { delayMs: 3000 };

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
	const cfg0 = loadConfig(process.cwd());
	let cfg = cfg0;

	/** 事件驱动刷新配置：全局常读；项目级仅 trusted 时叠加（ctx.isProjectTrusted） */
	function refreshConfig(ctx: ExtensionContext): void {
		const cwd = typeof ctx.cwd === "string" && ctx.cwd !== "" ? ctx.cwd : process.cwd();
		const trusted = typeof ctx.isProjectTrusted === "function" ? ctx.isProjectTrusted() : false;
		cfg = loadConfig(cwd, { trusted });
	}

	/** 切换渲染目标会话：视图状态按会话隔离重置（id 按会话独立编号，不可跨会话复用） */
	function switchRenderSid(sid: string): void {
		if (renderSid === sid) return;
		renderSid = sid;
		completedOrder = [];
		completionRound = new Map();
		suppressed = new Set();
	}

	// 面板视图状态（渲染层 only：清理只改这里，不动 store/快照）
	let renderSid: string | undefined;
	let collapsed = false;
	/** 跨轮完成序（旧→新）；重放后对账，未知来源的已完成按任务序追加为最旧 */
	let completedOrder: number[] = [];
	/** 完成时的轮次（重放恢复的记 0，即最旧） */
	let completionRound = new Map<number, number>();
	/** 已清理（隐藏）的 completed id */
	let suppressed = new Set<number>();
	let currentRound = 0;
	/** 3s 清理单 timer + 代数（防竞态） */
	let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
	let cleanupGen = 0;
	/** tool_execution_start 记录的 todo 参数（id/status），供 tool_execution_end 配对 */
	const todoStartArgs = new Map<string, { id?: number; status?: string }>();
	let currentLines: OverlayLine[] = [];

	function clearCleanupTimer(): void {
		cleanupGen++;
		if (cleanupTimer !== undefined) {
			clearTimeout(cleanupTimer);
			cleanupTimer = undefined;
		}
	}

	/** 重放/状态变化后对账：掉队 id 剔除，未知已完成追加为最旧（轮次 0） */
	function reconcile(): void {
		const state = renderSid !== undefined ? store.get(renderSid) : undefined;
		const completed = new Set(
			(state?.tasks ?? []).filter((t) => t.status === "completed").map((t) => t.id),
		);
		completedOrder = completedOrder.filter((id) => completed.has(id));
		for (const t of state?.tasks ?? []) {
			if (t.status === "completed" && !completedOrder.includes(t.id)) {
				completedOrder.push(t.id);
				if (!completionRound.has(t.id)) completionRound.set(t.id, 0);
			}
		}
		completionRound = new Map([...completionRound].filter(([id]) => completed.has(id)));
		suppressed = new Set([...suppressed].filter((id) => completed.has(id)));
	}

	function visibleCompletedOldestFirst(): number[] {
		const state = renderSid !== undefined ? store.get(renderSid) : undefined;
		if (!state) return [];
		const plan = planVisibility(state, { completedOrder, suppressed, maxLines: cfg.maxLines });
		const orderIdx = new Map(completedOrder.map((id, i) => [id, i]));
		return plan.completedShown
			.map((t) => t.id)
			.sort(
				(a, b) =>
					(completionRound.get(a) ?? 0) - (completionRound.get(b) ?? 0) ||
					(orderIdx.get(a) ?? 0) - (orderIdx.get(b) ?? 0),
			);
	}

	function renderedLines(): number {
		const state = renderSid !== undefined ? store.get(renderSid) : undefined;
		if (!state) return 0;
		return planVisibility(state, { completedOrder, suppressed, maxLines: cfg.maxLines }).renderedLines;
	}

	/** 按软目标修剪：先藏上一轮及更早，再藏本轮最旧；未完成必留（plan 层保证） */
	function trimToTarget(): void {
		let shown = visibleCompletedOldestFirst();
		while (renderedLines() > cfg.targetLines && shown.length > 0) {
			const oldest = shown.shift()!;
			suppressed = new Set(suppressed).add(oldest);
			shown = visibleCompletedOldestFirst();
		}
	}

	const renderWidget = (ctx: ExtensionContext): void => {
		if (!ctx.hasUI) return;
		const state = renderSid !== undefined ? store.get(renderSid) : undefined;
		currentLines = state
			? buildOverlayLines(state, { collapsed, completedOrder, suppressed, maxLines: cfg.maxLines })
			: [];
		if (currentLines.length === 0) {
			ctx.ui.setWidget(WIDGET_ID, undefined);
			return;
		}
		ctx.ui.setWidget(WIDGET_ID, (_tui, theme) => new Text(styledText(currentLines, theme), 0, 0));
	};

	function scheduleCleanup(ctx: ExtensionContext): void {
		clearCleanupTimer();
		cleanupGen++;
		const gen = cleanupGen;
		const sid = renderSid;
		const captured = ctx;
		cleanupTimer = setTimeout(() => {
			cleanupTimer = undefined;
			if (gen !== cleanupGen) return;
			if (sid === undefined || renderSid !== sid) return;
			if (!store.get(sid)) return;
			trimToTarget();
			renderWidget(captured);
		}, CLEANUP.delayMs);
		// 不占用进程退出（测试 fake timer 无 unref 时跳过）
		(cleanupTimer as unknown as { unref?: () => void }).unref?.();
	}

	// —— 会话生命周期：重放分支重建内存态并刷新面板（重放不触发清理，只对账） ——
	pi.on("session_start", async (_event, ctx) => {
		clearCleanupTimer();
		refreshConfig(ctx);
		replayFor(store, ctx);
		switchRenderSid(sessionIdOf(ctx));
		reconcile();
		renderWidget(ctx);
	});

	pi.on("session_compact", async (_event, ctx) => {
		clearCleanupTimer();
		refreshConfig(ctx);
		replayFor(store, ctx);
		reconcile();
		renderWidget(ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		clearCleanupTimer();
		refreshConfig(ctx);
		replayFor(store, ctx);
		switchRenderSid(sessionIdOf(ctx));
		reconcile();
		renderWidget(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		clearCleanupTimer();
		const sid = sessionIdOf(ctx);
		store.delete(sid);
		if (renderSid === sid) {
			renderSid = undefined;
			completedOrder = [];
			completionRound = new Map();
			suppressed = new Set();
		}
	});

	// —— 工具执行：记录 todo 参数，成功置完成则入完成序、立即渲染、重设计时 ——
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
		refreshConfig(ctx);
		switchRenderSid(sessionIdOf(ctx));
		reconcile();
		// 仅当本次调用把某任务 update 到 completed 时才入完成序（无关调用不点亮/不清零）
		if (args?.status === "completed" && args.id !== undefined) {
			completedOrder = [...completedOrder.filter((id) => id !== args.id), args.id];
			completionRound = new Map(completionRound).set(args.id, currentRound);
			if (suppressed.has(args.id)) suppressed = new Set([...suppressed].filter((id) => id !== args.id));
			renderWidget(ctx);
			scheduleCleanup(ctx);
			return;
		}
		renderWidget(ctx);
	});

	// —— 下一轮开始：轮次+1，旧轮优先修剪到软目标（总量在目标内则跨轮保留） ——
	pi.on("agent_start", async (_event, ctx) => {
		clearCleanupTimer();
		refreshConfig(ctx);
		currentRound++;
		trimToTarget();
		renderWidget(ctx);
	});

	// —— 折叠快捷键（toggle；主 alt+t，别名 ctrl+shift+t） ——
	const toggleCollapsed = (ctx: ExtensionContext): void => {
		refreshConfig(ctx);
		collapsed = !collapsed;
		renderWidget(ctx);
	};
	pi.registerShortcut(COLLAPSE_SHORTCUT, {
		description: "Toggle the todos panel",
		handler: (ctx) => {
			toggleCollapsed(ctx as ExtensionContext);
		},
	});
	pi.registerShortcut(COLLAPSE_SHORTCUT_ALIAS, {
		description: "Toggle the todos panel (alias)",
		handler: (ctx) => {
			toggleCollapsed(ctx as ExtensionContext);
		},
	});
}
