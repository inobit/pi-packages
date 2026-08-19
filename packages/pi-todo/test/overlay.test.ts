import { describe, expect, it } from "vitest";
import { buildOverlayLines, taskRow, type OverlayLine } from "../src/overlay.ts";
import { createEmptyState, type Task, type TaskState } from "../src/state.ts";

function state(tasks: Task[]): TaskState {
	return { tasks, nextId: tasks.length + 1 };
}

const pending = (id: number, subject: string): Task => ({ id, subject, status: "pending" });
const inProgress = (id: number, subject: string, activeForm?: string): Task =>
	activeForm ? { id, subject, status: "in_progress", activeForm } : { id, subject, status: "in_progress" };
const completed = (id: number, subject: string): Task => ({ id, subject, status: "completed" });
const deleted = (id: number, subject: string): Task => ({ id, subject, status: "deleted" });

function plain(lines: OverlayLine[]): string[] {
	return lines.map((l) => l.map((s) => s.text).join(""));
}

describe("buildOverlayLines", () => {
	it("空列表 → 返回空数组（卸载 widget 的信号）", () => {
		expect(buildOverlayLines(createEmptyState(), { collapsed: false })).toEqual([]);
		expect(buildOverlayLines(createEmptyState(), { collapsed: true })).toEqual([]);
	});

	it("标题：Todos (done/total)，tombstone 不计入 total", () => {
		const s = state([pending(1, "a"), completed(2, "b"), deleted(3, "z")]);
		const lines = plain(buildOverlayLines(s, { collapsed: false, revealedCompleted: new Set([2]) }));
		expect(lines[0]).toBe("Todos (1/2)");
	});

	it("行格式：glyph + 标题（无数字序号）；in_progress 附 activeForm 标签；completed 需揭示才显示", () => {
		const s = state([pending(1, "setup"), inProgress(2, "write tests", "writing tests"), completed(3, "done")]);
		const lines = plain(buildOverlayLines(s, { collapsed: false, revealedCompleted: new Set([3]) }));
		expect(lines[1]).toContain("○ setup");
		expect(lines[1]).not.toContain("#1");
		expect(lines[2]).toContain("◐ write tests — writing tests");
		expect(lines[3]).toContain("✓ done");
	});

	it("completed 行样式：整行灰色 + 标题删除线（pending/in_progress 不受影响）", () => {
		const s = state([completed(3, "done"), pending(1, "setup")]);
		const rows = buildOverlayLines(s, { collapsed: false, revealedCompleted: new Set([3]) }).slice(1);
		const [completedRow, pendingRow] = rows;
		// completed：glyph 灰、标题灰 + 删除线，无序号
		expect(completedRow).toEqual([
			{ text: " ✓ ", fg: "muted" },
			{ text: "done", fg: "muted", strikethrough: true },
		]);
		// pending：不受影响（无删除线，glyph dim）
		expect(pendingRow?.some((seg) => seg.strikethrough)).toBe(false);
		expect(pendingRow).toEqual([
			{ text: " ○ ", fg: "dim" },
			{ text: "setup", fg: "text" },
		]);
	});

	it("完成项隐藏：未在 revealedCompleted 中的 completed 不渲染（下轮隐藏），但标题仍统计", () => {
		const s = state([pending(1, "a"), completed(2, "b"), completed(3, "c")]);
		// 只揭示本轮刚完成的 3，2 保持隐藏
		const lines = plain(buildOverlayLines(s, { collapsed: false, revealedCompleted: new Set([3]) }));
		expect(lines).toHaveLength(3); // 标题 + a + c
		expect(lines.join("\n")).not.toContain("b");
		expect(lines.join("\n")).toContain("c");
		expect(lines[0]).toBe("Todos (2/3)");
		// 空集合：全部 completed 隐藏，仅剩标题 + pending
		const hidden = plain(buildOverlayLines(s, { collapsed: false }));
		expect(hidden).toHaveLength(2);
		expect(hidden[0]).toBe("Todos (2/3)");
	});

	it("折叠态：只留标题 + 一行提示（可见数=揭示后计数）", () => {
		const s = state([pending(1, "a"), pending(2, "b"), completed(3, "c")]);
		const lines = plain(buildOverlayLines(s, { collapsed: true, revealedCompleted: new Set([3]) }));
		expect(lines).toHaveLength(2);
		expect(lines[1]).toContain("3 task(s)");
		expect(lines[1]).toContain("ctrl+shift+t");
		// completed 未揭示时折叠提示只算可见数
		const hidden = plain(buildOverlayLines(s, { collapsed: true }));
		expect(hidden[1]).toContain("2 task(s)");
	});

	it("溢出：丢完 completed 后截断未完成行并提示 +N more", () => {
		// 上限 5 行（含标题）→ 可用 4 行；11 个任务（5 pending + 6 completed）
		const s = state([
			pending(1, "p1"), pending(2, "p2"), pending(3, "p3"), pending(4, "p4"), pending(5, "p5"),
			completed(6, "c1"), completed(7, "c2"), completed(8, "c3"), completed(9, "c4"), completed(10, "c5"), completed(11, "c6"),
		]);
		const lines = plain(buildOverlayLines(s, { collapsed: false, revealedCompleted: new Set([6, 7, 8, 9, 10, 11]), maxLines: 5 }));
		// 超 7 行 → 先丢全部 6 个 completed（剩 5 行仍超 4 行可用）→ 保留 3 行 + "+2 more"
		expect(lines).toHaveLength(5); // 标题 + 3 任务行 + more 行
		expect(lines[4]).toBe("+2 more");
		expect(lines.slice(1, 4).every((l) => l.includes("p"))).toBe(true); // 保留的都是 pending
	});

	it("溢出：丢完 completed 后未完成行仍不超限则不再截断", () => {
		const s = state([pending(1, "p1"), pending(2, "p2"), completed(3, "c1"), completed(4, "c2"), completed(5, "c3")]);
		const lines = plain(buildOverlayLines(s, { collapsed: false, revealedCompleted: new Set([3, 4, 5]), maxLines: 4 }));
		// 可用 3 行；5 行超 2 → 丢末尾 2 个 completed → 剩余 3 行刚好
		expect(lines).toHaveLength(4);
		expect(lines.some((l) => l.includes("c3"))).toBe(false);
		expect(lines.some((l) => l.includes("c1"))).toBe(true);
	});

	it("taskRow：超长标题截断加省略号", () => {
		const long = "x".repeat(100);
		const row = plain([taskRow(pending(1, long))]);
		expect(row[0]!.length).toBeLessThan(100 + 20);
		expect(row[0]).toContain("…");
	});
});