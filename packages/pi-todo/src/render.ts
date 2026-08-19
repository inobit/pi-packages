/**
 * @inobit/pi-todo — renderCall/renderResult 渲染 + 行格式工具（glyph、截断）。
 *
 * 渲染遵循瘦身约束：折叠行与结果行保持紧凑，不整表打印（整表走 /todos）。
 * list 的结果行只给数量概要；get 的结果行直接用 content 单条全量文本（含 description）。
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import type { TaskStatus } from "./state.ts";
import type { TodoDetails } from "./store.ts";

/** 行格式：glyph */
export const GLYPHS: Record<Exclude<TaskStatus, "deleted">, string> = {
	pending: "○",
	in_progress: "◐",
	completed: "✓",
};

export function glyphFor(status: TaskStatus): string {
	return status === "deleted" ? " " : GLYPHS[status];
}

/** 行格式：标题截断（默认 80 字符，超限截断加省略号） */
export function truncateSubject(subject: string, max = 80): string {
	if (subject.length <= max) return subject;
	return subject.slice(0, Math.max(0, max - 1)) + "…";
}

/** 折叠行：todo <action> <subject/#id>。args 未完整（streaming 早期）时只显示占位 … */
export function renderTodoCall(
	args: { action?: string; subject?: string; id?: number } | undefined,
	theme: Theme,
): Text {
	const action = typeof args?.action === "string" && args.action !== "" ? args.action : "…";
	let text = theme.fg("toolTitle", theme.bold("todo ")) + theme.fg("muted", action);
	if (action === "create" && args?.subject) {
		text += ` ${theme.fg("dim", `"${args.subject}"`)}`;
	} else if (args?.id !== undefined) {
		text += ` ${theme.fg("accent", `#${args.id}`)}`;
	}
	return new Text(text, 0, 0);
}

/** 取快照中指定 id 的任务行（变化任务展示用） */
/** 取快照中指定 id 的任务行（变化任务展示用）；completed 整行灰 + 标题删除线 */
function taskLine(tasks: TodoDetails["tasks"], id: number, theme: Theme): string {
	const t = tasks.find((x) => x.id === id);
	if (!t) return theme.fg("muted", `#${id}`);
	const isCompleted = t.status === "completed";
	const glyphFg = isCompleted ? "muted" : "dim";
	const glyph = theme.fg(glyphFg, glyphFor(t.status));
	const idPart = theme.fg(isCompleted ? "muted" : "accent", `#${t.id}`);
	const subject = truncateSubject(t.subject);
	const subjectPart = isCompleted ? theme.fg("muted", theme.strikethrough(subject)) : theme.fg("muted", subject);
	return `${glyph} ${idPart} ${subjectPart}`;
}

/** 结果行：按 action 给简要反馈（detail 缺失时回退 content 文本） */
export function renderTodoResult(
	result: { content: { type: string; text?: string }[]; details: unknown },
	args: { action?: string; id?: number; status?: string; activeForm?: string },
	theme: Theme,
): Text {
	const details = result.details as TodoDetails | undefined;
	const contentText = result.content[0]?.text ?? "";

	if (details?.error) {
		return new Text(theme.fg("error", `Error: ${details.error}`), 0, 0);
	}
	if (!details || !Array.isArray(details.tasks)) {
		// 无快照（理论不出现）：回退 content 文本
		return new Text(theme.fg("muted", contentText), 0, 0);
	}

	switch (details.action) {
		case "create": {
			// 快照末尾即新建任务
			const created = details.tasks.length > 0 ? details.tasks[details.tasks.length - 1] : undefined;
			const line = created
				? `${theme.fg("accent", `#${created.id}`)} ${theme.fg("muted", truncateSubject(created.subject))}`
				: "";
			return new Text(theme.fg("success", "✓ Added ") + line, 0, 0);
		}
		case "update": {
			const id = args.id ?? details.nextId - 1;
			let line = taskLine(details.tasks, id, theme);
			if (args.status) line += ` ${theme.fg("warning", "→")} ${theme.fg("muted", args.status)}`;
			if (args.activeForm) line += ` ${theme.fg("dim", `(${args.activeForm})`)}`;
			return new Text(theme.fg("success", "✓ Updated ") + line, 0, 0);
		}
		case "delete": {
			const id = args.id ?? details.nextId - 1;
			return new Text(theme.fg("success", "✓ Deleted ") + taskLine(details.tasks, id, theme), 0, 0);
		}
		case "clear":
			return new Text(theme.fg("success", "✓ ") + theme.fg("muted", contentText || "Cleared all tasks"), 0, 0);
		case "get":
			// content 已含单条全量（含 description），直接展示
			return new Text(theme.fg("success", "✓ ") + theme.fg("muted", contentText), 0, 0);
		case "list":
			return new Text(theme.fg("success", "✓ ") + theme.fg("muted", contentText), 0, 0);
		default:
			return new Text(theme.fg("muted", contentText), 0, 0);
	}
}