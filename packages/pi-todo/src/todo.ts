/**
 * @inobit/pi-todo — todo 工具与 /todos 命令注册。文案常量集中于此（评审/调参入口）。
 *
 * 侵入性预算（每轮提示词总开销 ≤ ~1.1KB）本文件：
 *   - promptSnippet ≤ 60 chars
 *   - promptGuidelines ≤ 3 条、每条 ≤ 140 chars、必须点名 todo 工具
 *   - description ≤ 600 chars（实际 ~440）
 *   - schema 各参数 description 合计 ≤ 270 chars（见 schema.ts）
 */

import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import type { Task, TaskState, TodoRequest } from "./state.ts";
import {
	applyTodoAction,
	countByStatus,
	createEmptyState,
	getTask,
	listTasks,
	toSnapshot,
} from "./state.ts";
import { TodoParams, type TodoParamsType } from "./schema.ts";
import { replayFromBranch, TodoStore, type BranchEntryLike } from "./store.ts";
import { renderTodoCall, renderTodoResult } from "./render.ts";

export { TodoParams };

export const TODO_PROMPT_SNIPPET = "Manage a task list to track multi-step progress";

export const TODO_PROMPT_GUIDELINES = [
	"Use todo when work has 3+ distinct steps, the user gives a task list, or new instructions arrive; skip single trivial steps.",
	"Mark a todo in_progress before starting it (one at a time); mark completed only when actually done — never on intent or while tests fail.",
	"Todo status moves pending → in_progress → completed; pass a present-continuous activeForm like \"writing tests\" when starting a task.",
] as const;

export const TODO_DESCRIPTION = `Track session tasks in a panel and via /todos.

Use when: 3+ steps, a task list, or new instructions. Skip trivial
steps or chat.

States: pending → in_progress → completed; one in_progress at a time.
Mark completed only when fully done (incl. verification). When
blocked/partial, keep in_progress + add a follow-up.

Actions: create / update (status, subject, description, activeForm) /
list (filter by status) / get (single) / delete / clear.`;

export interface TodoDeps {
	store: TodoStore;
}

/** 错误路径：details 只带 error（不写快照），内存态不变 */
function errorResult(action: string, error: string) {
	return {
		content: [{ type: "text" as const, text: `Error: ${error}` }],
		details: { action, error },
	};
}

/** 变更请求的反馈文本（模型可见，紧凑） */
function changeText(action: TodoRequest["action"], changed: Task | undefined, before: TaskState, params: TodoParamsType): string {
	switch (action) {
		case "create":
			return `Added #${changed!.id}: ${changed!.subject}`;
		case "update": {
			let text = `Updated #${changed!.id}: ${changed!.subject}`;
			if (params.status) text += ` → ${params.status}`;
			if (params.activeForm) text += ` (activeForm: ${params.activeForm})`;
			return text;
		}
		case "delete":
			return `Deleted #${changed!.id}: ${changed!.subject}`;
		case "clear": {
			const count = before.tasks.filter((t) => t.status !== "deleted").length;
			return `Cleared ${count} task(s)`;
		}
	}
}

function successDetails(action: string, state: TaskState) {
	return { action, tasks: toSnapshot(state), nextId: state.nextId };
}

/**
 * 工具 execute 的同步读-算-写核心。
 * 注意：读取 store → applyTodoAction → store.set 之间不得插入 await，
 * 否则并行工具调用下会发生读旧态覆盖（丢失更新）。
 */
function runAction(params: TodoParamsType, state: TaskState): { result: TaskState; error?: string } {
	let result = state;
	let error: string | undefined;
	switch (params.action) {
		case "create": {
			const applied = applyTodoAction(result, { action: "create", subject: params.subject ?? "", description: params.description });
			result = applied.state;
			error = applied.error;
			break;
		}
		case "update": {
			if (params.id === undefined) return { result, error: "id is required for update" };
			const applied = applyTodoAction(result, {
				action: "update",
				id: params.id,
				subject: params.subject,
				description: params.description,
				status: params.status,
				activeForm: params.activeForm,
			});
			result = applied.state;
			error = applied.error;
			break;
		}
		case "delete": {
			if (params.id === undefined) return { result, error: "id is required for delete" };
			const applied = applyTodoAction(result, { action: "delete", id: params.id });
			result = applied.state;
			error = applied.error;
			break;
		}
		case "clear": {
			const applied = applyTodoAction(result, { action: "clear" });
			result = applied.state;
			error = applied.error;
			break;
		}
		default:
			break;
	}
	return { result, error };
}

