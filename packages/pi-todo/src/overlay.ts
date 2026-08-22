/**
 * @inobit/pi-todo — 编辑器上方面板（widget）的行构建。
 *
 * 纯函数（不依赖 pi 运行时），产物为带样式的行段，由 index.ts 组装成 widget 组件。
 * 行为：折叠态只留标题+提示；溢出上限 12 行（含标题）——先丢 completed 行，再截断，末尾 +N more。
 * 完成项隐藏：showCompleted=false 时不渲染 completed 行（本轮结束后由 agent_start 触发）。
 */

import type { Task, TaskState } from "./state.ts";
import { countByStatus } from "./state.ts";
import { displayWidth, glyphFor, truncateSubject } from "./render.ts";

/** 行段：一段带样式的文本（fg 为主题色名，bold 加粗，strikethrough 删除线） */
export interface OverlaySegment {
	text: string;
	fg?: string;
	bold?: boolean;
	strikethrough?: boolean;
}

export type OverlayLine = OverlaySegment[];

export interface OverlayRenderOptions {
	collapsed: boolean;
	/** 本轮内被 update→completed 的任务 id（完成项隐藏机制：仅这些本轮可见，下轮隐藏） */
	revealedCompleted?: ReadonlySet<number>;
	/** 行数上限（含标题），默认 12 */
	maxLines?: number;
}

export const DEFAULT_MAX_LINES = 12;
export const HINT_TEXT = "ctrl+shift+t to expand";

function segment(text: string, fg?: string, bold?: boolean, strikethrough?: boolean): OverlaySegment {
	const seg: OverlaySegment = { text };
	if (fg !== undefined) seg.fg = fg;
	if (bold) seg.bold = true;
	if (strikethrough) seg.strikethrough = true;
	return seg;
}

/** 内容区列预算（不含 glyph 段的 3 列）；超长时优先压缩标题，activeForm 独立上限 */
export const ROW_CONTENT_COLS = 80;
const GLYPH_SEGMENT_COLS = 3;
const ACTIVE_FORM_MAX_COLS = 40;

/** 单任务行：glyph + 标题（不显示数字序号；in_progress 行附 activeForm 标签）；completed 整行灰 + 标题删除线。
 * 按显示宽度预算整行（CJK 宽字符按 2 列计），避免窄终端折行撑高面板。 */
export function taskRow(task: Task): OverlayLine {
	const isCompleted = task.status === "completed";
	const glyphFg = isCompleted ? "muted" : task.status === "pending" ? "dim" : "accent";
	const subjectFg = isCompleted ? "muted" : "text";
	const suffix =
		task.status === "in_progress" && task.activeForm
			? ` — ${truncateSubject(task.activeForm, ACTIVE_FORM_MAX_COLS)}`
			: "";
	const subjectBudget = Math.max(1, ROW_CONTENT_COLS - GLYPH_SEGMENT_COLS - displayWidth(suffix));
	const row: OverlayLine = [
		segment(` ${glyphFor(task.status)} `, glyphFg),
		segment(truncateSubject(task.subject, subjectBudget), subjectFg, false, isCompleted),
	];
	if (suffix) {
		row.push(segment(suffix, "muted"));
	}
	return row;
}

/**
 * 构建面板行。返回空数组表示应卸载 widget（列表为空）。
 */
export function buildOverlayLines(state: TaskState, options: OverlayRenderOptions): OverlayLine[] {
	const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
	// completed 仅当本轮的揭示集合含其 id 时才渲染；pending/in_progress 恒渲染
	const visible = state.tasks.filter(
		(t) => t.status !== "deleted" && (t.status !== "completed" || (options.revealedCompleted?.has(t.id) ?? false)),
	);
	if (visible.length === 0) return [];

	const counts = countByStatus(state);
	const total = counts.pending + counts.in_progress + counts.completed;
	const title: OverlayLine = [segment(`Todos (${counts.completed}/${total})`, "toolTitle", true)];

	if (options.collapsed) {
		return [title, [segment(`${visible.length} task(s) — ${HINT_TEXT}`, "dim")]];
	}

	let rows = visible.map(taskRow);
	const available = maxLines - 1; // 标题占 1 行
	if (rows.length > available) {
		// 1) 优先丢弃 completed 行（从列表末尾开始）
		const completedIdx: number[] = [];
		visible.forEach((t, i) => {
			if (t.status === "completed") completedIdx.push(i);
		});
		let toDrop = Math.min(rows.length - available, completedIdx.length);
		const dropSet = new Set(completedIdx.slice(-toDrop));
		if (toDrop > 0) {
			rows = rows.filter((_, i) => !dropSet.has(i));
		}
		// 2) 仍超限：截断剩余行，末尾提示 +N more
		if (rows.length > available) {
			const hidden = rows.length - (available - 1);
			rows = [...rows.slice(0, available - 1), [segment(`+${hidden} more`, "dim")]];
		}
	}

	return [title, ...rows];
}