/**
 * @inobit/pi-todo — 编辑器上方面板（widget）的行构建。
 *
 * 纯函数（不依赖 pi 运行时），产物为带样式的行段，由 index.ts 组装成 widget 组件。
 * 行为：
 * - 展开态：标题（▾）+ 任务行；硬上限 maxLines 行（含标题，默认 7）——未完成必留，
 *   已完成按完成顺序取最近、超了先丢最旧已完成，再截断未完成，末尾 +N more。
 * - 折叠态：单行 `▸ Todos (done/total) ✓ n ◐ n ○ n — hint`。
 * - 完成项可见性：仅 completedOrder（跨轮完成序，旧→新）中、且不在 suppressed（已清理）中的
 *   completed 才参与显示；pending/in_progress 恒渲染。
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
	/** 跨轮完成顺序（旧→新）；仅其中的 completed 才有资格渲染 */
	completedOrder?: readonly number[];
	/** 已被清理（隐藏）的 completed id（只影响渲染，不删状态） */
	suppressed?: ReadonlySet<number>;
	/** 行数上限（含标题），默认 7 */
	maxLines?: number;
}

/** 硬上限默认 7 行（含标题 → 最多 6 行任务） */
export const DEFAULT_MAX_LINES = 7;
/** 清理软目标默认 5 行（含标题）；best-effort，未完成必留 */
export const DEFAULT_TARGET_LINES = 5;
export const HINT_TEXT = "alt+t to expand";
/** 折叠单行列预算（含 ▸/标题/计数/hint） */
export const COLLAPSED_MAX_COLS = 80;

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

export interface VisibilityPlan {
	/** 必留的未完成任务（任务序） */
	unfinished: Task[];
	/** 本次显示的已完成任务（任务序，其数量已按硬预算取最近） */
	completedShown: Task[];
	/** 被预算/清理挡掉的已完成任务 */
	hiddenCompleted: Task[];
	/** 展开态渲染行数估计（含标题，含可能的 +N more 行；空态为 0） */
	renderedLines: number;
}

/**
 * 纯预算分配：未完成全留；已完成在硬预算剩余槽位内取最近（按 completedOrder 新→旧）。
 * index.ts 的清理（trim To target）复用它做行数估计，保证计数口径一致。
 */
export function planVisibility(
	state: TaskState,
	options: Pick<OverlayRenderOptions, "completedOrder" | "suppressed" | "maxLines">,
): VisibilityPlan {
	const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
	const order = options.completedOrder;
	const suppressed = options.suppressed;
	const orderIdx = new Map<number, number>();
	if (order) order.forEach((id, i) => orderIdx.set(id, i));

	const unfinished = state.tasks.filter((t) => t.status === "pending" || t.status === "in_progress");
	const eligible = state.tasks.filter(
		(t) => t.status === "completed" && orderIdx.has(t.id) && !(suppressed?.has(t.id) ?? false),
	);
	const available = Math.max(1, maxLines - 1); // 标题占 1 行
	let completedShown: Task[] = [];
	let hiddenCompleted: Task[] = [...eligible];
	if (unfinished.length < available) {
		const remaining = available - unfinished.length;
		// 取最近（orderIdx 大者新），显示时恢复任务序
		const newestFirst = [...eligible].sort((a, b) => (orderIdx.get(b.id) ?? 0) - (orderIdx.get(a.id) ?? 0));
		const shown = new Set(newestFirst.slice(0, remaining).map((t) => t.id));
		completedShown = eligible.filter((t) => shown.has(t.id));
		hiddenCompleted = eligible.filter((t) => !shown.has(t.id));
	}
	const totalVisible = unfinished.length + completedShown.length;
	return {
		unfinished,
		completedShown,
		hiddenCompleted,
		renderedLines: totalVisible === 0 ? 0 : 1 + Math.min(totalVisible, available),
	};
}

/** 折叠单行：`▸ Todos (done/total) ✓c ◐i ○p — hint`，超列预算时优先压缩 hint 段 */
function collapsedLine(counts: { pending: number; in_progress: number; completed: number }, total: number): OverlayLine {
	const head = `▸ Todos (${counts.completed}/${total}) `;
	const mid: OverlayLine = [
		segment(`✓ ${counts.completed}`, "muted"),
		segment(` ◐ ${counts.in_progress}`, "accent"),
		segment(` ○ ${counts.pending}`, "dim"),
	];
	const midText = mid.map((s) => s.text).join("");
	const tailBudget = Math.max(0, COLLAPSED_MAX_COLS - displayWidth(head) - displayWidth(midText));
	const tail = tailBudget > 0 ? truncateSubject(` — ${HINT_TEXT}`, tailBudget) : "";
	return [segment(head, "toolTitle", true), ...mid, ...(tail ? [segment(tail, "dim")] : [])];
}

/**
 * 构建面板行。返回空数组表示应卸载 widget（列表为空）。
 */
export function buildOverlayLines(state: TaskState, options: OverlayRenderOptions): OverlayLine[] {
	const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
	const counts = countByStatus(state);
	const total = counts.pending + counts.in_progress + counts.completed;

	if (options.collapsed) {
		if (total === 0) return [];
		return [collapsedLine(counts, total)];
	}

	const plan = planVisibility(state, options);
	if (plan.unfinished.length + plan.completedShown.length === 0) return [];
	const title: OverlayLine = [segment(`▾ Todos (${counts.completed}/${total})`, "toolTitle", true)];

	const visible = [...plan.unfinished, ...plan.completedShown].sort((a, b) => a.id - b.id);
	let rows = visible.map(taskRow);
	const available = Math.max(1, maxLines - 1);
	if (rows.length > available) {
		// 仅剩未完成溢出时截断（已完成已在 plan 阶段让位），末尾提示 +N more
		const hidden = rows.length - (available - 1);
		rows = [...rows.slice(0, available - 1), [segment(`+${hidden} more`, "dim")]];
	}

	return [title, ...rows];
}