export function registerTodoTool(pi: ExtensionAPI, deps: TodoDeps): void {
	const { store } = deps;
	pi.registerTool({
		name: "todo",
		label: "Todo",
		description: TODO_DESCRIPTION,
		promptSnippet: TODO_PROMPT_SNIPPET,
		promptGuidelines: [...TODO_PROMPT_GUIDELINES],
		parameters: TodoParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const sid = ctx.sessionManager.getSessionId() ?? "";
			const state = store.get(sid) ?? createEmptyState();

			// —— 只读动作（不改状态，误差时 details 带 error）——
			if (params.action === "list") {
				const matched = listTasks(state, params.status);
				const counts = countByStatus(state);
				const text = params.status
					? `${matched.length} task(s) with status ${params.status}`
					: `${listTasks(state).length} task(s): ${counts.pending} pending, ${counts.in_progress} in_progress, ${counts.completed} completed`;
				return {
					content: [{ type: "text", text }],
					details: successDetails("list", state),
				};
			}
			if (params.action === "get") {
				if (params.id === undefined) return errorResult("get", "id is required for get");
				const task = getTask(state, params.id);
				if (!task) return errorResult("get", `Task #${params.id} not found`);
				let text = `#${task.id} [${task.status}] ${task.subject}`;
				if (task.description) text += `\n${task.description}`;
				return {
					content: [{ type: "text", text }],
					details: successDetails("get", state),
				};
			}

			// —— 变更动作：同步读-算-写（无 await，保并行原子性）——
			const { result, error } = runAction(params, state);
			if (error) return errorResult(params.action, error);
			if (result !== state) store.set(sid, result);
			const changed = params.action === "clear" ? undefined : result.tasks.find((t) => t.id === (params.id ?? result.nextId - 1));
			return {
				content: [
					{
						type: "text",
						text: changeText(params.action, changed, state, params),
					},
				],
				details: successDetails(params.action, result),
			};
		},

		renderCall(args, theme) {
			return renderTodoCall(args as { action: string; subject?: string; id?: number }, theme);
		},

		renderResult(result, _options, theme, context) {
			const args = context.args as { action?: string; id?: number; status?: string; activeForm?: string } | undefined;
			return renderTodoResult(
				result as never,
				args ?? {},
				theme,
			);
		},
	});
}

/** /todos 全屏列表组件（按状态分组，Escape/ctrl+c 关闭） */
class TodosListComponent {
	private readonly tasks: Task[];
	private readonly theme: Theme;
	private readonly onClose: () => void;

	constructor(tasks: Task[], theme: Theme, onClose: () => void) {
		this.tasks = tasks;
		this.theme = theme;
		this.onClose = onClose;
	}

	invalidate(): void {
		// 静态列表，无需缓存失效
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.onClose();
		}
	}

	render(width: number): string[] {
		const th = this.theme;
		const lines: string[] = [];

		lines.push("");
		const title = th.fg("accent", " Todos ");
		lines.push(
			truncateToWidth(
				th.fg("borderMuted", "─".repeat(3)) + title + th.fg("borderMuted", "─".repeat(Math.max(0, width - 10))),
				width,
			),
		);
		lines.push("");

		if (this.tasks.length === 0) {
			lines.push(truncateToWidth(`  ${th.fg("dim", "No tasks yet. Ask the agent to use the todo tool.")}`, width));
			lines.push("");
			lines.push(truncateToWidth(`  ${th.fg("dim", "Press Escape to close")}`, width));
			lines.push("");
			return lines;
		}

		const groups: { title: string; tasks: Task[] }[] = [
			{ title: "Pending", tasks: this.tasks.filter((t) => t.status === "pending") },
			{ title: "In Progress", tasks: this.tasks.filter((t) => t.status === "in_progress") },
			{ title: "Completed", tasks: this.tasks.filter((t) => t.status === "completed") },
		];

		for (const group of groups) {
			if (group.tasks.length === 0) continue;
			lines.push(`  ${th.fg("accent", th.bold(group.title))} (${group.tasks.length})`);
			for (const t of group.tasks) {
				const isCompleted = t.status === "completed";
				const glyph = isCompleted
					? th.fg("muted", "✓")
					: th.fg(t.status === "in_progress" ? "accent" : "dim", t.status === "in_progress" ? "◐" : "○");
				let line = `  ${glyph} ${isCompleted ? th.fg("muted", th.strikethrough(t.subject)) : th.fg("text", t.subject)}`;
				if (t.status === "in_progress" && t.activeForm) {
					line += th.fg("muted", ` — ${t.activeForm}`);
				}
				lines.push(truncateToWidth(line, width));
			}
			lines.push("");
		}

		lines.push(truncateToWidth(`  ${th.fg("dim", "Press Escape to close")}`, width));
		lines.push("");
		return lines;
	}
}

export function registerTodosCommand(pi: ExtensionAPI, deps: TodoDeps): void {
	const { store } = deps;
	pi.registerCommand("todos", {
		description: "Show all todos on the current session",
		handler: async (_args, ctx) => {
			const sid = ctx.sessionManager.getSessionId() ?? "";
			const state = store.get(sid) ?? replayFromBranch(ctx.sessionManager.getBranch() as readonly BranchEntryLike[]) ?? undefined;
			const tasks = state ? listTasks(state) : [];

			if (ctx.mode === "tui") {
				await ctx.ui.custom<void>((_tui, theme, _kb, done) => {
					return new TodosListComponent(tasks, theme, () => done());
				});
				return;
			}
			if (!ctx.hasUI) {
				ctx.ui.notify("/todos requires interactive mode", "error");
				return;
			}
			const counts = state ? countByStatus(state) : { pending: 0, in_progress: 0, completed: 0 };
			ctx.ui.notify(
				`${tasks.length} task(s): ${counts.pending} pending, ${counts.in_progress} in_progress, ${counts.completed} completed`,
				"info",
			);
		},
	});
}